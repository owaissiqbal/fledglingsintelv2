// Did the Windsor Forest news article boost its score?
import { client } from "../src/db";

async function main() {
  const r = await client.execute(`
    SELECT i.name, i.type, os.tier, os.score, os.urgency_score, os.pipeline_value_score,
           os.critical_signals
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.name = 'Windsor Forest Colleges Group'
  `);
  console.table(r.rows);

  const news = await client.execute(`
    SELECT i.name, n.trigger_severity, n.relevance, n.curricula_tagged, n.title, n.angle
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE n.trigger_severity >= 70
  `);
  console.log("\n=== High-severity news in DB ===");
  console.table(news.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
