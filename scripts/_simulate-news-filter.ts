// Simulate the keyword pre-filter against existing news_items.
// Counts how many would have been short-circuited (no LLM call) vs sent
// to Claude — gives a £-cost estimate for next run.
import { client } from "../src/db";

const TRIGGER_KEYWORDS = [
  "strik", "ballot", "walk out", "walkout", "industrial action", "ucu",
  "redundanc", "lay off", "layoff", "job cut", "job loss", "restructur",
  "principal", "chief executive", "ceo", "step down", "stepping down",
  "resign", "depart", "appoint",
  "inadequate", "requires improvement", "rated good", "downgrad", "rated outstanding",
  "ofsted", "inspection report", "ofsted finds",
  "notice to improve", "best value notice", "intervention", "fec ", "fe commissioner",
  "removed from", "suspended", "fraud", "investigation", "probe",
  "audit", "warning", "complain", "compliance", "threat", "threaten",
  "deficit", "insolvenc", "administration", "liquidat", "merger",
  "merging", "merged", "fund", "budget cut", "loss",
  "financial difficult", "financial troubl", "financial crisis",
  "loan", "debt", "bankruptcy", "rescue",
  "safeguard", "behaviour", "behavior", "bully", "exclus", "absentee",
  "harm", "abuse", "assault", "stab", "knife", "weapon", "police",
  "death", "died", "tragedy", "accident", "evacuat", "fell", "fall",
  "racist", "racism", "homopho", "transpho",
  "consent", "missold", "mis-sold", "data integrity", "inflat",
  "scandal", "concern", "complaint",
  "closur", "closing", "shut down", "shutting", "shut at",
  "wellbeing", "mental health", "anxiety", "self-harm", "suicid",
  "apprent", "training provider", "roatp", "apar ",
];

const RE = new RegExp(
  TRIGGER_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

async function main() {
  const r = await client.execute(`
    SELECT title, excerpt, trigger_severity, angle FROM news_items
  `);

  let total = 0;
  let wouldSkip = 0;
  let wouldExtract = 0;
  let wouldSkipButHadHigh = 0;
  let wouldExtractAndHadHigh = 0;
  for (const row of r.rows as unknown as { title: string; excerpt: string | null; trigger_severity: number; angle: string | null }[]) {
    total++;
    const text = `${row.title} ${row.excerpt ?? ""}`;
    const hasKw = RE.test(text);
    if (hasKw) {
      wouldExtract++;
      if (row.trigger_severity >= 70) wouldExtractAndHadHigh++;
    } else {
      wouldSkip++;
      if (row.trigger_severity >= 70) wouldSkipButHadHigh++;
    }
  }

  console.log(`Total news_items: ${total}`);
  console.log(`Would SKIP (no keyword, no LLM call): ${wouldSkip} (${((wouldSkip/total)*100).toFixed(1)}%)`);
  console.log(`Would EXTRACT (keyword match, LLM call): ${wouldExtract} (${((wouldExtract/total)*100).toFixed(1)}%)`);
  console.log("");
  console.log(`Of skipped: ${wouldSkipButHadHigh} were actually high-severity (false negatives)`);
  console.log(`Of extracted: ${wouldExtractAndHadHigh} were high-severity (true positives)`);
  console.log("");
  // Cost estimate at Haiku 4.5 pricing: ~$1/MTok in, ~$5/MTok out
  // Per call ~700 in + ~150 out = ~£0.0008
  const oldCost = total * 0.0008;
  const newCost = wouldExtract * 0.0008;
  console.log(`Old cost (full LLM): ~£${oldCost.toFixed(2)}`);
  console.log(`New cost (filtered): ~£${newCost.toFixed(2)}`);
  console.log(`Savings: ~${(((oldCost - newCost) / oldCost) * 100).toFixed(0)}%`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
