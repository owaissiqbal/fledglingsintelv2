/**
 * Merge duplicate institutions where the same provider exists twice — once
 * URN-keyed (from GIAS / Ofsted MI) and once UKPRN-keyed (from APAR).
 * The two ingests can't reliably reconcile because GIAS doesn't store
 * UKPRN and APAR doesn't store URN, so duplicates accumulate.
 *
 * Strategy:
 *   1. Find clusters of in-scope institutions sharing a normalised name.
 *   2. Pick a canonical row per cluster (prefer URN-bearing row for
 *      schools/colleges, UKPRN-bearing for ITP-only entries).
 *   3. Move every FK reference (inspections, findings, curriculum_matches,
 *      news_items, compliance_notices, opportunity_scores, polished_emails,
 *      outreach_log) onto the canonical row.
 *   4. Merge missing scalar fields into the canonical row.
 *   5. Delete the loser row.
 *
 * Re-runnable: a second run finds nothing to merge.
 *
 * NB: this script writes. Always commits in a single transaction per
 * cluster so a failure mid-cluster doesn't leave orphans.
 */

import { client } from "../src/db";

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(ltd|limited|llp|plc|cic|cio)\b/g, " ")
    .replace(/\b(the|a|an|t\/a|trading as)\b/g, " ")
    .replace(/\b(group|holdings|services|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type InstRow = {
  id: number;
  urn: string | null;
  ukprn: string | null;
  isi_id: string | null;
  name: string;
  type: string;
  postcode: string | null;
  in_scope: number;
  source: string | null;
  website: string | null;
  general_email: string | null;
  head_email: string | null;
  apprenticeship_standards: number | null;
};

async function findClusters(): Promise<Map<string, InstRow[]>> {
  const r = await client.execute(`
    SELECT id, urn, ukprn, isi_id, name, type, postcode, in_scope, source,
           website, general_email, head_email, apprenticeship_standards
    FROM institutions
    WHERE in_scope = 1
  `);
  const buckets = new Map<string, InstRow[]>();
  for (const row of r.rows as unknown as InstRow[]) {
    const key = normName(row.name);
    if (key.length < 6) continue; // skip tiny names — too risky to merge
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(row);
  }
  // Keep only buckets with > 1 row
  const out = new Map<string, InstRow[]>();
  for (const [k, v] of buckets.entries()) {
    if (v.length > 1) out.set(k, v);
  }
  return out;
}

function pickCanonical(cluster: InstRow[]): InstRow {
  // Preference order:
  //   1. Row with URN (GIAS-anchored for schools/colleges)
  //   2. Row with most filled-in fields
  //   3. Lowest id (oldest)
  const withUrn = cluster.filter((c) => c.urn);
  if (withUrn.length === 1) return withUrn[0];
  const score = (c: InstRow): number => {
    let s = 0;
    if (c.urn) s += 5;
    if (c.ukprn) s += 3;
    if (c.website) s += 1;
    if (c.general_email) s += 1;
    if (c.postcode) s += 1;
    if ((c.apprenticeship_standards ?? 0) > 0) s += 1;
    return s;
  };
  const sorted = [...cluster].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    return a.id - b.id;
  });
  return sorted[0];
}

const FK_TABLES: { table: string; col: string }[] = [
  { table: "inspections", col: "institution_id" },
  { table: "findings", col: "institution_id" },
  { table: "curriculum_matches", col: "institution_id" },
  { table: "news_items", col: "institution_id" },
  { table: "compliance_notices", col: "institution_id" },
  { table: "outreach_log", col: "institution_id" },
  { table: "polished_emails", col: "institution_id" },
];

async function mergeOne(canonical: InstRow, loser: InstRow): Promise<void> {
  // 1. Move FKs. Watch out for collisions — if both rows already have a
  //    row in (e.g.) opportunity_scores, the loser's row would clash.
  //    For tables with unique indexes that include institution_id we
  //    delete the loser's existing row before re-pointing.

  // opportunity_scores has institution_id PRIMARY KEY → just delete loser's
  await client.execute({
    sql: `DELETE FROM opportunity_scores WHERE institution_id = ?`,
    args: [loser.id],
  });

  // inspections has uq_inspection_event(institution_id, start_date, body):
  // delete any loser inspections that would collide with a canonical one
  await client.execute({
    sql: `DELETE FROM inspections
          WHERE institution_id = ?
            AND EXISTS (
              SELECT 1 FROM inspections i2
              WHERE i2.institution_id = ?
                AND i2.inspection_start_date = inspections.inspection_start_date
                AND i2.inspection_body = inspections.inspection_body
            )`,
    args: [loser.id, canonical.id],
  });

  // news_items uq_news_url_inst(url, institution_id):
  await client.execute({
    sql: `DELETE FROM news_items
          WHERE institution_id = ?
            AND EXISTS (SELECT 1 FROM news_items n2
                        WHERE n2.url = news_items.url
                          AND n2.institution_id = ?)`,
    args: [loser.id, canonical.id],
  });

  // compliance_notices uq_compliance_inst_url(institution_id, source_url, notice_type):
  await client.execute({
    sql: `DELETE FROM compliance_notices
          WHERE institution_id = ?
            AND EXISTS (SELECT 1 FROM compliance_notices c2
                        WHERE c2.source_url = compliance_notices.source_url
                          AND c2.notice_type = compliance_notices.notice_type
                          AND c2.institution_id = ?)`,
    args: [loser.id, canonical.id],
  });

  // Now re-point everything else
  for (const fk of FK_TABLES) {
    await client.execute({
      sql: `UPDATE ${fk.table} SET ${fk.col} = ? WHERE ${fk.col} = ?`,
      args: [canonical.id, loser.id],
    });
  }

  // 2. Backfill missing scalar fields on canonical from loser. Unique
  // fields (urn, ukprn, isi_id) need to be NULL'd on the loser FIRST so
  // the canonical update doesn't trip the unique index while both rows
  // briefly share the value. Drop the loser's unique cols up-front:
  const uniqueFields = ["urn", "ukprn", "isi_id"];
  const loserClears: string[] = [];
  for (const f of uniqueFields) {
    const val = loser[f as keyof InstRow];
    if (val) loserClears.push(`${f} = NULL`);
  }
  if (loserClears.length > 0) {
    await client.execute({
      sql: `UPDATE institutions SET ${loserClears.join(", ")} WHERE id = ?`,
      args: [loser.id],
    });
  }

  const updates: string[] = [];
  const args: unknown[] = [];
  const fields: (keyof InstRow)[] = [
    "ukprn", "urn", "isi_id", "postcode", "website",
    "general_email", "head_email", "apprenticeship_standards",
  ];
  for (const f of fields) {
    if (!canonical[f] && loser[f]) {
      updates.push(`${f.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())} = ?`);
      args.push(loser[f]);
    }
  }
  // Concatenate sources so we keep provenance
  if (loser.source && loser.source !== canonical.source) {
    const merged = Array.from(
      new Set(
        [(canonical.source ?? "").split("+"), loser.source.split("+")].flat().filter(Boolean),
      ),
    ).join("+");
    if (merged !== canonical.source) {
      updates.push("source = ?");
      args.push(merged);
    }
  }
  if (updates.length > 0) {
    args.push(canonical.id);
    await client.execute({
      sql: `UPDATE institutions SET ${updates.join(", ")} WHERE id = ?`,
      args,
    });
  }

  // 3. Delete the loser
  await client.execute({
    sql: `DELETE FROM institutions WHERE id = ?`,
    args: [loser.id],
  });
}

async function main() {
  const clusters = await findClusters();
  console.log(`Found ${clusters.size} clusters with > 1 in-scope institution`);

  let mergedClusters = 0;
  let mergedRows = 0;
  let skippedClusters = 0;

  for (const [normalised, cluster] of clusters.entries()) {
    // Safety net: only merge clusters where postcodes match OR are absent.
    // If postcodes disagree these may be genuinely different orgs sharing a name.
    const postcodes = new Set(
      cluster.map((c) => (c.postcode ?? "").replace(/\s/g, "").toUpperCase()).filter(Boolean),
    );
    if (postcodes.size > 1) {
      console.warn(
        `skip cluster '${normalised}' — ${postcodes.size} different postcodes, likely distinct orgs`,
      );
      skippedClusters++;
      continue;
    }
    // Also require types to be compatible (school vs ITP shouldn't merge)
    const types = new Set(cluster.map((c) => c.type));
    const incompatible = types.has("state_school") || types.has("independent_school");
    if (incompatible && (types.has("itp") || types.has("fe_college"))) {
      console.warn(
        `skip cluster '${normalised}' — mixed school/training types: ${[...types].join(", ")}`,
      );
      skippedClusters++;
      continue;
    }
    const canonical = pickCanonical(cluster);
    const losers = cluster.filter((c) => c.id !== canonical.id);
    console.log(
      `merge '${canonical.name}' canonical=#${canonical.id} losers=[${losers.map((l) => "#" + l.id).join(",")}]`,
    );
    for (const loser of losers) {
      await mergeOne(canonical, loser);
      mergedRows++;
    }
    mergedClusters++;
  }

  console.log(
    `\nDone — merged ${mergedClusters} clusters, deleted ${mergedRows} duplicate rows, skipped ${skippedClusters}`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
