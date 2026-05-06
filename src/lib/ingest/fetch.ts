import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, rawDocuments } from "@/db";
import { log } from "./log";

const RAW_ROOT = path.resolve(
  process.cwd(),
  process.env.RAW_DOCS_PATH ?? "./data/raw",
);

const USER_AGENT =
  process.env.USER_AGENT ??
  "Fledglings-ICP-Bot/1.0 (internal tooling; replace USER_AGENT in .env)";

export type FetchResult = {
  url: string;
  localPath: string;
  bytes: number;
  fromCache: boolean;
  statusCode: number;
  contentType: string | null;
  sha256: string;
};

function localPathFor(url: string, subdir: string, hint?: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  const filename = hint ? `${hint}-${hash}` : hash;
  return path.join(RAW_ROOT, subdir, filename);
}

function ageMs(filePath: string): number | null {
  try {
    return Date.now() - statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function staleCacheFallback(
  localPath: string,
  url: string,
): FetchResult | null {
  try {
    const stat = statSync(localPath);
    return {
      url,
      localPath,
      bytes: stat.size,
      fromCache: true,
      statusCode: 0,
      contentType: null,
      sha256: "",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a URL once, cache the bytes on disk under data/raw/<subdir>/, and
 * record the fetch in the raw_documents table. Subsequent calls within
 * `maxAgeMs` return the cached file without hitting the network.
 */
export async function fetchToFile(
  url: string,
  options: {
    subdir: string;
    filenameHint?: string;
    maxAgeMs?: number;
    extension?: string;
  },
): Promise<FetchResult> {
  const maxAge = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const ext = options.extension ?? path.extname(new URL(url).pathname) ?? "";
  const base = localPathFor(url, options.subdir, options.filenameHint);
  const localPath = ext ? `${base}${ext}` : base;

  const cached = ageMs(localPath);
  if (cached !== null && cached < maxAge) {
    const stat = statSync(localPath);
    log.debug(
      `cache hit ${url} (${(cached / 1000 / 60).toFixed(0)}m old, ${stat.size}B)`,
    );
    const existing = await db
      .select()
      .from(rawDocuments)
      .where(eq(rawDocuments.url, url))
      .limit(1);
    return {
      url,
      localPath,
      bytes: stat.size,
      fromCache: true,
      statusCode: existing[0]?.statusCode ?? 200,
      contentType: existing[0]?.contentType ?? null,
      sha256: existing[0]?.sha256 ?? "",
    };
  }

  log.info(`fetching ${url}`);
  mkdirSync(path.dirname(localPath), { recursive: true });

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      redirect: "follow",
    });
  } catch (err) {
    // Network blew up. If we have any prior cache for this file, return it
    // even though it's stale — better than failing the whole pipeline.
    const fallback = staleCacheFallback(localPath, url);
    if (fallback) return fallback;
    throw err;
  }

  if (!response.ok) {
    const fallback = staleCacheFallback(localPath, url);
    if (fallback) {
      log.warn(
        `fetch ${url} -> HTTP ${response.status}; using stale on-disk cache`,
      );
      return fallback;
    }
    throw new Error(
      `fetch ${url} -> HTTP ${response.status} ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(localPath, buffer);

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const contentType = response.headers.get("content-type");

  await db
    .insert(rawDocuments)
    .values({
      url,
      contentType,
      statusCode: response.status,
      sha256,
      localPath: path.relative(process.cwd(), localPath),
      bytes: buffer.byteLength,
    })
    .onConflictDoUpdate({
      target: rawDocuments.url,
      set: {
        contentType,
        statusCode: response.status,
        sha256,
        localPath: path.relative(process.cwd(), localPath),
        bytes: buffer.byteLength,
        fetchedAt: new Date(),
      },
    });

  log.info(`fetched ${url} (${buffer.byteLength.toLocaleString()} bytes)`);

  return {
    url,
    localPath,
    bytes: buffer.byteLength,
    fromCache: false,
    statusCode: response.status,
    contentType,
    sha256,
  };
}
