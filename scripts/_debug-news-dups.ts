// Why are news items duplicating?
import { client } from "../src/db";

async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table(
    "Distinct (url, institution_id, title) — should equal news_items count if no dups",
    `SELECT
       COUNT(*) AS total_rows,
       COUNT(DISTINCT url || '|' || institution_id) AS distinct_url_inst,
       COUNT(DISTINCT title || '|' || institution_id) AS distinct_title_inst
     FROM news_items`,
  );
  await table(
    "Show URLs of duplicate pairs",
    `SELECT institution_id, url, title, COUNT(*) AS dups
     FROM news_items
     GROUP BY institution_id, url, title
     HAVING COUNT(*) > 1
     LIMIT 5`,
  );
  await table(
    "First 10 rows verbatim",
    `SELECT id, institution_id, url, substr(title,1,50) AS title FROM news_items ORDER BY id LIMIT 10`,
  );
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
