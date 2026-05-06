// Identify and clean up zombie ingestion runs (status='running' for > 1h).
import { client } from "../src/db";

async function main() {
  const stuck = await client.execute(`
    SELECT id, source, status, started_at,
           datetime(started_at/1000,'unixepoch') AS started,
           ROUND((unixepoch()*1000 - started_at) / 1000.0 / 60, 1) AS minutes_old
    FROM ingestion_runs
    WHERE status = 'running'
    ORDER BY started_at
  `);
  console.log("\n=== Zombie 'running' rows ===");
  console.table(stuck.rows);

  if (stuck.rows.length === 0) {
    console.log("\nNothing to clean.");
    return;
  }

  const result = await client.execute({
    sql: `UPDATE ingestion_runs
          SET status = 'failed',
              completed_at = unixepoch() * 1000,
              error_message = COALESCE(error_message, '') || ' [auto-marked failed: process exited without recording completion]'
          WHERE status = 'running'
            AND (unixepoch()*1000 - started_at) > 60 * 60 * 1000`,
    args: [],
  });
  console.log(`\nMarked ${result.rowsAffected} stuck run(s) as failed.`);

  const after = await client.execute(`
    SELECT id, source, status, error_message
    FROM ingestion_runs
    WHERE id IN (SELECT id FROM ingestion_runs WHERE status='failed' ORDER BY id DESC LIMIT 5)
    ORDER BY id DESC
  `);
  console.log("\n=== Recently-failed runs (after cleanup) ===");
  console.table(after.rows);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
