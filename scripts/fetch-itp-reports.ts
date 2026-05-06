/**
 * Fetch and parse Ofsted reports for every ITP / university / FE college /
 * sixth-form college that has a report URL but no report_text yet.
 *
 * Prioritises Inadequate → RI → others within the type filter so the most
 * actionable reports come back first. After this script, run:
 *   pnpm tsx ./scripts/refresh.ts --only=extract,score
 * to scan the freshly-pulled report text for phrase-library matches and
 * regenerate opportunity scores.
 */

import { ingestOfstedReports } from "../src/lib/ingest/ofsted-reports";
import { recordRun } from "../src/lib/ingest/run";
import { log } from "../src/lib/ingest/log";

async function main() {
  const capArg = process.argv.find((a) => a.startsWith("--cap="));
  const cap = capArg ? Number(capArg.slice("--cap=".length)) : 1000;
  const refresh = process.argv.includes("--refresh");

  log.info(`fetch_itp_reports: cap=${cap} refresh=${refresh}`);

  await recordRun("ofsted_reports_itp", () =>
    ingestOfstedReports({
      cap,
      refresh,
      types: ["itp", "university", "fe_college", "sixth_form_college"],
      prioritiseGrades: ["inadequate", "requires_improvement", "good", "outstanding"],
    }),
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
