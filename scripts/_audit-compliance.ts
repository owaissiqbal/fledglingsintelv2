// Audit compliance_notices populated so far.
import { client } from "../src/db";

async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table("Compliance notices by body+type",
    `SELECT notice_body, notice_type, COUNT(*) AS notices,
            ROUND(AVG(severity),0) AS avg_severity,
            SUM(CASE WHEN withdrawn_at IS NULL THEN 1 ELSE 0 END) AS active
     FROM compliance_notices
     GROUP BY notice_body, notice_type
     ORDER BY notices DESC`);

  await table("Sample active notices on ITPs",
    `SELECT i.name AS institution, cn.notice_body, cn.notice_type, cn.severity, cn.subject
     FROM compliance_notices cn
     JOIN institutions i ON i.id = cn.institution_id
     WHERE cn.withdrawn_at IS NULL AND i.type='itp'
     ORDER BY cn.severity DESC
     LIMIT 20`);

  await table("Compliance signals attached to FE colleges",
    `SELECT i.name AS institution, cn.notice_type, cn.severity, cn.subject
     FROM compliance_notices cn
     JOIN institutions i ON i.id = cn.institution_id
     WHERE i.type='fe_college'
     ORDER BY cn.severity DESC
     LIMIT 20`);

  await table("Coverage of ITPs",
    `SELECT
       (SELECT COUNT(*) FROM institutions WHERE type='itp' AND in_scope=1) AS total_itps,
       (SELECT COUNT(DISTINCT institution_id) FROM compliance_notices cn JOIN institutions i ON i.id=cn.institution_id WHERE i.type='itp') AS itps_with_compliance,
       (SELECT COUNT(*) FROM compliance_notices cn JOIN institutions i ON i.id=cn.institution_id WHERE i.type='itp' AND cn.withdrawn_at IS NULL) AS active_notices_on_itps`);
}

main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
