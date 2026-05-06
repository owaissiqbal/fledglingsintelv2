/**
 * APAR (Apprenticeship Provider and Assessment Register) ingest.
 *
 * Source: https://download.apprenticeships.education.gov.uk/apar
 *
 * APAR is the canonical list of every UK approved apprenticeship provider —
 * far more comprehensive than Ofsted's MI snapshot which only covers ones
 * Ofsted has interacted with. The CSV has 1,400+ rows split across:
 *
 *   ApplicationType                 → our institution.type
 *   ─────────────────────────────────────────────────────────────
 *   "Main provider"                 → itp        (1,138 rows)
 *   "Supporting provider"           → itp        (164 rows)
 *   "Employer provider"             → employer   (122 rows — Fledglings'
 *                                                  pre-employment bootcamp ICP)
 *
 * Columns: Ukprn, Name, ApplicationType, StartDate, Status,
 *          ApplicationDeterminedDate
 *
 * For each row we upsert the institution (keyed on UKPRN) and tag the
 * source so we know which providers came from APAR vs Ofsted MI.
 */

import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import * as cheerio from "cheerio";
import { eq } from "drizzle-orm";
import { db, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import type { RunResult } from "./run";

const APAR_PAGE = "https://download.apprenticeships.education.gov.uk/apar";
const USER_AGENT =
  process.env.USER_AGENT ??
  "Fledglings-ICP-Bot/1.0 (internal tooling; replace USER_AGENT in .env)";

async function findLatestCsvUrl(): Promise<string> {
  if (process.env.APAR_CSV_URL) return process.env.APAR_CSV_URL;
  const r = await fetch(APAR_PAGE, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`APAR page ${r.status}`);
  const html = await r.text();
  const $ = cheerio.load(html);
  // Look for the most recent download CSV link
  for (const el of $("a[href*='downloadcsv']").toArray()) {
    const href = $(el).attr("href") ?? "";
    if (href.includes("apar-")) {
      return href.startsWith("http")
        ? href
        : new URL(href, APAR_PAGE).href;
    }
  }
  throw new Error("No APAR CSV download link found");
}

type AparRow = {
  Ukprn: string;
  Name: string;
  ApplicationType: string;
  StartDate?: string;
  Status?: string;
  ApplicationDeterminedDate?: string;
};

function classifyType(applicationType: string): "itp" | "employer" {
  if (/employer\s+provider/i.test(applicationType)) return "employer";
  return "itp";
}

export async function ingestApar(): Promise<RunResult> {
  const url = await findLatestCsvUrl();
  log.info(`apar: latest CSV → ${url}`);

  const cached = await fetchToFile(url, {
    subdir: "apar",
    filenameHint: "apar",
    extension: ".csv",
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });

  const raw = readFileSync(cached.localPath, "utf-8");
  const rows = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
  }) as AparRow[];

  log.info(`apar: parsed ${rows.length} provider rows`);

  let createdItp = 0;
  let createdEmployer = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date();

  for (const row of rows) {
    const ukprn = (row.Ukprn || "").trim();
    if (!ukprn) {
      skipped++;
      continue;
    }
    const name = (row.Name || `UKPRN ${ukprn}`).trim();
    const newType = classifyType(row.ApplicationType || "");

    const existing = await db
      .select({
        id: institutions.id,
        type: institutions.type,
        source: institutions.source,
      })
      .from(institutions)
      .where(eq(institutions.ukprn, ukprn))
      .limit(1);

    if (existing[0]) {
      // Don't downgrade an existing rich classification (e.g. fe_college →
      // itp). Only switch to 'employer' if APAR explicitly classifies as
      // such; otherwise leave the type alone.
      const updates: Record<string, unknown> = { updatedAt: now };
      const tags = new Set([
        ...(existing[0].source ?? "").split("+").filter(Boolean),
        "apar",
      ]);
      updates.source = Array.from(tags).join("+");
      if (newType === "employer" && existing[0].type !== "employer") {
        // Promote to employer if APAR says so — these are an ICP segment
        // distinct from training providers.
        updates.type = "employer";
      }
      await db
        .update(institutions)
        .set(updates)
        .where(eq(institutions.id, existing[0].id));
      updated++;
      continue;
    }

    await db.insert(institutions).values({
      ukprn,
      name,
      type: newType,
      phase: "16 plus",
      inScope: true,
      source: "apar",
    });
    if (newType === "employer") createdEmployer++;
    else createdItp++;
  }

  log.info(
    `apar: complete — created itp=${createdItp} employer=${createdEmployer} updated=${updated} skipped=${skipped}`,
  );

  return {
    recordsSeen: rows.length,
    recordsUpserted: createdItp + createdEmployer + updated,
    notes: `created_itp=${createdItp} created_employer=${createdEmployer} updated_existing=${updated}`,
  };
}
