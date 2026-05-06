import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

async function main() {
  const configured = process.env.DATABASE_PATH ?? "./data/fledglings.db";
  const isUrlScheme =
    configured.startsWith("file:") || configured.startsWith("libsql:");

  let url: string;
  if (isUrlScheme) {
    url = configured;
  } else {
    const absolute = path.resolve(process.cwd(), configured);
    mkdirSync(path.dirname(absolute), { recursive: true });
    url = pathToFileURL(absolute).href;
  }

  const migrationsFolder = path.resolve(process.cwd(), "./drizzle");

  if (!existsSync(migrationsFolder)) {
    console.error(
      `Migrations folder not found at ${migrationsFolder}. Run \`pnpm db:generate\` first to produce migrations from the schema.`,
    );
    process.exit(1);
  }

  const client = createClient({ url });
  const db = drizzle(client);

  console.log(`Applying migrations to ${url}`);
  const start = Date.now();

  try {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA foreign_keys = ON");
    await migrate(db, { migrationsFolder });
    console.log(`Migrations applied in ${Date.now() - start}ms`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
