// Final audit after news extraction + re-score.
import { client } from "../src/db";

async function table(label: string, sql: string) {
  const r = await client.execute(sql);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
}

async function main() {
  await table(
    "ITP tier distribution (after compliance + news folded into urgency)",
    `SELECT COALESCE(os.tier,'unscored') AS tier,
            COUNT(*) AS itps,
            ROUND(AVG(os.score),1) AS avg_score,
            ROUND(AVG(os.urgency_score),1) AS avg_urgency
     FROM institutions i
     LEFT JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1
     GROUP BY tier ORDER BY itps DESC`,
  );

  await table(
    "High-severity (>= 70) news articles per source",
    `SELECT n.source, COUNT(*) AS articles
     FROM news_items n
     WHERE n.trigger_severity >= 70
     GROUP BY n.source ORDER BY articles DESC`,
  );

  await table(
    "Top 15 ITPs combining all 3 signal types",
    `SELECT i.name, i.type, os.tier, os.score, os.urgency_score, os.pipeline_value_score,
            (SELECT COUNT(*) FROM compliance_notices cn WHERE cn.institution_id = i.id AND cn.withdrawn_at IS NULL) AS compliance_count,
            (SELECT COUNT(*) FROM news_items n WHERE n.institution_id = i.id AND n.trigger_severity >= 50) AS news_count,
            os.top_curriculum
     FROM institutions i
     JOIN opportunity_scores os ON os.institution_id = i.id
     WHERE i.type='itp' AND i.in_scope=1
     ORDER BY os.urgency_score DESC, os.score DESC
     LIMIT 15`,
  );

  await table(
    "All high-trigger news (severity >= 70) — these are real Fledglings hooks",
    `SELECT i.name, i.type, n.trigger_severity AS sev, n.relevance AS rel,
            n.source, n.published_at,
            substr(n.title, 1, 50) AS title,
            substr(n.angle, 1, 80) AS angle
     FROM news_items n
     JOIN institutions i ON i.id = n.institution_id
     WHERE n.trigger_severity >= 70 AND n.relevance >= 50
     ORDER BY n.trigger_severity DESC`,
  );

  await table(
    "Coverage summary",
    `SELECT
       (SELECT COUNT(*) FROM institutions WHERE type='itp' AND in_scope=1) AS total_itps,
       (SELECT COUNT(*) FROM news_items) AS news_items_total,
       (SELECT COUNT(*) FROM news_items WHERE angle IS NOT NULL) AS news_items_extracted,
       (SELECT COUNT(*) FROM news_items WHERE trigger_severity >= 70) AS news_items_high_signal,
       (SELECT COUNT(*) FROM compliance_notices WHERE withdrawn_at IS NULL) AS compliance_active,
       (SELECT COUNT(DISTINCT institution_id) FROM compliance_notices WHERE withdrawn_at IS NULL) AS institutions_with_compliance,
       (SELECT COUNT(DISTINCT institution_id) FROM news_items WHERE trigger_severity >= 50) AS institutions_with_news_signal`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
