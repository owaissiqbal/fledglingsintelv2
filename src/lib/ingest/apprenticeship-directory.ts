/**
 * Enrich ITPs and FE colleges with email, phone, website by scraping the
 * gov.uk "Find Apprenticeship Training" provider directory.
 *
 *   https://findapprenticeshiptraining.apprenticeships.education.gov.uk/providers/{UKPRN}
 *
 * Each page is server-rendered HTML with a tidy <dl> of contact details
 * — Email (mailto link), Telephone, Website. No auth, no rate-limit
 * problems observed at modest concurrency.
 *
 * Free fix for the "ITPs have no contact details" gap.
 */

import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import type { RunResult } from "./run";

const BASE =
  "https://findapprenticeshiptraining.apprenticeships.education.gov.uk/providers/";
const CONCURRENCY = Number.parseInt(
  process.env.APPR_DIR_CONCURRENCY ?? "4",
  10,
);
const FETCH_DELAY_MS = Number.parseInt(
  process.env.APPR_DIR_DELAY_MS ?? "150",
  10,
);
const MAX = Number.parseInt(process.env.APPR_DIR_MAX ?? "5000", 10);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type Extracted = {
  email: string | null;
  phone: string | null;
  website: string | null;
  headName: string | null;
  standards: number;
};

function parseProviderPage(html: string): Extracted {
  const $ = cheerio.load(html);
  // Each apprenticeship standard is rendered with a "(level X)" marker
  // alongside its title. Counting these is the cleanest size signal we
  // can pull from the gov.uk page.
  const standards = (html.match(/\(level\s+\d+\)/g) ?? []).length;
  const result: Extracted = {
    email: null,
    phone: null,
    website: null,
    headName: null,
    standards,
  };

  // The page uses GOV.UK summary list pattern: <dt>Label</dt><dd>Value</dd>
  $("dt").each((_, el) => {
    const label = $(el).text().trim().toLowerCase();
    const dd = $(el).next("dd");
    if (!dd.length) return;
    const value = dd.text().replace(/\s+/g, " ").trim();
    if (label === "email") {
      const a = dd.find("a[href^='mailto:']").attr("href");
      const fromHref = a
        ? a.replace(/^mailto:/i, "").split("?")[0].trim()
        : null;
      result.email = fromHref ?? value;
    } else if (label === "telephone" || label === "phone") {
      result.phone = value;
    } else if (label === "website") {
      const a = dd.find("a").attr("href");
      result.website = a ?? value;
    } else if (
      label === "principal" ||
      label === "head" ||
      label === "managing director" ||
      label === "chief executive"
    ) {
      result.headName = value;
    }
  });

  return result;
}

export async function ingestApprenticeshipDirectory(): Promise<RunResult> {
  const cohort = await db
    .select({
      id: institutions.id,
      ukprn: institutions.ukprn,
      type: institutions.type,
    })
    .from(institutions)
    .where(
      and(
        eq(institutions.inScope, true),
        isNotNull(institutions.ukprn),
        sql`${institutions.type} IN ('itp','fe_college','sixth_form_college','employer')`,
        // Re-process anything missing key data: contact, website, OR
        // apprenticeship-standards count (size proxy).
        sql`(${institutions.generalEmail} IS NULL OR ${institutions.website} IS NULL OR ${institutions.apprenticeshipStandards} IS NULL OR ${institutions.apprenticeshipStandards} = 0)`,
      ),
    )
    .limit(MAX);

  log.info(
    `apprenticeship_directory: ${cohort.length} ITP/FE/sixth-form to enrich`,
  );

  const limit = pLimit(CONCURRENCY);
  let withEmail = 0;
  let withWebsite = 0;
  let withPhone = 0;
  let processed = 0;

  await Promise.allSettled(
    cohort.map((row) =>
      limit(async () => {
        if (!row.ukprn) return;
        if (FETCH_DELAY_MS > 0) await sleep(FETCH_DELAY_MS);
        try {
          const fetched = await fetchToFile(`${BASE}${row.ukprn}`, {
            subdir: "apprenticeship_directory",
            filenameHint: row.ukprn,
            extension: ".html",
            maxAgeMs: 30 * 24 * 60 * 60 * 1000,
          });
          const html = readFileSync(fetched.localPath, "utf-8");
          if (!/UKPRN\s+\d+|Training provider/i.test(html)) return;
          const x = parseProviderPage(html);

          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (x.email) {
            updates.generalEmail = x.email;
            withEmail++;
          }
          if (x.website) {
            updates.website = x.website;
            withWebsite++;
          }
          if (x.phone) {
            updates.phone = x.phone;
            withPhone++;
          }
          if (x.headName) updates.headName = x.headName;
          if (x.standards > 0) updates.apprenticeshipStandards = x.standards;

          if (Object.keys(updates).length > 1) {
            await db
              .update(institutions)
              .set(updates)
              .where(eq(institutions.id, row.id));
          }
          processed++;
          if (processed % 100 === 0)
            log.info(
              `apprenticeship_directory: ${processed}/${cohort.length} (emails=${withEmail} websites=${withWebsite})`,
            );
        } catch {
          // ignore — 404 means provider isn't on the apprenticeship register
        }
      }),
    ),
  );

  log.info(
    `apprenticeship_directory: complete — emails=${withEmail} websites=${withWebsite} phones=${withPhone} of ${cohort.length}`,
  );

  return {
    recordsSeen: cohort.length,
    recordsUpserted: withEmail + withWebsite,
    notes: `emails=${withEmail} websites=${withWebsite} phones=${withPhone}`,
  };
}
