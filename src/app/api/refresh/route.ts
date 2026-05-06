import { desc } from "drizzle-orm";
import { db, ingestionRuns } from "@/db";
import { ingestGias } from "@/lib/ingest/gias";
import { ingestOfstedMi } from "@/lib/ingest/ofsted-mi";
import { ingestOfstedProviders } from "@/lib/ingest/ofsted-providers";
import { ingestOfstedReports } from "@/lib/ingest/ofsted-reports";
import { ingestIsi } from "@/lib/ingest/isi";
import { runExtractor } from "@/lib/extract/extractor";
import { recomputeOpportunityScores } from "@/lib/extract/scoring";
import { recordRun } from "@/lib/ingest/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type State = {
  state: "idle" | "running" | "success" | "failed";
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  currentStage?: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __fledglings_refresh__: State | undefined;
}

function getState(): State {
  return globalThis.__fledglings_refresh__ ?? { state: "idle" };
}

function setState(next: State) {
  globalThis.__fledglings_refresh__ = next;
}

const STAGES: { name: string; run: () => Promise<unknown> }[] = [
  { name: "GIAS schools", run: () => recordRun("gias", () => ingestGias({ refresh: false }), "ui") },
  { name: "Ofsted MI", run: () => recordRun("ofsted_mi", () => ingestOfstedMi({ refresh: false }), "ui") },
  { name: "Provider pages (FE/ITP/sixth form)", run: () => recordRun("ofsted_providers", () => ingestOfstedProviders(), "ui") },
  { name: "Reports", run: () => recordRun("ofsted_reports", () => ingestOfstedReports({ refresh: false }), "ui") },
  { name: "ISI", run: () => recordRun("isi", () => ingestIsi(), "ui") },
  { name: "Extract findings", run: () => recordRun("extract", () => runExtractor(), "ui") },
  { name: "Score", run: () => recordRun("score", () => recomputeOpportunityScores(), "ui") },
];

async function runPipeline() {
  for (const stage of STAGES) {
    setState({
      ...getState(),
      currentStage: stage.name,
      message: `Running: ${stage.name}…`,
    });
    try {
      await stage.run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({
        state: "failed",
        startedAt: getState().startedAt,
        finishedAt: new Date().toISOString(),
        message: `${stage.name} failed: ${msg.slice(0, 160)}`,
      });
      return;
    }
  }
  setState({
    state: "success",
    startedAt: getState().startedAt,
    finishedAt: new Date().toISOString(),
    message: "Refresh complete",
  });
}

export async function POST() {
  const state = getState();
  if (state.state === "running") {
    return Response.json(
      { error: "Refresh already running", state },
      { status: 409 },
    );
  }
  setState({
    state: "running",
    startedAt: new Date().toISOString(),
    message: "Starting…",
  });
  // Fire-and-forget; updates `state` as it progresses.
  void runPipeline();
  return Response.json({ ok: true, state: getState() });
}

export async function GET() {
  const state = getState();
  // Augment with last few runs for the UI.
  const recent = await db
    .select({
      source: ingestionRuns.source,
      status: ingestionRuns.status,
      startedAt: ingestionRuns.startedAt,
      completedAt: ingestionRuns.completedAt,
      recordsUpserted: ingestionRuns.recordsUpserted,
    })
    .from(ingestionRuns)
    .orderBy(desc(ingestionRuns.startedAt))
    .limit(8);

  return Response.json({
    ...state,
    stages: recent.map((r) => ({
      source: r.source,
      status: r.status,
      recordsUpserted: r.recordsUpserted ?? 0,
    })),
  });
}
