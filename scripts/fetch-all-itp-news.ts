/**
 * One-shot Google News pass for EVERY in-scope ITP.
 *
 * The main `news_google` stage has a fixed budget (default 200) and
 * orders by tier so worth_a_look ITPs get evaluated last and most never
 * make the cut. This script doesn't care about tier — it walks every
 * ITP, ordered by size (apprenticeship-standards count) so the largest
 * providers get processed first.
 *
 * Already-fetched URLs hit the 24h cache for free. Only newly-encountered
 * providers cause network traffic.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { eq, sql } from "drizzle-orm";
import { client, db, newsItems } from "../src/db";
import { fetchToFile } from "../src/lib/ingest/fetch";
import { log } from "../src/lib/ingest/log";

function googleNewsUrl(name: string): string {
  const q = encodeURIComponent(`"${name}"`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`;
}

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

async function main() {
  // Optional CLI arg: --limit=N to cap the run for testing
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 0;

  const queue = await client.execute(`
    SELECT i.id, i.name, i.apprenticeship_standards
    FROM institutions i
    WHERE i.type = 'itp' AND i.in_scope = 1
    ORDER BY i.apprenticeship_standards DESC NULLS LAST, i.name
    ${limit ? `LIMIT ${limit}` : ""}
  `);
  const itps = queue.rows as unknown as { id: number; name: string; apprenticeship_standards: number | null }[];
  log.info(`fetch_all_itp_news: ${itps.length} ITPs to process`);

  let totalEntries = 0;
  let totalInserted = 0;
  let withErrors = 0;
  let consecutive503s = 0;
  let i = 0;

  for (const row of itps) {
    i++;
    // After three consecutive 503s, back off hard. Google News rate-
    // limits aggressively when ~1000 RSS queries hit in close succession,
    // and once it's blocking it stays blocked for ~hours. Surrender the
    // run early so we don't waste time and keep the IP cleaner.
    if (consecutive503s >= 3) {
      log.warn(
        `gnews itp: aborting at ${i - 1}/${itps.length} — Google rate-limiting (3+ consecutive 503s). Resume with this script after a few hours.`,
      );
      break;
    }
    // Polite sleep — 700ms between requests keeps us safely below the
    // soft rate limit.
    if (i > 1) await new Promise((r) => setTimeout(r, 700));
    const url = googleNewsUrl(row.name);
    try {
      const cached = await fetchToFile(url, {
        subdir: "news_google",
        filenameHint: `gnews-itp-${row.id}`,
        extension: ".xml",
        maxAgeMs: 24 * 60 * 60 * 1000,
      });
      const xml = readFileSync(cached.localPath, "utf-8");
      const items = parseRss(xml);
      totalEntries += items.length;

      // Sanity check on relevance: require at least one provider-name
      // word in the title or summary. Avoids picking up unrelated stories
      // from queries that returned generic results.
      const firstWord = row.name.toLowerCase().split(" ")[0];
      const tooShortFirstWord = firstWord.length < 4;
      for (const item of items.slice(0, 8)) {
        if (!tooShortFirstWord) {
          const text = (item.title + " " + item.summary).toLowerCase();
          if (!text.includes(firstWord)) continue;
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
          relevance: 55,
          triggerSeverity: 0,
          contentHash: item.contentHash,
        });
        totalInserted++;
      }
      // Successful fetch (cached or network). Reset 503 counter.
      consecutive503s = 0;
    } catch (err) {
      withErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HTTP 503")) consecutive503s++;
      log.warn(`gnews itp[${row.name}]: ${msg}`);
    }
    if (i % 50 === 0) {
      log.info(`gnews itp: progress ${i}/${itps.length} entries=${totalEntries} inserted=${totalInserted}`);
    }
  }

  log.info(
    `fetch_all_itp_news: done — providers=${i} entries=${totalEntries} inserted=${totalInserted} errors=${withErrors}`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
