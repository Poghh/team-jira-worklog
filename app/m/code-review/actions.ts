'use server'

import { revalidatePath } from 'next/cache'

import { type ChatMessage, applyChanges, cancelChat, listChat, sendChat } from '@/lib/modules/code-review/chat'
import { type ClaudeCheck, checkClaude } from '@/lib/modules/code-review/claude'
import type { WorkBranch } from '@/lib/modules/code-review/model'
import { getRepo, getTemplate, rememberPerson, setRepos, setRunnerConfig, setTemplates } from '@/lib/modules/code-review/config'
import {
  countDirty,
  currentBranch,
  diffRanges,
  fetchAll,
  gitSays,
  isRepo,
  listRemoteBranches,
  listWorkBranches,
  revParse,
  snapshotUncommitted,
  withRepoLock,
} from '@/lib/modules/code-review/git'
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
import {
  type ConfluenceAccess,
  ConfluenceError,
  checkConfluenceAccess,
  postPageComment,
  previewLink,
  replyToPageComment,
  resolveSources,
} from '@/lib/modules/code-review/confluence'
import { ForbiddenAction } from '@/lib/modules/code-review/guard'
import { confluencePages, type SubpageInfo, type Addressee, type DocFile, type DocTemplate, type FindingStatus, HONORIFICS, type PrLink, addressOf, anchorInDiff, cleanHandle, validHandle, type FindingView, type ItemSummary, type RepoPreset, type RoundView, where } from '@/lib/modules/code-review/model'
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
  setItemSources,
  setItemTemplate,
  toRound,
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
 * Ảnh chụp **toàn bộ thay đổi dưới máy** của một clone, ngay lúc này.
 *
 * Tự review soi code đang có ở local, không soi một commit hay một nhánh: thứ
 * cần biết là "những gì tôi đã đổi so với nhánh nền", mà nó gồm cả commit chưa
 * push lẫn việc chưa commit. Một ảnh chụp gộp cả hai trả lời đúng câu đó.
 *
 * Cây bẩn → `git stash create` dựng một commit lơ lửng trên HEAD, gom cả staged
 * lẫn unstaged. Cây sạch → chính HEAD, vì lúc đó "thay đổi dưới máy" là các
 * commit chưa lên nhánh nền.
 *
 * File chưa từng `git add` không vào được ảnh chụp — `stash create` không có
 * `--include-untracked`. Màn hình phải nói ra, không được im.
 */
async function snapshotLocal(
  dir: string,
): Promise<{ sha: string; base: string; label: string; why: string }> {
  const on = await currentBranch(dir).catch(() => '')
  const head = await revParse(dir, 'HEAD').catch(() => '')
  if (!head)
    return { sha: '', base: '', label: '', why: 'Không đọc được HEAD của clone làm việc.' }
  const dirty = await countDirty(dir).catch(() => 0)
  if (dirty > 0) {
    const sha = await snapshotUncommitted(dir).catch(() => '')
    // `stash create` dựng commit lơ lửng có cha là HEAD, nên hai đầu mút của
    // lượt soi là HEAD → ảnh chụp: đúng phần đang gõ dở, không gì khác.
    if (sha)
      return { sha, base: head, label: `${dirty} file chưa commit${on ? ` trên ${on}` : ''}`, why: '' }
  }
  return { sha: head, base: head, label: on || 'HEAD', why: '' }
}

/** Nhánh trong clone làm việc, kèm có việc chưa commit hay không. */
export async function listWorkAction(
  repoId: string,
  /** Clone nào — một repo có thể khai nhiều. Rỗng thì lấy cái đầu. */
  workPath = '',
): Promise<Result & { branches: WorkBranch[]; dirty: number; head: string }> {
  const none = { branches: [] as WorkBranch[], dirty: 0, head: '' }
  if (!enabled()) return { ...OFF, ...none }
  const repo = getRepo(repoId)
  if (!repo) return { ok: false, message: 'Không thấy repo.', ...none }
  // Chỉ nhận đường dẫn repo này đã khai: tham số tới từ trình duyệt, và một
  // đường dẫn tuỳ ý sẽ biến ô chọn clone thành cách đọc bất kỳ repo nào trên máy.
  const dir = workPath && repo.workPaths.includes(workPath) ? workPath : repo.workPaths[0]
  if (!dir)
    return { ok: false, message: 'Repo này chưa khai clone làm việc — vào Cấu hình điền đường dẫn.', ...none }
  try {
    return {
      ok: true,
      message: '',
      branches: await listWorkBranches(dir),
      dirty: await countDirty(dir),
      head: await currentBranch(dir),
    }
  } catch (err) {
    return { ok: false, message: gitSays(err), ...none }
  }
}

/**
 * Chụp lại những link "dưới máy", chốt hai đầu mút cho từng cái.
 *
 * Cùng lý do với ảnh chụp của chính hồ sơ: giữa lúc bấm và lúc tới lượt có
 * hàng đợi. Nếu vế kia chụp lúc chạy thì hai bên lệch nhau về thời gian, mà
 * cả việc link là để đối chiếu hai bên ở **cùng một thời điểm**.
 *
 * Link không phải dưới máy (PR, cặp nhánh) đi qua đây nguyên vẹn —
 * `prepareLinks` tự lấy chúng từ origin lúc chạy.
 */
async function snapshotLinks(links: PrLink[]): Promise<{ links?: PrLink[]; message?: string }> {
  const out: PrLink[] = []
  for (const l of links) {
    if (!l.workPath) {
      out.push(l)
      continue
    }
    const repo = getRepo(l.repoId)
    if (!repo) return { message: 'Một repo liên kết đã bị xoá khỏi Cấu hình.' }
    if (!repo.workPaths.includes(l.workPath))
      return { message: `Clone "${l.workPath}" không còn trong Cấu hình của ${repo.name}.` }
    const snap = await snapshotLocal(l.workPath)
    if (!snap.sha) return { message: `${repo.name}: ${snap.why}` }
    if (snap.sha === snap.base)
      return {
        message: `${repo.name} không có thay đổi nào chưa commit — bỏ liên kết đó ra, hoặc liên kết PR của nó.`,
      }
    out.push({ ...l, headRef: snap.sha, baseRef: snap.base, title: `${repo.name} · ${snap.label}` })
  }
  return { links: out }
}

/**
 * Xếp hàng một lượt tự review.
 *
 * Soi **thay đổi trước → sau**, không so với nhánh nền: vòng 1 là HEAD → phần
 * đang gõ dở, vòng sau là lần sửa trước → lần sửa này. Nhánh nền kéo cả lịch
 * sử nhánh vào mỗi lượt, và phần bạn vừa sửa chìm trong đó.
 *
 * Cả hai đầu mút chốt **ở đây**, không phải lúc chạy: giữa lúc bấm và lúc tới
 * lượt có hàng đợi, và bạn có thể đã gõ tiếp. Review phải soi đúng thứ bạn
 * nhìn thấy lúc bấm, nếu không thì finding trỏ vào những dòng đã đổi.
 *
 * Với việc chưa commit, cái chốt được là một commit lơ lửng do `git stash
 * create` dựng — xem {@link snapshotUncommitted}. Nó không đụng cây làm việc,
 * không đụng stash list, và `git gc` tự dọn.
 */
export async function queueSelfAction(input: {
  repoId: string
  /** Clone làm việc đã chọn. Phải là một trong những cái repo đã khai. */
  workPath: string
  title: string
  note: string
  docs?: DocFile[]
  /** Vế kia của một thay đổi hai repo — xem {@link snapshotLinks}. */
  links?: PrLink[]
}): Promise<Result & { itemId?: number }> {
  const blocked = await ready()
  if (blocked) return blocked
  const docs = await validDocs(input.docs ?? [])
  if (!docs) return { ok: false, message: 'Tài liệu đính kèm không hợp lệ — tải lên lại.' }
  const repo = getRepo(input.repoId)
  if (!repo) return { ok: false, message: 'Không thấy repo.' }
  const dir = repo.workPaths.includes(input.workPath) ? input.workPath : repo.workPaths[0]
  if (!dir) return { ok: false, message: 'Repo này chưa khai clone làm việc.' }

  const snap = await snapshotLocal(dir)
  if (!snap.sha) return { ok: false, message: snap.why }
  // Cây sạch thì hai đầu mút trùng nhau và lượt soi rỗng. Nói thẳng ở đây,
  // chứ chạy một lượt rỗng rồi trả về "không thấy gì" thì đọc thành "code
  // sạch" — một câu trả lời sai về đúng thứ người dùng muốn biết.
  if (snap.sha === snap.base)
    return {
      ok: false,
      message:
        'Chưa có thay đổi nào để soi — cây làm việc đang sạch. Sửa code rồi bấm lại, hoặc dùng “Nhánh” nếu muốn soi cả nhánh.',
    }
  const head = snap.sha
  const label = snap.label

  const linked = await snapshotLinks(input.links ?? [])
  if (!linked.links) return { ok: false, message: linked.message! }

  const itemId = createItem({
    kind: 'self',
    repoId: input.repoId,
    workPath: dir,
    title: input.title.trim() || label,
    prNumber: null,
    // Một sha, không phải tên nhánh: đây là mốc "trước" đã chốt, và tên nhánh
    // thì lúc chạy có thể đã trỏ chỗ khác.
    baseRef: snap.base,
    headRef: head,
    author: '',
    url: '',
    note: input.note.trim(),
    links: linked.links,
  })
  queueRound(itemId, docs)
  ensureTicker()
  void tick()
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã xếp hàng.', itemId }
}

/**
 * The documents a PR's next round inherits: whatever the last round had./**
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

  // Tự review: chụp lại **bây giờ**, không dùng lại ảnh của vòng trước.
  //
  // Vòng sau sinh ra để xem bạn đã sửa thế nào, nên nó phải soi trạng thái
  // hiện tại. Dùng lại `headRef` cũ thì hai vòng soi đúng một commit, và câu
  // trả lời cho "đã sửa chưa" luôn là "chưa".
  if (item.kind === 'self') {
    const repo = item.repoId ? getRepo(item.repoId) : undefined
    const dir = repo?.workPaths.includes(item.workPath) ? item.workPath : ''
    if (!dir) return { ok: false, message: 'Clone làm việc của hồ sơ này không còn trong Cấu hình.' }
    const snap = await snapshotLocal(dir)
    if (!snap.sha) return { ok: false, message: snap.why }
    patchItem(itemId, { headRef: snap.sha })
    // Vế kia chụp lại cùng lúc, nếu không thì vòng sau đối chiếu code iOS mới
    // với SDK của vòng trước — và chỗ lệch nó báo là chỗ bạn vừa sửa xong.
    if (item.links.some((l) => l.workPath)) {
      const relinked = await snapshotLinks(item.links)
      if (!relinked.links) return { ok: false, message: relinked.message! }
      setItemLinks(itemId, relinked.links)
    }
  }

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
  message: err instanceof ForbiddenAction || err instanceof GithubError || err instanceof ConfluenceError ? err.message : `Lỗi: ${(err as Error).message}`,
})

const locationLine = (f: FindingView) => `**\`${where(f)}\`**`

/**
 * Posts one finding on its own. Inside the diff it becomes an inline comment
 * on its line; outside it, a conversation comment that names the place.
 */
/**
 * Diff hunks of the round's PR, read from the local clone — the ground truth
 * for which lines GitHub will accept a comment on. Best-effort: without them
 * nothing is posted inline.
 */
async function roundRanges(itemId: number, baseSha: string, headSha: string) {
  const item = getItem(itemId)
  const repo = item?.repoId ? getRepo(item.repoId) : undefined
  if (!repo || !baseSha || !headSha) return null
  return diffRanges(repo.localPath, baseSha, headSha).catch(() => null)
}

/** GitHub refusing to place a comment on a line — the case worth retrying as a conversation comment. */
const unplaceable = (err: unknown) =>
  err instanceof GithubError && /could not be resolved|part of the diff|pull_request_review_thread/i.test(err.message)

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
  const asConversation = () => postIssueComment(ctx.repo, ctx.number, `${f.file ? `${locationLine(f)}\n\n` : ''}${f.body}`)
  try {
    // Re-anchored on the real diff now, not trusted from when it was stored: a
    // range running past its hunk is trimmed to fit, so GitHub can resolve it.
    const ranges = f.file && f.line ? await roundRanges(round!.itemId, round!.baseSha, round!.headSha) : null
    const anchor = f.file ? anchorInDiff(ranges?.get(f.file), f.line, f.endLine) : null
    if (anchor && round!.headSha) {
      try {
        const posted = await postInlineComment(ctx.repo, ctx.number, round!.headSha, { path: f.file, ...anchor, body: f.body })
        patchFinding(findingId, { ghCommentId: posted.id, ghUrl: posted.url })
        const trimmed = (anchor.startLine ?? anchor.line) !== f.line || anchor.line !== (f.endLine && f.endLine > f.line! ? f.endLine : f.line)
        return {
          ok: true,
          message: trimmed
            ? `Đã gửi lên PR (gắn vào dòng ${anchor.startLine ? `${anchor.startLine}–` : ''}${anchor.line} — phần nằm trong diff).`
            : 'Đã gửi lên PR.',
          url: posted.url,
        }
      } catch (err) {
        if (!unplaceable(err)) throw err
        // e.g. the PR was force-pushed past this round's commit.
        const posted = await asConversation()
        patchFinding(findingId, { ghCommentId: null, ghUrl: posted.url })
        return { ok: true, message: 'GitHub không gắn được vào dòng code — đã gửi thành comment chung (có ghi file:dòng).', url: posted.url }
      }
    }
    const posted = await asConversation()
    patchFinding(findingId, { ghCommentId: null, ghUrl: posted.url })
    return {
      ok: true,
      message: f.file && f.line ? 'Dòng này không nằm trong diff — đã gửi thành comment chung (có ghi file:dòng).' : 'Đã gửi lên PR.',
      url: posted.url,
    }
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
  const ranges = await roundRanges(round.itemId, round.baseSha, round.headSha)
  const anchors = new Map(chosen.map((f) => [f.id, f.file ? anchorInDiff(ranges?.get(f.file), f.line, f.endLine) : null]))
  const inline = chosen.filter((f) => anchors.get(f.id))
  const rest = chosen.filter((f) => !inline.includes(f))
  const body = [
    input.body.trim(),
    rest.length
      ? rest.map((f, i) => `${rest.length > 1 ? `${i + 1}. ` : ''}${f.file ? `${locationLine(f)} ` : ''}**${f.title}**\n${f.body.trim().replace(/^/gm, rest.length > 1 ? '   ' : '')}`).join('\n\n')
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
      comments: inline.map((f) => ({ path: f.file, ...anchors.get(f.id)!, body: f.body })),
    })
    inline.forEach((f, i) => patchFinding(f.id, { ghCommentId: res.comments[i]?.id || null, ghUrl: res.comments[i]?.url || res.url }))
    for (const f of rest) patchFinding(f.id, { ghUrl: res.url })
    return { ok: true, message: `Đã gửi review: ${inline.length} comment trên dòng code${rest.length ? ` + ${rest.length} điểm trong nội dung` : ''}.`, url: res.url }
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
    // Clone làm việc là tuỳ chọn — không khai thì repo này chỉ review PR và
    // nhánh đã push. Khai rồi thì kiểm ngay, vì cái giá của một đường dẫn sai
    // là một lần review chết giữa chừng chứ không phải một dòng đỏ ở đây.
    const workPaths: string[] = []
    for (const raw of r.workPaths) {
      const w = raw.trim().replace(/\/+$/, '')
      if (!w) continue
      if (!w.startsWith('/'))
        return { ok: false, message: `${name}: đường dẫn clone làm việc phải là đường dẫn tuyệt đối — "${w}".` }
      if (!(await isRepo(w))) return { ok: false, message: `${name}: ${w} không phải một git repo.` }
      if (w === localPath)
        return {
          ok: false,
          message: `${name}: clone làm việc phải khác clone review — app dựng worktree trong clone review, và làm thế ngay trong repo bạn đang gõ là chuyện khác hẳn.`,
        }
      if (!workPaths.includes(w)) workPaths.push(w)
    }
    const githubRepo = r.githubRepo
      .trim()
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
    if (githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(githubRepo))
      return { ok: false, message: `${name}: GitHub repo phải có dạng owner/name.` }
    clean.push({ id: r.id || crypto.randomUUID(), name, localPath, workPaths, githubRepo, rules: r.rules })
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

/* ── document templates ─────────────────────────────────────────────────── */

export async function saveTemplatesAction(list: DocTemplate[]): Promise<Result> {
  if (!enabled()) return OFF
  const clean: DocTemplate[] = []
  for (const t of list) {
    const name = String(t.name ?? '').trim()
    if (!name) {
      if (!t.files?.length && !t.note?.trim()) continue
      return { ok: false, message: 'Mẫu nào cũng cần tên.' }
    }
    const files = await validDocs(t.files ?? [])
    if (!files) return { ok: false, message: `${name}: file mẫu không hợp lệ — tải lên lại.` }
    if (!files.length && !String(t.note ?? '').trim()) return { ok: false, message: `${name}: cần ít nhất một file mẫu hoặc checklist.` }
    clean.push({
      id: t.id || crypto.randomUUID(),
      name,
      note: String(t.note ?? ''),
      files,
      repoIds: (t.repoIds ?? []).filter((id) => getRepo(id)),
    })
  }
  setTemplates(clean)
  revalidatePath('/m/code-review')
  return { ok: true, message: 'Đã lưu mẫu tài liệu.' }
}

export async function setTemplateAction(itemId: number, templateId: string): Promise<Result> {
  if (!enabled()) return OFF
  const item = getItem(itemId)
  if (!item || item.kind !== 'doc') return { ok: false, message: 'Chỉ hồ sơ tài liệu mới gắn mẫu.' }
  if (templateId && !getTemplate(templateId)) return { ok: false, message: 'Không thấy mẫu này.' }
  setItemTemplate(itemId, templateId)
  revalidatePath(`/m/code-review/${itemId}`)
  return { ok: true, message: templateId ? 'Đã gắn mẫu — áp dụng từ vòng review tiếp theo.' : 'Đã bỏ mẫu.' }
}

/**
 * A later round's follow-up on a finding that is already on GitHub. An inline
 * comment gets a reply in its own thread; a conversation comment (no thread to
 * reply in) gets a new comment that quotes and links the original.
 */
export async function followUpAction(findingId: number, body: string): Promise<Result & { url?: string }> {
  if (!enabled()) return OFF
  const text = body.trim()
  if (!text) return { ok: false, message: 'Nội dung trống.' }
  const f = getFinding(findingId)
  if (!f?.ghUrl) return { ok: false, message: 'Finding này chưa từng được gửi lên PR — dùng "Gửi lên PR".' }
  const round = getRound(f.roundId)
  const ctx = round ? prContext(round.itemId) : 'Không thấy vòng review.'
  if (typeof ctx === 'string') return { ok: false, message: ctx }
  const denied = await denyWrite(ctx)
  if (denied) return denied
  try {
    const posted = f.ghCommentId
      ? await replyToComment(ctx.repo, ctx.number, f.ghCommentId, text)
      : await postIssueComment(ctx.repo, ctx.number, `> **${f.title}** — [comment trước](${f.ghUrl})\n\n${text}`)
    patchFinding(findingId, { followReply: text, followSentUrl: posted.url })
    return { ok: true, message: f.ghCommentId ? 'Đã trả lời trong thread.' : 'Đã comment tiếp (trích comment cũ).', url: posted.url }
  } catch (err) {
    return failure(err)
  }
}

/* ── Confluence (doc reviews) ───────────────────────────────────────────── */

/**
 * Doc findings go back onto the Confluence page they are about — inline on
 * the quoted text where it is still there, as a page comment otherwise. Same
 * rules as GitHub: one explicit click (two, to confirm), the server re-checks
 * the permission, and only the comment endpoints exist (guard.ts). The comment
 * id and link are kept in gh_comment_id / gh_url, with comment_kind set.
 */
export async function confluenceAccessAction(itemId: number, force = false): Promise<ConfluenceAccess> {
  if (!enabled()) return { read: false, write: false, reason: 'Module đang tắt.' }
  const item = getItem(itemId)
  const pageId = item?.sources[0]?.pageId
  if (!item || item.kind !== 'doc' || !pageId) return { read: false, write: false, reason: 'Hồ sơ này không có trang Confluence.' }
  return checkConfluenceAccess(pageId, force)
}

/** The finding, and the Confluence page of its round it may be posted to. */
function pageTarget(findingId: number, pageId?: string) {
  const f = getFinding(findingId)
  if (!f) return 'Không thấy finding.'
  const row = getRound(f.roundId)
  const item = row ? getItem(row.itemId) : null
  if (!row || !item || item.kind !== 'doc') return 'Finding này không thuộc hồ sơ tài liệu.'
  const pages = confluencePages(toRound(row).docs)
  // Only a page this round actually read — never an id from the browser alone.
  const page = pages.find((p) => p.source.pageId === (pageId || f.docRef))
  if (!page) return pages.length ? 'Chọn trang Confluence để gửi comment.' : 'Vòng này không đọc trang Confluence nào.'
  return { f, page }
}

async function postOne(findingId: number, pageId?: string): Promise<Result & { url?: string }> {
  const t = pageTarget(findingId, pageId)
  if (typeof t === 'string') return { ok: false, message: t }
  const { f, page } = t
  if (f.ghUrl) return { ok: false, message: 'Finding này đã được gửi.' }
  const access = await checkConfluenceAccess(page.source.pageId)
  if (!access.write) return { ok: false, message: access.reason }
  try {
    const c = await postPageComment({ pageId: page.source.pageId, pageUrl: page.source.url, body: f.body, quote: f.quote })
    patchFinding(findingId, { ghCommentId: c.id, ghUrl: c.url, commentKind: c.kind, docRef: page.source.pageId })
    return {
      ok: true,
      message: c.anchored ? `Đã comment vào đoạn được chọn trên "${page.name}".` : `Đã gửi thành comment cuối trang "${page.name}"${f.quote ? ' (đoạn trích không còn khớp — có trích kèm)' : ''}.`,
      url: c.url,
    }
  } catch (err) {
    return failure(err)
  }
}

export async function postConfluenceAction(findingId: number, pageId?: string): Promise<Result & { url?: string }> {
  if (!enabled()) return OFF
  return postOne(findingId, pageId)
}

/** The findings the reviewer kept, each as its own comment — one after another, stopping at the first refusal of access. */
export async function postAllConfluenceAction(roundId: number, findingIds: number[]): Promise<Result & { sent: number }> {
  if (!enabled()) return { ...OFF, sent: 0 }
  const round = getRound(roundId)
  if (!round || round.state !== 'done') return { ok: false, message: 'Vòng review này chưa xong.', sent: 0 }
  const mine = new Set(listFindings(roundId).map((f) => f.id))
  let sent = 0
  const problems: string[] = []
  for (const id of findingIds) {
    if (!mine.has(id)) continue
    const r = await postOne(id)
    if (r.ok) sent++
    else {
      problems.push(`#${id}: ${r.message}`)
      if (/quyền|401|403|token/i.test(r.message)) break
    }
  }
  return {
    ok: problems.length === 0,
    sent,
    message: `Đã gửi ${sent} comment lên Confluence.${problems.length ? ` Không gửi được ${problems.length}: ${problems.slice(0, 3).join(' · ')}` : ''}`,
  }
}

/** A reply under a finding already on Confluence, in its thread. */
export async function confluenceReplyAction(findingId: number, body: string): Promise<Result & { url?: string }> {
  if (!enabled()) return OFF
  const text = body.trim()
  if (!text) return { ok: false, message: 'Nội dung trống.' }
  const f = getFinding(findingId)
  if (!f?.ghCommentId || !f.commentKind) return { ok: false, message: 'Finding này chưa được gửi lên Confluence.' }
  const t = pageTarget(findingId, f.docRef)
  const pageId = typeof t === 'string' ? f.docRef : t.page.source.pageId
  const pageUrl = typeof t === 'string' ? f.ghUrl : t.page.source.url
  if (pageId) {
    const access = await checkConfluenceAccess(pageId)
    if (!access.write) return { ok: false, message: access.reason }
  }
  try {
    const c = await replyToPageComment({ kind: f.commentKind, parentId: f.ghCommentId, body: text, pageUrl })
    patchFinding(findingId, { followSentUrl: c.url })
    return { ok: true, message: 'Đã trả lời trong thread trên Confluence.', url: c.url }
  } catch (err) {
    return failure(err)
  }
}

/** A pasted Confluence link: its title and its subpages, so each can get its own role and template. */
export async function confluencePreviewAction(
  url: string,
): Promise<Result & { pageId?: string; title?: string; url?: string; subpages?: SubpageInfo[] }> {
  if (!enabled()) return OFF
  try {
    return { ok: true, message: '', ...(await previewLink(url)) }
  } catch (err) {
    return failure(err)
  }
}

/** The pasted Confluence pages of a doc review — used from the next round on. */
export async function setSourcesAction(itemId: number, input: unknown): Promise<Result> {
  if (!enabled()) return OFF
  const item = getItem(itemId)
  if (!item || item.kind !== 'doc') return { ok: false, message: 'Không thấy hồ sơ tài liệu.' }
  const sources = await resolveSources(input)
  if (typeof sources === 'string') return { ok: false, message: sources }
  for (const s of sources) if (s.templateId && !getTemplate(s.templateId)) return { ok: false, message: 'Mẫu tài liệu không còn trong Cấu hình.' }
  setItemSources(itemId, sources)
  revalidatePath('/m/code-review')
  return { ok: true, message: sources.length ? `Đã lưu ${sources.length} link Confluence — áp dụng từ vòng tiếp theo.` : 'Đã bỏ hết link Confluence.' }
}

/**
 * The code a doc review is checked against: the first repo is where Claude
 * runs, the others are read beside it (stored as links with no base).
 */
export async function setDocReposAction(itemId: number, repos: Array<{ repoId: string; ref: string }>): Promise<Result> {
  if (!enabled()) return OFF
  const item = getItem(itemId)
  if (!item || item.kind !== 'doc') return { ok: false, message: 'Không thấy hồ sơ tài liệu.' }
  const picked: Array<{ repoId: string; ref: string }> = []
  for (const r of (Array.isArray(repos) ? repos : []).slice(0, 6)) {
    const id = String(r?.repoId ?? '').trim()
    const ref = String(r?.ref ?? '').trim()
    if (!id) continue
    const repo = getRepo(id)
    if (!repo) return { ok: false, message: 'Không thấy repo.' }
    if (!ref) return { ok: false, message: `Chọn nhánh cho ${repo.name}.` }
    if (!picked.some((p) => p.repoId === id && p.ref === ref)) picked.push({ repoId: id, ref })
  }
  patchItem(itemId, { repoId: picked[0]?.repoId ?? '', headRef: picked[0]?.ref ?? '' })
  setItemLinks(
    itemId,
    picked.slice(1).map((p) => ({ repoId: p.repoId, prNumber: null, baseRef: '', headRef: p.ref, title: p.ref, url: '' })),
  )
  revalidatePath('/m/code-review')
  return { ok: true, message: picked.length ? `Đối chiếu với ${picked.length} repo — áp dụng từ vòng tiếp theo.` : 'Không đối chiếu code nữa.' }
}
