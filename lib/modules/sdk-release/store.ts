import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { sdkReleaseRun } from "@/lib/db/schema";

import type { RunState } from "./model";

/** One attempt to release, as the table holds it. */
export interface RunRow {
  id: number;
  version: string;
  branch: string;
  commitSha: string;
  suffix: string;
  ordinal: number;
  localOnly: boolean;
  state: RunState;
  pid: number;
  pgid: number;
  logPath: string;
  exitCode: number | null;
  phase: string;
  message: string;
  verified: string;
  /** `origin/main` of the swift repo when this run started. */
  mainSha: string;
  bootAt: number;
  startedAt: number;
  endedAt: number | null;
}

const toRow = (r: typeof sdkReleaseRun.$inferSelect): RunRow => ({
  ...r,
  state: r.state as RunState,
});

export function listRuns(limit = 20): RunRow[] {
  return db
    .select()
    .from(sdkReleaseRun)
    .orderBy(desc(sdkReleaseRun.id))
    .limit(limit)
    .all()
    .map(toRow);
}

export function getRun(id: number): RunRow | null {
  const r = db.select().from(sdkReleaseRun).where(eq(sdkReleaseRun.id, id)).get();
  return r ? toRow(r) : null;
}

/** The run still in flight, if any. At most one — the partial unique index. */
export function liveRun(): RunRow | null {
  const r = db
    .select()
    .from(sdkReleaseRun)
    .where(eq(sdkReleaseRun.state, "running"))
    .get();
  return r ? toRow(r) : null;
}

/**
 * Claims the slot before any process exists.
 *
 * Insert first, spawn second. The partial unique index on `state = 'running'`
 * rejects a second claim here, so "one release at a time" is settled by the
 * database rather than by a check that two requests could both pass. Throws on
 * collision; the caller turns that into a message.
 */
export function claimRun(input: {
  version: string;
  branch: string;
  commitSha: string;
  suffix: string;
  ordinal: number;
  localOnly: boolean;
  mainSha: string;
  bootAt: number;
}): number {
  return db
    .insert(sdkReleaseRun)
    .values({ ...input, state: "running" })
    .returning({ id: sdkReleaseRun.id })
    .get().id;
}

/**
 * Plain `UPDATE … WHERE id`, never an upsert.
 *
 * An upsert against a partial index has to repeat the index's predicate or
 * SQLite answers "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
 * constraint" — the same trap already documented on `task_notes_issue_idx`.
 * Nothing here needs an upsert, so nothing here uses one.
 */
export function updateRun(id: number, patch: Partial<Omit<RunRow, "id">>) {
  db.update(sdkReleaseRun).set(patch).where(eq(sdkReleaseRun.id, id)).run();
}

/** Marks a run finished, freeing the slot the unique index guards. */
export function finishRun(
  id: number,
  state: Exclude<RunState, "running">,
  patch: Partial<Omit<RunRow, "id" | "state">> = {},
) {
  db.update(sdkReleaseRun)
    .set({
      ...patch,
      state,
      endedAt: sql`(strftime('%s','now'))` as unknown as number,
    })
    .where(and(eq(sdkReleaseRun.id, id), eq(sdkReleaseRun.state, "running")))
    .run();
}
