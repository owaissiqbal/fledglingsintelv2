import { client } from "../src/db";
import { sectionise } from "../src/lib/extract/sections";

async function main() {
  const r = await client.execute(`
    SELECT report_text FROM inspections WHERE id = (
      SELECT id FROM inspections WHERE institution_id = 8404
      ORDER BY inspection_start_date DESC LIMIT 1
    )
  `);
  const text = (r.rows[0] as { report_text: string }).report_text;
  console.log(`Text length: ${text.length}`);

  // Where do "Inspection report:" markers appear?
  const re = /Inspection report:\s*[A-Z]/g;
  for (const m of text.matchAll(re)) {
    console.log(`  at offset ${m.index}: ${text.slice(Math.max(0, m.index! - 20), m.index! + 60).replace(/\n/g, "↵")}`);
  }

  // Where does the action section start?
  const actionRe = /what does the provider need to do to improve/i;
  const actionMatch = text.match(actionRe);
  console.log(`Action section starts at: ${actionMatch?.index}`);

  // Run sectioniser and see what happens
  const sections = sectionise(text);
  for (const s of sections) {
    console.log(`  ${s.sectionKey}: chars ${s.sectionText.length}, ends with: "${s.sectionText.slice(-100).replace(/\n/g, "↵")}"`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
