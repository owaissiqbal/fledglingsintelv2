import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT i.id, i.name FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.in_scope = 1 AND os.tier = 'critical' AND i.type IN ('itp','fe_college')
    ORDER BY os.urgency_score DESC, os.score DESC
    LIMIT 5
  `);
  for (const row of r.rows as unknown as { id: number; name: string }[]) {
    console.log(`${row.id}\t${row.name}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
