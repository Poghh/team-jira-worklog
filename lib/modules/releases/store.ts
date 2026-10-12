import 'server-only'

import { desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { releaseTasks } from '@/lib/db/schema'

import { BUILD_STATUS, BUILT_STATUS, type FixCode, REPORTED_STATUS, type ReleaseTaskShape } from './model'

export interface ReleaseTaskRow extends ReleaseTaskShape {
  id: number
}

function parseFixes(raw: string): FixCode[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr
          .filter((f) => f && typeof f.code === 'string' && f.code.trim())
          .map((f) => ({ code: String(f.code).trim(), status: String(f.status || BUILD_STATUS[0]), ...(f.build ? { build: String(f.build) } : {}) }))
      : []
  } catch {
    return []
  }
}

function parseSub(raw: string): string[] {
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

export function listReleaseTasks(): ReleaseTaskRow[] {
  return db
    .select()
    .from(releaseTasks)
    .orderBy(desc(releaseTasks.updatedAt))
    .all()
    .map((r) => ({
      id: r.id,
      taskId: r.taskId,
      description: r.description,
      branchName: r.branchName,
      subTasks: parseSub(r.subTasks),
      product: r.product,
      team: r.team,
      environment: r.environment,
      buildStatus: r.buildStatus,
      noBranch: r.noBranch,
      refId: r.refId,
      fixes: parseFixes(r.fixes),
      publishedBuild: r.publishedBuild,
    }))
}

export function getReleaseTask(id: number): ReleaseTaskRow | undefined {
  return listReleaseTasks().find((t) => t.id === id)
}

export function saveReleaseTask(input: ReleaseTaskShape & { id?: number }): number {
  const stamp = sql`(strftime('%s','now'))` as unknown as number
  const values = {
    taskId: input.taskId,
    description: input.description,
    branchName: input.branchName,
    subTasks: JSON.stringify(input.subTasks),
    product: input.product,
    team: input.team,
    environment: input.environment,
    buildStatus: input.buildStatus,
    noBranch: input.noBranch,
    refId: input.refId,
    fixes: JSON.stringify(input.fixes),
    publishedBuild: input.publishedBuild,
    updatedAt: stamp,
  }

  if (input.id) {
    db.update(releaseTasks).set(values).where(eq(releaseTasks.id, input.id)).run()
    return input.id
  }
  return db.insert(releaseTasks).values(values).returning({ id: releaseTasks.id }).get().id
}

export interface ReleaseTaskPatch {
  environment?: string
  buildStatus?: string
  fixes?: FixCode[]
  refId?: number | null
  publishedBuild?: string
}

/** Quick edits from the board card — column, build status, fix codes, link. */
export function patchReleaseTask(id: number, patch: ReleaseTaskPatch) {
  const set: Record<string, unknown> = { updatedAt: sql`(strftime('%s','now'))` }
  if (patch.environment !== undefined) set.environment = patch.environment
  if (patch.buildStatus !== undefined) set.buildStatus = patch.buildStatus
  if (patch.fixes !== undefined) set.fixes = JSON.stringify(patch.fixes)
  if (patch.refId !== undefined) set.refId = patch.refId
  if (patch.publishedBuild !== undefined) set.publishedBuild = patch.publishedBuild
  db.update(releaseTasks).set(set).where(eq(releaseTasks.id, id)).run()
}

export function deleteReleaseTask(id: number) {
  db.delete(releaseTasks).where(eq(releaseTasks.id, id)).run()
}

/** Whether `token` appears in `text` as a standalone id (bounded by non-alnum). */
function mentions(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i').test(text)
}

/**
 * Promote every "đã build" task whose id is named in `text` to "đã public",
 * returning the ids moved. Called when an iOS build ships to testers — the
 * What-to-Test text lists exactly those tasks. Restricted to the "đã build"
 * stage so a stray mention can't jump a task straight from "đang PR" to public,
 * which also makes a repeat submit a no-op.
 */
export function publishBuiltTasksMentioned(text: string, build = ''): string[] {
  if (!text.trim()) return []
  const promoted: string[] = []
  for (const r of listReleaseTasks()) {
    const id = r.taskId.trim()
    if (r.buildStatus === BUILT_STATUS && id && mentions(text, id)) {
      patchReleaseTask(r.id, { buildStatus: REPORTED_STATUS, publishedBuild: build })
      promoted.push(id)
    }
    // Fix codes follow the same rule: only a built one can go public.
    let changed = false
    const fixes = r.fixes.map((f) => {
      if (f.status === BUILT_STATUS && mentions(text, f.code)) {
        changed = true
        promoted.push(f.code)
        return { ...f, status: REPORTED_STATUS, ...(build ? { build } : {}) }
      }
      return f
    })
    if (changed) patchReleaseTask(r.id, { fixes })
  }
  return promoted
}

/**
 * Marks exactly the codes the reviewer ticked as public in `build` — the
 * explicit half of what a TestFlight submit records. Only "đã build" codes
 * move, so a repeat or a stale page cannot republish anything.
 */
export function publishCodes(codes: Array<{ taskRowId: number; code: string; kind: 'feature' | 'fix' }>, build: string): string[] {
  const done: string[] = []
  const byRow = new Map<number, typeof codes>()
  for (const c of codes) byRow.set(c.taskRowId, [...(byRow.get(c.taskRowId) ?? []), c])
  for (const [rowId, list] of byRow) {
    const r = getReleaseTask(rowId)
    if (!r) continue
    if (list.some((c) => c.kind === 'feature') && r.buildStatus === BUILT_STATUS) {
      patchReleaseTask(r.id, { buildStatus: REPORTED_STATUS, publishedBuild: build })
      done.push(r.taskId)
    }
    const wanted = new Set(list.filter((c) => c.kind === 'fix').map((c) => c.code.toUpperCase()))
    if (wanted.size) {
      let changed = false
      const fixes = r.fixes.map((f) => {
        if (wanted.has(f.code.toUpperCase()) && f.status === BUILT_STATUS) {
          changed = true
          done.push(f.code)
          return { ...f, status: REPORTED_STATUS, build }
        }
        return f
      })
      if (changed) patchReleaseTask(r.id, { fixes })
    }
  }
  return done
}
