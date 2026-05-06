// What does our Ofsted-report ingestion actually look like for ITPs?
import { client } from "../src/db";
async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}
async function main() {
  await table("ITP inspections — report-text coverage",
    `SELECT
       COUNT(*) AS total_inspections,
       SUM(CASE WHEN insp.report_text IS NOT NULL THEN 1 ELSE 0 END) AS with_report_text,
       SUM(CASE WHEN insp.report_pdf_path IS NOT NULL THEN 1 ELSE 0 END) AS with_pdf,
       SUM(CASE WHEN insp.report_url IS NOT NULL THEN 1 ELSE 0 END) AS with_report_url
     FROM institutions i JOIN inspections insp ON insp.institution_id = i.id
     WHERE i.type='itp'`);

  await table("ITP findings — verbatim quotes extracted",
    `SELECT
       COUNT(DISTINCT i.id) AS itps_with_any_finding,
       COUNT(*) AS total_findings
     FROM institutions i JOIN findings f ON f.institution_id = i.id
     WHERE i.type='itp'`);

  await table("Findings on the 14 critical/high ITPs",
    `SELECT i.name, os.tier, os.score,
            (SELECT COUNT(*) FROM findings f WHERE f.institution_id = i.id AND f.suppressed = 0) AS findings,
            (SELECT report_text IS NOT NULL FROM inspections WHERE institution_id=i.id ORDER BY inspection_start_date DESC LIMIT 1) AS has_text
     FROM institutions i JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND os.tier IN ('critical','high')
     ORDER BY os.score DESC, os.urgency_score DESC LIMIT 20`);

  await table("Recent RI/Inadequate ITP inspections WITHOUT report text",
    `SELECT i.name, insp.overall_grade, insp.inspection_start_date, insp.report_url
     FROM institutions i JOIN inspections insp ON insp.institution_id = i.id
     WHERE i.type='itp'
       AND insp.overall_grade IN ('requires_improvement','inadequate')
       AND insp.report_text IS NULL
       AND insp.report_url IS NOT NULL
     ORDER BY insp.inspection_start_date DESC LIMIT 20`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
