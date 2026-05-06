// What Status values actually appear in the latest APAR CSV?
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";

const dir = path.resolve(process.cwd(), "data/raw/apar");
const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
if (files.length === 0) {
  console.error("no APAR CSVs cached");
  process.exit(1);
}
const latest = files[files.length - 1];
console.log(`Latest cached APAR: ${latest}`);

const raw = readFileSync(path.join(dir, latest), "utf-8");
const rows = parseCsv(raw, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  relax_quotes: true,
  bom: true,
}) as Record<string, string>[];

console.log(`\nTotal rows: ${rows.length}`);
console.log(`Columns: ${Object.keys(rows[0] ?? {}).join(", ")}`);

const statusCounts = new Map<string, number>();
const typeStatusCounts = new Map<string, number>();
const sampleByStatus: Record<string, { name: string; ukprn: string; type: string }[]> = {};

for (const row of rows) {
  const status = (row.Status ?? "").trim();
  const type = (row.ApplicationType ?? "").trim();
  statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  const key = `${type} | ${status}`;
  typeStatusCounts.set(key, (typeStatusCounts.get(key) ?? 0) + 1);
  if (!sampleByStatus[status]) sampleByStatus[status] = [];
  if (sampleByStatus[status].length < 3) {
    sampleByStatus[status].push({ name: row.Name, ukprn: row.Ukprn, type });
  }
}

console.log("\n=== Status counts ===");
for (const [s, n] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(5)}  ${s || "(empty)"}`);
}

console.log("\n=== Type × Status ===");
for (const [k, n] of [...typeStatusCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(5)}  ${k}`);
}

console.log("\n=== Sample providers per status ===");
for (const [s, samples] of Object.entries(sampleByStatus)) {
  console.log(`\n  Status: "${s}"`);
  for (const sample of samples) {
    console.log(`    - ${sample.name} (UKPRN ${sample.ukprn}, ${sample.type})`);
  }
}
