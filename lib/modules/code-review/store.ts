import 'server-only'

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { reviewFindings, reviewItems, reviewMessages, reviewRounds } from '@/lib/db/schema'

import {
  type DocFile,
  type FindingStatus,
  type FindingView,
  type ItemKind,
  type ItemSummary,
  type ItemView,
  LIVE_STATES,
  type Addressee,
  type PrLink,
  type RoundLink,
  type RoundState,
  type RoundView,
  type Severity,
  type Verdict,
} from './model'

const nowSql = sql`(strftime('%s','now'))` as unknown as number

function parseAddressee(raw: string): Addressee | null {
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as Addressee
    return a && typeof a.handle === 'string' && a.handle ? a : null
  } catch {
    return null
  }
}

export function setItemAddressee(id: number, a: Addressee | null) {
  db.update(reviewItems).set({ addressee: a ? JSON.stringify(a) : '' }).where(eq(reviewItems.id, id)).run()
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function parseDocs(raw: string): DocFile[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as DocFile[]) : []
  } catch {
    return []
  }
}

const toItem = (r: typeof reviewItems.$inferSelect): ItemView => ({
  id: r.id,
  kind: r.kind as ItemKind,
  repoId: r.repoId,
  title: r.title,
  prNumber: r.prNumber,
  baseRef: r.baseRef,
  headRef: r.headRef,
  author: r.author,
  url: r.url,
  note: r.note,
  status: r.status === 'archived' ? 'archived' : 'open',
  seenAt: r.seenAt,
  links: parseJsonArray<PrLink>(r.links),
  addressee: parseAddressee(r.addressee),
  updatedAt: r.updatedAt,
})

export const toRound = (r: typeof reviewRounds.$inferSelect): RoundView => ({
  id: r.id,
  itemId: r.itemId,
  round: r.round,
  state: r.state as RoundState,
  baseSha: r.baseSha,
  headSha: r.headSha,
  prevHeadSha: r.prevHeadSha,
  docs: parseDocs(r.docs),
  links: parseJsonArray<RoundLink>(r.links),
  verdict: r.verdict as Verdict | '',
  summary: r.summary,
  message: r.message,
  costUsd: r.costUsd,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
})

const toFinding = (r: typeof reviewFindings.$inferSelect): FindingView => ({
  id: r.id,
  roundId: r.roundId,
  prevId: r.prevId,
  file: r.file,
  line: r.line,
  endLine: r.endLine,
  location: r.location,
  severity: r.severity as Severity,
  category: r.category,
  title: r.title,
  body: r.body,
  snippet: r.snippet,
  snippetStart: r.snippetStart,
  inDiff: r.inDiff,
  origin: r.origin === 'carried' ? 'carried' : 'new',
  status: r.status as FindingStatus,
  followNote: r.followNote,
  ghCommentId: r.ghCommentId,
  ghUrl: r.ghUrl,
})

/* ── items ──────────────────────────────────────────────────────────────── */

export function getItem(id: number): ItemView | null {
  const r = db.select().from(reviewItems).where(eq(reviewItems.id, id)).get()
  return r ? toItem(r) : null
}

/** An open item already tracking this PR, so "Review" twice does not fork it. */
export function findPrItem(repoId: string, prNumber: number): ItemView | null {
  const r = db
    .select()
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.repoId, repoId),
        eq(reviewItems.prNumber, prNumber),
        eq(reviewItems.status, 'open'),
      ),
    )
    .get()
  return r ? toItem(r) : null
}

export function createItem(
  input: Omit<ItemView, 'id' | 'status' | 'updatedAt' | 'seenAt' | 'links' | 'addressee'> & { links?: PrLink[] },
): number {
  const { links, ...rest } = input
  return db
    .insert(reviewItems)
    .values({ ...rest, links: JSON.stringify(links ?? []) })
    .returning({ id: reviewItems.id })
    .get().id
}

export function setItemLinks(id: number, links: PrLink[]) {
  db.update(reviewItems).set({ links: JSON.stringify(links) }).where(eq(reviewItems.id, id)).run()
}

export function patchItem(id: number, patch: Partial<Omit<ItemView, 'id' | 'links' | 'addressee'>>) {
  db.update(reviewItems).set({ ...patch, updatedAt: nowSql }).where(eq(reviewItems.id, id)).run()
}

/** Marks the discussion read without bumping the item up the dashboard. */
export function markSeen(id: number) {
  db.update(reviewItems).set({ seenAt: Math.floor(Date.now() / 1000) }).where(eq(reviewItems.id, id)).run()
}

export function deleteItem(id: number) {
  const roundIds = db.select({ id: reviewRounds.id }).from(reviewRounds).where(eq(reviewRounds.itemId, id)).all().map((r) => r.id)
  if (roundIds.length) db.delete(reviewMessages).where(inArray(reviewMessages.roundId, roundIds)).run()
  db.delete(reviewFindings).where(eq(reviewFindings.itemId, id)).run()
  db.delete(reviewRounds).where(eq(reviewRounds.itemId, id)).run()
  db.delete(reviewItems).where(eq(reviewItems.id, id)).run()
}

export function listItems(status: 'open' | 'archived' = 'open'): ItemSummary[] {
  const items = db
    .select()
    .from(reviewItems)
    .where(eq(reviewItems.status, status))
    .orderBy(desc(reviewItems.updatedAt))
    .all()
  if (!items.length) return []
  const ids = items.map((i) => i.id)
  const rounds = db
    .select()
    .from(reviewRounds)
    .where(inArray(reviewRounds.itemId, ids))
    .orderBy(asc(reviewRounds.round))
    .all()
  const latest = new Map<number, typeof reviewRounds.$inferSelect>()
  const counts = new Map<number, number>()
  for (const r of rounds) {
    latest.set(r.itemId, r)
    counts.set(r.itemId, (counts.get(r.itemId) ?? 0) + 1)
  }
  const latestIds = [...latest.values()].map((r) => r.id)
  const open = new Map<number, number>()
  if (latestIds.length) {
    for (const f of db
      .select({ roundId: reviewFindings.roundId, status: reviewFindings.status })
      .from(reviewFindings)
      .where(inArray(reviewFindings.roundId, latestIds))
      .all()) {
      if (f.status !== 'fixed' && f.status !== 'dismissed') open.set(f.roundId, (open.get(f.roundId) ?? 0) + 1)
    }
  }
  return items.map((i) => {
    const l = latest.get(i.id)
    return {
      ...toItem(i),
      latest: l ? toRound(l) : null,
      rounds: counts.get(i.id) ?? 0,
      openFindings: l ? open.get(l.id) ?? 0 : 0,
    }
  })
}

/* ── rounds ─────────────────────────────────────────────────────────────── */

export type RoundRow = typeof reviewRounds.$inferSelect

export function getRound(id: number): RoundRow | null {
  return db.select().from(reviewRounds).where(eq(reviewRounds.id, id)).get() ?? null
}

export function listRounds(itemId: number): RoundView[] {
  return db
    .select()
    .from(reviewRounds)
    .where(eq(reviewRounds.itemId, itemId))
    .orderBy(asc(reviewRounds.round))
    .all()
    .map(toRound)
}

export function lastRound(itemId: number): RoundRow | null {
  return (
    db
      .select()
      .from(reviewRounds)
      .where(eq(reviewRounds.itemId, itemId))
      .orderBy(desc(reviewRounds.round))
      .get() ?? null
  )
}

/** The newest round that finished — the baseline a follow-up compares against. */
export function lastDoneRound(itemId: number): RoundRow | null {
  return (
    db
      .select()
      .from(reviewRounds)
      .where(and(eq(reviewRounds.itemId, itemId), eq(reviewRounds.state, 'done')))
      .orderBy(desc(reviewRounds.round))
      .get() ?? null
  )
}

export function queueRound(itemId: number, docs: DocFile[] = []): number {
  const last = lastRound(itemId)
  const id = db
    .insert(reviewRounds)
    .values({ itemId, round: (last?.round ?? 0) + 1, state: 'queued', docs: JSON.stringify(docs) })
    .returning({ id: reviewRounds.id })
    .get().id
  patchItem(itemId, {})
  return id
}

export function roundsIn(states: RoundState[]): RoundRow[] {
  return db
    .select()
    .from(reviewRounds)
    .where(inArray(reviewRounds.state, states))
    .orderBy(asc(reviewRounds.id))
    .all()
}

export function hasLiveRound(itemId: number): boolean {
  return Boolean(
    db
      .select({ id: reviewRounds.id })
      .from(reviewRounds)
      .where(and(eq(reviewRounds.itemId, itemId), inArray(reviewRounds.state, LIVE_STATES)))
      .get(),
  )
}

export function updateRound(id: number, patch: Partial<Omit<RoundRow, 'id'>>) {
  db.update(reviewRounds).set(patch).where(eq(reviewRounds.id, id)).run()
}

/**
 * Moves a round from one state to another only if it is still in `from` —
 * the compare-and-set that keeps two polls from starting the same round.
 */
export function transitionRound(
  id: number,
  from: RoundState[],
  to: RoundState,
  patch: Partial<Omit<RoundRow, 'id' | 'state'>> = {},
): boolean {
  const res = db
    .update(reviewRounds)
    .set({ ...patch, state: to })
    .where(and(eq(reviewRounds.id, id), inArray(reviewRounds.state, from)))
    .run()
  return res.changes > 0
}

export function finishRound(
  id: number,
  state: Exclude<RoundState, 'queued' | 'preparing' | 'running' | 'finalizing'>,
  patch: Partial<Omit<RoundRow, 'id' | 'state'>> = {},
): boolean {
  return transitionRound(id, ['queued', 'preparing', 'running', 'finalizing'], state, {
    ...patch,
    endedAt: nowSql,
  })
}

/* ── findings ───────────────────────────────────────────────────────────── */

export function listFindings(roundId: number): FindingView[] {
  return db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.roundId, roundId))
    .orderBy(asc(reviewFindings.position), asc(reviewFindings.id))
    .all()
    .map(toFinding)
}

export function listItemFindings(itemId: number): FindingView[] {
  return db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.itemId, itemId))
    .orderBy(asc(reviewFindings.position), asc(reviewFindings.id))
    .all()
    .map(toFinding)
}

/** Findings of a round the next round must re-check: not fixed, not dismissed. */
export function openFindings(roundId: number): FindingView[] {
  return listFindings(roundId).filter((f) => f.status !== 'fixed' && f.status !== 'dismissed')
}

export function insertFindings(rows: Array<typeof reviewFindings.$inferInsert>) {
  if (!rows.length) return
  db.insert(reviewFindings).values(rows).run()
}

export function patchFinding(
  id: number,
  patch: { body?: string; status?: FindingStatus; title?: string; ghCommentId?: number | null; ghUrl?: string },
) {
  db.update(reviewFindings).set(patch).where(eq(reviewFindings.id, id)).run()
}

export function getFinding(id: number): FindingView | null {
  const r = db.select().from(reviewFindings).where(eq(reviewFindings.id, id)).get()
  return r ? toFinding(r) : null
}

/* ── chat ───────────────────────────────────────────────────────────────── */

export type MessageRow = typeof reviewMessages.$inferSelect

export function listMessages(roundId: number): MessageRow[] {
  return db.select().from(reviewMessages).where(eq(reviewMessages.roundId, roundId)).orderBy(asc(reviewMessages.id)).all()
}

export function getMessage(id: number): MessageRow | null {
  return db.select().from(reviewMessages).where(eq(reviewMessages.id, id)).get() ?? null
}

export function insertMessage(row: typeof reviewMessages.$inferInsert): number {
  return db.insert(reviewMessages).values(row).returning({ id: reviewMessages.id }).get().id
}

export function updateMessage(id: number, patch: Partial<Omit<MessageRow, 'id'>>) {
  db.update(reviewMessages).set(patch).where(eq(reviewMessages.id, id)).run()
}

/** Ends a running assistant turn — only if it is still running (compare-and-set). */
export function finishMessage(id: number, state: 'done' | 'failed' | 'cancelled' | 'lost', patch: Partial<Omit<MessageRow, 'id' | 'state'>> = {}) {
  return (
    db
      .update(reviewMessages)
      .set({ ...patch, state, endedAt: nowSql })
      .where(and(eq(reviewMessages.id, id), eq(reviewMessages.state, 'running')))
      .run().changes > 0
  )
}

export function runningMessages(): MessageRow[] {
  return db.select().from(reviewMessages).where(eq(reviewMessages.state, 'running')).all()
}

export function patchFindingFull(id: number, patch: Partial<Omit<typeof reviewFindings.$inferInsert, 'id'>>) {
  db.update(reviewFindings).set(patch).where(eq(reviewFindings.id, id)).run()
}
