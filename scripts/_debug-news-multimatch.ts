import { client } from "../src/db";

async function main() {
  const r = await client.execute(`
    SELECT id, name, type, urn, ukprn
    FROM institutions
    WHERE id IN (2299, 8820, 2384, 8906, 2352, 8874, 2266, 8786, 2225)
    ORDER BY id
  `);
  console.table(r.rows);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
