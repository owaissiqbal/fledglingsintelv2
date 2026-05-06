import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT i.name, n.title, n.relevance, n.trigger_severity, n.curricula_tagged, n.angle, n.published_at
    FROM news_items n JOIN institutions i ON i.id = n.institution_id
    WHERE i.name LIKE '%Southampton Solent%' OR i.name LIKE '%De Montfort%'
    ORDER BY n.trigger_severity DESC
  `);
  console.table(r.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
