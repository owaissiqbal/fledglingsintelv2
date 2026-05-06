import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT
      SUM(CASE WHEN angle IS NOT NULL THEN 1 ELSE 0 END) AS extracted,
      SUM(CASE WHEN angle IS NULL THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM news_items
  `);
  console.table(r.rows);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
