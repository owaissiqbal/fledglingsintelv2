import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT
      SUM(CASE WHEN withdrawn_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN withdrawn_at IS NOT NULL THEN 1 ELSE 0 END) AS withdrawn,
      COUNT(*) AS total
    FROM compliance_notices
    WHERE notice_body = 'esfa'
  `);
  console.table(r.rows);
  const sample = await client.execute(`
    SELECT subject, severity, withdrawn_at
    FROM compliance_notices
    WHERE notice_body = 'esfa'
    ORDER BY withdrawn_at DESC NULLS LAST
    LIMIT 20
  `);
  console.table(sample.rows);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
