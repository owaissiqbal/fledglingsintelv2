import { and, eq } from "drizzle-orm";
import { db, ingestionRuns } from "@/db";
import { log } from "./log";

export type RunResult = {
  recordsSeen: number;
  recordsUpserted: number;
  notes?: string;
};

export async function recordRun<T extends RunResult>(
  source: string,
  fn: () => Promise<T>,
  triggeredBy: string = "cli",
): Promise<T> {
  // Self-heal: if a prior run for this source died without flipping its
  // status (SIGKILL, power-off, unhandled crash), the row will sit at
  // 'running' forever. Mark any such rows failed before starting fresh.
  const interrupted = await db
    .update(ingestionRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorMessage: "interrupted (process exited without recording completion)",
    })
    .where(
      and(eq(ingestionRuns.source, source), eq(ingestionRuns.status, "running")),
    )
    .returning({ id: ingestionRuns.id });
  if (interrupted.length > 0) {
    log.warn(
      `${source}: marked ${interrupted.length} prior interrupted run(s) as failed`,
    );
  }

  const [{ id }] = await db
    .insert(ingestionRuns)
    .values({
      source,
      status: "running",
      triggeredBy,
    })
    .returning({ id: ingestionRuns.id });

  const startedAt = Date.now();
  log.info(`${source}: run #${id} started`);

  try {
    const result = await fn();
    await db
      .update(ingestionRuns)
      .set({
        status: "success",
        completedAt: new Date(),
        recordsSeen: result.recordsSeen,
        recordsUpserted: result.recordsUpserted,
        errorMessage: result.notes ?? null,
      })
      .where(eq(ingestionRuns.id, id));

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log.info(
      `${source}: run #${id} done in ${elapsed}s — seen=${result.recordsSeen} upserted=${result.recordsUpserted}`,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(ingestionRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
      })
      .where(eq(ingestionRuns.id, id));
    log.error(`${source}: run #${id} failed — ${message}`);
    throw err;
  }
}
