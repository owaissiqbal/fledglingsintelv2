// How many ITPs / unis actually have evidence to click through to?
import { client } from "../src/db";
async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}
async function main() {
  await table("Per-type evidence coverage",
    `SELECT i.type,
            COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM inspections WHERE institution_id=i.id) THEN 1 ELSE 0 END) AS any_inspection,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM inspections WHERE institution_id=i.id AND report_url IS NOT NULL) THEN 1 ELSE 0 END) AS with_report_url,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM inspections WHERE institution_id=i.id AND report_text IS NOT NULL) THEN 1 ELSE 0 END) AS with_report_text,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM compliance_notices WHERE institution_id=i.id AND withdrawn_at IS NULL) THEN 1 ELSE 0 END) AS with_active_compliance,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM news_items WHERE institution_id=i.id AND trigger_severity >= 50) THEN 1 ELSE 0 END) AS with_news_signal,
            SUM(CASE WHEN
              EXISTS (SELECT 1 FROM inspections WHERE institution_id=i.id AND report_url IS NOT NULL)
              OR EXISTS (SELECT 1 FROM compliance_notices WHERE institution_id=i.id AND withdrawn_at IS NULL)
              OR EXISTS (SELECT 1 FROM news_items WHERE institution_id=i.id AND trigger_severity >= 50)
            THEN 1 ELSE 0 END) AS actionable
     FROM institutions i
     WHERE i.in_scope = 1 AND i.type IN ('itp','university','fe_college','sixth_form_college','employer')
     GROUP BY i.type ORDER BY total DESC`);

  await table("ITPs with NO evidence at all (currently shown but useless)",
    `SELECT COUNT(*) AS no_evidence_itps
     FROM institutions i
     WHERE i.in_scope=1 AND i.type='itp'
       AND NOT EXISTS (SELECT 1 FROM inspections WHERE institution_id=i.id AND report_url IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM compliance_notices WHERE institution_id=i.id AND withdrawn_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM news_items WHERE institution_id=i.id AND trigger_severity >= 50)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
