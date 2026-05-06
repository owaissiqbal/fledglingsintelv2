/**
 * Re-runs the section parser over every inspection that already has
 * report_text. Drops and rebuilds report_sections per inspection.
 *
 * Use after sections.ts changes so all stored reports pick up the new
 * markers / end-markers without re-fetching PDFs.
 */

import { eq, isNotNull, sql } from "drizzle-orm";
import { db, inspections, reportSections } from "../src/db";
import { sectionise } from "../src/lib/extract/sections";
import { log } from "../src/lib/ingest/log";

async function main() {
  const rows = await db
    .select({
      id: inspections.id,
      reportText: inspections.reportText,
    })
    .from(inspections)
    .where(isNotNull(inspections.reportText));

  log.info(`resectionise: ${rows.length} inspections to re-process`);
  let processed = 0;
  let totalSections = 0;

  for (const row of rows) {
    if (!row.reportText) continue;
    const sections = sectionise(row.reportText);
    await db.transaction(async (tx) => {
      await tx.delete(reportSections).where(eq(reportSections.inspectionId, row.id));
      for (const s of sections) {
        await tx.insert(reportSections).values({
          inspectionId: row.id,
          sectionKey: s.sectionKey,
          sectionTitle: s.sectionTitle,
          sectionText: s.sectionText,
          multiplier: s.multiplier,
          orderIndex: s.orderIndex,
        });
      }
    });
    totalSections += sections.length;
    processed++;
    if (processed % 200 === 0) {
      log.info(`resectionise: ${processed}/${rows.length} done · ${totalSections} sections`);
    }
  }

  log.info(`resectionise: complete · ${processed} inspections · ${totalSections} sections`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
