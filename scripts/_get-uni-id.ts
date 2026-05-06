import { client } from "../src/db";
async function main() {
  const r = await client.execute(`
    SELECT id, name FROM institutions
    WHERE type='university' AND apprenticeship_standards IS NOT NULL
    ORDER BY apprenticeship_standards DESC LIMIT 3
  `);
  for (const row of r.rows as unknown as { id: number; name: string }[]) {
    console.log(`${row.id}\t${row.name}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
