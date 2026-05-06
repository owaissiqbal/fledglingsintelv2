import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT i.type, os.tier, COUNT(*) AS n
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.in_scope = 1
      AND (os.tier IN ('critical','high')
           OR (os.tier = 'worth_a_look' AND i.type='itp'))
    GROUP BY i.type, os.tier
    ORDER BY n DESC
  `);
  console.table(r.rows);
  const total = await client.execute(`
    SELECT COUNT(*) AS total
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.in_scope = 1
      AND (os.tier IN ('critical','high')
           OR (os.tier = 'worth_a_look' AND i.type='itp'))
  `);
  console.log("\nFull cohort size:", total.rows);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
