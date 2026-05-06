// Verify the grade ceiling caps Outstanding/Good ITPs without urgency.
import { client } from "../src/db";
async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}
async function main() {
  await table("Outstanding ITPs (was 100, should now cap at ~60)",
    `SELECT i.name, latest.overall_grade, os.tier, os.score, os.urgency_score, os.pipeline_value_score
     FROM institutions i JOIN opportunity_scores os ON os.institution_id = i.id
     JOIN (SELECT institution_id, overall_grade, ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn FROM inspections) latest
       ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type='itp' AND i.in_scope=1 AND latest.overall_grade='outstanding'
     ORDER BY os.score DESC LIMIT 10`);

  await table("Good ITPs by size (should now cap at ~75)",
    `SELECT i.name, i.apprenticeship_standards, latest.overall_grade, os.tier, os.score, os.urgency_score
     FROM institutions i JOIN opportunity_scores os ON os.institution_id = i.id
     JOIN (SELECT institution_id, overall_grade, ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn FROM inspections) latest
       ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type='itp' AND i.in_scope=1 AND latest.overall_grade='good'
     ORDER BY i.apprenticeship_standards DESC NULLS LAST LIMIT 15`);

  await table("Inadequate / RI ITPs — these SHOULD still hit 95-100",
    `SELECT i.name, latest.overall_grade, os.tier, os.score, os.urgency_score
     FROM institutions i JOIN opportunity_scores os ON os.institution_id = i.id
     JOIN (SELECT institution_id, overall_grade, ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn FROM inspections) latest
       ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type='itp' AND i.in_scope=1 AND latest.overall_grade IN ('inadequate','requires_improvement')
     ORDER BY os.score DESC LIMIT 15`);

  await table("Score distribution by latest grade",
    `WITH latest AS (
       SELECT institution_id, overall_grade, ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn FROM inspections
     )
     SELECT COALESCE(latest.overall_grade,'no_inspection') AS grade,
            COUNT(*) AS itps,
            ROUND(AVG(os.score),0) AS avg_score,
            MAX(os.score) AS max_score,
            MIN(os.score) AS min_score
     FROM institutions i JOIN opportunity_scores os ON os.institution_id = i.id
     LEFT JOIN latest ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type='itp' AND i.in_scope=1
     GROUP BY grade ORDER BY avg_score DESC`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
