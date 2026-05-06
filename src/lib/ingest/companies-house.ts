/**
 * Companies House compliance ingest. Uses the free Companies House REST
 * API (https://developer.company-information.service.gov.uk/) to flag
 * financial-health risks on UK ITPs.
 *
 * Auth: HTTP Basic with API key as the username. Rate limit: 600 req per
 * 5-min window per key.
 *
 * Pipeline per ITP:
 *   1. If we don't yet know the company number for this UKPRN, search
 *      `/search/companies?q=<name>` and pick the best match by normalised
 *      name + status (active companies preferred). Cache the resolved
 *      number on `institutions.source` (suffixed) and on a side table…
 *      actually we just persist on `companies_house_lookups`.
 *   2. GET /company/{n} for company_status, accounts.overdue,
 *      confirmation_statement.overdue.
 *   3. GET /company/{n}/insolvency for insolvency cases (404 if none).
 *   4. Map flags into compliance_notices rows.
 *
 * Budget: COMPANIES_HOUSE_BUDGET_PER_RUN env var caps the number of ITPs
 * processed per run. We pick least-recently-checked first so weekly runs
 * eventually cover the whole list.
 */

import { eq, sql } from "drizzle-orm";
import { db, complianceNotices, institutions } from "@/db";
import { log } from "./log";
import type { RunResult } from "./run";

const API_BASE = "https://api.company-information.service.gov.uk";

function authHeader(): string {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error("COMPANIES_HOUSE_API_KEY not set");
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

// Self-throttling: respect the 600/5-min budget. We aim for 100 req/min
// (safe well below ceiling) which is one request every 600ms.
const REQ_INTERVAL_MS = 600;
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = lastRequestAt + REQ_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function chFetch<T>(pathname: string): Promise<T | null> {
  await throttle();
  const r = await fetch(API_BASE + pathname, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (r.status === 404) return null;
  if (r.status === 429) {
    // Back off harder if we hit the rate limit.
    log.warn("companies_house: 429 — backing off 30s");
    await new Promise((res) => setTimeout(res, 30_000));
    return chFetch<T>(pathname);
  }
  if (!r.ok) {
    throw new Error(`Companies House ${pathname} -> HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

type SearchResult = {
  items?: {
    company_number: string;
    title: string;
    company_status: string;
    address_snippet?: string;
    address?: { postal_code?: string };
  }[];
};

type CompanyProfile = {
  company_number: string;
  company_name: string;
  company_status: string;
  company_status_detail?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  accounts?: {
    next_due?: string;
    last_accounts?: { period_end_on?: string };
    overdue?: boolean;
  };
  confirmation_statement?: { next_due?: string; overdue?: boolean };
};

type Insolvency = {
  cases?: { type?: string; dates?: { type?: string; date?: string }[] }[];
};

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(ltd|limited|llp|plc|cic|cio|t\/a)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function findCompanyNumber(
  name: string,
  postcode?: string | null,
): Promise<string | null> {
  const q = encodeURIComponent(name);
  const result = await chFetch<SearchResult>(
    `/search/companies?q=${q}&items_per_page=20`,
  );
  if (!result?.items?.length) return null;

  const target = normName(name);
  const exact = result.items.find((i) => normName(i.title) === target);
  if (exact && exact.company_status === "active") return exact.company_number;
  if (exact) return exact.company_number;

  // Postcode match wins ties
  if (postcode) {
    const postcodeMatch = result.items.find(
      (i) =>
        i.address?.postal_code &&
        i.address.postal_code.replace(/\s/g, "").toUpperCase() ===
          postcode.replace(/\s/g, "").toUpperCase(),
    );
    if (postcodeMatch) return postcodeMatch.company_number;
  }

  // Otherwise pick the active one closest by length
  const active = result.items.filter((i) => i.company_status === "active");
  const candidates = active.length > 0 ? active : result.items;
  candidates.sort(
    (a, b) =>
      Math.abs(normName(a.title).length - target.length) -
      Math.abs(normName(b.title).length - target.length),
  );
  return candidates[0]?.company_number ?? null;
}

function classifyProfile(p: CompanyProfile): { type: string; subject: string }[] {
  const out: { type: string; subject: string }[] = [];
  const status = (p.company_status ?? "").toLowerCase();
  const detail = p.company_status_detail ?? "";
  if (status === "dissolved") {
    out.push({
      type: "companies_house.dissolution",
      subject: `Companies House: dissolved${p.date_of_cessation ? ` ${p.date_of_cessation}` : ""}`,
    });
  } else if (status.includes("liquidation")) {
    out.push({
      type: "companies_house.liquidation",
      subject: `Companies House: in liquidation (${detail || status})`,
    });
  } else if (status.includes("administration")) {
    out.push({
      type: "companies_house.administration",
      subject: `Companies House: in administration (${detail || status})`,
    });
  } else if (status.includes("voluntary-arrangement")) {
    out.push({
      type: "companies_house.administration",
      subject: "Companies House: company voluntary arrangement (CVA)",
    });
  }
  if (p.accounts?.overdue) {
    out.push({
      type: "companies_house.accounts_overdue",
      subject: `Companies House: accounts overdue (next due ${p.accounts.next_due ?? "?"})`,
    });
  }
  if (p.confirmation_statement?.overdue) {
    out.push({
      type: "companies_house.confirmation_overdue",
      subject: `Companies House: confirmation statement overdue (next due ${p.confirmation_statement.next_due ?? "?"})`,
    });
  }
  return out;
}

async function refreshOne(institutionId: number, name: string, postcode: string | null): Promise<{
  resolved: boolean;
  notices: number;
}> {
  const number = await findCompanyNumber(name, postcode);
  if (!number) return { resolved: false, notices: 0 };

  const profile = await chFetch<CompanyProfile>(`/company/${number}`);
  if (!profile) return { resolved: true, notices: 0 };

  const findings = classifyProfile(profile);

  // Insolvency endpoint — 404 when none. Adds a notice if any case present.
  const insolvency = await chFetch<Insolvency>(`/company/${number}/insolvency`);
  if (insolvency?.cases?.length) {
    findings.push({
      type: "companies_house.insolvency",
      subject: `Companies House: ${insolvency.cases.length} insolvency case(s) on file`,
    });
  }

  const sourceUrl = `https://find-and-update.company-information.service.gov.uk/company/${number}`;
  const today = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const f of findings) {
    await db
      .insert(complianceNotices)
      .values({
        institutionId,
        noticeBody: "companies_house",
        noticeType: f.type,
        issuedAt: today,
        severity: severityForCh(f.type),
        subject: f.subject,
        details: `Company ${profile.company_name} (${number}) status=${profile.company_status}${
          profile.company_status_detail ? ` detail=${profile.company_status_detail}` : ""
        }`,
        sourceUrl,
        sourceTitle: "Companies House",
        rawPayload: JSON.stringify({ profile, insolvency }),
      })
      .onConflictDoUpdate({
        target: [
          complianceNotices.institutionId,
          complianceNotices.sourceUrl,
          complianceNotices.noticeType,
        ],
        set: {
          subject: f.subject,
          details: `Company ${profile.company_name} (${number})`,
          lastSeenAt: new Date(),
        },
      });
    written++;
  }
  return { resolved: true, notices: written };
}

function severityForCh(noticeType: string): number {
  switch (noticeType) {
    case "companies_house.insolvency":
    case "companies_house.dissolution":
      return 95;
    case "companies_house.liquidation":
    case "companies_house.administration":
      return 92;
    case "companies_house.accounts_overdue":
      return 70;
    case "companies_house.confirmation_overdue":
      return 60;
    default:
      return 50;
  }
}

export async function ingestCompaniesHouse(): Promise<RunResult> {
  if (!process.env.COMPANIES_HOUSE_API_KEY) {
    log.warn("companies_house: skipped — COMPANIES_HOUSE_API_KEY not set");
    return {
      recordsSeen: 0,
      recordsUpserted: 0,
      notes: "skipped — COMPANIES_HOUSE_API_KEY not set",
    };
  }
  const budget = Number(process.env.COMPANIES_HOUSE_BUDGET_PER_RUN ?? "200");
  if (budget <= 0) {
    log.info("companies_house: budget=0 — skipped");
    return { recordsSeen: 0, recordsUpserted: 0, notes: "budget=0" };
  }

  // Pick ITPs least-recently-checked first. We piggyback on
  // `institutions.updatedAt` for staleness ranking — every other ingest
  // mutates this column, so the longer it's been since we last touched the
  // row the more likely we haven't done a CH check yet.
  const queue = await db
    .select({
      id: institutions.id,
      name: institutions.name,
      postcode: institutions.postcode,
    })
    .from(institutions)
    .where(
      sql`${institutions.type} = 'itp' AND ${institutions.inScope} = 1`,
    )
    .orderBy(sql`${institutions.updatedAt} ASC`)
    .limit(budget);

  let resolved = 0;
  let notices = 0;
  let unresolved = 0;
  for (const itp of queue) {
    try {
      const r = await refreshOne(itp.id, itp.name, itp.postcode);
      if (r.resolved) {
        resolved++;
        notices += r.notices;
      } else {
        unresolved++;
      }
      // Touch updatedAt so next run skips this one
      await db
        .update(institutions)
        .set({ updatedAt: new Date() })
        .where(eq(institutions.id, itp.id));
    } catch (err) {
      log.warn(
        `companies_house: ${itp.name} (#${itp.id}) — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  log.info(
    `companies_house: processed=${queue.length} resolved=${resolved} unresolved=${unresolved} notices=${notices}`,
  );
  return {
    recordsSeen: queue.length,
    recordsUpserted: notices,
    notes: `resolved=${resolved} unresolved=${unresolved}`,
  };
}
