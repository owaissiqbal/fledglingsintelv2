// Re-check ITP tier distribution after score fix.
import { client } from "../src/db";

async function table(label: string, sqlText: string) {
  const result = await client.execute(sqlText);
  console.log(`\n=== ${label} ===`);
  console.table(result.rows);
}

async function main() {
  await table(
    "ITP tier distribution",
    `SELECT COALESCE(os.tier,'unscored') AS tier,
            COUNT(*) AS itps,
            ROUND(AVG(os.score),1) AS avg_score,
            ROUND(AVG(os.urgency_score),1) AS avg_urgency,
            ROUND(AVG(os.pipeline_value_score),1) AS avg_pipeline
     FROM institutions i
     LEFT JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1
     GROUP BY tier
     ORDER BY itps DESC`,
  );

  await table(
    "Why each ITP is in 'critical' tier",
    `SELECT
       CASE
         WHEN os.urgency_score >= 90 THEN 'urgency 90+ (Inadequate / safeguarding fail / 2+ critical signals)'
         WHEN os.urgency_score >= 70 THEN 'urgency 70-89 (RI signals)'
         WHEN os.urgency_score BETWEEN 50 AND 69 THEN 'urgency 50-69 (weaker signal)'
         WHEN os.pipeline_value_score >= 90 THEN 'pipeline 90+ (no inspection urgency, big provider)'
         WHEN os.pipeline_value_score BETWEEN 70 AND 89 THEN 'pipeline 70-89'
         ELSE 'other'
       END AS reason,
       COUNT(*) AS itps
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1 AND os.tier='critical'
     GROUP BY reason
     ORDER BY itps DESC`,
  );

  await table(
    "Distribution of headline scores",
    `SELECT
       (CAST(os.score / 5 AS INTEGER) * 5) AS score_band,
       COUNT(*) AS itps
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1
     GROUP BY score_band
     ORDER BY score_band DESC`,
  );

  await table(
    "Top 10 ITPs by score, with the actual driver",
    `SELECT i.name, os.tier, os.score AS headline,
            os.urgency_score AS urgency, os.pipeline_value_score AS pipeline,
            (SELECT overall_grade FROM inspections insp
             WHERE insp.institution_id=i.id
             ORDER BY insp.inspection_start_date DESC LIMIT 1) AS latest_grade,
            os.top_curriculum
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id=i.id
     WHERE i.type='itp' AND i.in_scope=1
     ORDER BY os.score DESC, os.urgency_score DESC
     LIMIT 10`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
