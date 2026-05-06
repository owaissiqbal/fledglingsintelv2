// One-off audit: what ITP data exists today, and where the gaps sit.
// Safe to run repeatedly; pure read-only queries.
import { client } from "../src/db";

async function table(label: string, sqlText: string) {
  const result = await client.execute(sqlText);
  console.log(`\n=== ${label} ===`);
  console.table(result.rows);
}

async function main() {
  await table(
    "Institutions by type",
    `SELECT type,
            COUNT(*) AS total,
            SUM(CASE WHEN in_scope = 1 THEN 1 ELSE 0 END) AS in_scope
     FROM institutions
     GROUP BY type
     ORDER BY total DESC`,
  );

  await table(
    "ITP coverage",
    `SELECT
       COUNT(*) AS total_itps,
       SUM(CASE WHEN in_scope = 1 THEN 1 ELSE 0 END) AS in_scope_itps,
       SUM(CASE WHEN ukprn IS NOT NULL THEN 1 ELSE 0 END) AS with_ukprn,
       SUM(CASE WHEN website IS NOT NULL THEN 1 ELSE 0 END) AS with_website,
       SUM(CASE WHEN general_email IS NOT NULL THEN 1 ELSE 0 END) AS with_general_email,
       SUM(CASE WHEN head_email IS NOT NULL THEN 1 ELSE 0 END) AS with_head_email,
       SUM(CASE WHEN apprenticeship_standards > 0 THEN 1 ELSE 0 END) AS with_standards
     FROM institutions
     WHERE type = 'itp'`,
  );

  await table(
    "ITP latest Ofsted grade distribution (in-scope only)",
    `WITH latest AS (
       SELECT institution_id, overall_grade,
              ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
       FROM inspections
     )
     SELECT COALESCE(latest.overall_grade, 'no_inspection') AS latest_grade,
            COUNT(*) AS itps
     FROM institutions i
     LEFT JOIN latest ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type = 'itp' AND i.in_scope = 1
     GROUP BY latest_grade
     ORDER BY itps DESC`,
  );

  await table(
    "ITP inspection landscape",
    `SELECT
       COUNT(insp.id) AS itp_inspections,
       SUM(CASE WHEN insp.publication_date >= date('now','-12 months') THEN 1 ELSE 0 END) AS last_12m,
       SUM(CASE WHEN insp.overall_grade IN ('requires_improvement','inadequate') THEN 1 ELSE 0 END) AS ri_or_inadequate,
       SUM(CASE WHEN insp.grade_dropped = 1 THEN 1 ELSE 0 END) AS grade_dropped,
       SUM(CASE WHEN insp.safeguarding_effective = 0 THEN 1 ELSE 0 END) AS safeguarding_not_met
     FROM institutions i
     JOIN inspections insp ON insp.institution_id = i.id
     WHERE i.type = 'itp'`,
  );

  await table(
    "ITP opportunity-score tier distribution",
    `SELECT COALESCE(os.tier, 'unscored') AS tier,
            COUNT(*) AS itps,
            ROUND(AVG(os.score), 1) AS avg_score
     FROM institutions i
     LEFT JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type = 'itp' AND i.in_scope = 1
     GROUP BY tier
     ORDER BY itps DESC`,
  );

  await table(
    "Last run per ingestion source (most recent first)",
    `WITH ranked AS (
       SELECT source, started_at, status, records_seen, records_upserted, error_message,
              ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
       FROM ingestion_runs
     )
     SELECT source,
            datetime(started_at/1000, 'unixepoch') AS last_run,
            status,
            records_seen,
            records_upserted,
            error_message
     FROM ranked
     WHERE rn = 1
     ORDER BY started_at DESC`,
  );

  await table(
    "ITP critical-signal coverage (top 10 examples by score)",
    `SELECT i.name, i.ukprn, os.tier, os.score,
            os.urgency_score, os.pipeline_value_score,
            os.top_curriculum, os.top_curriculum_score,
            os.critical_signals
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type = 'itp' AND i.in_scope = 1
     ORDER BY os.score DESC, os.urgency_score DESC
     LIMIT 10`,
  );

  await table(
    "ITPs with RI/Inadequate latest inspection in last 12m (highest-signal trigger list)",
    `WITH latest AS (
       SELECT institution_id, overall_grade, publication_date, inspection_start_date,
              ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
       FROM inspections
     )
     SELECT COUNT(*) AS itps_with_recent_ri_inadequate
     FROM institutions i
     JOIN latest ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type = 'itp' AND i.in_scope = 1
       AND latest.overall_grade IN ('requires_improvement','inadequate')
       AND latest.publication_date >= date('now','-12 months')`,
  );

  await table(
    "Apprenticeship-standards size distribution among ITPs",
    `SELECT
       CASE
         WHEN apprenticeship_standards = 0 THEN '0 (unknown)'
         WHEN apprenticeship_standards BETWEEN 1 AND 4 THEN '1-4 (niche)'
         WHEN apprenticeship_standards BETWEEN 5 AND 14 THEN '5-14 (medium)'
         WHEN apprenticeship_standards BETWEEN 15 AND 49 THEN '15-49 (large)'
         ELSE '50+ (very large)'
       END AS size_band,
       COUNT(*) AS itps
     FROM institutions
     WHERE type = 'itp' AND in_scope = 1
     GROUP BY size_band
     ORDER BY MIN(apprenticeship_standards)`,
  );

  await table(
    "All DB tables",
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
