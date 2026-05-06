// Verify compliance signals propagated into opportunity scores.
import { client } from "../src/db";

async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table("ITPs that gained urgency from compliance",
    `SELECT i.name, os.tier, os.score, os.urgency_score, os.pipeline_value_score, os.critical_signals
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     JOIN compliance_notices cn ON cn.institution_id = i.id AND cn.withdrawn_at IS NULL
     WHERE i.type='itp'
     ORDER BY os.urgency_score DESC
     LIMIT 20`);

  await table("FE colleges with active compliance notices",
    `SELECT i.name, os.tier, os.score, os.urgency_score, os.pipeline_value_score, os.critical_signals
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     JOIN compliance_notices cn ON cn.institution_id = i.id AND cn.withdrawn_at IS NULL
     WHERE i.type='fe_college'
     ORDER BY os.urgency_score DESC
     LIMIT 10`);

  await table("ITP tier distribution after compliance integration",
    `SELECT COALESCE(os.tier,'unscored') AS tier, COUNT(*) AS itps,
            ROUND(AVG(os.score),1) AS avg_score
     FROM institutions i
     LEFT JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1
     GROUP BY tier ORDER BY itps DESC`);
}

main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
