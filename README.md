# Fledglings Inspection Intelligence

Local-first sales intelligence dashboard. Ingests Ofsted (schools and FE & Skills) and ISI inspection reports, flags institutions whose latest inspection identifies weaknesses Fledglings' curricula can address, scores the opportunity, and prepares the lead for Instantly outreach.

Runs entirely on your machine. The only outbound network calls are to public government data sources (Ofsted, ISI, GIAS, UKRLP) for ingestion and to Instantly for pushing leads. No telemetry, no analytics.

## Quickstart

- `pnpm install` — install dependencies (one-off)
- `pnpm db:migrate` — create or update the SQLite schema at `./data/fledglings.db`
- `pnpm ingest` — pull the latest data from Ofsted, ISI, GIAS and UKRLP, extract findings, recompute scores
- `pnpm dev` — open the dashboard at <http://localhost:3000>
- `pwsh ./scripts/setup-windows-task.ps1` — register a Windows Task Scheduler entry that runs `pnpm ingest` every Monday at 06:00 (run once, in an admin PowerShell)

## What lives where

```
src/app/          Next.js App Router pages and route handlers
src/db/           Drizzle ORM schema, client, migration runner
src/lib/          Shared utilities (extractors, scrapers, scoring, instantly client)
src/components/   React components (added as the UI is built)
config/phrases/   YAML phrase libraries — one per curriculum, plus shared
config/email-angles/  Markdown email templates with {{merge_variables}}
drizzle/          Generated SQL migrations (committed)
data/             SQLite database file and cached raw HTML/PDF (not committed)
scripts/          CLI entry points (refresh, extract, score) and OS scripts
```

## Refresh schedule

Data refresh runs **on demand** (the "Refresh data" button in the dashboard, or `pnpm ingest` from a terminal) and **automatically every Monday at 06:00** via Windows Task Scheduler if you run `setup-windows-task.ps1`. Both invoke the same CLI; the scheduled task simply runs it for you so you wake up to fresh data at the start of the week.

## Conventions

- British English in all code, comments, UI copy, and commit messages.
- Never use the acronym for careers education — spell it out.
- Every flagged finding stores the verbatim source quote and section. If you can't link a claim to a specific paragraph in the report, it doesn't ship.
