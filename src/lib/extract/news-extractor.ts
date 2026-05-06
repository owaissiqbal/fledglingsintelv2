/**
 * Run Claude over news_items rows that haven't been LLM-evaluated yet.
 * "Not yet evaluated" = trigger_severity = 0 AND angle IS NULL — every
 * insert from news.ts starts with both unset, and a successful
 * extraction sets at least `angle`.
 *
 * Writes back: relevance (refined), trigger_severity, curricula_tagged,
 * angle. Idempotent: re-running skips already-extracted rows.
 *
 * Cost ballpark on Haiku 4.5: ~700 input + ~80 output tokens per row →
 * roughly £0.0008 per article. 100 articles ≈ £0.08.
 *
 * Budget: NEWS_EXTRACTION_BUDGET_PER_RUN env var (default 100). Pick
 * highest-tier institutions first so the spend goes where it matters.
 */

import { eq } from "drizzle-orm";
import { client, db, newsItems } from "@/db";
import { extractNewsSignal, isClaudeEnabled } from "../claude";
import { log } from "../ingest/log";
import type { RunResult } from "../ingest/run";

// Trigger-keyword pre-filter. Articles whose title + excerpt contain NONE
// of these words are almost certainly "no angle" — sports wins, awards,
// fundraising, partnership announcements, generic curriculum updates. We
// short-circuit those to triggerSeverity=0 / angle="no trigger keywords"
// without a Claude call. Every word is the stem so we catch variants
// (e.g. "strik" matches strike, strikes, striking). Saves ~75-80% of the
// LLM spend on a typical Google News dump while keeping all currently-
// observed real signals.
const TRIGGER_KEYWORDS = [
  // Industrial action / staffing
  "strik", "ballot", "walk out", "walkout", "industrial action", "ucu",
  "redundanc", "lay off", "layoff", "job cut", "job loss", "restructur",
  "principal", "chief executive", "ceo", "step down", "stepping down",
  "resign", "depart", "appoint",
  // Ofsted / inspection
  "inadequate", "requires improvement", "rated good", "downgrad", "rated outstanding",
  "ofsted", "inspection report", "ofsted finds",
  // Compliance / regulator
  "notice to improve", "best value notice", "intervention", "fec ", "fe commissioner",
  "removed from", "suspended", "fraud", "investigation", "probe",
  "audit", "warning", "complain", "compliance", "threat", "threaten",
  // Financial health
  "deficit", "insolvenc", "administration", "liquidat", "merger",
  "merging", "merged", "fund", "budget cut", "loss",
  "financial difficult", "financial troubl", "financial crisis",
  "loan", "debt", "bankruptcy", "rescue",
  // Safeguarding / behaviour / serious incidents
  "safeguard", "behaviour", "behavior", "bully", "exclus", "absentee",
  "harm", "abuse", "assault", "stab", "knife", "weapon", "police",
  "death", "died", "tragedy", "accident", "evacuat", "fell", "fall",
  "racist", "racism", "homopho", "transpho",
  // Quality / curriculum issues
  "consent", "missold", "mis-sold", "data integrity", "inflat",
  "scandal", "concern", "complaint",
  "closur", "closing", "shut down", "shutting", "shut at",
  // Mental health / wellbeing
  "wellbeing", "mental health", "anxiety", "self-harm", "suicid",
  // Specific to apprenticeships / FE
  "apprent", "training provider", "roatp", "apar ",
];

const KEYWORD_RE = new RegExp(
  TRIGGER_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

function hasTriggerKeyword(title: string, excerpt: string | null): boolean {
  const haystack = `${title} ${excerpt ?? ""}`;
  return KEYWORD_RE.test(haystack);
}

export async function extractNewsSignals(): Promise<RunResult> {
  if (!isClaudeEnabled()) {
    log.warn("news_extract: skipped — ANTHROPIC_API_KEY not set");
    return {
      recordsSeen: 0,
      recordsUpserted: 0,
      notes: "skipped — ANTHROPIC_API_KEY not set",
    };
  }

  const budget = Number(process.env.NEWS_EXTRACTION_BUDGET_PER_RUN ?? "100");
  if (budget <= 0) {
    return { recordsSeen: 0, recordsUpserted: 0, notes: "budget=0" };
  }

  // Pull pending rows ordered by institution priority. We join through
  // opportunity_scores so high-tier providers' news gets evaluated first.
  // Rows where the parent institution has no opportunity_score yet still
  // get processed, just last.
  const queue = await client.execute({
    sql: `SELECT n.id, n.institution_id, n.title, n.excerpt, n.source, n.published_at,
                 i.name AS institution_name, i.type AS institution_type
          FROM news_items n
          JOIN institutions i ON i.id = n.institution_id
          LEFT JOIN opportunity_scores os ON os.institution_id = i.id
          WHERE n.angle IS NULL
          ORDER BY COALESCE(os.score, 0) DESC, n.published_at DESC
          LIMIT ?`,
    args: [budget],
  });
  const pending = queue.rows as unknown as {
    id: number;
    institution_id: number;
    title: string;
    excerpt: string | null;
    source: string;
    published_at: string | null;
    institution_name: string;
    institution_type: string;
  }[];

  log.info(`news_extract: ${pending.length} rows pending (budget=${budget})`);

  let extracted = 0;
  let skippedNoKeyword = 0;
  let failed = 0;
  let highSeverityCount = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const row of pending) {
    // Pre-filter: if neither title nor excerpt contains any signal keyword,
    // short-circuit to "no angle" without spending an LLM call. Saves ~85%
    // of API spend on a typical Google News dump.
    if (!hasTriggerKeyword(row.title, row.excerpt)) {
      await db
        .update(newsItems)
        .set({
          relevance: Math.min(row.title.length > 0 ? 30 : 10, 35),
          triggerSeverity: 0,
          curriculaTagged: null,
          angle: "filtered: no signal keywords matched",
          lastSeenAt: new Date(),
        })
        .where(eq(newsItems.id, row.id));
      skippedNoKeyword++;
      continue;
    }
    try {
      const result = await extractNewsSignal({
        institutionName: row.institution_name,
        institutionType: row.institution_type,
        title: row.title,
        excerpt: row.excerpt ?? "",
        source: row.source,
        publishedAt: row.published_at,
      });
      await db
        .update(newsItems)
        .set({
          relevance: result.relevance,
          triggerSeverity: result.triggerSeverity,
          curriculaTagged: result.curriculaTagged || null,
          angle: result.angle,
          lastSeenAt: new Date(),
        })
        .where(eq(newsItems.id, row.id));
      extracted++;
      totalIn += result.inputTokens;
      totalOut += result.outputTokens;
      if (result.triggerSeverity >= 70) highSeverityCount++;
    } catch (err) {
      failed++;
      log.warn(
        `news_extract row#${row.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  log.info(
    `news_extract: extracted=${extracted} skipped_no_keyword=${skippedNoKeyword} failed=${failed} high_severity=${highSeverityCount} tokens_in=${totalIn} tokens_out=${totalOut}`,
  );

  return {
    recordsSeen: pending.length,
    recordsUpserted: extracted + skippedNoKeyword,
    notes: `extracted=${extracted} skipped_no_keyword=${skippedNoKeyword} high_severity=${highSeverityCount} tokens_in=${totalIn} tokens_out=${totalOut}`,
  };
}
