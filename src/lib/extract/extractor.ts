/**
 * Deterministic phrase-library extractor.
 *
 * For every report section we already have parsed, run each phrase regex
 * against the text. For each match: build a sentence-snapped source quote,
 * apply negation guards, and write a `findings` row plus one
 * `curriculum_matches` row per curriculum the phrase maps to.
 *
 * Idempotent: re-running deletes prior findings for the inspection first,
 * so YAML edits + `pnpm extract` is the right tight loop.
 */

import { eq, sql } from "drizzle-orm";
import {
  curriculumMatches,
  db,
  findings,
  inspections,
  phraseLibraryVersions,
  reportSections,
} from "@/db";
import { log } from "../ingest/log";
import { loadPhraseLibrary, type Phrase } from "./phrase-library";
import type { RunResult } from "../ingest/run";

const QUOTE_RADIUS = 200;

function buildSourceQuote(
  text: string,
  start: number,
  end: number,
): { quote: string; from: number; to: number } {
  const from = Math.max(0, start - QUOTE_RADIUS);
  const to = Math.min(text.length, end + QUOTE_RADIUS);

  // Snap to sentence boundaries
  let s = from;
  while (s > 0 && !/[.!?]/.test(text[s - 1] ?? "")) s--;
  let e = to;
  while (e < text.length && !/[.!?]/.test(text[e] ?? "")) e++;
  if (e < text.length) e++;

  return {
    quote: text.slice(s, e).replace(/\s+/g, " ").trim(),
    from: s,
    to: e,
  };
}

function checkGuards(quote: string, phrase: Phrase): string | null {
  for (const g of phrase.guardRegexes) {
    const m = quote.match(g);
    if (m) return m[0];
  }
  return null;
}

async function ensurePhraseLibraryVersion(
  hash: string,
  count: number,
): Promise<number | null> {
  const existing = await db
    .select({ id: phraseLibraryVersions.id })
    .from(phraseLibraryVersions)
    .where(eq(phraseLibraryVersions.yamlHash, hash))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(phraseLibraryVersions)
    .values({ yamlHash: hash, phraseCount: count })
    .onConflictDoNothing()
    .returning({ id: phraseLibraryVersions.id });
  return inserted[0]?.id ?? null;
}

export async function runExtractor(opts: {
  inspectionId?: number;
} = {}): Promise<RunResult> {
  const lib = loadPhraseLibrary();
  log.info(
    `extract: loaded ${lib.phrases.length} phrases (hash=${lib.hash.slice(0, 8)}, files=${lib.files.length})`,
  );

  await ensurePhraseLibraryVersion(lib.hash, lib.phrases.length);

  // Get inspections to process. Restrict to those with at least one section.
  let inspectionIds: number[];
  if (opts.inspectionId) {
    inspectionIds = [opts.inspectionId];
  } else {
    const result = await db
      .selectDistinct({ id: reportSections.inspectionId })
      .from(reportSections);
    inspectionIds = result.map((r) => r.id);
  }

  log.info(`extract: processing ${inspectionIds.length} inspections`);

  let totalFindings = 0;
  let totalSuppressed = 0;
  let totalMatches = 0;

  const BATCH = 100;
  for (let i = 0; i < inspectionIds.length; i += BATCH) {
    const slice = inspectionIds.slice(i, i + BATCH);
    for (const inspectionId of slice) {
      const insRow = await db
        .select({
          id: inspections.id,
          institutionId: inspections.institutionId,
        })
        .from(inspections)
        .where(eq(inspections.id, inspectionId))
        .limit(1);
      if (!insRow[0]) continue;
      const institutionId = insRow[0].institutionId;

      const sections = await db
        .select()
        .from(reportSections)
        .where(eq(reportSections.inspectionId, inspectionId));

      // Wipe prior findings + their curriculum matches for this inspection.
      // curriculum_matches has FK ON DELETE CASCADE so the join table clears with it.
      await db.delete(findings).where(eq(findings.inspectionId, inspectionId));

      for (const section of sections) {
        if (section.multiplier === 0.0) continue;

        for (const phrase of lib.phrases) {
          phrase.re.lastIndex = 0;
          let m: RegExpExecArray | null;
          const seen = new Set<string>();

          while ((m = phrase.re.exec(section.sectionText)) !== null) {
            totalMatches++;
            const start = m.index;
            const end = start + m[0].length;
            const { quote, from, to } = buildSourceQuote(
              section.sectionText,
              start,
              end,
            );
            const dedupeKey = `${phrase.id}:${from}-${to}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const guardHit = checkGuards(quote, phrase);
            const finalSeverity = phrase.severity * section.multiplier;

            const inserted = await db
              .insert(findings)
              .values({
                inspectionId,
                institutionId,
                phraseId: phrase.id,
                phrasePattern: phrase.pattern,
                sectionKey: section.sectionKey,
                sourceQuote: quote,
                quoteStart: from,
                quoteEnd: to,
                baseSeverity: phrase.severity,
                multiplier: section.multiplier,
                finalSeverity,
                suppressed: !!guardHit,
                suppressionReason: guardHit ? `guard: ${guardHit}` : null,
              })
              .returning({ id: findings.id });

            if (guardHit) {
              totalSuppressed++;
            } else {
              totalFindings++;
              for (const curriculum of phrase.curricula) {
                await db.insert(curriculumMatches).values({
                  findingId: inserted[0].id,
                  institutionId,
                  curriculum,
                  weight: 1.0,
                });
              }
            }

            // Avoid infinite loops on zero-length matches
            if (m[0].length === 0) phrase.re.lastIndex++;
          }
        }
      }
    }
    if (i + BATCH < inspectionIds.length) {
      log.info(
        `extract: ${i + BATCH}/${inspectionIds.length} inspections — findings=${totalFindings}`,
      );
    }
  }

  log.info(
    `extract: complete — findings=${totalFindings} suppressed=${totalSuppressed} matches=${totalMatches}`,
  );

  return {
    recordsSeen: inspectionIds.length,
    recordsUpserted: totalFindings,
    notes: `suppressed=${totalSuppressed}; matches=${totalMatches}`,
  };
}
