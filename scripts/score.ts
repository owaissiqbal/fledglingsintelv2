/**
 * `pnpm score` — recompute Opportunity Scores from current findings + the
 * curriculum mapping file. Cheap; safe to run as often as you like.
 */

import { recomputeOpportunityScores } from "@/lib/extract/scoring";
import { recordRun } from "@/lib/ingest/run";
import { log } from "@/lib/ingest/log";

async function main() {
  await recordRun("score", () => recomputeOpportunityScores());
}

main().catch((err) => {
  log.error(`score: fatal — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
