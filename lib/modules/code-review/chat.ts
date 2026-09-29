import 'server-only'

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { checkClaude } from './claude'
import { getRepo, getReviewConfig, resolveAddressee, templatesForDocs } from './config'
import { type RawFinding, buildFreshRows, cleanSeverity } from './findings'
import { addWorktree, diffRanges, gitSays, removeWorktree, withRepoLock } from './git'
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, ISOLATION_FLAGS, reviewEnv } from './guard'
import type { DocFile, FindingView } from './model'
import { type LogLine, bootTime, lastResult, parseLog, pidAlive, readLog, strayLines } from './proc'
import { cleanupLinks, linkDirs, restoreLinks } from './links'
import { CHAT_SCHEMA, chatPrompt } from './prompts'
import {
  type MessageRow,
  finishMessage,
  getItem,
  getMessage,
  getRound,
  insertFindings,
  insertMessage,
  listFindings,
  listMessages,
  listRounds,
  patchFindingFull,
  runningMessages,
  toRound,
  updateMessage,
  updateRound,
} from './store'

/**
 * Talking to Claude about a finished round, so a first-pass review can become
 * the one that gets posted.
 *
 * Each turn is `claude -p --resume <the round's session>`: the same
 * conversation that did the review, so it still knows what it read. Resuming
 * needs the same working directory, so the round's worktree is recreated at
 * the path it had (`r<roundId>`) at the same sha, and removed again after the
 * turn. A turn runs detached under the same supervisor, same read-only tools,
 * same isolation and environment as the review itself (guard.ts).
 *
 * Claude may *propose* changes to the review; they are stored with the turn
 * and touch nothing until the reviewer applies them.
 */

const LOG_DIR = path.join(process.cwd(), 'data', 'code-review', 'logs')
const SUPERVISOR = path.join(process.cwd(), 'lib/modules/code-review/supervise.mjs')

export interface ChatChanges {
  summary_comment?: string
  update?: Array<{ id: number; title?: string; comment?: string; severity?: string; dismiss?: boolean; reason?: string }>
  add?: RawFinding[]
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  body: string
  changes: ChatChanges | null
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'lost'
  applied: boolean
  message: string
  costUsd: number
  createdAt: number
  /** What Claude is doing right now, while the turn runs. */
  activity: LogLine[]
}

function parseChanges(raw: string): ChatChanges | null {
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as ChatChanges
    const empty = !c.update?.length && !c.add?.length
    return empty ? null : c
  } catch {
    return null
  }
}

function parseDocs(raw: string): DocFile[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export async function listChat(roundId: number): Promise<ChatMessage[]> {
  const rows = listMessages(roundId)
  return Promise.all(
    rows.map(async (m) => ({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      body: m.body,
      changes: parseChanges(m.changes),
      state: m.state as ChatMessage['state'],
      applied: m.applied,
      message: m.message,
      costUsd: m.costUsd,
      createdAt: m.createdAt,
      activity: m.state === 'running' && m.logPath ? parseLog(await readLog(m.logPath), m.workdir, 4) : [],
    })),
  )
}

/** Where the turn must run to resume the round's session, recreated if needed. */
async function workspace(roundId: number): Promise<{ workdir: string; addDirs: string[]; repoPath: string } | string> {
  const round = getRound(roundId)
  const item = round ? getItem(round.itemId) : null
  if (!round || !item) return 'Không thấy vòng review.'
  const repo = item.repoId ? getRepo(item.repoId) : undefined
  if (item.repoId && !repo) return 'Repo của hồ sơ này đã bị xoá khỏi Cấu hình.'

  const docs = parseDocs(round.docs)
  if (item.kind === 'doc') {
    const prev = listRounds(item.id).filter((r) => r.round < round.round && r.state === 'done').at(-1)
    if (prev) docs.push(...prev.docs)
  }
  const addDirs: string[] = []
  const templateFiles = templatesForDocs(docs, item.templateId).flatMap((u) => u.template.files)
  for (const d of [...docs, ...templateFiles]) {
    const dir = path.dirname(d.path)
    if (!addDirs.includes(dir)) addDirs.push(dir)
  }

  if (!repo) {
    if (!addDirs[0]) return 'Vòng này không có code hay tài liệu để đối chiếu.'
    return { workdir: addDirs[0], addDirs, repoPath: '' }
  }
  if (!round.headSha) return 'Vòng này chưa có commit để mở lại.'
  try {
    // The session lives under the directory the round ran in, so recreate
    // exactly that one — its recorded name, not one derived from the id.
    const name = round.workdir ? path.basename(round.workdir) : `r${roundId}`
    const workdir = await withRepoLock(repo.localPath, () => addWorktree(repo.localPath, name, round.headSha))
    // The linked PRs, back where the session last read them.
    const links = await restoreLinks(roundId, toRound(round).links)
    addDirs.push(...linkDirs(links))
    return { workdir, addDirs, repoPath: repo.localPath }
  } catch (err) {
    return `Không mở lại được code của vòng này: ${gitSays(err)}`
  }
}

export async function sendChat(roundId: number, text: string): Promise<{ ok: boolean; message: string }> {
  const body = text.trim()
  if (!body) return { ok: false, message: 'Tin nhắn trống.' }
  const round = getRound(roundId)
  if (!round) return { ok: false, message: 'Không thấy vòng review này nữa (có thể đã bị xoá) — tải lại trang.' }
  if (round.state !== 'done') return { ok: false, message: 'Chỉ trao đổi được với vòng review đã xong.' }
  if (listMessages(roundId).some((m) => m.state === 'running')) {
    return { ok: false, message: 'Claude đang trả lời tin trước — đợi chút.' }
  }
  const claude = await checkClaude()
  if (!claude.ok) return { ok: false, message: claude.problem }

  const item = getItem(round.itemId)!
  insertMessage({ roundId, role: 'user', body, state: 'done' })
  const replyId = insertMessage({ roundId, role: 'assistant', state: 'running', bootAt: await bootTime() })
  const fail = (message: string) => {
    finishMessage(replyId, 'failed', { message })
    return { ok: false, message }
  }

  const ws = await workspace(roundId)
  if (typeof ws === 'string') return fail(ws)

  const resume = round.sessionId
  const prompt = chatPrompt({
    kind: item.kind,
    message: body,
    summary: round.summary,
    findings: listFindings(roundId),
    fresh: resume ? null : { title: item.title, baseSha: round.baseSha, headSha: round.headSha, docs: parseDocs(round.docs) },
    addressee: resolveAddressee(item),
  })

  await fs.mkdir(LOG_DIR, { recursive: true })
  const logPath = path.join(LOG_DIR, `m${replyId}.jsonl`)
  await fs.writeFile(logPath, '')
  await fs.rm(`${logPath}.status`, { force: true })

  const cfg = getReviewConfig()
  const args = [
    '-p',
    prompt,
    ...(resume ? ['--resume', resume] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(CHAT_SCHEMA),
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    DISALLOWED_TOOLS.join(','),
    ...ISOLATION_FLAGS,
    ...(cfg.model ? ['--model', cfg.model] : []),
    ...ws.addDirs.flatMap((d) => ['--add-dir', d]),
  ]
  try {
    const child = spawn(process.execPath, [SUPERVISOR, logPath, `${logPath}.status`, claude.bin, ...args], {
      cwd: ws.workdir,
      detached: true,
      stdio: 'ignore',
      env: reviewEnv(process.env),
    })
    child.unref()
    updateMessage(replyId, { pid: child.pid ?? 0, logPath, workdir: ws.workdir })
    return { ok: true, message: '' }
  } catch (err) {
    await cleanup(roundId, ws.workdir)
    return fail(`Không khởi động được claude: ${(err as Error).message}`)
  }
}

async function cleanup(roundId: number, workdir: string) {
  const round = getRound(roundId)
  const item = round ? getItem(round.itemId) : null
  const repo = item?.repoId ? getRepo(item.repoId) : undefined
  // Another turn on the same round may already be using the worktree again.
  if (runningMessages().some((m) => m.roundId === roundId)) return
  if (repo && workdir) await withRepoLock(repo.localPath, () => removeWorktree(repo.localPath, workdir))
  if (round) await cleanupLinks(roundId, toRound(round).links)
}

/** Called from the queue's tick: finish every turn whose process has ended. */
export async function reapChats() {
  const running = runningMessages()
  if (!running.length) return
  const boot = await bootTime()
  for (const m of running) {
    if (!m.pid) {
      // Still being set up by the request that created it — unless that was
      // long ago, in which case the setup died with its server.
      if (Date.now() / 1000 - m.createdAt > 300) finishMessage(m.id, 'lost', { message: 'Không khởi động được — gửi lại.' })
      continue
    }
    if (boot && m.bootAt && m.createdAt < boot) {
      finishMessage(m.id, 'lost', { message: 'Máy đã khởi động lại giữa chừng — gửi lại.' })
      await cleanup(m.roundId, m.workdir)
      continue
    }
    if (pidAlive(m.pid)) continue
    await finalize(m)
  }
}

async function finalize(m: MessageRow) {
  const log = await readLog(m.logPath)
  const result = lastResult(log)
  const out = result?.structured_output as { reply?: string; changes?: ChatChanges } | undefined
  if (!result || result.is_error || !out?.reply) {
    const why = result?.errors?.join(' ') || result?.result || strayLines(log) || 'claude dừng mà không trả lời.'
    // A session that cannot be resumed will never resume: forget it, so the
    // next message starts a fresh one with the review as context.
    if (/no conversation found|session/i.test(why)) updateRound(m.roundId, { sessionId: '' })
    finishMessage(m.id, 'failed', { message: `Claude không trả lời được: ${String(why).slice(0, 400)} — gửi lại thử.` })
  } else {
    finishMessage(m.id, 'done', {
      body: out.reply.trim(),
      changes: out.changes ? JSON.stringify(out.changes) : '',
      costUsd: result.total_cost_usd ?? 0,
    })
    if (result.session_id) updateRound(m.roundId, { sessionId: result.session_id })
  }
  await cleanup(m.roundId, m.workdir)
}

export async function cancelChat(messageId: number) {
  const m = getMessage(messageId)
  if (!m || m.state !== 'running') return
  if (m.pid) {
    try {
      process.kill(-m.pid, 'SIGTERM')
    } catch {}
  }
  finishMessage(m.id, 'cancelled', { message: 'Đã huỷ.' })
  await cleanup(m.roundId, m.workdir)
}

/**
 * The reviewer accepted what Claude proposed in one turn. Edits apply only to
 * findings of that round; additions are anchored like a review's own.
 */
export async function applyChanges(messageId: number): Promise<{ ok: boolean; message: string }> {
  const m = getMessage(messageId)
  if (!m || m.role !== 'assistant' || m.state !== 'done') return { ok: false, message: 'Không thấy đề xuất.' }
  if (m.applied) return { ok: false, message: 'Đề xuất này đã được áp dụng.' }
  const changes = parseChanges(m.changes)
  if (!changes) return { ok: false, message: 'Tin này không có đề xuất thay đổi.' }
  const round = getRound(m.roundId)
  const item = round ? getItem(round.itemId) : null
  if (!round || !item) return { ok: false, message: 'Không thấy vòng review.' }

  const mine = new Map<number, FindingView>(listFindings(round.id).map((f) => [f.id, f]))
  let edited = 0
  let dismissed = 0
  for (const u of changes.update ?? []) {
    if (!mine.has(u.id)) continue
    if (u.dismiss) {
      patchFindingFull(u.id, { status: 'dismissed' })
      dismissed++
      continue
    }
    const patch: Record<string, string> = {}
    if (u.title?.trim()) patch.title = u.title.trim()
    if (u.comment?.trim()) patch.body = u.comment.trim()
    if (u.severity) patch.severity = cleanSeverity(u.severity)
    if (Object.keys(patch).length) {
      patchFindingFull(u.id, patch)
      edited++
    }
  }

  let added = 0
  if (changes.add?.length) {
    const repo = item.repoId ? getRepo(item.repoId) : undefined
    const ranges =
      item.kind === 'pr' && repo && round.baseSha && round.headSha
        ? await diffRanges(repo.localPath, round.baseSha, round.headSha).catch(() => null)
        : null
    // After everything the review itself produced, in the order accepted.
    const start = 10_000 + mine.size
    const rows = await buildFreshRows(round, item.kind, repo, changes.add, ranges, start)
    insertFindings(rows)
    added = rows.length
  }

  // The round note is Claude's read for the reviewer, not part of what gets
  // posted — chat does not rewrite it.
  updateMessage(m.id, { applied: true })
  const parts = [edited && `sửa ${edited}`, dismissed && `bỏ ${dismissed}`, added && `thêm ${added}`]
  return { ok: true, message: `Đã áp dụng: ${parts.filter(Boolean).join(', ') || 'không có gì thay đổi'}.` }
}
