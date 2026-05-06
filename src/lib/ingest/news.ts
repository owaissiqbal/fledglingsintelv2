/**
 * News ingest. Pulls articles mentioning institutions in our DB from FE
 * Week, Schools Week, FE News (all WordPress / RSS), gov.uk Atom feeds,
 * and Google News (per-provider RSS for the highest-priority tiers).
 *
 * The pipeline is two-pass:
 *
 *   Pass 1 — fetch + match (this file)
 *     - For each RSS feed, walk every entry, extract title + summary +
 *       link + pubdate, try to fuzzy-match to one or more institutions in
 *       our DB by name. Store each match as a news_items row with a
 *       provisional `relevance` based on match strength.
 *     - For Google News, walk our top-priority institutions and run one
 *       query per provider. Each item gets relevance proportional to how
 *       precisely the provider name appears in title/snippet.
 *
 *   Pass 2 — LLM extraction (extract-news.ts)
 *     - For each news_items row, ask Claude:
 *         (a) is this article actually about this provider? (relevance)
 *         (b) is it a Fledglings buying trigger? (trigger_severity)
 *         (c) which curricula does it touch?
 *         (d) one-line angle for sales
 *     - Cache by content_hash so we don't re-call on every refresh.
 *
 * The scoring step reads `news_items` directly — see scoring.ts.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { eq, sql } from "drizzle-orm";
import { client, db, institutions, newsItems } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import type { RunResult } from "./run";

// ---------- shared name-matching ------------------------------------------

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

type NameIndexEntry = {
  id: number;
  name: string;
  normalised: string;
  type: string;
  // Searchable name fragments for substring scanning (only for names of 4+
  // tokens so common short words don't cause false positives)
  tokens: string[];
};
let nameIndexCache: NameIndexEntry[] | null = null;

async function getNameIndex(): Promise<NameIndexEntry[]> {
  if (nameIndexCache) return nameIndexCache;
  const rows = await db
    .select({
      id: institutions.id,
      name: institutions.name,
      type: institutions.type,
    })
    .from(institutions)
    .where(eq(institutions.inScope, true));
  nameIndexCache = rows.map((r) => {
    const norm = normName(r.name);
    return {
      id: r.id,
      name: r.name,
      normalised: norm,
      type: r.type,
      tokens: norm.split(" ").filter((t) => t.length >= 3),
    };
  });
  return nameIndexCache;
}

// Scan a piece of text (article title + summary) for any institution
// whose normalised name appears as a contiguous substring. Returns all
// matches with a relevance estimate (longer/more-specific name = higher).
async function findMatches(text: string): Promise<{
  institutionId: number;
  institutionName: string;
  type: string;
  relevance: number;
}[]> {
  const idx = await getNameIndex();
  const haystack = " " + normName(text) + " ";
  const matches: {
    institutionId: number;
    institutionName: string;
    type: string;
    relevance: number;
  }[] = [];
  for (const entry of idx) {
    if (entry.normalised.length < 8) continue; // skip short ambiguous names
    if (entry.tokens.length < 2) continue; // single-token names too risky
    const phrase = " " + entry.normalised + " ";
    if (haystack.includes(phrase)) {
      // High relevance — exact normalised name appears
      const lengthBonus = Math.min(40, Math.floor(entry.normalised.length / 2));
      matches.push({
        institutionId: entry.id,
        institutionName: entry.name,
        type: entry.type,
        relevance: 50 + lengthBonus, // 50-90 range
      });
    }
  }
  return matches;
}

// ---------- RSS / Atom shape ----------------------------------------------

type FeedItem = {
  title: string;
  summary: string;
  link: string;
  publishedAt: string | null;
  contentHash: string;
};

function parseRss(xml: string): FeedItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: FeedItem[] = [];
  $("item").each((_, el) => {
    const $el = $(el);
    const title = $el.find("title").first().text().trim();
    const summary =
      $el.find("description").first().text().trim() ||
      $el.find("content\\:encoded").first().text().trim();
    const link = $el.find("link").first().text().trim();
    const pubDate = $el.find("pubDate").first().text().trim();
    if (!title || !link) return;
    items.push({
      title,
      summary: summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 800),
      link,
      publishedAt: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : null,
      contentHash: createHash("sha1").update(link + title).digest("hex").slice(0, 16),
    });
  });
  return items;
}

function parseAtom(xml: string): FeedItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: FeedItem[] = [];
  $("entry").each((_, el) => {
    const $el = $(el);
    const title = $el.find("title").first().text().trim();
    const summary = $el.find("summary").first().text().trim();
    const link = $el.find("link").first().attr("href") ?? "";
    const updated = $el.find("updated").first().text().trim();
    if (!title || !link) return;
    items.push({
      title,
      summary: summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 800),
      link,
      publishedAt: updated ? updated.slice(0, 10) : null,
      contentHash: createHash("sha1").update(link + title).digest("hex").slice(0, 16),
    });
  });
  return items;
}

// ---------- (1) Trade-press feeds -----------------------------------------

const RSS_FEEDS: { source: string; url: string }[] = [
  { source: "fe_week", url: "https://feweek.co.uk/feed/" },
  { source: "schools_week", url: "https://schoolsweek.co.uk/feed/" },
  { source: "fe_news", url: "https://www.fenews.co.uk/feed/" },
];

const ATOM_FEEDS: { source: string; url: string }[] = [
  { source: "ofsted_news", url: "https://www.gov.uk/government/organisations/ofsted.atom" },
  {
    source: "dfe_news",
    url: "https://www.gov.uk/government/organisations/department-for-education.atom",
  },
  {
    source: "esfa_news",
    url: "https://www.gov.uk/government/organisations/education-and-skills-funding-agency.atom",
  },
];

async function ingestFeed(
  source: string,
  url: string,
  parser: "rss" | "atom",
): Promise<{ entries: number; matched: number; inserted: number }> {
  const cached = await fetchToFile(url, {
    subdir: "news_feeds",
    filenameHint: source,
    extension: parser === "rss" ? ".xml" : ".atom",
    maxAgeMs: 60 * 60 * 1000, // 1 hour
  });
  const xml = readFileSync(cached.localPath, "utf-8");
  const items = parser === "rss" ? parseRss(xml) : parseAtom(xml);

  let matched = 0;
  let inserted = 0;
  for (const item of items) {
    const matches = await findMatches(`${item.title}\n${item.summary}`);
    if (matches.length === 0) continue;

    // Limit to top 3 matches per article — articles about >3 providers are
    // usually list-roundups with low per-provider relevance.
    const limited = matches.slice(0, 3);
    for (const match of limited) {
      matched++;
      const existing = await db
        .select({ id: newsItems.id })
        .from(newsItems)
        .where(
          sql`${newsItems.url} = ${item.link} AND ${newsItems.institutionId} = ${match.institutionId}`,
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(newsItems)
          .set({
            title: item.title.slice(0, 500),
            excerpt: item.summary,
            publishedAt: item.publishedAt,
            relevance: match.relevance,
            contentHash: item.contentHash,
            lastSeenAt: new Date(),
          })
          .where(eq(newsItems.id, existing[0].id));
        continue;
      }
      await db.insert(newsItems).values({
        institutionId: match.institutionId,
        source,
        url: item.link,
        title: item.title.slice(0, 500),
        excerpt: item.summary,
        publishedAt: item.publishedAt,
        relevance: match.relevance,
        triggerSeverity: 0, // LLM pass fills this in
        contentHash: item.contentHash,
      });
      inserted++;
    }
  }
  log.info(
    `news ${source}: items=${items.length} matched=${matched} inserted=${inserted}`,
  );
  return { entries: items.length, matched, inserted };
}

export async function ingestNewsTradePress(): Promise<RunResult> {
  let totalEntries = 0;
  let totalMatched = 0;
  let totalInserted = 0;
  for (const f of RSS_FEEDS) {
    const r = await ingestFeed(f.source, f.url, "rss");
    totalEntries += r.entries;
    totalMatched += r.matched;
    totalInserted += r.inserted;
  }
  for (const f of ATOM_FEEDS) {
    const r = await ingestFeed(f.source, f.url, "atom");
    totalEntries += r.entries;
    totalMatched += r.matched;
    totalInserted += r.inserted;
  }
  return {
    recordsSeen: totalEntries,
    recordsUpserted: totalInserted,
    notes: `feeds=${RSS_FEEDS.length + ATOM_FEEDS.length} matched=${totalMatched}`,
  };
}

// ---------- (2) Google News per-provider ----------------------------------

const GOOGLE_NEWS_BUDGET = Number(
  process.env.GOOGLE_NEWS_BUDGET_PER_RUN ?? "200",
);

function googleNewsUrl(name: string): string {
  const q = encodeURIComponent(`"${name}"`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`;
}

export async function ingestGoogleNewsPerProvider(): Promise<RunResult> {
  if (GOOGLE_NEWS_BUDGET <= 0) {
    log.info("google_news: budget=0 — skipped");
    return { recordsSeen: 0, recordsUpserted: 0, notes: "budget=0" };
  }

  // ITP-first cohort. The user-facing focus is "ITPs with compliance +
  // news" — so the per-provider Google News pass concentrates on ITPs
  // and FE colleges (the same buying universe). Then critical/high
  // employers as a smaller priority group. Schools mostly already get
  // good signal from Ofsted/ISI inspections, and trade-press scrapers
  // cover what little news there is.
  const queue = await client.execute({
    sql: `SELECT i.id, i.name
          FROM institutions i
          JOIN opportunity_scores os ON os.institution_id = i.id
          WHERE i.in_scope = 1
            AND (
              i.type IN ('itp','fe_college','sixth_form_college','university')
              OR (os.tier IN ('critical','high') AND i.type = 'employer')
            )
          ORDER BY
            CASE WHEN os.tier = 'critical' THEN 0
                 WHEN os.tier = 'high' THEN 1
                 WHEN os.tier = 'worth_a_look' THEN 2
                 ELSE 3 END,
            os.score DESC
          LIMIT ?`,
    args: [GOOGLE_NEWS_BUDGET],
  });

  let totalEntries = 0;
  let totalInserted = 0;
  let withErrors = 0;
  let i = 0;

  for (const row of (queue.rows ?? []) as unknown as { id: number; name: string }[]) {
    i++;
    const url = googleNewsUrl(row.name);
    try {
      const cached = await fetchToFile(url, {
        subdir: "news_google",
        filenameHint: `gnews-${row.id}`,
        extension: ".xml",
        maxAgeMs: 24 * 60 * 60 * 1000,
      });
      const xml = readFileSync(cached.localPath, "utf-8");
      const items = parseRss(xml);
      totalEntries += items.length;

      for (const item of items.slice(0, 8)) {
        // Only insert items that mention the provider name in title or
        // summary — Google sometimes returns weakly-related results.
        const text = (item.title + " " + item.summary).toLowerCase();
        if (!text.includes(row.name.toLowerCase().split(" ").slice(0, 2).join(" "))) {
          continue;
        }
        const existing = await db
          .select({ id: newsItems.id })
          .from(newsItems)
          .where(
            sql`${newsItems.url} = ${item.link} AND ${newsItems.institutionId} = ${row.id}`,
          )
          .limit(1);
        if (existing[0]) {
          await db
            .update(newsItems)
            .set({
              title: item.title.slice(0, 500),
              excerpt: item.summary,
              publishedAt: item.publishedAt,
              lastSeenAt: new Date(),
            })
            .where(eq(newsItems.id, existing[0].id));
          continue;
        }
        await db.insert(newsItems).values({
          institutionId: row.id,
          source: "google_news",
          url: item.link,
          title: item.title.slice(0, 500),
          excerpt: item.summary,
          publishedAt: item.publishedAt,
          relevance: 55, // mid by default; LLM pass refines
          triggerSeverity: 0,
          contentHash: item.contentHash,
        });
        totalInserted++;
      }
    } catch (err) {
      withErrors++;
      log.warn(
        `google_news[${row.name}]: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (i % 25 === 0) {
      log.info(
        `google_news: progress ${i}/${queue.rows?.length ?? 0} entries=${totalEntries} inserted=${totalInserted}`,
      );
    }
  }

  return {
    recordsSeen: totalEntries,
    recordsUpserted: totalInserted,
    notes: `providers_queried=${i} errors=${withErrors}`,
  };
}
