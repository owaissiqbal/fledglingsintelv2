// Audit major providers + Outstanding-rated + universities
import { client } from "../src/db";
async function table(label: string, sql: string, args: unknown[] = []) {
  const r = await client.execute({ sql, args: args as Array<string | number> });
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table("Major-name search — are they in the DB?",
    `SELECT id, name, type, ukprn, urn, apprenticeship_standards, in_scope, source
     FROM institutions
     WHERE LOWER(name) LIKE '%lifetime%'
        OR LOWER(name) LIKE '%babcock%'
        OR LOWER(name) LIKE '%kaplan%'
        OR LOWER(name) LIKE '%bpp%'
        OR LOWER(name) LIKE 'qa %'
        OR LOWER(name) LIKE '%city & guilds kineo%'
        OR LOWER(name) LIKE '%pearson tq%'
        OR LOWER(name) LIKE '%fdm group%'
        OR LOWER(name) LIKE '%multiverse%'
        OR LOWER(name) LIKE '%firebrand%'
        OR LOWER(name) LIKE '%estio%'
        OR LOWER(name) LIKE '%paragon skills%'
        OR LOWER(name) LIKE '%hit training%'
        OR LOWER(name) LIKE '%nottinghamshire training%'
     ORDER BY apprenticeship_standards DESC NULLS LAST`);

  await table("Top 30 ITPs by apprenticeship standards (proxy for size)",
    `SELECT name, type, apprenticeship_standards, ukprn,
            (SELECT tier FROM opportunity_scores WHERE institution_id = institutions.id) AS tier,
            (SELECT score FROM opportunity_scores WHERE institution_id = institutions.id) AS score,
            (SELECT overall_grade FROM inspections WHERE institution_id = institutions.id ORDER BY inspection_start_date DESC LIMIT 1) AS latest_grade
     FROM institutions
     WHERE type = 'itp' AND in_scope = 1
     ORDER BY apprenticeship_standards DESC NULLS LAST
     LIMIT 30`);

  await table("Outstanding-rated ITPs",
    `SELECT i.name, i.apprenticeship_standards,
            (SELECT tier FROM opportunity_scores WHERE institution_id = i.id) AS tier,
            (SELECT score FROM opportunity_scores WHERE institution_id = i.id) AS score,
            latest.overall_grade,
            latest.inspection_start_date
     FROM institutions i
     JOIN (
       SELECT institution_id, overall_grade, inspection_start_date,
              ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
       FROM inspections
     ) latest ON latest.institution_id = i.id AND latest.rn = 1
     WHERE i.type = 'itp' AND i.in_scope = 1 AND latest.overall_grade = 'outstanding'
     ORDER BY latest.inspection_start_date DESC`);

  await table("ITPs with 'university' in the name (HE-affiliated)",
    `SELECT id, name, ukprn, apprenticeship_standards
     FROM institutions
     WHERE type = 'itp' AND in_scope = 1
       AND (LOWER(name) LIKE '%university%' OR LOWER(name) LIKE '%uni of%' OR LOWER(name) LIKE '%college university%')
     ORDER BY apprenticeship_standards DESC NULLS LAST
     LIMIT 50`);

  await table("Skip tier — what's in there?",
    `SELECT
       CASE
         WHEN apprenticeship_standards >= 10 THEN 'large skip'
         WHEN apprenticeship_standards >= 3 THEN 'medium skip'
         WHEN apprenticeship_standards >= 1 THEN 'niche skip'
         ELSE 'tiny / unknown'
       END AS size_band,
       COUNT(*) AS itps
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1 AND os.tier='skip'
     GROUP BY size_band
     ORDER BY MIN(COALESCE(apprenticeship_standards,0)) DESC`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
