import { client } from "../src/db";
async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table("University tier distribution",
    `SELECT COALESCE(os.tier,'unscored') AS tier, COUNT(*) AS n,
            ROUND(AVG(os.score),0) AS avg_score
     FROM institutions i
     LEFT JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type = 'university' AND i.in_scope = 1
     GROUP BY tier ORDER BY n DESC`);

  await table("Top 15 universities by score",
    `SELECT i.name, i.apprenticeship_standards, os.tier, os.score, os.urgency_score, os.pipeline_value_score
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='university' AND i.in_scope=1
     ORDER BY os.score DESC, os.urgency_score DESC
     LIMIT 15`);

  await table("Universe summary",
    `SELECT
       (SELECT COUNT(*) FROM institutions WHERE type='itp' AND in_scope=1) AS itps,
       (SELECT COUNT(*) FROM institutions WHERE type='university' AND in_scope=1) AS universities,
       (SELECT COUNT(*) FROM institutions WHERE type='fe_college' AND in_scope=1) AS fe_colleges,
       (SELECT COUNT(*) FROM institutions WHERE type='sixth_form_college' AND in_scope=1) AS sixth_form_colleges,
       (SELECT COUNT(*) FROM institutions WHERE type='employer' AND in_scope=1) AS employers`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
