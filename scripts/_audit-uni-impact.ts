import { client } from "../src/db";

async function main() {
  const r1 = await client.execute(`
    SELECT i.name, n.title, n.trigger_severity, n.angle, n.published_at
    FROM news_items n JOIN institutions i ON i.id = n.institution_id
    WHERE i.type = 'university' AND n.trigger_severity >= 50
    ORDER BY n.trigger_severity DESC LIMIT 10
  `);
  console.log("\n=== High-signal university news (sev >= 50) ===");
  console.table(r1.rows);

  const r2 = await client.execute(`
    SELECT i.name, COUNT(n.id) AS news_count,
           SUM(CASE WHEN n.trigger_severity >= 50 THEN 1 ELSE 0 END) AS signal_count
    FROM institutions i
    LEFT JOIN news_items n ON n.institution_id = i.id
    WHERE i.type = 'university' AND i.in_scope = 1
    GROUP BY i.id
    ORDER BY signal_count DESC, news_count DESC
    LIMIT 15
  `);
  console.log("\n=== Universities with most news coverage ===");
  console.table(r2.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
