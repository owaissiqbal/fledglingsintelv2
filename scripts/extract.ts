/**
 * `pnpm extract` — re-run the deterministic phrase-library extractor over
 * already-fetched report sections. Use after editing config/phrases/*.yaml
 * so you can iterate on the libraries without re-fetching reports.
 */

import { runExtractor } from "@/lib/extract/extractor";
import { recordRun } from "@/lib/ingest/run";
import { log } from "@/lib/ingest/log";

async function main() {
  await recordRun("extract", () => runExtractor());
  log.info(`extract: done. Re-run \`pnpm score\` to refresh Opportunity Scores.`);
}

main().catch((err) => {
  log.error(`extract: fatal — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
