/**
 * One-shot Google News pass for universities only.
 *
 * Universities aren't Ofsted-graded so they all sit in `worth_a_look`,
 * which loses out to critical/high cohorts in the main news_google
 * scraper's priority ordering. This script runs them directly so they
 * get news coverage too.
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
  const queue = await client.execute(`
    SELECT i.id, i.name FROM institutions i
    WHERE i.type = 'university' AND i.in_scope = 1
    ORDER BY i.apprenticeship_standards DESC NULLS LAST
  `);
  const unis = queue.rows as unknown as { id: number; name: string }[];
  log.info(`fetch_university_news: ${unis.length} universities`);

  let totalEntries = 0;
  let totalInserted = 0;
  let withErrors = 0;
  let i = 0;

  for (const row of unis) {
    i++;
    const url = googleNewsUrl(row.name);
    try {
      const cached = await fetchToFile(url, {
        subdir: "news_google",
        filenameHint: `gnews-uni-${row.id}`,
        extension: ".xml",
        maxAgeMs: 24 * 60 * 60 * 1000,
      });
      const xml = readFileSync(cached.localPath, "utf-8");
      const items = parseRss(xml);
      totalEntries += items.length;

      const firstTwoWords = row.name.toLowerCase().split(" ").slice(0, 2).join(" ");
      for (const item of items.slice(0, 8)) {
        const text = (item.title + " " + item.summary).toLowerCase();
        if (!text.includes(firstTwoWords)) continue;
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
    } catch (err) {
      withErrors++;
      log.warn(
        `gnews uni[${row.name}]: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (i % 20 === 0) {
      log.info(`gnews uni: progress ${i}/${unis.length} entries=${totalEntries} inserted=${totalInserted}`);
    }
  }

  log.info(
    `fetch_university_news: done — providers=${i} entries=${totalEntries} inserted=${totalInserted} errors=${withErrors}`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
