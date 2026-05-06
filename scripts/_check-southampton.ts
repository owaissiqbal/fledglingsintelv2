import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT i.name, os.tier, os.score, os.urgency_score, os.pipeline_value_score,
           os.critical_signals
    FROM institutions i JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.name LIKE '%Southampton Solent%' OR i.name LIKE '%De Montfort%' OR i.name LIKE '%Pathway First%' OR i.name LIKE '%Windsor Forest%'
  `);
  console.table(r.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
