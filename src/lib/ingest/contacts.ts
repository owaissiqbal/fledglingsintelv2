/**
 * Contact email enrichment by lightweight website scraping.
 *
 * For each in-scope institution that has a website but no general/head
 * email, fetch the homepage + /contact + /contact-us, find every
 * `mailto:` link or bare email pattern on the institution's own domain,
 * and store the best match.
 *
 * Preference order (most generic mailbox first to avoid pestering
 * named individuals without a lawful basis):
 *   admissions@ > enquiries@ > info@ > contact@ > office@ > head@ > admin@
 *
 * GDPR note: generic mailboxes aren't personal data. Named-individual
 * emails (e.g. j.smith@school.ac.uk) are; we still capture them but the
 * UI / CSV export should treat them with care and apply a PECR-friendly
 * legitimate-interest notice in any first-touch outreach.
 *
 * Scoped to top-tier institutions (critical/high) by default to keep the
 * scrape footprint small. Run with CONTACTS_ALL_TIERS=1 to enrich
 * everything in scope (slower, ~hours for 6k sites).
 */

import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, institutions, opportunityScores } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import { readFileSync } from "node:fs";
import type { RunResult } from "./run";

const USER_AGENT =
  process.env.USER_AGENT ??
  "Fledglings-ICP-Bot/1.0 (internal tooling; replace USER_AGENT in .env)";
const CONCURRENCY = Number.parseInt(
  process.env.CONTACTS_CONCURRENCY ?? "3",
  10,
);
const FETCH_DELAY_MS = Number.parseInt(
  process.env.CONTACTS_DELAY_MS ?? "300",
  10,
);
const ALL_TIERS = process.env.CONTACTS_ALL_TIERS === "1";
const MAX_INSTITUTIONS = Number.parseInt(
  process.env.CONTACTS_MAX ?? (ALL_TIERS ? "5000" : "300"),
  10,
);

const MAILBOX_PRIORITY = [
  "admissions",
  "enquiries",
  "enquiry",
  "info",
  "contact",
  "office",
  "head",
  "headteacher",
  "principal",
  "admin",
  "reception",
  "school",
  "hello",
];

const PATHS_TO_TRY = ["", "/contact", "/contact-us", "/contact_us"];

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function rankMailbox(email: string): number {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  for (let i = 0; i < MAILBOX_PRIORITY.length; i++) {
    if (local === MAILBOX_PRIORITY[i] || local.startsWith(MAILBOX_PRIORITY[i])) {
      return i;
    }
  }
  // Personal-looking address — sortable last.
  return MAILBOX_PRIORITY.length + 50;
}

function pickBestEmail(emails: string[], domain: string): string | null {
  const normalised = emails
    .map((e) => e.toLowerCase().trim())
    .filter((e) => e.length < 100)
    .filter((e) => !/example\.|@example|@test/i.test(e))
    .filter((e) => !/sentry|datadog|raygun|@cloudflare/i.test(e))
    // Stay on the institution's own domain — drop mailto: links to vendors.
    .filter((e) => e.endsWith("." + domain) || e.endsWith("@" + domain));

  if (!normalised.length) return null;
  normalised.sort((a, b) => rankMailbox(a) - rankMailbox(b));
  return normalised[0];
}

async function scrapeInstitution(
  institutionId: number,
  websiteUrl: string,
): Promise<{ email: string | null; pages: number }> {
  const u = safeUrl(websiteUrl);
  if (!u) return { email: null, pages: 0 };
  const baseDomain = u.hostname.replace(/^www\./, "");

  const found: string[] = [];
  let pagesHit = 0;

  for (const path of PATHS_TO_TRY) {
    const target = `${u.protocol}//${u.host}${path || ""}`;
    try {
      const cached = await fetchToFile(target, {
        subdir: "contacts",
        filenameHint: `${institutionId}-${path.replace(/\W/g, "")}`,
        extension: ".html",
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      });
      const html = readFileSync(cached.localPath, "utf-8");
      pagesHit++;

      const $ = cheerio.load(html);
      $("a[href^='mailto:']").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        const cleaned = href.replace(/^mailto:/i, "").split("?")[0];
        // Run the regex on the cleaned mailto contents — mailto hrefs in
        // the wild often contain stray text like "fao John: real@mail.uk".
        const m = cleaned.match(EMAIL_REGEX);
        if (m) found.push(...m);
      });

      const matches = html.match(EMAIL_REGEX);
      if (matches) found.push(...matches);

      if (FETCH_DELAY_MS > 0) await sleep(FETCH_DELAY_MS);

      // If we already have a great match from the homepage, don't bother
      // hitting /contact pages.
      const pickedEarly = pickBestEmail(found, baseDomain);
      if (pickedEarly && rankMailbox(pickedEarly) <= 4) break;
    } catch {
      // 404 or DNS — try next path
    }
  }

  return { email: pickBestEmail(found, baseDomain), pages: pagesHit };
}

export async function ingestContacts(): Promise<RunResult> {
  const baseQuery = db
    .select({
      id: institutions.id,
      website: institutions.website,
      tier: opportunityScores.tier,
    })
    .from(institutions)
    .leftJoin(
      opportunityScores,
      eq(opportunityScores.institutionId, institutions.id),
    )
    .where(
      and(
        eq(institutions.inScope, true),
        isNotNull(institutions.website),
        isNull(institutions.generalEmail),
        isNull(institutions.headEmail),
      ),
    );

  const cohort = ALL_TIERS
    ? await baseQuery.limit(MAX_INSTITUTIONS)
    : await baseQuery
        .where(
          sql`${opportunityScores.tier} IN ('critical','high','worth_a_look')`,
        )
        .orderBy(desc(opportunityScores.score))
        .limit(MAX_INSTITUTIONS);

  log.info(
    `contacts: ${cohort.length} institutions to enrich (ALL_TIERS=${ALL_TIERS} max=${MAX_INSTITUTIONS})`,
  );

  const limit = pLimit(CONCURRENCY);
  let success = 0;
  let nothing = 0;

  await Promise.allSettled(
    cohort.map((row) =>
      limit(async () => {
        if (!row.website) return;
        const result = await scrapeInstitution(row.id, row.website);
        if (result.email) {
          await db
            .update(institutions)
            .set({ generalEmail: result.email, updatedAt: new Date() })
            .where(eq(institutions.id, row.id));
          success++;
          if (success % 25 === 0)
            log.info(`contacts: enriched ${success}/${cohort.length}`);
        } else {
          nothing++;
        }
      }),
    ),
  );

  log.info(
    `contacts: complete — emails found=${success} no-match=${nothing} of ${cohort.length}`,
  );

  return {
    recordsSeen: cohort.length,
    recordsUpserted: success,
    notes: `nothing=${nothing}`,
  };
}
