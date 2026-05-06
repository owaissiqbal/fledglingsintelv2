/**
 * Move ITP rows that are actually universities into a new `university`
 * institution type. Detection is conservative — false positives are
 * worse than false negatives (we'd rather miss one university than
 * mis-label an NHS trust or primary academy).
 *
 * Rules (must pass HE_RE, must not pass EXCLUDE_RE):
 *   HE_RE matches: "University of X", "X University", "University Centre",
 *                  "Imperial College", "King's College London", "UCL",
 *                  "London School of Economics", "Liverpool Hope University",
 *                  "University College Birmingham"
 *   EXCLUDE_RE blocks: NHS Trust, Hospital, Academy (the MAT-style),
 *                  "University Academy" (used by primary academies)
 */

import { client } from "../src/db";

// Match formal HE provider names. The "University" / "College" must be the
// substantive noun, not adjectival.
const HE_RE = new RegExp(
  [
    /\buniversity of \w+/i.source,
    /\b\w+ university\b/i.source,
    /\buniversity college \w+/i.source,
    /\buniversity centre \w+/i.source,
    /\bimperial college london\b/i.source,
    /\bking's college london\b/i.source,
    /\b(?:^|\s)ucl(?:\s|$|,)/i.source,
    /\blondon school of economics\b/i.source,
    /\blse\b/i.source,
    /\broyal college of (?:art|music|nursing|surgeons|physicians|paediatrics)/i.source,
    /\bschool of oriental and african studies\b/i.source,
    /\bsoas\b/i.source,
    /\b(?:liverpool hope|aston|brunel|coventry|cranfield|de montfort|loughborough|northumbria|salford|sheffield hallam|teesside) university\b/i.source,
  ].join("|"),
  "i",
);

const EXCLUDE_RE =
  /\b(NHS|hospital|hospitals|trust|academy holbeach|academy 92|stem education academy|primary|secondary|further education|fe college)\b/i;

async function main() {
  // First, undo any previous wrong reclassification (move 'university'
  // back to 'itp' before re-running with the tighter rule)
  await client.execute(
    `UPDATE institutions SET type = 'itp' WHERE type = 'university'`,
  );

  const candidates = await client.execute(`
    SELECT id, name, ukprn FROM institutions
    WHERE in_scope = 1 AND type = 'itp'
  `);

  let reclassified = 0;
  let skipped = 0;
  let excluded = 0;

  for (const row of candidates.rows as unknown as { id: number; name: string; ukprn: string | null }[]) {
    const heMatch = HE_RE.test(row.name);
    if (!heMatch) {
      skipped++;
      continue;
    }
    if (EXCLUDE_RE.test(row.name)) {
      excluded++;
      continue;
    }
    await client.execute({
      sql: `UPDATE institutions SET type = 'university', updated_at = unixepoch() * 1000 WHERE id = ?`,
      args: [row.id],
    });
    reclassified++;
  }

  console.log(`Reclassified ${reclassified} rows · excluded ${excluded} false-positives · skipped ${skipped}`);

  // Print the final list to eyeball
  const final = await client.execute(`
    SELECT id, name, ukprn FROM institutions WHERE type = 'university' ORDER BY name
  `);
  console.log("\nFinal university list:");
  for (const r of final.rows as unknown as { id: number; name: string; ukprn: string | null }[]) {
    console.log(`  ${r.name} (UKPRN ${r.ukprn ?? "—"})`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
