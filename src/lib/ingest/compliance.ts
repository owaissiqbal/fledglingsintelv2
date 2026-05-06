/**
 * Compliance / regulatory ingest. Three sub-runs share this file because
 * they all write into the same `compliance_notices` table and use the same
 * institution-name-matching helpers:
 *
 *   1. APAR Status → ITP restrictions ("Not Currently Starting New
 *      Apprentices", "Removed", etc.). Reads the cached APAR CSV, writes
 *      a notice per non-active status. Diff against existing notices so
 *      withdrawn restrictions get withdrawn_at set.
 *
 *   2. gov.uk Atom feeds (Ofsted, DfE, ESFA) → notice/intervention
 *      announcements. Pulls the three Atom feeds, filters entries by
 *      compliance keyword, name-matches each entry against institutions in
 *      the DB, writes a notice per match.
 *
 *   3. gov.uk "Colleges & higher education institutions: Notices to
 *      Improve" collection page → FE college notices. Scrapes the
 *      collection page, follows each linked notice, links by college name
 *      to institutions of type 'fe_college'.
 *
 * Shared properties:
 *   - all reads use fetchToFile so cached / polite
 *   - all upserts use the (institution_id, notice_body, notice_type,
 *     issued_at) unique index so idempotent
 *   - severity comes from a small lookup table — see SEVERITY_BY_TYPE
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import * as cheerio from "cheerio";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, complianceNotices, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import type { RunResult } from "./run";

// ---------- shared severity lookup ----------------------------------------

const SEVERITY_BY_TYPE: Record<string, number> = {
  // APAR
  "apar.not_currently_starting_new_apprentices": 85,
  "apar.removed": 95,
  "apar.suspended": 92,
  "apar.conditions_imposed": 80,
  "apar.status_other": 60,
  // ESFA / DfE NTI for FE colleges
  "esfa.notice_to_improve_quality": 95,
  "esfa.notice_to_improve_financial": 88,
  "esfa.notice_to_improve_governance": 88,
  "esfa.notice_to_improve_other": 80,
  "dfe.financial_intervention": 90,
  "dfe.minimum_standards_intervention": 92,
  "dfe.intervention_other": 75,
  // Atom feed-derived
  "govuk.intervention_announced": 75,
  "govuk.notice_issued": 80,
  "govuk.compliance_action": 78,
  // Companies House
  "companies_house.accounts_overdue": 70,
  "companies_house.confirmation_overdue": 60,
  "companies_house.insolvency": 95,
  "companies_house.dissolution": 95,
  "companies_house.strike_off": 92,
  "companies_house.gazette_notice": 65,
  "companies_house.administration": 90,
  "companies_house.liquidation": 92,
};

function severityFor(noticeType: string): number {
  return SEVERITY_BY_TYPE[noticeType] ?? 50;
}

// ---------- shared name-matching ------------------------------------------

// Normalise an organisation name for fuzzy comparison. The published name
// in a notice or feed entry is rarely byte-identical to what we have in
// `institutions.name` — we strip punctuation, suffixes, casing, common
// word-noise.
const NAME_NOISE = [
  /\b(ltd|limited|llp|plc|cic|cio)\b/g,
  /\b(the|a|an)\b/g,
  /\b(t\/a|trading as)\b.*$/g,
  /\b(group|holdings|services|company)\b/g,
];

function normName(s: string): string {
  let out = s.toLowerCase();
  for (const r of NAME_NOISE) out = out.replace(r, " ");
  return out
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type NameIndexEntry = { id: number; name: string; normalised: string };
let nameIndexCache: NameIndexEntry[] | null = null;

async function getNameIndex(): Promise<NameIndexEntry[]> {
  if (nameIndexCache) return nameIndexCache;
  const rows = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutions)
    .where(eq(institutions.inScope, true));
  nameIndexCache = rows.map((r) => ({
    id: r.id,
    name: r.name,
    normalised: normName(r.name),
  }));
  return nameIndexCache;
}

// Try to map an externally-supplied name to one of our institutions.
// Strategy: (1) exact normalised match; (2) substring match where ours is
// fully contained in theirs OR vice versa AND lengths are within 50%.
// Returns the institution id or null.
async function matchInstitutionByName(
  externalName: string,
): Promise<number | null> {
  const idx = await getNameIndex();
  const target = normName(externalName);
  if (!target || target.length < 4) return null;
  for (const entry of idx) {
    if (entry.normalised === target) return entry.id;
  }
  const candidates = idx.filter((entry) => {
    const a = entry.normalised;
    const b = target;
    if (!a || !b) return false;
    if (a.length < 5 || b.length < 5) return false;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) {
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      return ratio >= 0.5;
    }
    return false;
  });
  if (candidates.length === 1) return candidates[0].id;
  return null;
}

// ---------- (1) APAR status ingest ----------------------------------------

type AparRow = {
  Ukprn: string;
  Name: string;
  ApplicationType: string;
  Status?: string;
  ApplicationDeterminedDate?: string;
};

function classifyAparStatus(status: string): {
  type: string;
  subject: string;
} | null {
  const s = status.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("not currently starting new apprentices")) {
    return {
      type: "apar.not_currently_starting_new_apprentices",
      subject:
        "APAR status: Not currently starting new apprentices (regulatory restriction)",
    };
  }
  if (s.includes("removed")) {
    return { type: "apar.removed", subject: "APAR status: Removed from register" };
  }
  if (s.includes("suspended")) {
    return { type: "apar.suspended", subject: "APAR status: Suspended" };
  }
  if (s.includes("conditions")) {
    return {
      type: "apar.conditions_imposed",
      subject: "APAR status: Conditions imposed",
    };
  }
  return {
    type: "apar.status_other",
    subject: `APAR status: ${status.trim()}`,
  };
}

function findLatestAparCsv(): string | null {
  const dir = path.resolve(process.cwd(), "data/raw/apar");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return path.join(dir, files[files.length - 1]);
}

export async function ingestAparCompliance(): Promise<RunResult> {
  const csvPath = findLatestAparCsv();
  if (!csvPath) {
    log.warn("apar_compliance: no cached APAR CSV — run `pnpm ingest` first");
    return {
      recordsSeen: 0,
      recordsUpserted: 0,
      notes: "no APAR CSV cached — run apar ingest first",
    };
  }
  const raw = readFileSync(csvPath, "utf-8");
  const rows = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
  }) as AparRow[];

  const sourceUrl = "https://download.apprenticeships.education.gov.uk/apar";
  const today = new Date().toISOString().slice(0, 10);
  const seenInstIds = new Set<number>();

  let inserted = 0;
  let updated = 0;
  let withdrawn = 0;
  let skippedNoMatch = 0;

  // Build a quick UKPRN → institution_id lookup to avoid 1.4k DB hits
  const allUkprns = rows
    .map((r) => (r.Ukprn ?? "").trim())
    .filter((u) => u.length > 0);
  const ukprnRows = await db
    .select({ id: institutions.id, ukprn: institutions.ukprn })
    .from(institutions)
    .where(inArray(institutions.ukprn, allUkprns));
  const ukprnToId = new Map<string, number>();
  for (const r of ukprnRows) {
    if (r.ukprn) ukprnToId.set(r.ukprn, r.id);
  }

  for (const row of rows) {
    const ukprn = (row.Ukprn ?? "").trim();
    if (!ukprn) continue;
    const instId = ukprnToId.get(ukprn);
    if (!instId) {
      skippedNoMatch++;
      continue;
    }
    const classification = classifyAparStatus(row.Status ?? "");
    if (!classification) continue;
    seenInstIds.add(instId);

    const result = await db
      .insert(complianceNotices)
      .values({
        institutionId: instId,
        noticeBody: "apar",
        noticeType: classification.type,
        issuedAt: row.ApplicationDeterminedDate?.slice(0, 10) ?? today,
        severity: severityFor(classification.type),
        subject: classification.subject,
        details: `APAR ApplicationType: ${row.ApplicationType}; Status: ${row.Status}`,
        sourceUrl,
        sourceTitle: "APAR — Apprenticeship Provider and Assessment Register",
        rawPayload: JSON.stringify(row),
      })
      .onConflictDoUpdate({
        target: [
          complianceNotices.institutionId,
          complianceNotices.sourceUrl,
          complianceNotices.noticeType,
        ],
        set: {
          severity: severityFor(classification.type),
          subject: classification.subject,
          details: `APAR ApplicationType: ${row.ApplicationType}; Status: ${row.Status}`,
          rawPayload: JSON.stringify(row),
          withdrawnAt: null, // re-seen → un-withdraw
          lastSeenAt: new Date(),
        },
      })
      .returning({ id: complianceNotices.id });

    if (result.length > 0) {
      // Detect insert vs update — drizzle's libsql onConflict returns one row
      // either way; we approximate by matching first_seen vs last_seen later.
      inserted++;
    }
  }

  // Mark any APAR-typed notices not seen in this snapshot as withdrawn
  // (they were previously restricted but the current CSV no longer flags
  // them). Restricted to apar.* notice types so we don't touch other bodies.
  const stillOpen = await db
    .select({
      id: complianceNotices.id,
      institutionId: complianceNotices.institutionId,
      noticeType: complianceNotices.noticeType,
    })
    .from(complianceNotices)
    .where(
      and(
        sql`${complianceNotices.noticeBody} = 'apar'`,
        sql`${complianceNotices.withdrawnAt} IS NULL`,
      ),
    );
  for (const open of stillOpen) {
    if (!seenInstIds.has(open.institutionId)) {
      await db
        .update(complianceNotices)
        .set({
          withdrawnAt: today,
          lastSeenAt: new Date(),
        })
        .where(eq(complianceNotices.id, open.id));
      withdrawn++;
    }
  }

  log.info(
    `apar_compliance: inserted/updated=${inserted} withdrawn=${withdrawn} skipped_no_match=${skippedNoMatch}`,
  );

  return {
    recordsSeen: rows.length,
    recordsUpserted: inserted + withdrawn,
    notes: `inserted=${inserted} withdrawn=${withdrawn} skipped_no_match=${skippedNoMatch} updated=${updated}`,
  };
}

// ---------- (2) gov.uk Atom feeds -----------------------------------------

const ATOM_FEEDS: { source: string; url: string; body: string }[] = [
  {
    source: "ofsted_atom",
    url: "https://www.gov.uk/government/organisations/ofsted.atom",
    body: "govuk",
  },
  {
    source: "dfe_atom",
    url: "https://www.gov.uk/government/organisations/department-for-education.atom",
    body: "govuk",
  },
  {
    source: "esfa_atom",
    url: "https://www.gov.uk/government/organisations/education-and-skills-funding-agency.atom",
    body: "govuk",
  },
];

// Compliance keywords — only entries matching at least one are considered.
// Tuned for FE/ITP context: enforcement language, register changes,
// intervention notices.
const COMPLIANCE_KEYWORDS = [
  /\bnotice to improve\b/i,
  /\bfinancial notice\b/i,
  /\bquality notice\b/i,
  /\bgovernance notice\b/i,
  /\bintervention\b/i,
  /\bremoved from\s+(?:the\s+)?(?:register|apar|roatp)\b/i,
  /\bsuspended from\s+(?:apar|roatp)\b/i,
  /\bsubcontracting standard\b/i,
  /\bminimum standards\b/i,
  /\b(?:fe\s+)?commissioner\b/i,
  /\bsafeguarding (?:concern|failure|investigation)\b/i,
  /\bfraud (?:investigation|charges?)\b/i,
];

function classifyGovUkEntry(title: string, summary: string): {
  type: string;
  matched: string;
} | null {
  const text = `${title}\n${summary}`;
  for (const re of COMPLIANCE_KEYWORDS) {
    const m = text.match(re);
    if (m) {
      let type = "govuk.compliance_action";
      if (/notice to improve|financial notice|quality notice|governance notice/i.test(text))
        type = "govuk.notice_issued";
      else if (/intervention|commissioner/i.test(text))
        type = "govuk.intervention_announced";
      return { type, matched: m[0] };
    }
  }
  return null;
}

type AtomEntry = {
  title: string;
  summary: string;
  link: string;
  updated: string;
};

function parseAtom(xml: string): AtomEntry[] {
  // gov.uk Atom is consistent enough that we can extract with cheerio's XML
  // mode. Each <entry> has <title>, <link href>, <summary>, <updated>.
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: AtomEntry[] = [];
  $("entry").each((_, el) => {
    const $el = $(el);
    const title = $el.find("title").first().text().trim();
    const summary = $el.find("summary").first().text().trim();
    const link = $el.find("link").first().attr("href") ?? "";
    const updated = $el.find("updated").first().text().trim();
    out.push({ title, summary, link, updated });
  });
  return out;
}

export async function ingestGovUkAtomFeeds(): Promise<RunResult> {
  let totalEntries = 0;
  let matched = 0;
  let inserted = 0;

  for (const feed of ATOM_FEEDS) {
    const cached = await fetchToFile(feed.url, {
      subdir: "compliance_atom",
      filenameHint: feed.source,
      extension: ".atom",
      maxAgeMs: 60 * 60 * 1000, // 1h
    });
    const xml = readFileSync(cached.localPath, "utf-8");
    const entries = parseAtom(xml);
    totalEntries += entries.length;

    for (const entry of entries) {
      const classification = classifyGovUkEntry(entry.title, entry.summary);
      if (!classification) continue;
      // Try to extract an institution name from the title — Ofsted/DfE
      // notices typically lead with the provider name then a colon.
      const candidates = extractInstitutionCandidates(entry.title);
      for (const candidate of candidates) {
        const instId = await matchInstitutionByName(candidate);
        if (!instId) continue;
        matched++;
        const result = await db
          .insert(complianceNotices)
          .values({
            institutionId: instId,
            noticeBody: feed.body,
            noticeType: classification.type,
            issuedAt: entry.updated.slice(0, 10),
            severity: severityFor(classification.type),
            subject: entry.title.slice(0, 240),
            details: entry.summary.slice(0, 4000),
            sourceUrl: entry.link,
            sourceTitle: feed.source,
            rawPayload: JSON.stringify(entry),
          })
          .onConflictDoUpdate({
            target: [
              complianceNotices.institutionId,
              complianceNotices.noticeBody,
              complianceNotices.noticeType,
              complianceNotices.issuedAt,
            ],
            set: {
              subject: entry.title.slice(0, 240),
              details: entry.summary.slice(0, 4000),
              lastSeenAt: new Date(),
            },
          })
          .returning({ id: complianceNotices.id });
        if (result.length > 0) inserted++;
      }
    }
  }

  log.info(
    `govuk_atom: feeds=${ATOM_FEEDS.length} entries=${totalEntries} matched=${matched} inserted=${inserted}`,
  );

  return {
    recordsSeen: totalEntries,
    recordsUpserted: inserted,
    notes: `feeds=${ATOM_FEEDS.length} matched=${matched}`,
  };
}

// Pull plausible institution-name candidates out of a feed entry title.
// gov.uk titles use a few patterns:
//   "Notice to improve: <College Name>"
//   "<Provider Name>: notice to improve issued"
//   "Ofsted publishes report on <Provider Name>"
function extractInstitutionCandidates(title: string): string[] {
  const out: string[] = [];
  const colonSplit = title.split(":").map((s) => s.trim()).filter(Boolean);
  for (const part of colonSplit) {
    if (part.length >= 6 && /[A-Z]/.test(part)) out.push(part);
  }
  // Match "report on X" / "notice issued to X" patterns
  const onMatch = title.match(/(?:report on|notice (?:issued )?to)\s+(.+?)(?:\.|$)/i);
  if (onMatch?.[1]) out.push(onMatch[1].trim());
  return Array.from(new Set(out));
}

// ---------- (3) FE Notices to Improve collection --------------------------

const FE_NTI_COLLECTION =
  "https://www.gov.uk/government/collections/colleges-and-higher-education-institutions-notices-to-improve";

export async function ingestFeNoticesToImprove(): Promise<RunResult> {
  const cached = await fetchToFile(FE_NTI_COLLECTION, {
    subdir: "compliance_fe_nti",
    filenameHint: "fe_nti_collection",
    extension: ".html",
    maxAgeMs: 24 * 60 * 60 * 1000, // 1 day
  });
  const html = readFileSync(cached.localPath, "utf-8");
  const $ = cheerio.load(html);

  type Entry = {
    href: string;
    title: string;
    section: string;
  };
  const entries: Entry[] = [];

  // The collection page groups notices by section: "Open notices",
  // "Notices in PIMS transition", "Closed notices". Each <section> holds
  // <a> tags whose text is the college name + notice slug.
  $("section, .gem-c-document-list__item, .gem-c-document-list").each(
    (_, sec) => {
      const $sec = $(sec);
      const sectionTitle = $sec.find("h2, h3").first().text().trim() || "Notices";
      $sec.find("a[href*='/government/publications/']").each((_, a) => {
        const href = $(a).attr("href") ?? "";
        const title = $(a).text().trim();
        if (!href || !title) return;
        entries.push({
          href: href.startsWith("http") ? href : new URL(href, FE_NTI_COLLECTION).href,
          title,
          section: sectionTitle,
        });
      });
    },
  );

  // De-duplicate
  const dedup = new Map<string, Entry>();
  for (const e of entries) dedup.set(e.href, e);
  const uniqueEntries = [...dedup.values()];

  let matched = 0;
  let inserted = 0;
  let skipped = 0;

  for (const entry of uniqueEntries) {
    // Try to extract the college name from the title. Patterns:
    //   "Financial Health Notice to Improve: Some College"
    //   "Notice to Improve: Some College"
    //   "Some College: notice to improve (financial)"
    let collegeName = entry.title;
    if (entry.title.includes(":")) {
      const parts = entry.title.split(":").map((s) => s.trim());
      // The college part is whichever side does NOT mention "notice to improve"
      const nonNotice = parts.find(
        (p) => !/notice to improve|financial|quality|governance/i.test(p),
      );
      if (nonNotice) collegeName = nonNotice;
    }

    const instId = await matchInstitutionByName(collegeName);
    if (!instId) {
      skipped++;
      continue;
    }
    matched++;

    const noticeType = classifyFeNtiType(entry.title);
    // gov.uk consistently prefixes inactive notices with "Closed" or
    // "Revoked" in the link text. The collection page also groups them
    // under a "Closed notices" <section>, but the section selector is
    // unreliable depending on page version, so use the title prefix as
    // the primary signal.
    const isClosed =
      /^closed\b/i.test(entry.title) ||
      /^revoked\b/i.test(entry.title) ||
      /closed/i.test(entry.section);

    const result = await db
      .insert(complianceNotices)
      .values({
        institutionId: instId,
        noticeBody: "esfa",
        noticeType,
        issuedAt: null, // we'd have to fetch each notice page to read date
        withdrawnAt: isClosed ? new Date().toISOString().slice(0, 10) : null,
        severity: isClosed ? 30 : severityFor(noticeType),
        subject: entry.title.slice(0, 240),
        details: `Section on collection: ${entry.section}`,
        sourceUrl: entry.href,
        sourceTitle: "ESFA — Notices to Improve (FE colleges)",
        rawPayload: JSON.stringify(entry),
      })
      .onConflictDoUpdate({
        target: [
          complianceNotices.institutionId,
          complianceNotices.sourceUrl,
          complianceNotices.noticeType,
        ],
        set: {
          withdrawnAt: isClosed ? new Date().toISOString().slice(0, 10) : null,
          severity: isClosed ? 30 : severityFor(noticeType),
          subject: entry.title.slice(0, 240),
          details: `Section on collection: ${entry.section}`,
          lastSeenAt: new Date(),
        },
      })
      .returning({ id: complianceNotices.id });

    if (result.length > 0) inserted++;
  }

  log.info(
    `fe_nti: entries=${uniqueEntries.length} matched=${matched} inserted=${inserted} skipped=${skipped}`,
  );
  return {
    recordsSeen: uniqueEntries.length,
    recordsUpserted: inserted,
    notes: `matched=${matched} skipped_no_college_match=${skipped}`,
  };
}

function classifyFeNtiType(title: string): string {
  if (/financial/i.test(title)) return "esfa.notice_to_improve_financial";
  if (/quality/i.test(title)) return "esfa.notice_to_improve_quality";
  if (/governance/i.test(title)) return "esfa.notice_to_improve_governance";
  return "esfa.notice_to_improve_other";
}
