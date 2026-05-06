// Sanity check the news scraper — are the institution matches real?
import { client } from "../src/db";

async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table(
    "News by source",
    `SELECT source, COUNT(*) AS items, ROUND(AVG(relevance),0) AS avg_relevance
     FROM news_items GROUP BY source ORDER BY items DESC`,
  );

  await table(
    "Sample matched news (most recent first)",
    `SELECT i.name AS institution, i.type, n.source, n.relevance,
            substr(n.title, 1, 90) AS title,
            n.published_at
     FROM news_items n
     JOIN institutions i ON i.id = n.institution_id
     ORDER BY n.published_at DESC NULLS LAST
     LIMIT 30`,
  );

  await table(
    "Distinct institutions with news",
    `SELECT i.type,
            COUNT(DISTINCT i.id) AS institutions_with_news,
            COUNT(n.id) AS news_items
     FROM news_items n
     JOIN institutions i ON i.id = n.institution_id
     GROUP BY i.type ORDER BY news_items DESC`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
