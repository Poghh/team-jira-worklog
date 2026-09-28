import 'server-only'

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { reviewFindings } from '@/lib/db/schema'

import { checkClaude } from './claude'
import { getRepo, getReviewConfig } from './config'
import {
  addWorktree,
  commitExists,
  diffRanges,
  diffStat,
  fetchAll,
  fetchPull,
  gitSays,
  isAncestor,
  mergeBase,
  removeWorktree,
  revParse,
  snippetAt,
  withRepoLock,
} from './git'
import { getPull, listPullComments } from './github'
import {
  DOC_CATEGORIES,
  type DocFile,
  type FindingStatus,
  SEVERITIES,
  type Severity,
} from './model'
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, ISOLATION_FLAGS, reviewEnv } from './guard'
import { CODE_SCHEMA, DOC_SCHEMA, codePrompt, docPrompt } from './prompts'
import {
  type RoundRow,
  finishRound,
  getItem,
  getRound,
  insertFindings,
  lastDoneRound,
  openFindings,
  patchItem,
  roundsIn,
  transitionRound,
  updateRound,
} from './store'

const run = promisify(execFile)

/**
 * The review queue.
 *
 * A round is `queued` → `preparing` (fetch, worktree, prompt — in this server)
 * → `running` (a detached `claude -p` under supervise.mjs) → `done` / `failed`
 * / `cancelled` / `lost`. At most `concurrency` rounds are preparing or running
 * at once; the rest wait their turn.
 *
 * Nothing holds the child process. Like sdk-release, state is reconstructed on
 * each tick from the pid, the boot time, a status file and the log — so a dev
 * server restart mid-review loses nothing but the tick that was in flight.
 * Unlike sdk-release there is no one-at-a-time index: parallel is the point.
 */

export const LOG_DIR = path.join(process.cwd(), 'data', 'code-review', 'logs')
const SUPERVISOR = path.join(process.cwd(), 'lib/modules/code-review/supervise.mjs')

async function bootTime(): Promise<number> {
  try {
    const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 5_000 })
    const m = /sec\s*=\s*(\d+)/.exec(stdout)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/* ── ticking ────────────────────────────────────────────────────────────── */

const g = globalThis as unknown as {
  __crTimer?: ReturnType<typeof setInterval>
  __crTimerOwner?: symbol
  __crTicking?: boolean
  /** Rounds this server process is preparing right now. */
  __crPreparing?: Set<number>
}
const preparing = (g.__crPreparing ??= new Set())
const OWNER = Symbol('code-review-ticker')

/**
 * Keeps the queue moving while nobody has the page open.
 *
 * Called from the page and every action. A hot reload re-evaluates this file
 * and mints a new `OWNER`, so the interval is swapped for one running the new
 * code instead of the old closure ticking forever.
 */
export function ensureTicker() {
  if (g.__crTimerOwner === OWNER && g.__crTimer) return
  if (g.__crTimer) clearInterval(g.__crTimer)
  g.__crTimerOwner = OWNER
  g.__crTimer = setInterval(() => void tick(), 4000)
  g.__crTimer.unref?.()
}

export async function tick(): Promise<void> {
  if (g.__crTicking) return
  g.__crTicking = true
  try {
    await reap()
    startQueued()
  } catch (err) {
    console.error('[code-review] tick', err)
  } finally {
    g.__crTicking = false
  }
}

async function reap() {
  // A round left in `preparing` by a server that has since restarted will
  // never finish preparing — nobody is doing it. Put it back in line.
  for (const r of roundsIn(['preparing'])) {
    if (!preparing.has(r.id)) transitionRound(r.id, ['preparing'], 'queued')
  }

  const running = roundsIn(['running'])
  if (!running.length) return
  const boot = await bootTime()
  for (const r of running) {
    if (boot && r.bootAt && (r.startedAt ?? 0) < boot) {
      await endRound(r, 'lost', 'Máy đã khởi động lại trong lúc review — chạy lại vòng này.')
      continue
    }
    if (pidAlive(r.pid)) continue
    await finalize(r)
  }
}

function startQueued() {
  const { concurrency } = getReviewConfig()
  const busy = roundsIn(['preparing', 'running']).length
  let free = concurrency - busy
  if (free <= 0) return
  for (const r of roundsIn(['queued'])) {
    if (free <= 0) break
    if (!transitionRound(r.id, ['queued'], 'preparing')) continue
    free -= 1
    preparing.add(r.id)
    void prepareAndSpawn(r.id).finally(() => preparing.delete(r.id))
  }
}

/* ── starting ───────────────────────────────────────────────────────────── */

async function prepareAndSpawn(roundId: number) {
  const round = getRound(roundId)
  if (!round) return
  const fail = (message: string) => finishRound(roundId, 'failed', { message })

  const claude = await checkClaude()
  if (!claude.ok) return fail(claude.problem)

  const item = getItem(round.itemId)
  if (!item) return fail('Không thấy hồ sơ review.')
  const cfg = getReviewConfig()
  const repo = item.repoId ? getRepo(item.repoId) : undefined
  if (item.repoId && !repo) return fail('Repo của hồ sơ này đã bị xoá khỏi Cấu hình.')
  if (item.kind === 'pr' && !repo) return fail('Review code cần một repo.')

  const prev = lastDoneRound(item.id)
  const previous = prev && prev.id !== roundId ? openFindings(prev.id) : []

  let workdir = ''
  let baseSha = ''
  let headSha = ''
  let prompt = ''
  let schema: object = CODE_SCHEMA
  const addDirs: string[] = []

  try {
    if (item.kind === 'pr') {
      const r = repo!
      let prBody = ''
      let comments: Awaited<ReturnType<typeof listPullComments>> = []
      if (item.prNumber && r.githubRepo) {
        const pull = await getPull(r.githubRepo, item.prNumber)
        prBody = pull.body
        // The PR may have been retargeted or renamed since it was queued.
        patchItem(item.id, { title: pull.title, baseRef: pull.baseRef, headRef: pull.headRef, author: pull.author, url: pull.url })
        Object.assign(item, { title: pull.title, baseRef: pull.baseRef, headRef: pull.headRef, author: pull.author })
        comments = await listPullComments(r.githubRepo, item.prNumber)
      }

      await withRepoLock(r.localPath, async () => {
        if (item.prNumber && r.githubRepo) {
          headSha = await fetchPull(r.localPath, item.prNumber, item.baseRef)
        } else {
          await fetchAll(r.localPath)
          headSha = await revParse(r.localPath, `origin/${item.headRef}`)
        }
        baseSha = await mergeBase(r.localPath, `origin/${item.baseRef}`, headSha)
        workdir = await addWorktree(r.localPath, `r${roundId}`, headSha)
      })

      const prevHeadSha = prev?.headSha ?? ''
      const incremental =
        Boolean(prevHeadSha) &&
        (await commitExists(r.localPath, prevHeadSha)) &&
        (await isAncestor(r.localPath, prevHeadSha, headSha))

      const docs = parseDocs(round.docs)
      for (const d of docs) {
        const dir = path.dirname(d.path)
        if (!addDirs.includes(dir)) addDirs.push(dir)
      }
      // Same files as last round, or a newer upload? A new version is worth
      // a second look at requirements that were already checked.
      const prevPaths = prev ? parseDocs(prev.docs).map((d) => d.path).sort().join('\n') : ''
      const docsChanged = round.round > 1 && docs.map((d) => d.path).sort().join('\n') !== prevPaths

      prompt = codePrompt({
        repoName: r.name,
        docs,
        docsChanged,
        title: item.title,
        prNumber: item.prNumber,
        author: item.author,
        baseRef: item.baseRef,
        headRef: item.headRef,
        baseSha,
        headSha,
        prBody,
        note: item.note,
        round: round.round,
        prevHeadSha,
        incremental,
        previous,
        comments,
        diffStat: await diffStat(r.localPath, baseSha, headSha),
        globalRules: cfg.globalRules,
        repoRules: r.rules,
      })
    } else {
      schema = DOC_SCHEMA
      const docs = parseDocs(round.docs)
      if (!docs.length) return fail('Vòng này chưa có tài liệu nào.')
      const prevDocs = prev ? parseDocs(prev.docs) : []
      for (const d of [...docs, ...prevDocs]) {
        const dir = path.dirname(d.path)
        if (!addDirs.includes(dir)) addDirs.push(dir)
      }

      if (repo) {
        await withRepoLock(repo.localPath, async () => {
          await fetchAll(repo.localPath)
          headSha = await revParse(repo.localPath, `origin/${item.headRef}`)
          workdir = await addWorktree(repo.localPath, `r${roundId}`, headSha)
        })
      } else {
        workdir = addDirs[0]
      }

      prompt = docPrompt({
        title: item.title,
        repoName: repo?.name ?? '',
        ref: item.headRef,
        headSha,
        docs,
        prevDocs,
        note: item.note,
        round: round.round,
        previous,
        globalRules: cfg.globalRules,
        repoRules: repo?.rules ?? '',
      })
    }
  } catch (err) {
    if (workdir && repo) await withRepoLock(repo.localPath, () => removeWorktree(repo.localPath, workdir))
    return fail(`Chuẩn bị thất bại: ${gitSays(err)}`)
  }

  await fs.mkdir(LOG_DIR, { recursive: true })
  const logPath = path.join(LOG_DIR, `r${roundId}.jsonl`)
  await fs.writeFile(logPath, '')
  await fs.rm(`${logPath}.status`, { force: true })
  // Kept beside the log: when a review reads oddly, the first question is
  // what it was asked.
  await fs.writeFile(path.join(LOG_DIR, `r${roundId}.prompt.md`), prompt)

  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(schema),
    '--allowedTools',
    ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    DISALLOWED_TOOLS.join(','),
    ...ISOLATION_FLAGS,
    ...(cfg.model ? ['--model', cfg.model] : []),
    ...addDirs.flatMap((d) => ['--add-dir', d]),
  ]

  // Cancelled while we were fetching? Then do not start anything.
  if (getRound(roundId)?.state !== 'preparing') {
    if (repo && workdir !== addDirs[0]) await withRepoLock(repo.localPath, () => removeWorktree(repo.localPath, workdir))
    return
  }

  // No token, no SSH agent, git transport off — see guard.ts.
  const env = reviewEnv(process.env)

  try {
    const child = spawn(process.execPath, [SUPERVISOR, logPath, `${logPath}.status`, claude.bin, ...args], {
      cwd: workdir,
      detached: true,
      stdio: 'ignore',
      env,
    })
    child.unref()
    const ok = transitionRound(roundId, ['preparing'], 'running', {
      pid: child.pid ?? 0,
      logPath,
      workdir,
      baseSha,
      headSha,
      prevHeadSha: prev?.headSha ?? '',
      bootAt: await bootTime(),
      startedAt: Math.floor(Date.now() / 1000),
    })
    if (!ok && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
    }
  } catch (err) {
    fail(`Không khởi động được claude: ${(err as Error).message}`)
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

/* ── finishing ──────────────────────────────────────────────────────────── */

interface ResultEvent {
  type: 'result'
  subtype?: string
  is_error?: boolean
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  errors?: string[]
}

interface Output {
  verdict?: string
  summary_comment?: string
  findings?: Array<{
    file?: string
    line?: number
    end_line?: number
    location?: string
    severity?: string
    category?: string
    title?: string
    comment?: string
  }>
  previous?: Array<{ id?: number; status?: string; note?: string; line?: number; end_line?: number }>
}

async function readLog(logPath: string): Promise<string> {
  try {
    return await fs.readFile(logPath, 'utf8')
  } catch {
    return ''
  }
}

function lastResult(log: string): ResultEvent | null {
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{')) continue
    try {
      const e = JSON.parse(l)
      if (e?.type === 'result') return e as ResultEvent
    } catch {}
  }
  return null
}

/** Lines of the log that are not stream-json — the CLI's own complaints. */
function strayLines(log: string): string {
  return log
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('{'))
    .slice(-6)
    .join(' ')
    .slice(0, 600)
}

async function cleanup(r: RoundRow) {
  const item = getItem(r.itemId)
  const repo = item?.repoId ? getRepo(item.repoId) : undefined
  if (repo && r.workdir) await withRepoLock(repo.localPath, () => removeWorktree(repo.localPath, r.workdir))
}

async function endRound(r: RoundRow, state: 'failed' | 'lost' | 'cancelled', message: string) {
  finishRound(r.id, state, { message })
  await cleanup(r)
}

async function finalize(r: RoundRow) {
  const log = await readLog(r.logPath)
  const result = lastResult(log)
  let status: { exitCode: number | null; error?: string } | null = null
  try {
    status = JSON.parse(await fs.readFile(`${r.logPath}.status`, 'utf8'))
  } catch {}

  if (!result) {
    const why = status?.error
      ? `Không chạy được claude: ${status.error}`
      : status
        ? `claude thoát (mã ${status.exitCode ?? '?'}) mà không trả kết quả. ${strayLines(log)}`
        : 'Tiến trình review không còn chạy và không để lại kết quả — có thể đã bị kill.'
    return endRound(r, status ? 'failed' : 'lost', why.trim())
  }

  const out = result.structured_output as Output | undefined
  if (result.is_error || !out || typeof out !== 'object') {
    const why = result.errors?.join(' ') || result.result || result.subtype || 'không rõ'
    return endRound(r, 'failed', `Claude báo lỗi: ${String(why).slice(0, 600)}`)
  }

  try {
    await storeOutput(r, out)
  } catch (err) {
    return endRound(r, 'failed', `Không lưu được kết quả: ${(err as Error).message}`)
  }

  const verdict = ['approve', 'request_changes', 'comment'].includes(out.verdict ?? '') ? out.verdict! : 'comment'
  finishRound(r.id, 'done', {
    verdict,
    summary: (out.summary_comment ?? '').trim(),
    costUsd: result.total_cost_usd ?? 0,
    message: '',
  })
  await cleanup(r)
}

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 }

async function storeOutput(r: RoundRow, out: Output) {
  const item = getItem(r.itemId)
  if (!item) return
  const repo = item.repoId ? getRepo(item.repoId) : undefined
  const rows: Array<typeof reviewFindings.$inferInsert> = []

  let ranges: Map<string, Array<[number, number]>> | null = null
  if (item.kind === 'pr' && repo && r.baseSha && r.headSha) {
    ranges = await diffRanges(repo.localPath, r.baseSha, r.headSha).catch(() => null)
  }

  const fresh = [...(out.findings ?? [])]
    .filter((f) => (f.title || f.comment)?.trim())
    .map((f) => ({ ...f, severity: (SEVERITIES as string[]).includes(f.severity ?? '') ? (f.severity as Severity) : 'minor' }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  let position = 0
  for (const f of fresh) {
    const file = (f.file ?? '').replace(/^\.?\//, '').trim()
    const line = Number.isInteger(f.line) && f.line! > 0 ? f.line! : null
    const endLine = Number.isInteger(f.end_line) && f.end_line! >= (line ?? 0) ? f.end_line! : null
    let snippet = { text: '', start: 0 }
    if (repo && file && line && r.headSha) snippet = await snippetAt(repo.localPath, r.headSha, file, line, endLine)
    const inDiff = Boolean(
      ranges && file && line && (ranges.get(file) ?? []).some(([a, b]) => line >= a && line <= b),
    )
    rows.push({
      roundId: r.id,
      itemId: r.itemId,
      file,
      line,
      endLine,
      location: (f.location ?? '').trim(),
      severity: f.severity,
      category:
        item.kind === 'doc'
          ? (DOC_CATEGORIES as string[]).includes(f.category ?? '')
            ? f.category!
            : 'unreasonable'
          : (f.category ?? '').trim(),
      title: (f.title ?? '').trim(),
      body: (f.comment ?? '').trim(),
      snippet: snippet.text,
      snippetStart: snippet.start,
      inDiff,
      origin: 'new',
      status: 'open',
      position: position++,
    })
  }

  // Carry every finding the previous round left open into this one, with
  // Claude's verdict on whether it was addressed. The old rows stay as they
  // were — each round is a record of what was true at its sha.
  const prev = lastDoneRound(r.itemId)
  if (prev && prev.id !== r.id) {
    const verdicts = new Map((out.previous ?? []).map((p) => [Number(p.id), p]))
    for (const old of openFindings(prev.id)) {
      const v = verdicts.get(old.id)
      const status: FindingStatus =
        v?.status === 'fixed' || v?.status === 'partial' || v?.status === 'not_fixed' ? v.status : 'not_fixed'
      // Code moves between rounds. Where Claude says where the problem sits
      // now, re-anchor to it so the snippet and the GitHub link show today's
      // code; otherwise keep the old place, which is at least where it was.
      let { line, endLine, snippet, snippetStart, inDiff } = old
      const moved = Number.isInteger(v?.line) && v!.line! > 0 ? v!.line! : null
      if (moved && repo && old.file && r.headSha && status !== 'fixed') {
        line = moved
        endLine = Number.isInteger(v?.end_line) && v!.end_line! >= moved ? v!.end_line! : null
        const snip = await snippetAt(repo.localPath, r.headSha, old.file, line, endLine)
        if (snip.text) ({ text: snippet, start: snippetStart } = snip)
        inDiff = Boolean(ranges && (ranges.get(old.file) ?? []).some(([a, b]) => line! >= a && line! <= b))
      }
      rows.push({
        roundId: r.id,
        itemId: r.itemId,
        prevId: old.id,
        file: old.file,
        line,
        endLine,
        location: old.location,
        severity: old.severity,
        category: old.category,
        title: old.title,
        body: old.body,
        snippet,
        snippetStart,
        inDiff,
        origin: 'carried',
        // Still the same conversation on GitHub: keep the link so the thread
        // and the member's replies follow the finding into this round.
        ghCommentId: old.ghCommentId,
        ghUrl: old.ghUrl,
        status,
        followNote: v?.note?.trim() || (v ? '' : 'Claude không đánh giá lại điểm này — tự kiểm tra.'),
        position: position++,
      })
    }
  }

  insertFindings(rows)
}

/* ── cancelling ─────────────────────────────────────────────────────────── */

export async function cancelRound(id: number): Promise<{ ok: boolean; message: string }> {
  const r = getRound(id)
  if (!r) return { ok: false, message: 'Không thấy vòng review này.' }
  if (r.state === 'queued' || r.state === 'preparing') {
    // A preparing round notices on its own, right before spawning.
    finishRound(id, 'cancelled', { message: 'Huỷ trước khi chạy.' })
    return { ok: true, message: 'Đã huỷ.' }
  }
  if (r.state !== 'running') return { ok: false, message: 'Vòng này đã kết thúc.' }
  // The supervisor was spawned detached, so its pid is its process group and
  // claude is in it; one signal to the group reaches both.
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-r.pid, sig)
    } catch {}
    if (sig === 'SIGTERM') await new Promise((res) => setTimeout(res, 1500))
    if (!pidAlive(r.pid)) break
  }
  await endRound(r, 'cancelled', 'Huỷ từ app.')
  return { ok: true, message: 'Đã huỷ.' }
}

/* ── watching ───────────────────────────────────────────────────────────── */

export interface LogLine {
  kind: 'tool' | 'text' | 'result' | 'error'
  text: string
}

function short(s: unknown, n = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => {
    const s = String(p ?? '')
    if (cwd && s.startsWith(cwd)) return s.slice(cwd.length + 1) || '.'
    // Outside the worktree is the uploaded PDFs: the name is what matters.
    return s.startsWith('/') ? path.basename(s) : s
  }
  switch (name) {
    case 'Read':
      return `📖 ${rel(input.file_path)}${input.offset ? ` @${input.offset}` : ''}${input.pages ? ` tr.${input.pages}` : ''}`
    case 'Grep':
      return `🔎 grep ${short(input.pattern, 80)}${input.path ? ` trong ${rel(input.path)}` : ''}`
    case 'Glob':
      return `🗂 ${short(input.pattern, 80)}`
    case 'Bash':
      return `$ ${short(input.command, 160)}`
    case 'StructuredOutput':
      return '📝 Ghi kết quả'
    default:
      return `🔧 ${name}`
  }
}

/** The log as a reviewer wants to watch it: what Claude is reading, and why. */
export async function viewLog(id: number, limit = 250): Promise<LogLine[]> {
  const r = getRound(id)
  if (!r?.logPath) return []
  const raw = await readLog(r.logPath)
  const out: LogLine[] = []
  for (const l of raw.split('\n')) {
    const line = l.trim()
    if (!line) continue
    if (!line.startsWith('{')) {
      out.push({ kind: 'error', text: short(line, 400) })
      continue
    }
    let e: {
      type?: string
      message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }
      subtype?: string
      is_error?: boolean
      num_turns?: number
      total_cost_usd?: number
      duration_ms?: number
    }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') out.push({ kind: 'tool', text: describeTool(c.name ?? '', c.input ?? {}, r.workdir) })
        else if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: short(c.text, 600) })
      }
    } else if (e.type === 'result') {
      out.push({
        kind: e.is_error ? 'error' : 'result',
        text: `${e.is_error ? '✗ Lỗi' : '✓ Xong'} · ${e.num_turns ?? '?'} lượt · ${Math.round((e.duration_ms ?? 0) / 1000)}s${e.total_cost_usd ? ` · ~$${e.total_cost_usd.toFixed(2)}` : ''}`,
      })
    }
  }
  return out.slice(-limit)
}

export function updateRoundSummary(id: number, summary: string) {
  updateRound(id, { summary })
}
