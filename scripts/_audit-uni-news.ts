import { client } from "../src/db";

async function main() {
  const r1 = await client.execute(`
    SELECT
      COUNT(DISTINCT n.institution_id) AS unis_with_news,
      COUNT(*) AS total_news_items,
      SUM(CASE WHEN n.trigger_severity >= 70 THEN 1 ELSE 0 END) AS high_severity
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE i.type = 'university'
  `);
  console.log("\n=== Universities news coverage ===");
  console.table(r1.rows);

  const r2 = await client.execute(`
    SELECT i.name, n.title, n.trigger_severity, n.angle
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE i.type = 'university' AND n.trigger_severity >= 50
    ORDER BY n.trigger_severity DESC
    LIMIT 20
  `);
  console.log("\n=== High-signal university news ===");
  console.table(r2.rows);

  const r3 = await client.execute(`
    SELECT i.name, COUNT(n.id) AS news_count
    FROM institutions i
    LEFT JOIN news_items n ON n.institution_id = i.id
    WHERE i.type = 'university' AND i.in_scope = 1
    GROUP BY i.id
    HAVING news_count = 0
    ORDER BY i.apprenticeship_standards DESC NULLS LAST
    LIMIT 20
  `);
  console.log("\n=== Universities with NO news yet (might need a fresh pass) ===");
  console.table(r3.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
