/**
 * `pnpm ingest` entry point.
 *
 * Orchestrates the full refresh pipeline. Each stage is wrapped by
 * `recordRun` so progress and errors land in the `ingestion_runs` table.
 *
 * Flags:
 *   --refresh           re-fetch even if cached files are fresh
 *   --only=stage[,...]  run a subset of stages (gias, ofsted_mi,
 *                       ofsted_reports, isi, extract, score)
 *
 * Default cap on per-run report fetches lives in REPORTS_CAP env var
 * (default 500). Subsequent runs pick up where the previous one stopped
 * because cached docs aren't re-fetched.
 */

import { ingestApar } from "@/lib/ingest/apar";
import { ingestApprenticeshipDirectory } from "@/lib/ingest/apprenticeship-directory";
import { ingestSkillsBootcamps } from "@/lib/ingest/skills-bootcamps";
import { ingestContacts } from "@/lib/ingest/contacts";
import { ingestGias } from "@/lib/ingest/gias";
import { ingestOfstedMi } from "@/lib/ingest/ofsted-mi";
import { ingestOfstedProviders } from "@/lib/ingest/ofsted-providers";
import { ingestOfstedReports } from "@/lib/ingest/ofsted-reports";
import { ingestIsi } from "@/lib/ingest/isi";
import {
  ingestAparCompliance,
  ingestGovUkAtomFeeds,
  ingestFeNoticesToImprove,
} from "@/lib/ingest/compliance";
import { ingestCompaniesHouse } from "@/lib/ingest/companies-house";
import {
  ingestNewsTradePress,
  ingestGoogleNewsPerProvider,
} from "@/lib/ingest/news";
import { extractNewsSignals } from "@/lib/extract/news-extractor";
import { runExtractor } from "@/lib/extract/extractor";
import { extractIsiGrades } from "@/lib/extract/isi-grades";
import { recomputeOpportunityScores } from "@/lib/extract/scoring";
import { recordRun } from "@/lib/ingest/run";
import { log } from "@/lib/ingest/log";

const STAGES = [
  "gias",
  "ofsted_mi",
  "apar",
  "skills_bootcamps",
  "ofsted_providers",
  "ofsted_reports",
  "isi",
  "isi_grades",
  "appr_dir",
  "extract",
  "apar_compliance",
  "govuk_atom",
  "fe_nti",
  "companies_house",
  "news_trade",
  "news_google",
  "news_extract",
  "score",
  "contacts",
] as const;

type Stage = (typeof STAGES)[number];

function parseArgs(argv: string[]): { only?: Stage[]; refresh: boolean } {
  const only: Stage[] = [];
  let refresh = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--refresh") {
      refresh = true;
    } else if (arg.startsWith("--only=")) {
      const stages = arg.slice("--only=".length).split(",") as Stage[];
      for (const s of stages) {
        if (!STAGES.includes(s)) {
          console.error(`Unknown stage: ${s}. Valid: ${STAGES.join(", ")}`);
          process.exit(2);
        }
        only.push(s);
      }
    }
  }
  return { only: only.length ? only : undefined, refresh };
}

async function runStage(stage: Stage, refresh: boolean) {
  switch (stage) {
    case "gias":
      await recordRun("gias", () => ingestGias({ refresh }));
      return;
    case "ofsted_mi":
      await recordRun("ofsted_mi", () => ingestOfstedMi({ refresh }));
      return;
    case "ofsted_providers":
      await recordRun("ofsted_providers", () => ingestOfstedProviders());
      return;
    case "ofsted_reports":
      await recordRun("ofsted_reports", () =>
        ingestOfstedReports({ refresh }),
      );
      return;
    case "isi":
      await recordRun("isi", () => ingestIsi());
      return;
    case "extract":
      await recordRun("extract", () => runExtractor());
      return;
    case "isi_grades":
      await recordRun("isi_grades", () => extractIsiGrades());
      return;
    case "score":
      await recordRun("score", () => recomputeOpportunityScores());
      return;
    case "contacts":
      await recordRun("contacts", () => ingestContacts());
      return;
    case "appr_dir":
      await recordRun("appr_dir", () => ingestApprenticeshipDirectory());
      return;
    case "apar":
      await recordRun("apar", () => ingestApar());
      return;
    case "skills_bootcamps":
      await recordRun("skills_bootcamps", () => ingestSkillsBootcamps());
      return;
    case "apar_compliance":
      await recordRun("apar_compliance", () => ingestAparCompliance());
      return;
    case "govuk_atom":
      await recordRun("govuk_atom", () => ingestGovUkAtomFeeds());
      return;
    case "fe_nti":
      await recordRun("fe_nti", () => ingestFeNoticesToImprove());
      return;
    case "companies_house":
      await recordRun("companies_house", () => ingestCompaniesHouse());
      return;
    case "news_trade":
      await recordRun("news_trade", () => ingestNewsTradePress());
      return;
    case "news_google":
      await recordRun("news_google", () => ingestGoogleNewsPerProvider());
      return;
    case "news_extract":
      await recordRun("news_extract", () => extractNewsSignals());
      return;
  }
}

async function main() {
  const { only, refresh } = parseArgs(process.argv);
  const stages = only ?? [...STAGES];

  log.info(
    `pipeline starting — mode=${refresh ? "incremental" : "initial"} stages=${stages.join(",")}`,
  );
  const startedAt = Date.now();

  for (const stage of stages) {
    try {
      await runStage(stage, refresh);
    } catch (err) {
      log.error(
        `${stage}: aborted — ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue to the next stage; failures are visible in ingestion_runs.
    }
  }

  log.info(
    `pipeline finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
