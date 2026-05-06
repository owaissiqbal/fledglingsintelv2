// Show LLM extraction results — relevance, trigger severity, angles.
import { client } from "../src/db";

async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table(
    "All extracted news rows, sorted by trigger severity",
    `SELECT i.name AS institution,
            n.trigger_severity AS sev,
            n.relevance AS rel,
            n.curricula_tagged AS curricula,
            substr(n.title, 1, 60) AS title,
            substr(n.angle, 1, 90) AS angle
     FROM news_items n
     JOIN institutions i ON i.id = n.institution_id
     WHERE n.angle IS NOT NULL
     ORDER BY n.trigger_severity DESC, n.relevance DESC`,
  );

  await table(
    "Distribution of trigger severity",
    `SELECT
       CASE
         WHEN trigger_severity >= 90 THEN '90+ (immediate trigger)'
         WHEN trigger_severity >= 70 THEN '70-89 (warm trigger)'
         WHEN trigger_severity >= 40 THEN '40-69 (mild trigger)'
         ELSE '<40 (no trigger)'
       END AS band,
       COUNT(*) AS rows
     FROM news_items
     WHERE angle IS NOT NULL
     GROUP BY band
     ORDER BY MIN(trigger_severity) DESC`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
