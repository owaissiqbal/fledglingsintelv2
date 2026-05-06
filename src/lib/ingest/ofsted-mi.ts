/**
 * Ofsted Management Information adapter.
 *
 * State-funded schools snapshot publishes a single "latest inspections" CSV
 * which now (post-Nov 2025) carries the new "report card" thematic standards
 * for newly-inspected schools, plus an OEIF (old EIF) date column for
 * everything inspected before the framework changed. We treat each row with
 * any inspection date as an inspection event so the downstream report
 * fetcher has a URL to walk.
 *
 * Further Education & Skills publishes two CSVs on the periodic-MI page:
 *   - a registry of all providers (no inspection details)
 *   - a list of recent inspection events
 * We process both. The registry creates institutions for ITPs not in GIAS;
 * the events file populates `inspections`.
 */

import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import * as cheerio from "cheerio";
import { eq } from "drizzle-orm";
import { db, inspections, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import {
  isOfstedGradeDrop,
  normaliseGrade,
  parseBoolean,
  parseInspectionDate,
} from "../grades";
import type { RunResult } from "./run";

const SCHOOLS_PAGE =
  process.env.OFSTED_MI_SCHOOLS_PAGE ??
  "https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes";
const FE_PAGE =
  process.env.OFSTED_MI_FE_PAGE ??
  "https://www.gov.uk/government/collections/further-education-and-skills-inspection-outcomes";

const USER_AGENT =
  process.env.USER_AGENT ??
  "Fledglings-ICP-Bot/1.0 (internal tooling; replace USER_AGENT in .env)";

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return await r.text();
}

async function findLatestSchoolsCsv(): Promise<string> {
  if (process.env.OFSTED_MI_SCHOOLS_URL) return process.env.OFSTED_MI_SCHOOLS_URL;
  const html = await fetchHtml(SCHOOLS_PAGE);
  const $ = cheerio.load(html);
  for (const el of $("a").toArray()) {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim();
    if (!href.endsWith(".csv")) continue;
    if (!/state-funded.*latest|latest.*state-funded/i.test(text + " " + href))
      continue;
    return href.startsWith("http") ? href : new URL(href, SCHOOLS_PAGE).href;
  }
  throw new Error(
    `No state-funded schools 'latest inspections' CSV found on ${SCHOOLS_PAGE}.`,
  );
}

async function findLatestFeUrls(): Promise<string[]> {
  if (process.env.OFSTED_MI_FE_URL) return [process.env.OFSTED_MI_FE_URL];

  const collection = await fetchHtml(FE_PAGE);
  const $col = cheerio.load(collection);
  let miPage: string | null = null;
  for (const el of $col("a").toArray()) {
    const href = $col(el).attr("href") ?? "";
    const text = $col(el).text().toLowerCase();
    if (
      /management.*information.*from/i.test(text) &&
      href.includes("statistical-data-sets")
    ) {
      miPage = href.startsWith("http") ? href : new URL(href, FE_PAGE).href;
      break;
    }
  }
  if (!miPage) {
    log.warn("ofsted_mi: could not locate FE & Skills MI page on collection");
    return [];
  }

  const miHtml = await fetchHtml(miPage);
  const $mi = cheerio.load(miHtml);
  const urls: string[] = [];
  for (const el of $mi("a").toArray()) {
    const href = $mi(el).attr("href") ?? "";
    const text = $mi(el).text().toLowerCase();
    if (!href.endsWith(".csv")) continue;
    if (!/further education/i.test(text)) continue;
    const full = href.startsWith("http") ? href : new URL(href, miPage).href;
    if (!urls.includes(full)) urls.push(full);
  }

  // First two = the latest pair (registry + events). Older periods follow.
  return urls.slice(0, 2);
}

type Row = Record<string, string>;

function pickRow(row: Row, ...candidates: string[]): string | null {
  const lowerKeys: Record<string, string> = {};
  for (const k of Object.keys(row)) {
    const norm = k.toLowerCase().replace(/\s+/g, " ").trim();
    lowerKeys[norm] = k;
  }
  for (const c of candidates) {
    const key = lowerKeys[c.toLowerCase().replace(/\s+/g, " ").trim()];
    if (
      key &&
      row[key] != null &&
      row[key] !== "" &&
      row[key] !== "NULL"
    )
      return row[key];
  }
  return null;
}

async function lookupInstitutionId(opts: {
  urn?: string | null;
  ukprn?: string | null;
}): Promise<number | null> {
  if (opts.urn) {
    const found = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.urn, opts.urn))
      .limit(1);
    if (found[0]) return found[0].id;
  }
  if (opts.ukprn) {
    const found = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.ukprn, opts.ukprn))
      .limit(1);
    if (found[0]) return found[0].id;
  }
  return null;
}

async function ingestCsv(opts: {
  url: string;
  body: "ofsted";
  framework: string;
  isFe: boolean;
}): Promise<{ seen: number; upserted: number; skipped: number; institutionsCreated: number }> {
  const cached = await fetchToFile(opts.url, {
    subdir: "ofsted_mi",
    filenameHint: opts.isFe ? "fe" : "schools",
    extension: ".csv",
    maxAgeMs: 24 * 60 * 60 * 1000,
  });

  const raw = readFileSync(cached.localPath, "utf-8");
  const rows = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
  }) as Row[];

  log.info(
    `ofsted_mi: parsed ${rows.length.toLocaleString()} rows from ${opts.isFe ? "FE/Skills" : "state schools"} CSV`,
  );

  let seen = 0;
  let upserted = 0;
  let skipped = 0;
  let institutionsCreated = 0;

  for (const row of rows) {
    seen++;

    const urn = pickRow(row, "URN", "Provider URN");
    const ukprn = pickRow(row, "UKPRN", "Provider UKPRN");
    if (!urn && !ukprn) {
      skipped++;
      continue;
    }

    let institutionId = await lookupInstitutionId({ urn, ukprn });

    if (!institutionId && opts.isFe) {
      const name =
        pickRow(row, "Provider name", "School name") ?? `UKPRN ${ukprn ?? urn}`;
      const region = pickRow(row, "Region", "Government office region (GOR)");
      const la = pickRow(row, "Local authority");
      const providerType = (pickRow(row, "Provider type") ?? "").toLowerCase();
      const type = providerType.includes("independent")
        ? "itp"
        : providerType.includes("college")
          ? "fe_college"
          : "itp";
      const inserted = await db
        .insert(institutions)
        .values({
          urn: urn ?? null,
          ukprn: ukprn ?? null,
          name,
          type,
          phase: "16 plus",
          region,
          localAuthority: la,
          inScope: true,
          source: "ofsted_mi_fe",
        })
        .onConflictDoNothing()
        .returning({ id: institutions.id });
      if (inserted[0]) {
        institutionId = inserted[0].id;
        institutionsCreated++;
      } else {
        institutionId = await lookupInstitutionId({ urn, ukprn });
      }
    }

    if (!institutionId) {
      skipped++;
      continue;
    }

    const inspectionDate = parseInspectionDate(
      pickRow(
        row,
        "Inspection start date",
        "Inspection start date of latest OEIF graded inspection",
        "First day of inspection",
        "Inspection date",
        "Date of latest section 5 inspection",
        "Latest inspection start date",
        "Latest inspection date",
      ),
    );

    if (!inspectionDate) {
      // Registry row with no inspection event — institution row was upserted above; nothing more to do.
      skipped++;
      continue;
    }

    let reportUrl =
      pickRow(
        row,
        "Web Link",
        "Web Link (opens in new window)",
        "URL",
        "Inspection URL",
        "Web link to latest report",
        "Latest inspection web link",
      ) ?? "";
    // Normalise legacy http -> https
    if (reportUrl.startsWith("http://")) {
      reportUrl = "https://" + reportUrl.slice(7);
    }
    // FE/Skills CSV doesn't carry a Web Link. Synthesise the modern provider
    // URL so resolveReportUrl + the fetcher have something to work with.
    // Use URN by default (Ofsted's reports site keys on URN, not UKPRN).
    if (!reportUrl) {
      const id = urn ?? ukprn;
      if (id) {
        // 33 = Independent Learning Providers (most FE-MI rows are ITPs).
        // FE colleges show up under 31; resolveReportUrl will swap if needed.
        const code = opts.isFe ? 33 : 23;
        reportUrl = `https://reports.ofsted.gov.uk/provider/${code}/${id}`;
      }
    }

    // Sub-judgements: try every alias for both legacy EIF and the new
    // post-Nov-2025 report-card columns, plus FE/Skills events labels.
    const qoe = normaliseGrade(
      pickRow(
        row,
        "Quality of education",
        "Curriculum and teaching",
        "Education programmes for young people - achievement",
        "Education programmes for young people -  curriculum teaching and training",
      ),
    );
    const ba = normaliseGrade(
      pickRow(
        row,
        "Behaviour and attitudes",
        "Behaviour & attitudes",
        "Attendance and behaviour",
        "Inclusion",
      ),
    );
    const pd = normaliseGrade(
      pickRow(
        row,
        "Personal development",
        "Personal development and wellbeing",
        "Education programmes for young people - participation and development",
      ),
    );
    const lm = normaliseGrade(
      pickRow(
        row,
        "Leadership and management",
        "Leadership and governance",
        "Contribution to meeting skills needs",
      ),
    );
    const sf = normaliseGrade(pickRow(row, "Sixth form provision"));
    const apprenticeships = normaliseGrade(
      pickRow(
        row,
        "Apprenticeships",
        "Apprenticeship provision",
        "Apprenticeships -  achievement",
        "Apprenticeships - participation and development",
      ),
    );
    const adult = normaliseGrade(
      pickRow(
        row,
        "Adult learning programmes",
        "Adult learning",
        "Adult learning programmes - achievement",
        "Adult learning programmes - participation and development",
      ),
    );

    // Overall effectiveness: legacy column first, then synthesise from the
    // worst sub-judgement on the new framework (where there's no single
    // overall grade — the report card just lists thematic standards).
    const SUB_RANK: Record<string, number> = {
      outstanding: 1,
      good: 2,
      requires_improvement: 3,
      inadequate: 4,
      meets_standard: 2,
      does_not_meet_standard: 4,
    };
    const candidates = [qoe, ba, pd, lm, apprenticeships, adult].filter(
      (g): g is string => g != null && SUB_RANK[g] != null,
    );
    const synthesised =
      candidates.length > 0
        ? candidates.reduce((worst, g) =>
            SUB_RANK[g] > SUB_RANK[worst] ? g : worst,
          )
        : null;
    const overall =
      normaliseGrade(
        pickRow(
          row,
          "Overall effectiveness",
          "Latest inspection overall effectiveness",
          "Overall Effectiveness",
        ),
      ) ?? synthesised;

    const previous = normaliseGrade(
      pickRow(
        row,
        "Previous full inspection overall effectiveness",
        "Previous overall effectiveness",
        "Previous full inspection grade",
      ),
    );
    const dropped = isOfstedGradeDrop(overall, previous);

    const safeguarding =
      parseBoolean(pickRow(row, "Safeguarding is effective")) ??
      (pickRow(row, "Safeguarding standards") === "Met"
        ? true
        : pickRow(row, "Safeguarding standards") === "Not met"
          ? false
          : null);

    // Post-Nov-2025 Ofsted "report card" thematic standards
    const inclusion = normaliseGrade(pickRow(row, "Inclusion"));
    const attendanceBehaviour = normaliseGrade(
      pickRow(row, "Attendance and behaviour"),
    );
    const personalDevWellbeing = normaliseGrade(
      pickRow(row, "Personal development and wellbeing"),
    );
    const achievement = normaliseGrade(
      pickRow(
        row,
        "Achievement",
        "Education programmes for young people - achievement",
      ),
    );
    const curriculumTeaching = normaliseGrade(
      pickRow(
        row,
        "Curriculum and teaching",
        "Education programmes for young people -  curriculum teaching and training",
      ),
    );

    // Ofsted FE & Skills judgement areas
    const youngPeoples = normaliseGrade(
      pickRow(
        row,
        "Education programmes for young people",
        "Education programmes for young people - participation and development",
      ),
    );
    const highNeeds = normaliseGrade(
      pickRow(
        row,
        "Provision for learners and apprentices with high needs",
        "Provision for learners with high needs - achievement",
        "Provision for learners with high needs - participation and development",
      ),
    );
    const contributionToSkills = normaliseGrade(
      pickRow(row, "Contribution to meeting skills needs"),
    );
    const inspectionType = pickRow(
      row,
      "Inspection type",
      "Latest inspection type",
      "Event type grouping",
    );

    const publicationDate = parseInspectionDate(
      pickRow(row, "Publication date", "Date published"),
    );

    const inspectionRow = {
      institutionId,
      inspectionBody: opts.body,
      framework: opts.framework,
      inspectionType,
      inspectionStartDate: inspectionDate,
      publicationDate,
      reportUrl:
        reportUrl ||
        `https://reports.ofsted.gov.uk/provider/-/${urn ?? ukprn}`,
      overallGrade: overall,
      qualityOfEducation: qoe,
      behaviourAttitudes: ba,
      personalDevelopment: pd,
      leadershipManagement: lm,
      sixthFormProvision: sf,
      apprenticeships,
      adultLearningProgrammes: adult,
      safeguardingEffective: safeguarding,
      inclusion,
      attendanceBehaviour,
      personalDevWellbeing,
      achievement,
      curriculumTeaching,
      youngPeoplesProvision: youngPeoples,
      highNeedsProvision: highNeeds,
      contributionToSkills,
      previousOverallGrade: previous,
      gradeDropped: dropped,
    };
    await db
      .insert(inspections)
      .values(inspectionRow)
      .onConflictDoUpdate({
        target: [
          inspections.institutionId,
          inspections.inspectionStartDate,
          inspections.inspectionBody,
        ],
        set: { ...inspectionRow, updatedAt: new Date() },
      });
    upserted++;
  }

  return { seen, upserted, skipped, institutionsCreated };
}

export async function ingestOfstedMi(opts: {
  refresh?: boolean;
} = {}): Promise<RunResult> {
  let totalSeen = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalCreated = 0;
  const notes: string[] = [];

  try {
    const url = await findLatestSchoolsCsv();
    log.info(`ofsted_mi: schools URL -> ${url}`);
    const r = await ingestCsv({
      url,
      body: "ofsted",
      framework: "eif_2024",
      isFe: false,
    });
    totalSeen += r.seen;
    totalUpserted += r.upserted;
    totalSkipped += r.skipped;
    notes.push(`schools: upserted=${r.upserted} skipped=${r.skipped}`);
  } catch (err) {
    log.error(`ofsted_mi: schools failed — ${(err as Error).message}`);
    notes.push(`schools: failed (${(err as Error).message})`);
  }

  try {
    const feUrls = await findLatestFeUrls();
    log.info(`ofsted_mi: FE URLs -> ${feUrls.length} candidate(s)`);
    for (const url of feUrls) {
      log.info(`ofsted_mi: FE -> ${url}`);
      const r = await ingestCsv({
        url,
        body: "ofsted",
        framework: "feskills_2022",
        isFe: true,
      });
      totalSeen += r.seen;
      totalUpserted += r.upserted;
      totalSkipped += r.skipped;
      totalCreated += r.institutionsCreated;
      notes.push(
        `fe: upserted=${r.upserted} created=${r.institutionsCreated} skipped=${r.skipped}`,
      );
    }
  } catch (err) {
    log.error(`ofsted_mi: FE failed — ${(err as Error).message}`);
    notes.push(`fe: failed (${(err as Error).message})`);
  }

  return {
    recordsSeen: totalSeen,
    recordsUpserted: totalUpserted,
    notes:
      notes.join("; ") +
      ` total: skipped=${totalSkipped} createdInstitutions=${totalCreated}`,
  };
}
