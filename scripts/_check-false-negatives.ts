import { client } from "../src/db";

const TRIGGER_KEYWORDS = [
  "strik", "ballot", "walk out", "walkout", "industrial action", "uniso n", "ucu",
  "redundanc", "lay off", "layoff", "job cut", "job loss", "restructur",
  "principal", "chief executive", "ceo", " chair ", "step down", "stepping down",
  "resign", "depart", "appoint",
  "inadequate", "requires improvement", "rated good", "downgrad", "rated outstanding",
  "ofsted", "inspection report", "ofsted finds",
  "notice to improve", "intervention", "fec ", "fe commissioner",
  "removed from", "suspended", "fraud", "investigation", "probe",
  "audit", "warning", "complain", "compliance",
  "deficit", "insolvenc", "administration", "liquidat", "merger",
  "merging", "merged", "funding cut", "budget cut", "loss",
  "financial difficult", "financial troubl", "financial crisis",
  "loan", "debt", "bankruptcy", "rescue",
  "safeguard", "behaviour", "behavior", "bully", "exclus", "absentee",
  "harm", "abuse", "assault", "stab", "knife", "weapon", "police",
  "death", "died", "tragedy", "accident", "evacuat", "fire ",
  "racist", "racism", "homopho", "transpho",
  "consent", "missold", "mis-sold", "data integrity", "inflat",
  "scandal", "concern", "complaint", "review",
  "closur", "closing", "shut down", "shutting", "shut at",
  "wellbeing", "mental health", "anxiety", "stress", "self-harm", "suicid",
  "apprent", "training provider", "roatp", "apar ",
];
const RE = new RegExp(
  TRIGGER_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

async function main() {
  const r = await client.execute(`
    SELECT title, excerpt, trigger_severity, angle FROM news_items
    WHERE trigger_severity >= 70
    ORDER BY trigger_severity DESC
  `);
  console.log("High-severity articles the keyword filter would MISS:\n");
  for (const row of r.rows as unknown as { title: string; excerpt: string | null; trigger_severity: number; angle: string | null }[]) {
    const text = `${row.title} ${row.excerpt ?? ""}`;
    if (!RE.test(text)) {
      console.log(`  [sev ${row.trigger_severity}] ${row.title}`);
      console.log(`     excerpt: ${(row.excerpt ?? "").slice(0, 200)}`);
      console.log(`     angle: ${(row.angle ?? "").slice(0, 120)}`);
      console.log("");
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
