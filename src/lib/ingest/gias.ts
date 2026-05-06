/**
 * GIAS (Get Information about Schools) adapter.
 *
 * Source: https://get-information-schools.service.gov.uk/Downloads
 * The bulk "All establishment data" CSV is published daily under a
 * predictable URL pattern. We try today, then walk back up to a week to
 * tolerate publishing delays.
 *
 * The CSV has ~50k rows covering every English school. We filter to in-scope
 * (secondary+, England, open) and upsert into `institutions` keyed on URN.
 */

import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { format, subDays } from "date-fns";
import { eq, sql } from "drizzle-orm";
import { db, institutions } from "@/db";
import { fetchToFile } from "./fetch";
import { log } from "./log";
import { classifyScope, mapInstitutionType } from "./scope";
import type { RunResult } from "./run";

const GIAS_BASE =
  process.env.GIAS_BASE_URL ??
  "https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public";

const URL_OVERRIDE = process.env.GIAS_DOWNLOAD_URL;

async function findGiasUrl(): Promise<string> {
  if (URL_OVERRIDE) {
    log.info(`gias: using GIAS_DOWNLOAD_URL override`);
    return URL_OVERRIDE;
  }
  // GIAS publishes Mon-Fri. The Azure endpoint returns 500 on HEAD but is
  // happy with a ranged GET, so we probe with a 1-byte read.
  for (let daysBack = 0; daysBack <= 10; daysBack++) {
    const stamp = format(subDays(new Date(), daysBack), "yyyyMMdd");
    const candidate = `${GIAS_BASE}/edubasealldata${stamp}.csv`;
    try {
      const probe = await fetch(candidate, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
      });
      // 200 (no range support) and 206 (partial content) both mean the file exists.
      if (probe.status === 200 || probe.status === 206) {
        // Drain the tiny body so the connection can be reused.
        await probe.arrayBuffer();
        log.info(`gias: latest download is ${stamp} (${daysBack}d back)`);
        return candidate;
      }
    } catch (err) {
      log.debug(`gias: probe ${candidate} failed: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `Could not find an accessible GIAS download in the last 10 days. ` +
      `Set GIAS_DOWNLOAD_URL in .env to a known-good URL to override.`,
  );
}

type GiasRow = Record<string, string>;

function pick(row: GiasRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

function parseAge(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function joinAddress(row: GiasRow): string | null {
  const parts = [
    pick(row, "Street"),
    pick(row, "Locality"),
    pick(row, "Town"),
    pick(row, "County (name)"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function headFullName(row: GiasRow): string | null {
  const title = pick(row, "HeadTitle (name)");
  const first = pick(row, "HeadFirstName");
  const last = pick(row, "HeadLastName");
  const parts = [title, first, last].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

export async function ingestGias(opts: {
  refresh?: boolean;
} = {}): Promise<RunResult> {
  const url = await findGiasUrl();
  const cached = await fetchToFile(url, {
    subdir: "gias",
    filenameHint: "edubasealldata",
    extension: ".csv",
    maxAgeMs: opts.refresh ? 0 : 7 * 24 * 60 * 60 * 1000,
  });

  log.info(
    `gias: parsing ${cached.localPath} (${(cached.bytes / 1024 / 1024).toFixed(1)} MB)`,
  );

  // GIAS files are Windows-1252 with the £ glyph etc. csv-parse handles UTF-8
  // by default; we read as latin1 and the columns we use are ASCII-clean.
  const raw = readFileSync(cached.localPath, "latin1");
  const rows = parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as GiasRow[];

  log.info(`gias: parsed ${rows.length.toLocaleString()} rows from CSV`);

  let seen = 0;
  let inScope = 0;
  let upserted = 0;
  const now = new Date();
  const BATCH_SIZE = 500;
  let batch: Array<typeof institutions.$inferInsert> = [];

  async function flush() {
    if (!batch.length) return;
    for (const row of batch) {
      await db
        .insert(institutions)
        .values(row)
        .onConflictDoUpdate({
          target: institutions.urn,
          set: {
            name: row.name,
            type: row.type,
            phase: row.phase,
            region: row.region,
            localAuthority: row.localAuthority,
            postcode: row.postcode,
            address: row.address,
            gender: row.gender,
            religiousCharacter: row.religiousCharacter,
            website: row.website,
            phone: row.phone,
            generalEmail: row.generalEmail,
            headName: row.headName,
            inScope: row.inScope,
            outOfScopeReason: row.outOfScopeReason,
            source: row.source,
            updatedAt: now,
          },
        });
      upserted++;
    }
    batch = [];
  }

  for (const row of rows) {
    seen++;
    const urn = pick(row, "URN");
    if (!urn) continue;

    const status = pick(row, "EstablishmentStatus (name)");
    const phase = pick(row, "PhaseOfEducation (name)");
    const typeName = pick(row, "TypeOfEstablishment (name)");
    const highAge = parseAge(pick(row, "StatutoryHighAge"));
    const lowAge = parseAge(pick(row, "StatutoryLowAge"));

    const scope = classifyScope({
      status,
      phase,
      typeOfEstablishment: typeName,
      statutoryHighAge: highAge,
      statutoryLowAge: lowAge,
    });

    if (!scope.inScope) {
      // Skip silently — out-of-scope rows aren't worth a DB write.
      continue;
    }
    inScope++;

    const name = pick(row, "EstablishmentName") ?? `URN ${urn}`;
    const region = pick(row, "GOR (name)");
    const la = pick(row, "LA (name)");
    const postcode = pick(row, "Postcode");
    const phone = pick(row, "TelephoneNum");
    const website = pick(row, "SchoolWebsite");
    const email = pick(row, "SchoolEmail");
    const gender = pick(row, "Gender (name)");
    const religion = pick(row, "ReligiousCharacter (name)");
    const address = joinAddress(row);
    const head = headFullName(row);

    batch.push({
      urn,
      name,
      type: mapInstitutionType(typeName),
      phase,
      region,
      localAuthority: la,
      postcode,
      address,
      gender,
      religiousCharacter: religion,
      website,
      phone,
      generalEmail: email,
      headName: head,
      inScope: true,
      outOfScopeReason: null,
      source: "gias",
      updatedAt: now,
      createdAt: now,
    });

    if (batch.length >= BATCH_SIZE) {
      await flush();
      if (upserted % 2000 === 0) {
        log.info(
          `gias: upserted ${upserted.toLocaleString()} so far (in-scope=${inScope.toLocaleString()})`,
        );
      }
    }
  }

  await flush();

  log.info(
    `gias: complete — rows=${seen.toLocaleString()} in_scope=${inScope.toLocaleString()} upserted=${upserted.toLocaleString()}`,
  );

  return {
    recordsSeen: seen,
    recordsUpserted: upserted,
    notes: `In scope: ${inScope}; cached: ${cached.fromCache}`,
  };
}
