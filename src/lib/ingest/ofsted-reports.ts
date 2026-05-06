/**
 * Per-inspection report fetcher and text extractor.
 *
 * For each inspection that has a `report_url` but no extracted `report_text`,
 * we fetch the URL once and cache it under data/raw/ofsted_reports/. URLs
 * point to one of:
 *   - A provider HTML page on reports.ofsted.gov.uk that lists PDF reports
 *     (we then resolve the latest inspection PDF and fetch that)
 *   - A direct PDF on files.ofsted.gov.uk
 *   - Older HTML-only pages (we extract main content as a last resort)
 *
 * Capped at REPORTS_CAP per run to be polite. Subsequent runs catch the rest.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { and, asc, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db, inspections, institutions, reportSections } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import { resolveReportUrl } from "./ofsted-url";
import { sectionise, hashText } from "../extract/sections";
import type { RunResult } from "./run";

// pdf-parse is a CJS module that runs a self-test against a bundled sample
// PDF on first require, which fails outside its own working dir. Loading via
// createRequire from the project root + pointing at the inner module file
// avoids the self-test entirely.
const requireCjs = createRequire(import.meta.url);
type PdfParseFn = (buf: Buffer) => Promise<{ text: string }>;
let pdfParse: PdfParseFn;
try {
  pdfParse = requireCjs("pdf-parse/lib/pdf-parse.js");
} catch (err) {
  log.warn(`pdf-parse import failed: ${(err as Error).message.slice(0, 200)}`);
  // Fall back to main entry, accepting the self-test cost.
  pdfParse = requireCjs("pdf-parse");
}

const REPORTS_CAP = Number.parseInt(process.env.REPORTS_CAP ?? "500", 10);
// SQLite handles a single writer well; concurrent writes from p-limit cause
// SQLITE_BUSY even with WAL+timeout. Keep DB ops serial; parallelism on
// network fetches doesn't help us much when reports are mostly cached.
const CONCURRENCY = Number.parseInt(process.env.FETCH_CONCURRENCY ?? "1", 10);
const REPORT_CACHE_AGE = 30 * 24 * 60 * 60 * 1000; // a month

async function extractFromBuffer(
  buffer: Buffer,
  reportUrl: string,
): Promise<{ text: string; resolvedPdfUrl?: string } | null> {
  const isPdf = buffer.slice(0, 4).toString("ascii") === "%PDF";
  if (isPdf) {
    try {
      const data = await pdfParse(buffer);
      return { text: cleanPdfText(data.text) };
    } catch (err) {
      log.warn(
        `pdf parse failed for ${reportUrl}: ${(err as Error).message.slice(0, 120)}`,
      );
      return null;
    }
  }

  const html = buffer.toString("utf-8");
  const $ = cheerio.load(html);

  // Look for inspection report links. Modern reports.ofsted.gov.uk pages
  // link to PDFs at files.ofsted.gov.uk/v1/file/{id}; older pages used .pdf
  // extensions. Take the most recent dated match. Skip "Monitoring visit"
  // and "Short inspection" — they're light-touch and don't contain the
  // narrative our phrase library targets.
  const candidates: {
    href: string;
    date: number | null;
    isFull: boolean;
  }[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim();
    const looksLikePdf =
      /files\.ofsted\.gov\.uk\/v1\/file\//i.test(href) ||
      /\.pdf(?:\?|$)/i.test(href);
    if (!looksLikePdf) return;
    if (!/inspect|report/i.test(text)) return;

    const full = href.startsWith("http") ? href : new URL(href, reportUrl).href;
    const dateMatch = text.match(
      /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[A-Za-z]*\s+\d{4}|\d{4}-\d{2}-\d{2})/,
    );
    const isFull =
      /full inspection|school inspection|graded inspection|standard inspection/i.test(
        text,
      );
    candidates.push({
      href: full,
      date: dateMatch ? Date.parse(dateMatch[1]) : null,
      isFull,
    });
  });

  // Prefer full/graded inspections, then by recency.
  candidates.sort((a, b) => {
    if (a.isFull !== b.isFull) return a.isFull ? -1 : 1;
    return (b.date ?? 0) - (a.date ?? 0);
  });

  for (const c of candidates) {
    try {
      const pdfFetched = await fetchToFile(c.href, {
        subdir: "ofsted_reports/pdf",
        maxAgeMs: REPORT_CACHE_AGE,
      });
      const pdfBuffer = readFileSync(pdfFetched.localPath);
      const isPdfFile =
        pdfBuffer.slice(0, 4).toString("ascii") === "%PDF";
      if (!isPdfFile) continue;
      const data = await pdfParse(pdfBuffer);
      if (data.text && data.text.length > 500) {
        return {
          text: cleanPdfText(data.text),
          resolvedPdfUrl: c.href,
        };
      }
    } catch (err) {
      log.debug(
        `pdf parse skipped for ${c.href}: ${(err as Error).message.slice(0, 80)}`,
      );
    }
  }

  // Fall back to extracting main body text from the HTML page.
  const main =
    $("main").text() ||
    $("article").text() ||
    $(".govuk-main-wrapper").text() ||
    $("body").text();
  const text = main.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  if (text.length < 500) return null;
  return { text };
}

function cleanPdfText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "") // join hyphenated line breaks
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export async function ingestOfstedReports(opts: {
  refresh?: boolean;
  cap?: number;
  types?: string[];          // restrict to certain institution types
  prioritiseGrades?: string[]; // grade values to fetch first (e.g. ['inadequate','requires_improvement'])
} = {}): Promise<RunResult> {
  const cap = opts.cap ?? REPORTS_CAP;

  // Build a prioritised queue: high-urgency grades first within the type
  // filter, then everything else by recency. The original ordering
  // (recency only) gets crowded out by the 5,000 state schools and
  // leaves ITPs starved.
  const conds = [
    isNotNull(inspections.reportUrl),
    ne(inspections.reportUrl, ""),
  ];
  if (!opts.refresh) conds.push(isNull(inspections.reportText));
  if (opts.types && opts.types.length > 0) {
    conds.push(sql`${institutions.type} IN (${sql.join(
      opts.types.map((t) => sql`${t}`),
      sql`,`,
    )})`);
  }

  const priorityGrades = opts.prioritiseGrades ?? [];
  // Use a CASE expression to put RI/Inadequate first, then by recency.
  const priorityOrder = priorityGrades.length
    ? sql`CASE ${inspections.overallGrade}
            ${sql.join(
              priorityGrades.map((g, i) => sql`WHEN ${g} THEN ${i}`),
              sql` `,
            )}
            ELSE ${priorityGrades.length} END ASC,`
    : sql``;

  const candidates = await db
    .select({
      id: inspections.id,
      reportUrl: inspections.reportUrl,
      institutionId: inspections.institutionId,
      institutionType: institutions.type,
    })
    .from(inspections)
    .innerJoin(institutions, eq(institutions.id, inspections.institutionId))
    .where(and(...conds))
    .orderBy(sql`${priorityOrder} ${inspections.inspectionStartDate} DESC`)
    .limit(cap);

  log.info(
    `ofsted_reports: ${candidates.length} inspections to fetch (cap=${cap}, refresh=${!!opts.refresh})`,
  );

  const limit = pLimit(CONCURRENCY);
  let success = 0;
  let failed = 0;

  const results = await Promise.allSettled(
    candidates.map((row) =>
      limit(async () => {
        try {
          const resolved = await resolveReportUrl(
            row.reportUrl,
            row.institutionType,
          );
          if (!resolved) {
            failed++;
            return;
          }
          const fetched = await fetchToFile(resolved, {
            subdir: "ofsted_reports",
            maxAgeMs: REPORT_CACHE_AGE,
          });
          const buffer = readFileSync(fetched.localPath);
          const extracted = await extractFromBuffer(buffer, resolved);
          if (!extracted || !extracted.text) {
            failed++;
            return;
          }

          const sections = sectionise(extracted.text);
          const hash = hashText(extracted.text);

          await db.transaction(async (tx) => {
            await tx
              .update(inspections)
              .set({
                reportText: extracted.text,
                reportTextHash: hash,
                reportPdfPath: fetched.localPath,
                updatedAt: new Date(),
              })
              .where(eq(inspections.id, row.id));

            await tx
              .delete(reportSections)
              .where(eq(reportSections.inspectionId, row.id));

            for (const s of sections) {
              await tx.insert(reportSections).values({
                inspectionId: row.id,
                sectionKey: s.sectionKey,
                sectionTitle: s.sectionTitle,
                sectionText: s.sectionText,
                multiplier: s.multiplier,
                orderIndex: s.orderIndex,
              });
            }
          });

          success++;
          if (success % 50 === 0) {
            log.info(
              `ofsted_reports: ${success}/${candidates.length} parsed (failed=${failed})`,
            );
          }
        } catch (err) {
          failed++;
          if (failed <= 3) {
            log.warn(
              `ofsted_reports: ${row.reportUrl} -> ${(err as Error).message.slice(0, 200)}`,
            );
          }
        }
      }),
    ),
  );

  log.info(
    `ofsted_reports: complete — fetched=${success} failed=${failed} skipped_settled=${results.length - success - failed}`,
  );

  return {
    recordsSeen: candidates.length,
    recordsUpserted: success,
    notes: `failed=${failed}`,
  };
}
