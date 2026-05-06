// Server-side only. Imported by Next.js server components and by CLI scripts.
// Do not import this module from a client component.
import path from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __fledglings_db__: ReturnType<typeof drizzle<typeof schema>> | undefined;
  // eslint-disable-next-line no-var
  var __fledglings_libsql__: Client | undefined;
}

function resolveDatabaseUrl(): string {
  const configured = process.env.DATABASE_PATH ?? "./data/fledglings.db";
  if (configured.startsWith("file:") || configured.startsWith("libsql:")) {
    return configured;
  }
  const absolute = path.resolve(process.cwd(), configured);
  mkdirSync(path.dirname(absolute), { recursive: true });
  return pathToFileURL(absolute).href;
}

function openClient(): Client {
  const url = resolveDatabaseUrl();
  const client = createClient({ url });
  // Pragmas tuned for local single-writer use. busy_timeout makes SQLite
  // wait rather than instantly failing with SQLITE_BUSY when another
  // connection (e.g. the Next.js dev server) is mid-transaction.
  void client.execute("PRAGMA journal_mode = WAL");
  void client.execute("PRAGMA foreign_keys = ON");
  void client.execute("PRAGMA synchronous = NORMAL");
  void client.execute("PRAGMA busy_timeout = 30000");
  return client;
}

const client = globalThis.__fledglings_libsql__ ?? openClient();
const db = globalThis.__fledglings_db__ ?? drizzle(client, { schema });

if (process.env.NODE_ENV !== "production") {
  globalThis.__fledglings_libsql__ = client;
  globalThis.__fledglings_db__ = db;
}

export { db, client, schema };
export * from "./schema";
