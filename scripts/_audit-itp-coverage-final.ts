import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT
      COUNT(DISTINCT i.id) AS total_itps,
      SUM(CASE WHEN nm.news_count > 0 THEN 1 ELSE 0 END) AS with_news,
      SUM(CASE WHEN nm.news_count IS NULL THEN 1 ELSE 0 END) AS no_news_yet
    FROM institutions i
    LEFT JOIN (SELECT institution_id, COUNT(*) AS news_count FROM news_items GROUP BY institution_id) nm
      ON nm.institution_id = i.id
    WHERE i.type = 'itp' AND i.in_scope = 1
  `);
  console.log("\n=== ITP news coverage ===");
  console.table(r.rows);

  const r2 = await client.execute(`
    SELECT
      i.type,
      COUNT(DISTINCT i.id) AS total,
      SUM(CASE WHEN nm.news_count > 0 THEN 1 ELSE 0 END) AS with_news
    FROM institutions i
    LEFT JOIN (SELECT institution_id, COUNT(*) AS news_count FROM news_items GROUP BY institution_id) nm
      ON nm.institution_id = i.id
    WHERE i.in_scope = 1
    GROUP BY i.type ORDER BY total DESC
  `);
  console.log("\n=== Coverage by institution type ===");
  console.table(r2.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
