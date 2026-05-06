/**
 * ISI (Independent Schools Inspectorate) adapter.
 *
 * isi.net's directory at /reports/ is server-rendered HTML with simple
 * `?p=N` pagination — no JS needed. ~1,373 schools across ~138 pages.
 * Each school detail page lists PDFs at reports.isi.net/DownloadReport.aspx.
 *
 * Pipeline:
 *   1. Walk every listing page → list of school slugs
 *   2. For each school, fetch detail page → extract every report PDF URL
 *   3. Match to an existing institution by name + postcode; otherwise create
 *      a new institution sourced from ISI
 *   4. Upsert one inspection per report event with body="isi"
 *   5. Cache PDF, parse via pdf-parse, sectionise, write into the same
 *      tables Ofsted reports use — findings + scoring just work afterwards
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { and, eq, like } from "drizzle-orm";
import { db, inspections, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import { sectionise, hashText } from "../extract/sections";
import type { RunResult } from "./run";

const requireCjs = createRequire(import.meta.url);
type PdfParseFn = (buf: Buffer) => Promise<{ text: string }>;
const pdfParse: PdfParseFn = requireCjs("pdf-parse/lib/pdf-parse.js");

const ISI_BASE = "https://www.isi.net";
const REPORT_HOST = "https://reports.isi.net";

const USER_AGENT =
  process.env.USER_AGENT ??
  "Fledglings-ICP-Bot/1.0 (internal tooling; replace USER_AGENT in .env)";

const ISI_MAX_PAGES = Number.parseInt(process.env.ISI_MAX_PAGES ?? "200", 10);
const ISI_MAX_SCHOOLS = Number.parseInt(
  process.env.ISI_MAX_SCHOOLS ?? "2000",
  10,
);
const ISI_CONCURRENCY = Number.parseInt(
  process.env.ISI_CONCURRENCY ?? "2",
  10,
);

type SchoolListing = {
  slug: string;
  isiId: string;
  name: string;
  address: string | null;
  postcode: string | null;
};

type ReportLink = {
  url: string;
  filename: string;
  date: string | null; // ISO YYYY-MM-DD
  typeCode: string; // e.g. "EQI", "FCI", "ADD", "GRT", "REG"
  inspectionType: string;
};

const TYPE_LABEL: Record<string, string> = {
  EQI: "Educational Quality Inspection",
  FCI: "Focused Compliance Inspection",
  ADD: "Additional Inspection",
  GRT: "Integrated Inspection",
  REG: "Regulatory Compliance",
  ROU: "Routine Inspection",
  IRD: "Initial Registration",
  PRG: "Progress Monitoring",
  PMV: "Progress Monitoring Visit",
  EFD: "Early Findings Visit",
  STD: "Standard Inspection",
  FND: "Findings Update",
};

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return await r.text();
}

function parseListing(html: string): SchoolListing[] {
  const $ = cheerio.load(html);
  const out: SchoolListing[] = [];

  // Each result is <tr class="result" id="school_{ISI_ID}"> with the
  // school name inside <td class="name"> and town inside <td class="location">.
  $("tr.result").each((_, el) => {
    const row = $(el);
    const id = row.attr("id") ?? "";
    const idMatch = id.match(/school_(\d+)/);
    if (!idMatch) return;
    const isiId = idMatch[1];

    const link = row.find("td.name a[href*='institutions/school/']").first();
    const href = link.attr("href") ?? "";
    const slugMatch = href.match(/institutions\/school\/([^/?#]+)/);
    if (!slugMatch) return;
    const slug = slugMatch[1];

    const name = link.text().replace(/\s+/g, " ").trim();
    const location = row
      .find("td.location")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    out.push({
      slug,
      isiId,
      name,
      address: location || null,
      postcode: null, // listing doesn't expose postcode; matched by name only
    });
  });

  return out;
}

function parseDetail(html: string, isiId: string): ReportLink[] {
  const $ = cheerio.load(html);
  const out: ReportLink[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!/reports\.isi\.net\/DownloadReport\.aspx/i.test(href)) return;
    const m = href.match(/r=([A-Z]{2,4})(\d+)_(\d{8})\.pdf/i);
    if (!m) return;
    const [, code, , stamp] = m;
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    out.push({
      url: href.startsWith("http") ? href : `${REPORT_HOST}${href.startsWith("/") ? "" : "/"}${href}`,
      filename: `${code}${isiId}_${stamp}.pdf`,
      date: iso,
      typeCode: code.toUpperCase(),
      inspectionType: TYPE_LABEL[code.toUpperCase()] ?? `${code} inspection`,
    });
  });

  // Latest first.
  out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return out;
}

function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/&/g, "and")
    .replace(/\b(school|college|the|of|and|st\.?)\b/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findOrCreateInstitution(
  school: SchoolListing,
): Promise<number> {
  // Already linked to this ISI ID?
  const direct = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.isiId, school.isiId))
    .limit(1);
  if (direct[0]) return direct[0].id;

  // Try matching to a GIAS independent school by normalised name.
  // Listing pages don't expose postcode, so name-only is what we have.
  const target = normaliseName(school.name);
  if (target.length >= 4) {
    const allInd = await db
      .select({ id: institutions.id, name: institutions.name })
      .from(institutions)
      .where(eq(institutions.type, "independent_school"));
    const match = allInd.find((c) => normaliseName(c.name) === target);
    if (match) {
      await db
        .update(institutions)
        .set({
          isiId: school.isiId,
          source: "gias+isi",
          updatedAt: new Date(),
        })
        .where(eq(institutions.id, match.id));
      return match.id;
    }
  }

  // No match — create new institution (ISI-only).
  const inserted = await db
    .insert(institutions)
    .values({
      isiId: school.isiId,
      name: school.name,
      type: "independent_school",
      phase: "all_through",
      address: school.address,
      postcode: school.postcode,
      inScope: true,
      source: "isi",
    })
    .returning({ id: institutions.id });
  return inserted[0].id;
}

function isPdf(buf: Buffer): boolean {
  return buf.slice(0, 4).toString("ascii") === "%PDF";
}

function cleanPdfText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function processSchool(
  school: SchoolListing,
): Promise<{ inspections: number; parsed: number } | null> {
  let detailHtml: string;
  try {
    const detailUrl = `${ISI_BASE}/institutions/school/${school.slug}`;
    const cached = await fetchToFile(detailUrl, {
      subdir: "isi/detail",
      filenameHint: school.isiId,
      extension: ".html",
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
    });
    detailHtml = readFileSync(cached.localPath, "utf-8");
  } catch (err) {
    log.debug(`isi detail fetch failed for ${school.slug}: ${(err as Error).message}`);
    return null;
  }

  const reports = parseDetail(detailHtml, school.isiId);
  if (!reports.length) return { inspections: 0, parsed: 0 };

  const institutionId = await findOrCreateInstitution(school);

  let inspectionsUpserted = 0;
  let parsedCount = 0;

  for (const report of reports) {
    if (!report.date) continue;

    // Upsert inspection event keyed on (institution, date, body).
    const upserted = await db
      .insert(inspections)
      .values({
        institutionId,
        inspectionBody: "isi",
        framework: "isi_2023",
        inspectionType: report.inspectionType,
        inspectionStartDate: report.date,
        reportUrl: report.url,
      })
      .onConflictDoUpdate({
        target: [
          inspections.institutionId,
          inspections.inspectionStartDate,
          inspections.inspectionBody,
        ],
        set: {
          framework: "isi_2023",
          inspectionType: report.inspectionType,
          reportUrl: report.url,
          updatedAt: new Date(),
        },
      })
      .returning({ id: inspections.id });
    inspectionsUpserted++;

    // Only parse the most recent (first) report's PDF to keep load reasonable.
    if (report !== reports[0]) continue;
    const inspectionId = upserted[0].id;

    try {
      const pdfFetched = await fetchToFile(report.url, {
        subdir: "isi/pdf",
        filenameHint: report.filename.replace(/\.pdf$/i, ""),
        extension: ".pdf",
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      });
      const buffer = readFileSync(pdfFetched.localPath);
      if (!isPdf(buffer)) continue;
      const data = await pdfParse(buffer);
      if (!data.text || data.text.length < 500) continue;
      const text = cleanPdfText(data.text);
      const sections = sectionise(text);

      await db
        .update(inspections)
        .set({
          reportText: text,
          reportTextHash: hashText(text),
          reportPdfPath: pdfFetched.localPath,
          updatedAt: new Date(),
        })
        .where(eq(inspections.id, inspectionId));

      // Replace existing sections for this inspection.
      const { reportSections } = await import("@/db/schema");
      await db
        .delete(reportSections)
        .where(eq(reportSections.inspectionId, inspectionId));
      for (const s of sections) {
        await db.insert(reportSections).values({
          inspectionId,
          sectionKey: s.sectionKey,
          sectionTitle: s.sectionTitle,
          sectionText: s.sectionText,
          multiplier: s.multiplier,
          orderIndex: s.orderIndex,
        });
      }
      parsedCount++;
    } catch (err) {
      log.debug(
        `isi pdf parse failed for ${report.url}: ${(err as Error).message.slice(0, 120)}`,
      );
    }
  }

  return { inspections: inspectionsUpserted, parsed: parsedCount };
}

export async function ingestIsi(): Promise<RunResult> {
  log.info(
    `isi: starting (max_pages=${ISI_MAX_PAGES} max_schools=${ISI_MAX_SCHOOLS} concurrency=${ISI_CONCURRENCY})`,
  );

  // Walk listing pages until a page returns no schools or we hit cap.
  const listings: SchoolListing[] = [];
  for (let page = 1; page <= ISI_MAX_PAGES; page++) {
    let html: string;
    try {
      const url = `${ISI_BASE}/reports/?p=${page}`;
      const cached = await fetchToFile(url, {
        subdir: "isi/listing",
        filenameHint: `p${page}`,
        extension: ".html",
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      });
      html = readFileSync(cached.localPath, "utf-8");
    } catch (err) {
      log.warn(`isi: listing page ${page} failed: ${(err as Error).message}`);
      break;
    }
    const items = parseListing(html);
    if (!items.length) {
      log.info(`isi: listing page ${page} returned no schools — stopping`);
      break;
    }
    listings.push(...items);
    if (page % 20 === 0) {
      log.info(`isi: listing page ${page} → ${listings.length} schools so far`);
    }
    if (listings.length >= ISI_MAX_SCHOOLS) break;
  }

  // Dedupe across pages.
  const seen = new Set<string>();
  const uniqueListings = listings.filter((s) => {
    if (seen.has(s.isiId)) return false;
    seen.add(s.isiId);
    return true;
  });

  log.info(`isi: ${uniqueListings.length} unique schools discovered`);

  const limit = pLimit(ISI_CONCURRENCY);
  let totalInspections = 0;
  let totalParsed = 0;
  let processed = 0;

  await Promise.allSettled(
    uniqueListings.map((school) =>
      limit(async () => {
        const result = await processSchool(school);
        if (result) {
          totalInspections += result.inspections;
          totalParsed += result.parsed;
        }
        processed++;
        if (processed % 50 === 0) {
          log.info(
            `isi: ${processed}/${uniqueListings.length} schools — inspections=${totalInspections} parsed=${totalParsed}`,
          );
        }
      }),
    ),
  );

  log.info(
    `isi: complete — schools=${uniqueListings.length} inspections=${totalInspections} parsed=${totalParsed}`,
  );

  return {
    recordsSeen: uniqueListings.length,
    recordsUpserted: totalInspections,
    notes: `parsed=${totalParsed}; pages_walked<=${ISI_MAX_PAGES}`,
  };
}
