import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT i.name, i.type, insp.overall_grade, insp.inspection_start_date, insp.report_url
    FROM institutions i LEFT JOIN inspections insp ON insp.institution_id = i.id
    WHERE i.name = 'Windsor Forest Colleges Group'
    ORDER BY insp.inspection_start_date DESC
  `);
  console.table(r.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
