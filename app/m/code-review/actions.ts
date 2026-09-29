'use server'

import { revalidatePath } from 'next/cache'

import { type ChatMessage, applyChanges, cancelChat, listChat, sendChat } from '@/lib/modules/code-review/chat'
import { type ClaudeCheck, checkClaude } from '@/lib/modules/code-review/claude'
import { getRepo, rememberPerson, setRepos, setRunnerConfig } from '@/lib/modules/code-review/config'
import { isRepo, listRemoteBranches, fetchAll, gitSays, withRepoLock } from '@/lib/modules/code-review/git'
import {
  type Discussion,
  type GithubAccess,
  GithubError,
  checkAccess,
  type PullSummary,
  type ReviewEvent,
  getDiscussion,
  listOpenPulls,
  postInlineComment,
  postIssueComment,
  repliesSince,
  replyToComment,
  setThreadResolved,
  submitReview,
  viewerLogin,
} from '@/lib/modules/code-review/github'
import { ForbiddenAction } from '@/lib/modules/code-review/guard'
import { type Addressee, type DocFile, type FindingStatus, HONORIFICS, type PrLink, addressOf, cleanHandle, validHandle, type FindingView, type ItemSummary, type RepoPreset, type RoundView, where } from '@/lib/modules/code-review/model'
import { type LogLine, cancelRound, ensureTicker, tick, updateRoundSummary, viewLog } from '@/lib/modules/code-review/runner'
import {
  createItem,
  deleteItem,
  findPrItem,
  getFinding,
  getItem,
  getRound,
  hasLiveRound,
  lastRound,
  listFindings,
  listItems,
  listRounds,
  markSeen,
  patchFinding,
  patchItem,
  queueRound,
  setItemAddressee,
  setItemLinks,
} from '@/lib/modules/code-review/store'
import { validDocs } from '@/lib/modules/code-review/uploads'
import { isModuleEnabled } from '@/lib/modules/state'

export interface Result {
  ok: boolean
  message: string
}

function enabled() {
  try {
    return isModuleEnabled('code-review')
  } catch {
    return false
  }
}

const OFF: Result = { ok: false, message: 'Module Code review đang tắt.' }

/** Refuses to queue anything the machine cannot run — the module's one engine is the CLI. */
async function ready(): Promise<Result | null> {
  if (!enabled()) return OFF
  const c = await checkClaude()
  return c.ok ? null : { ok: false, message: c.problem }
}

export async function claudeStatusAction(force = false): Promise<ClaudeCheck> {
  return checkClaude(force)
}

/* ── starting reviews ───────────────────────────────────────────────────── */

export interface PullRow extends PullSummary {
  /** The open item tracking this PR, if any. */
  itemId: number | null
  /** Head sha of the latest round, to tell "has new commits". */
  reviewedSha: string
  live: boolean
}

export async function listPullsAction(repoId: string): Promise<Result & { pulls: PullRow[] }> {
  if (!enabled()) return { ...OFF, pulls: [] }
  const repo = getRepo(repoId)
  if (!repo) return { ok: false, message: 'Không thấy repo.', pulls: [] }
  if (!repo.githubRepo) return { ok: false, message: 'Repo này chưa điền owner/name GitHub.', pulls: [] }
  try {
    const pulls = await listOpenPulls(repo.githubRepo)
    return {
      ok: true,
      message: '',
      pulls: pulls.map((p) => {
        const item = findPrItem(repoId, p.number)
        const last = item ? lastRound(item.id) : null
        return {
          ...p,
          itemId: item?.id ?? null,
          reviewedSha: last?.headSha ?? '',
          live: item ? hasLiveRound(item.id) : false,
        }
      }),
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message, pulls: [] }
  }
}

export async function queuePullsAction(input: {
  repoId: string
  pulls: Array<Pick<PullSummary, 'number' | 'title' | 'author' | 'headRef' | 'baseRef' | 'url'>>
  note: string
  /** Spec / TDD PDFs to compare the implementation against, applied to every PR picked. */
  docs?: DocFile[]
  /** PRs in other repos to read alongside (SDK ↔ iOS). */
  links?: PrLink[]
}): Promise<Result> {
  const blocked = await ready()
  if (blocked) return blocked
  const docs = await validDocs(input.docs ?? [])
  if (!docs) return { ok: false, message: 'Tài liệu đính kèm không hợp lệ — tải lên lại.' }
  if (!getRepo(input.repoId)) return { ok: false, message: 'Không thấy repo.' }
  let queued = 0
  let skipped = 0
  for (const p of input.pulls) {
    const existing = findPrItem(input.repoId, p.number)
    const itemId =
      existing?.id ??
      createItem({
        kind: 'pr',
        repoId: input.repoId,
        title: p.title,
        prNumber: p.number,
        baseRef: p.baseRef,
        headRef: p.headRef,
        author: p.author,
        url: p.url,
        note: input.note.trim(),
      })
    if (existing && input.note.trim()) patchItem(itemId, { note: input.note.trim() })
    if (input.links?.length) {
      const merged = [...(existing?.links ?? []), ...input.links]
      await setLinksAction(itemId, merged)
    }
    if (hasLiveRound(itemId)) {
      skipped++
      continue
    }
    queueRound(itemId, docs.length ? docs : carriedDocs(itemId))
    queued++
  }
  ensureTicker()
  void tick()
  revalidatePath('/m/code-review')
  return {
    ok: true,
    message: `Đã xếp hàng ${queued} PR${skipped ? ` · ${skipped} PR đang review dở nên bỏ qua` : ''}.`,
  }
}

export async function listBranchesAction(repoId: string, refresh = false): Promise<Result & { branches: string[] }> {
  if (!enabled()) return { ...OFF, branches: [] }
  const repo = getRepo(repoId)
  if (!repo) return { ok: false, message: 'Không thấy repo.', branches: [] }
  try {
    if (refresh) await withRepoLock(repo.localPath, () => fetchAll(repo.localPath))
    return { ok: true, message: '', branches: await listRemoteBranches(repo.localPath) }
  } catch (err) {
    return { ok: false, message: gitSays(err), branches: [] }
  }
}

export async function queueBranchesAction(input: {
  repoId: string
  baseRef: string
  headRef: string
  title: string
  note: string
  docs?: DocFile[]
  links?: PrLink[]
}): Promise<Result & { itemId?: number }> {
  const blocked = await ready()
  if (blocked) return blocked
  const docs = await validDocs(input.docs ?? [])
  if (!docs) return { ok: false, message: 'Tài liệu đính kèm không hợp lệ — tải lên lại.' }
  if (!getRepo(input.repoId)) return { ok: false, message: 'Không thấy repo.' }
  if (!input.baseRef.trim() || !input.headRef.trim()) return { ok: false, message: 'Chọn nhánh nguồn và nhánh đích.' }
  const itemId = createItem({
    kind: 'pr',
    repoId: input.repoId,
    title: input.title.trim() || `${input.headRef} → ${input.baseRef}`,
    prNumber: null,
    baseRef: input.baseRef.trim(),
    headRef: input.headRef.trim(),
    author: '',
    url: '',
    note: input.note.trim(),
  })
  if (input.links?.length) await setLinksAction(itemId, input.links)
  queueRound(itemId, docs)
  ensureTicker()
  void tick()
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã xếp hàng.', itemId }
}

/**
 * The documents a PR's next round inherits: whatever the last round had.
 * Attached once, they follow the PR until someone uploads a newer version.
 */
function carriedDocs(itemId: number): DocFile[] {
  const last = lastRound(itemId)
  try {
    return last?.docs ? (JSON.parse(last.docs) as DocFile[]) : []
  } catch {
    return []
  }
}

/**
 * "Review tiếp" / "Chạy lại". A new doc version for a doc item goes through
 * the docs route instead; here the documents are either newly attached (PR)
 * or carried over from the last round.
 */
export async function reReviewAction(itemId: number, note?: string, newDocs?: DocFile[]): Promise<Result> {
  const blocked = await ready()
  if (blocked) return blocked
  const docs = newDocs?.length ? await validDocs(newDocs) : null
  if (newDocs?.length && !docs) return { ok: false, message: 'Tài liệu đính kèm không hợp lệ — tải lên lại.' }
  const item = getItem(itemId)
  if (!item) return { ok: false, message: 'Không thấy hồ sơ.' }
  if (hasLiveRound(itemId)) return { ok: false, message: 'Hồ sơ này đang có vòng review chưa xong.' }
  if (note !== undefined) patchItem(itemId, { note: note.trim() })
  queueRound(itemId, docs ?? carriedDocs(itemId))
  ensureTicker()
  void tick()
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã xếp hàng vòng mới.' }
}

export async function cancelRoundAction(roundId: number): Promise<Result> {
  if (!enabled()) return OFF
  const res = await cancelRound(roundId)
  void tick()
  return res
}

/* ── reading ────────────────────────────────────────────────────────────── */

export async function dashboardAction(archived = false): Promise<ItemSummary[]> {
  if (!enabled()) return []
  ensureTicker()
  await tick()
  return listItems(archived ? 'archived' : 'open')
}

export interface Updates {
  /** Item id → PR head sha, when it moved past the latest round. */
  commits: Record<number, string>
  /** Item id → comments by other people since the discussion was last read. */
  replies: Record<number, number>
}

/**
 * New commits and new replies on the tracked PRs. Reads only: one call for
 * the open PRs and two for recent comments, per repo.
 */
export async function checkUpdatesAction(): Promise<Updates> {
  const out: Updates = { commits: {}, replies: {} }
  if (!enabled()) return out
  const items = listItems('open').filter((i) => i.kind === 'pr' && i.prNumber && i.latest)
  const byRepo = new Map<string, typeof items>()
  for (const i of items) byRepo.set(i.repoId, [...(byRepo.get(i.repoId) ?? []), i])
  let viewer = ''
  try {
    viewer = await viewerLogin()
  } catch {}
  await Promise.all(
    [...byRepo].map(async ([repoId, list]) => {
      const repo = getRepo(repoId)
      if (!repo?.githubRepo) return
      try {
        const pulls = await listOpenPulls(repo.githubRepo)
        for (const i of list) {
          const p = pulls.find((x) => x.number === i.prNumber)
          if (p && i.latest!.headSha && p.headSha !== i.latest!.headSha) out.commits[i.id] = p.headSha
        }
      } catch {}
      if (!viewer) return
      // Never opened → count from the first review; after that, from the last read.
      const since = (i: (typeof list)[number]) => i.seenAt ?? i.latest!.createdAt
      const oldest = Math.min(...list.map(since))
      try {
        const replies = await repliesSince(repo.githubRepo, new Date(oldest * 1000).toISOString(), viewer)
        for (const i of list) {
          const after = new Date(since(i) * 1000).toISOString()
          const n = (replies.get(i.prNumber!) ?? []).filter((at) => at > after).length
          if (n) out.replies[i.id] = n
        }
      } catch {}
    }),
  )
  return out
}

/* ── GitHub: posting and discussing ─────────────────────────────────────── */

/** The PR an item is about, or why it cannot talk to GitHub. */
function prContext(itemId: number): { repo: string; number: number; item: NonNullable<ReturnType<typeof getItem>> } | string {
  const item = getItem(itemId)
  if (!item) return 'Không thấy hồ sơ.'
  if (item.kind !== 'pr' || !item.prNumber) return 'Hồ sơ này không gắn với một PR trên GitHub.'
  const repo = getRepo(item.repoId)
  if (!repo?.githubRepo) return 'Repo chưa điền owner/name GitHub trong Cấu hình.'
  return { repo: repo.githubRepo, number: item.prNumber, item }
}

/**
 * The server-side half of "no permission → Copy only": every write re-checks
 * the token, so a stale page that still shows a send button cannot send.
 */
async function denyWrite(ctx: { repo: string; number: number }): Promise<Result | null> {
  const access = await checkAccess(ctx.repo, ctx.number)
  return access.write ? null : { ok: false, message: access.reason }
}

export async function githubAccessAction(itemId: number, force = false): Promise<GithubAccess> {
  if (!enabled()) return { read: false, write: false, reason: 'Module đang tắt.' }
  const ctx = prContext(itemId)
  if (typeof ctx === 'string') return { read: false, write: false, reason: ctx }
  return checkAccess(ctx.repo, ctx.number, force)
}

const failure = (err: unknown): Result => ({
  ok: false,
  message: err instanceof ForbiddenAction || err instanceof GithubError ? err.message : `Lỗi: ${(err as Error).message}`,
})

const locationLine = (f: FindingView) => `**\`${where(f)}\`**`

/**
 * Posts one finding on its own. Inside the diff it becomes an inline comment
 * on its line; outside it, a conversation comment that names the place.
 */
export async function postFindingAction(findingId: number): Promise<Result & { url?: string }> {
  if (!enabled()) return OFF
  const f = getFinding(findingId)
  if (!f) return { ok: false, message: 'Không thấy finding.' }
  if (f.ghUrl) return { ok: false, message: 'Finding này đã được gửi.' }
  const round = getRound(f.roundId)
  const ctx = round ? prContext(round.itemId) : 'Không thấy vòng review.'
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  const denied = await denyWrite(ctx)
  if (denied) return denied
  try {
    const posted =
      f.inDiff && f.line && f.file && round!.headSha
        ? await postInlineComment(ctx.repo, ctx.number, round!.headSha, {
            path: f.file,
            line: f.endLine && f.endLine > f.line ? f.endLine : f.line,
            startLine: f.endLine && f.endLine > f.line ? f.line : undefined,
            body: f.body,
          })
        : await postIssueComment(ctx.repo, ctx.number, `${f.file ? `${locationLine(f)}\n\n` : ''}${f.body}`)
    patchFinding(findingId, { ghCommentId: f.inDiff ? posted.id : null, ghUrl: posted.url })
    return { ok: true, message: 'Đã gửi lên PR.', url: posted.url }
  } catch (err) {
    return failure(err)
  }
}

/**
 * The whole review in one submission: summary, verdict, and every chosen
 * finding — inline where GitHub allows, listed in the body where it does not.
 */
export async function submitReviewAction(input: {
  roundId: number
  findingIds: number[]
  body: string
  event: ReviewEvent
}): Promise<Result & { url?: string }> {
  if (!enabled()) return OFF
  const round = getRound(input.roundId)
  if (!round || round.state !== 'done') return { ok: false, message: 'Vòng review này chưa xong.' }
  const ctx = prContext(round.itemId)
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  const denied = await denyWrite(ctx)
  if (denied) return denied
  const chosen = listFindings(round.id).filter((f) => input.findingIds.includes(f.id) && !f.ghUrl)
  const inline = chosen.filter((f) => f.inDiff && f.line && f.file)
  const rest = chosen.filter((f) => !inline.includes(f))
  const body = [
    input.body.trim(),
    rest.length
      ? `**Các điểm khác:**\n\n${rest.map((f, i) => `${i + 1}. ${f.file ? `${locationLine(f)} ` : ''}**${f.title}**\n${f.body.trim().replace(/^/gm, '   ')}`).join('\n\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')
  if (!body && !inline.length) return { ok: false, message: 'Không có gì để gửi.' }
  try {
    const res = await submitReview(ctx.repo, ctx.number, {
      commitId: round.headSha,
      body,
      event: input.event,
      comments: inline.map((f) => ({
        path: f.file,
        line: f.endLine && f.endLine > f.line! ? f.endLine : f.line!,
        startLine: f.endLine && f.endLine > f.line! ? f.line! : undefined,
        body: f.body,
      })),
    })
    inline.forEach((f, i) => patchFinding(f.id, { ghCommentId: res.comments[i]?.id || null, ghUrl: res.comments[i]?.url || res.url }))
    for (const f of rest) patchFinding(f.id, { ghUrl: res.url })
    return { ok: true, message: `Đã gửi review: ${inline.length} comment inline${rest.length ? ` + ${rest.length} điểm trong nội dung` : ''}.`, url: res.url }
  } catch (err) {
    return failure(err)
  }
}

export async function discussionAction(itemId: number): Promise<Result & { discussion?: Discussion }> {
  if (!enabled()) return OFF
  const ctx = prContext(itemId)
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  try {
    const discussion = await getDiscussion(ctx.repo, ctx.number)
    markSeen(itemId)
    return { ok: true, message: '', discussion }
  } catch (err) {
    return failure(err)
  }
}

export async function replyAction(itemId: number, commentId: number, body: string): Promise<Result> {
  if (!enabled()) return OFF
  if (!body.trim()) return { ok: false, message: 'Nội dung trống.' }
  const ctx = prContext(itemId)
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  const denied = await denyWrite(ctx)
  if (denied) return denied
  try {
    await replyToComment(ctx.repo, ctx.number, commentId, body.trim())
    return { ok: true, message: 'Đã trả lời.' }
  } catch (err) {
    return failure(err)
  }
}

export async function commentAction(itemId: number, body: string): Promise<Result> {
  if (!enabled()) return OFF
  if (!body.trim()) return { ok: false, message: 'Nội dung trống.' }
  const ctx = prContext(itemId)
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  const denied = await denyWrite(ctx)
  if (denied) return denied
  try {
    await postIssueComment(ctx.repo, ctx.number, body.trim())
    return { ok: true, message: 'Đã comment.' }
  } catch (err) {
    return failure(err)
  }
}

export async function resolveThreadAction(itemId: number, threadId: string, resolved: boolean): Promise<Result> {
  if (!enabled()) return OFF
  const ctx = prContext(itemId)
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  const denied = await denyWrite(ctx)
  if (denied) return denied
  try {
    await setThreadResolved(threadId, resolved)
    return { ok: true, message: resolved ? 'Đã resolve.' : 'Đã mở lại thread.' }
  } catch (err) {
    return failure(err)
  }
}

export interface ItemDetail {
  rounds: RoundView[]
  findings: Record<number, FindingView[]>
  log: LogLine[]
  logRoundId: number | null
}

export async function itemDetailAction(itemId: number, logRoundId?: number): Promise<ItemDetail> {
  if (!enabled()) return { rounds: [], findings: {}, log: [], logRoundId: null }
  ensureTicker()
  await tick()
  const rounds = listRounds(itemId)
  const findings: Record<number, FindingView[]> = {}
  for (const r of rounds) if (r.state === 'done') findings[r.id] = listFindings(r.id)
  const target = logRoundId ?? rounds.at(-1)?.id ?? null
  return { rounds, findings, log: target ? await viewLog(target) : [], logRoundId: target }
}

/* ── editing results ────────────────────────────────────────────────────── */

export async function patchFindingAction(
  id: number,
  patch: { body?: string; status?: FindingStatus },
): Promise<Result> {
  if (!enabled()) return OFF
  patchFinding(id, patch)
  return { ok: true, message: '' }
}

export async function updateSummaryAction(roundId: number, summary: string): Promise<Result> {
  if (!enabled()) return OFF
  if (!getRound(roundId)) return { ok: false, message: 'Không thấy vòng review.' }
  updateRoundSummary(roundId, summary)
  return { ok: true, message: '' }
}

export async function archiveItemAction(itemId: number, archived: boolean): Promise<Result> {
  if (!enabled()) return OFF
  patchItem(itemId, { status: archived ? 'archived' : 'open' })
  revalidatePath('/m/code-review')
  return { ok: true, message: archived ? 'Đã lưu trữ.' : 'Đã mở lại.' }
}

export async function deleteItemAction(itemId: number): Promise<Result> {
  if (!enabled()) return OFF
  if (hasLiveRound(itemId)) return { ok: false, message: 'Huỷ vòng đang chạy trước khi xoá.' }
  deleteItem(itemId)
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã xoá.' }
}

/* ── config ─────────────────────────────────────────────────────────────── */

export async function saveReposAction(repos: RepoPreset[]): Promise<Result> {
  if (!enabled()) return OFF
  const clean: RepoPreset[] = []
  for (const r of repos) {
    const name = r.name.trim()
    const localPath = r.localPath.trim().replace(/\/+$/, '')
    if (!name && !localPath) continue
    if (!name) return { ok: false, message: 'Repo nào cũng cần tên.' }
    if (!localPath.startsWith('/')) return { ok: false, message: `${name}: đường dẫn clone phải là đường dẫn tuyệt đối.` }
    if (!(await isRepo(localPath))) return { ok: false, message: `${name}: ${localPath} không phải một git repo.` }
    const githubRepo = r.githubRepo
      .trim()
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
    if (githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(githubRepo))
      return { ok: false, message: `${name}: GitHub repo phải có dạng owner/name.` }
    clean.push({ id: r.id || crypto.randomUUID(), name, localPath, githubRepo, rules: r.rules })
  }
  setRepos(clean)
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã lưu repo.' }
}

export async function saveRunnerAction(input: {
  concurrency: number
  claudeBin: string
  model: string
  globalRules: string
}): Promise<Result & { claude?: ClaudeCheck }> {
  if (!enabled()) return OFF
  setRunnerConfig(input)
  const claude = await checkClaude(true)
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã lưu.', claude }
}

/* ── chat with Claude about a round ─────────────────────────────────────── */

export async function chatAction(roundId: number): Promise<ChatMessage[]> {
  if (!enabled()) return []
  ensureTicker()
  await tick()
  return listChat(roundId)
}

export async function sendChatAction(roundId: number, text: string): Promise<Result> {
  if (!enabled()) return OFF
  ensureTicker()
  return sendChat(roundId, text)
}

export async function cancelChatAction(messageId: number): Promise<Result> {
  if (!enabled()) return OFF
  await cancelChat(messageId)
  return { ok: true, message: 'Đã huỷ.' }
}

export async function applyChatAction(messageId: number): Promise<Result> {
  if (!enabled()) return OFF
  return applyChanges(messageId)
}

/* ── linked PRs (SDK ↔ iOS) ─────────────────────────────────────────────── */

/** Keeps only well-formed links to configured repos, never the item itself. */
function cleanLinks(links: unknown, self?: { repoId: string; prNumber: number | null; headRef: string }): PrLink[] | string {
  if (!Array.isArray(links)) return 'Liên kết không hợp lệ.'
  const out: PrLink[] = []
  for (const l of links as PrLink[]) {
    const repo = getRepo(String(l?.repoId ?? ''))
    if (!repo) return 'Repo của PR liên kết không có trong Cấu hình.'
    const prNumber = Number.isInteger(l.prNumber) && l.prNumber! > 0 ? l.prNumber : null
    const headRef = String(l.headRef ?? '').trim()
    const baseRef = String(l.baseRef ?? '').trim()
    if (!headRef || !baseRef) return 'PR liên kết cần nhánh nguồn và nhánh đích.'
    if (self && self.repoId === repo.id && (prNumber ? prNumber === self.prNumber : headRef === self.headRef)) continue
    if (out.some((o) => o.repoId === repo.id && (prNumber ? o.prNumber === prNumber : o.headRef === headRef))) continue
    out.push({ repoId: repo.id, prNumber, headRef, baseRef, title: String(l.title ?? '').slice(0, 300), url: String(l.url ?? '') })
  }
  return out.slice(0, 5)
}

/**
 * Sets an item's linked PRs. Where a linked PR is itself tracked here, the
 * link is added on its side too — a pair is a pair from both ends.
 */
export async function setLinksAction(itemId: number, links: PrLink[]): Promise<Result> {
  if (!enabled()) return OFF
  const item = getItem(itemId)
  if (!item || item.kind !== 'pr') return { ok: false, message: 'Chỉ liên kết được giữa các PR.' }
  const clean = cleanLinks(links, item)
  if (typeof clean === 'string') return { ok: false, message: clean }
  setItemLinks(itemId, clean)

  const selfLink: PrLink = {
    repoId: item.repoId,
    prNumber: item.prNumber,
    headRef: item.headRef,
    baseRef: item.baseRef,
    title: item.title,
    url: item.url,
  }
  let mirrored = 0
  for (const l of clean) {
    const other = l.prNumber ? findPrItem(l.repoId, l.prNumber) : null
    if (!other || other.links.some((x) => x.repoId === item.repoId && x.prNumber === item.prNumber && x.headRef === item.headRef)) continue
    setItemLinks(other.id, [...other.links, selfLink])
    mirrored++
  }
  revalidatePath('/m/code-review')
  return {
    ok: true,
    message: clean.length
      ? `Đã liên kết ${clean.length} PR${mirrored ? ` (và liên kết ngược ở ${mirrored} hồ sơ)` : ''} — áp dụng từ vòng review tiếp theo.`
      : 'Đã bỏ liên kết.',
  }
}

/* ── how comments address the author ───────────────────────────────────── */

/**
 * Sets how this PR's comments speak to its author, and — unless told not to —
 * remembers it for the author's next PRs too.
 */
export async function setAddresseeAction(itemId: number, input: Addressee, remember = true): Promise<Result> {
  if (!enabled()) return OFF
  const item = getItem(itemId)
  if (!item) return { ok: false, message: 'Không thấy hồ sơ.' }
  const handle = cleanHandle(input.handle)
  if (!validHandle(handle)) return { ok: false, message: 'Username GitHub không hợp lệ.' }
  if (!HONORIFICS.includes(input.honorific)) return { ok: false, message: 'Chọn Em / Anh / Chị.' }
  const a: Addressee = { handle, honorific: input.honorific }
  setItemAddressee(itemId, a)
  if (remember && item.author) rememberPerson(item.author, a)
  revalidatePath(`/m/code-review/${itemId}`)
  return { ok: true, message: `Đã lưu — comment sẽ gọi "${addressOf(a)}".` }
}
