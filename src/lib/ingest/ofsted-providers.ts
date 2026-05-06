/**
 * Discover historical Ofsted inspections for FE colleges, ITPs and sixth
 * form colleges by scraping reports.ofsted.gov.uk provider pages.
 *
 * The Ofsted MI snapshot only contains inspections from the new framework
 * (Nov 2025+), so most FE/ITP institutions have no inspection events at
 * all. Their provider page on reports.ofsted.gov.uk lists every historical
 * inspection PDF with date and headline grade in the link text — perfect
 * for back-filling.
 *
 * Pipeline per institution:
 *   1. Build candidate provider URLs from TYPE_CANDIDATES
 *   2. Walk candidates, take the first 200 OK
 *   3. Cache the HTML, parse PDF links with dates and grades
 *   4. Upsert one inspection event per PDF with body="ofsted"
 *
 * Subsequent runs of `ofsted_reports` parse the actual PDF contents.
 */

import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { and, eq, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db, inspections, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import { normaliseGrade, parseInspectionDate } from "../grades";
import type { RunResult } from "./run";

const TYPE_CANDIDATES: Record<string, number[]> = {
  itp: [33, 31],
  fe_college: [31, 33, 46],
  sixth_form_college: [46, 31, 23],
  independent_school: [21],
  state_school: [23],
};

const ALL_TARGET_TYPES = ["itp", "fe_college", "sixth_form_college"] as const;
const TARGET_TYPES = (process.env.PROVIDER_TYPES
  ? process.env.PROVIDER_TYPES.split(",").map((s) => s.trim())
  : (ALL_TARGET_TYPES as readonly string[])) as readonly string[];

const CONCURRENCY = Number.parseInt(
  process.env.PROVIDER_CONCURRENCY ?? "1",
  10,
);
const MAX_PER_TYPE = Number.parseInt(
  process.env.PROVIDER_MAX_PER_TYPE ?? "1000",
  10,
);
// Politeness delay between fetches in ms. reports.ofsted.gov.uk aggressively
// rate-limits — 800ms is the lowest that survived a full overnight run in
// testing. Override with PROVIDER_DELAY_MS=0 if you have a different IP.
const FETCH_DELAY_MS = Number.parseInt(
  process.env.PROVIDER_DELAY_MS ?? "800",
  10,
);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type ProviderHit = {
  url: string;
  code: number;
  html: string;
};

async function fetchProvider(
  urn: string,
  type: string,
): Promise<ProviderHit | null> {
  const codes = TYPE_CANDIDATES[type] ?? TYPE_CANDIDATES.itp;
  for (const code of codes) {
    const url = `https://reports.ofsted.gov.uk/provider/${code}/${urn}`;
    try {
      const cached = await fetchToFile(url, {
        subdir: "ofsted_providers",
        filenameHint: `${type}-${urn}-${code}`,
        extension: ".html",
        maxAgeMs: 14 * 24 * 60 * 60 * 1000,
      });
      const html = readFileSync(cached.localPath, "utf-8");
      // Provider pages always contain "Inspection report" or
      // "Provider:" header text. 404 pages don't.
      if (!/inspection|provider/i.test(html.slice(0, 4000))) continue;
      // The 404 page also has no PDF links.
      if (!/files\.ofsted\.gov\.uk\/v1\/file\//i.test(html)) continue;
      return { url, code, html };
    } catch {
      // try next code
    }
  }
  return null;
}

type ProviderInspection = {
  reportUrl: string;
  date: string; // ISO YYYY-MM-DD
  inspectionType: string;
  grade: string | null;
};

function parseProviderHtml(html: string): ProviderInspection[] {
  const $ = cheerio.load(html);
  const out: ProviderInspection[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!/files\.ofsted\.gov\.uk\/v1\/file\//i.test(href)) return;
    const linkText = $(el).text().replace(/\s+/g, " ").trim();
    if (!/inspect|report/i.test(linkText)) return;

    // Examples:
    //  "Full inspection: GoodFull inspection, PDF - 08 February 2013"
    //  "School inspection: Requires ImprovementSchool inspection, PDF - 10..."
    //  "Short inspection                Short inspection, PDF - 27 J..."
    //  "Monitoring visit                Monitoring visit, PDF - 12 March 2024"

    const dateMatch = linkText.match(
      /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i,
    );
    const date = dateMatch ? parseInspectionDate(dateMatch[1]) : null;
    if (!date) return;

    const typeMatch = linkText.match(
      /(Full inspection|School inspection|Short inspection|Monitoring visit|Section 5|Section 8|Survey visit|Graded inspection|Ungraded inspection|Standard inspection|Progress monitoring)/i,
    );
    const inspectionType = typeMatch
      ? typeMatch[1]
      : linkText.split(",")[0].trim();

    const gradeMatch = linkText.match(
      /:\s*(Outstanding|Good|Requires Improvement|Inadequate|Special measures|Serious weaknesses|Satisfactory)/i,
    );
    const grade = gradeMatch ? normaliseGrade(gradeMatch[1]) : null;

    const fullUrl = href.startsWith("http")
      ? href
      : `https://reports.ofsted.gov.uk${href.startsWith("/") ? "" : "/"}${href}`;

    out.push({ reportUrl: fullUrl, date, inspectionType, grade });
  });

  // Latest first.
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export async function ingestOfstedProviders(): Promise<RunResult> {
  let totalDiscovered = 0;
  let totalUpserted = 0;
  let totalProvidersHit = 0;

  for (const type of TARGET_TYPES) {
    // Find institutions of this type that don't yet have any inspection.
    const cohort = await db
      .select({
        id: institutions.id,
        urn: institutions.urn,
        ukprn: institutions.ukprn,
      })
      .from(institutions)
      .where(
        and(
          eq(institutions.type, type),
          eq(institutions.inScope, true),
          sql`${institutions.urn} IS NOT NULL OR ${institutions.ukprn} IS NOT NULL`,
        ),
      )
      .limit(MAX_PER_TYPE);

    log.info(`providers: type=${type} candidates=${cohort.length}`);

    const limit = pLimit(CONCURRENCY);
    let typeHit = 0;
    let typeUpserted = 0;

    await Promise.allSettled(
      cohort.map((row) =>
        limit(async () => {
          if (FETCH_DELAY_MS > 0) await sleep(FETCH_DELAY_MS);
          const id = row.urn ?? row.ukprn;
          if (!id) return;
          const hit = await fetchProvider(id, type);
          if (!hit) return;
          typeHit++;

          const provs = parseProviderHtml(hit.html);
          for (const p of provs) {
            await db
              .insert(inspections)
              .values({
                institutionId: row.id,
                inspectionBody: "ofsted",
                framework: type === "itp" ? "feskills" : "eif",
                inspectionType: p.inspectionType,
                inspectionStartDate: p.date,
                reportUrl: p.reportUrl,
                overallGrade: p.grade,
              })
              .onConflictDoUpdate({
                target: [
                  inspections.institutionId,
                  inspections.inspectionStartDate,
                  inspections.inspectionBody,
                ],
                set: {
                  inspectionType: p.inspectionType,
                  reportUrl: p.reportUrl,
                  overallGrade: p.grade ?? undefined,
                  updatedAt: new Date(),
                },
              });
            typeUpserted++;
          }
        }),
      ),
    );

    log.info(
      `providers: type=${type} provider_pages_hit=${typeHit} inspections_upserted=${typeUpserted}`,
    );
    totalProvidersHit += typeHit;
    totalUpserted += typeUpserted;
    totalDiscovered += cohort.length;
  }

  return {
    recordsSeen: totalDiscovered,
    recordsUpserted: totalUpserted,
    notes: `provider_pages=${totalProvidersHit}`,
  };
}
