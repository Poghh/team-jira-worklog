/**
 * Shapes and pure helpers for the code-review module — no server imports, so
 * the client components render comments with exactly the same code that the
 * server uses.
 */

export type ItemKind = 'pr' | 'doc'

export type RoundState =
  | 'queued'
  | 'preparing'
  | 'running'
  /** Claude has finished; one server process is storing its findings. */
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'lost'

export const LIVE_STATES: RoundState[] = ['queued', 'preparing', 'running', 'finalizing']

export const ROUND_LABEL: Record<RoundState, string> = {
  queued: 'Đang chờ',
  preparing: 'Chuẩn bị',
  running: 'Đang review',
  finalizing: 'Đang lưu',
  done: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
  lost: 'Mất dấu',
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nit'
export const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nit']
export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: 'Chặn merge',
  major: 'Quan trọng',
  minor: 'Nhỏ',
  nit: 'Góp ý vặt',
}

export type DocCategory = 'missing' | 'wrong' | 'unreasonable' | 'mismatch'
export const DOC_CATEGORIES: DocCategory[] = ['missing', 'wrong', 'unreasonable', 'mismatch']
export const DOC_CATEGORY_LABEL: Record<DocCategory, string> = {
  missing: 'Thiếu',
  wrong: 'Sai',
  unreasonable: 'Chưa hợp lý',
  mismatch: 'Lệch với code / spec',
}

export type FindingStatus = 'open' | 'fixed' | 'partial' | 'not_fixed' | 'dismissed'
export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Mới',
  fixed: 'Đã sửa',
  partial: 'Sửa chưa hết',
  not_fixed: 'Chưa sửa',
  dismissed: 'Bỏ qua',
}

export type Verdict = 'approve' | 'request_changes' | 'comment'
export const VERDICT_LABEL: Record<Verdict, string> = {
  approve: 'Ổn, có thể duyệt',
  request_changes: 'Cần sửa',
  comment: 'Góp ý',
}

export type DocRole = 'spec' | 'tdd' | 'other'
export const DOC_ROLE_LABEL: Record<DocRole, string> = {
  spec: 'Mô tả chức năng',
  tdd: 'TDD',
  other: 'Khác',
}

export interface DocFile {
  name: string
  role: DocRole
  /** Absolute path on this machine, under data/code-review/docs. */
  path: string
  /** Doc reviews: the template this file must follow (TDD iOS / TDD SDK…); none = the item's default. */
  templateId?: string
  /** Set when the file is a Confluence page, saved as Markdown for this round. */
  source?: ConfluencePage
}

/**
 * A Confluence page the reviewer pasted a link to. A round fetches it (and,
 * with `children`, every page under it) afresh, so "Review tiếp" always reads
 * the latest version.
 */
export interface ConfluenceRef {
  url: string
  pageId: string
  /** Title when the link was added — the round records the current one. */
  title: string
  /** Also read every subpage under it. */
  children: boolean
  role: DocRole
  /** Template the page (and its subpages) must follow; '' = none / the item's default. */
  templateId: string
}

/** One fetched page, as a round saw it. */
export interface ConfluencePage {
  pageId: string
  url: string
  version: number
  /** The pasted page this one was reached from; equal to pageId for the page itself. */
  rootId: string
  /** Titles from the pasted page down to this one's parent. */
  trail: string[]
}

/** The Confluence pages of a round, in the order Claude was given them. */
export const confluencePages = (docs: DocFile[]) => docs.filter((d): d is DocFile & { source: ConfluencePage } => Boolean(d.source))

/**
 * The template a picked file most likely follows: a TDD whose name says "sdk"
 * gets the template whose name says "SDK", "ios" likewise; otherwise the
 * fallback (the repo's default). Specs and other files follow none.
 */
export function guessTemplate(
  file: { name: string; role: DocRole },
  templates: Array<{ id: string; name: string }>,
  fallback: string,
): string {
  if (file.role !== 'tdd') return ''
  for (const key of ['sdk', 'ios', 'android', 'backend', 'web']) {
    if (new RegExp(key, 'i').test(file.name)) {
      const hit = templates.find((t) => new RegExp(key, 'i').test(t.name))
      if (hit) return hit.id
    }
  }
  return fallback
}

/** A repository the reviewer keeps a dedicated clone of. */
export interface RepoPreset {
  id: string
  name: string
  /** Absolute path of the clone. The app fetches into it; nothing is checked out there. */
  localPath: string
  /** `owner/name` on github.com — empty to review branches by hand only. */
  githubRepo: string
  /** Project-specific review checklist, appended to every prompt for this repo. */
  rules: string
}

/**
 * A PR in another repo reviewed alongside this one — typically the SDK change
 * an iOS PR builds on, or the other way round. Claude reads its code and diff
 * for context; findings still land on this PR.
 */
export interface PrLink {
  repoId: string
  /** GitHub PR number; null for a branch pair picked by hand. */
  prNumber: number | null
  baseRef: string
  headRef: string
  title: string
  url: string
}

/** A link as one round resolved it: what was actually compared, and where. */
export interface RoundLink extends PrLink {
  repoName: string
  baseSha: string
  headSha: string
  /** Worktree of the linked PR's head, readable by Claude via --add-dir. */
  workdir: string
  /** `git diff base head` of the linked PR, written out for Claude to Read. */
  diffPath: string
  /** Why it could not be prepared, when it could not. */
  error: string
}

export function linkLabel(l: Pick<PrLink, 'prNumber' | 'headRef' | 'title'>, repoName: string): string {
  return `${repoName} ${l.prNumber ? `#${l.prNumber}` : l.headRef}`
}

/**
 * How a comment speaks to the PR author. Vietnamese needs a pronoun that
 * encodes seniority: someone younger is simply mentioned (`@login`), someone
 * older gets "anh" / "chị" before the mention.
 */
export type Honorific = 'em' | 'anh' | 'chi'
export const HONORIFICS: Honorific[] = ['em', 'anh', 'chi']
export const HONORIFIC_LABEL: Record<Honorific, string> = { em: 'Em', anh: 'Anh', chi: 'Chị' }

export interface Addressee {
  /** GitHub username, without the @. */
  handle: string
  honorific: Honorific
}

/** The words that stand for the author in a comment: "@x", "anh @x", "chị @x". */
export function addressOf(a: Addressee): string {
  const at = `@${a.handle}`
  return a.honorific === 'anh' ? `anh ${at}` : a.honorific === 'chi' ? `chị ${at}` : at
}

export const cleanHandle = (h: string) => h.trim().replace(/^@+/, '')
export const validHandle = (h: string) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(h)

/**
 * A document template — what a TDD iOS / TDD SDK is supposed to look like.
 * A doc review checks the document against it: sections present, in order,
 * filled in, and the checklist met.
 */
export interface DocTemplate {
  id: string
  name: string
  /** Required sections / rules in prose — the checklist the files may not spell out. */
  note: string
  /** The template itself: PDF / Markdown / text, stored under data/code-review/docs/templates. */
  files: DocFile[]
  /** Repos this template is the default for when reviewing their documents. */
  repoIds: string[]
}

/**
 * A test Claude suggests the reviewer run on their own machine to confirm or
 * rule out a finding. Suggested only — the app never runs it.
 */
export interface TestSuggestion {
  /** What the run would show. */
  purpose: string
  /** Shell command, from the repository root. */
  command: string
  /** How to read the result: what a pass / a failure means for the review. */
  expect: string
  /** Titles of the findings it bears on. */
  findings: string[]
}

export interface FindingView {
  id: number
  roundId: number
  prevId: number | null
  file: string
  line: number | null
  endLine: number | null
  location: string
  severity: Severity
  category: string
  title: string
  body: string
  snippet: string
  snippetStart: number
  inDiff: boolean
  origin: 'new' | 'carried'
  status: FindingStatus
  followNote: string
  /** The GitHub comment this finding was posted as — replies hang off it. */
  ghCommentId: number | null
  ghUrl: string
  /** Carried findings already on GitHub: the reply Claude drafted for that thread. */
  followReply: string
  /** Set once that reply is posted. */
  followSentUrl: string
  /** Doc findings on Confluence: the page it is about ('' = not known). */
  docRef: string
  /** Doc findings: the exact text the comment hangs on, for an inline comment. */
  quote: string
  /** Once posted to Confluence: 'inline' | 'footer' — replies go to the same kind. */
  commentKind: '' | 'inline' | 'footer'
}

export interface RoundView {
  id: number
  itemId: number
  round: number
  state: RoundState
  baseSha: string
  headSha: string
  prevHeadSha: string
  docs: DocFile[]
  links: RoundLink[]
  testPlan: TestSuggestion[]
  verdict: Verdict | ''
  summary: string
  message: string
  costUsd: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

export interface ItemView {
  id: number
  kind: ItemKind
  repoId: string
  title: string
  prNumber: number | null
  baseRef: string
  headRef: string
  author: string
  url: string
  note: string
  status: 'open' | 'archived'
  seenAt: number | null
  links: PrLink[]
  /** Set on this PR; null = fall back to what is remembered for the author. */
  addressee: Addressee | null
  /** Doc reviews: the template it is checked against; '' = none. */
  templateId: string
  /** Doc reviews: Confluence pages fetched afresh by every round. */
  sources: ConfluenceRef[]
  updatedAt: number
}

/** A row on the dashboard: the item plus where its latest round stands. */
export interface ItemSummary extends ItemView {
  latest: RoundView | null
  rounds: number
  openFindings: number
}

export const shortSha = (sha: string) => sha.slice(0, 7)

export function where(f: Pick<FindingView, 'file' | 'line' | 'endLine' | 'location'>): string {
  if (f.location && !f.file) return f.location
  if (!f.file) return ''
  if (!f.line) return f.file
  return f.endLine && f.endLine > f.line
    ? `${f.file}:${f.line}-${f.endLine}`
    : `${f.file}:${f.line}`
}

/** What goes into the clipboard for one finding — the comment itself, nothing else. */
export function findingClipboard(f: FindingView, kind: ItemKind): string {
  if (kind === 'doc') {
    const cat = DOC_CATEGORY_LABEL[f.category as DocCategory] ?? f.category
    const loc = f.location ? ` (${f.location})` : ''
    return `**[${cat}]${loc} ${f.title}**\n${f.body}`.trim()
  }
  return f.body.trim()
}

/**
 * Every still-relevant finding as one markdown comment, for reviewers who would
 * rather paste once than twenty times. Inline-able findings go first by file.
 */
export function allClipboard(kind: ItemKind, findings: FindingView[]): string {
  const live = findings.filter((f) => f.status !== 'dismissed' && f.status !== 'fixed')
  const parts: string[] = []
  if (live.length) {
    const lines = live.map((f, i) => {
      const loc = kind === 'doc' ? f.location : where(f)
      const tag =
        kind === 'doc'
          ? DOC_CATEGORY_LABEL[f.category as DocCategory] ?? f.category
          : SEVERITY_LABEL[f.severity]
      const head = `${i + 1}. **[${tag}]${loc ? ` \`${loc}\`` : ''}** ${f.title}`
      return `${head}\n${indent(f.body.trim())}`
    })
    parts.push(lines.join('\n\n'))
  }
  return parts.join('\n\n---\n\n')
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => (l ? `   ${l}` : l))
    .join('\n')

/** GitHub link to a line at the reviewed sha, when the item is a GitHub PR. */
export function blobUrl(githubRepo: string, sha: string, f: FindingView): string {
  if (!githubRepo || !sha || !f.file) return ''
  const anchor = f.line ? `#L${f.line}${f.endLine && f.endLine > f.line ? `-L${f.endLine}` : ''}` : ''
  return `https://github.com/${githubRepo}/blob/${sha}/${f.file}${anchor}`
}

/**
 * Where a finding can sit on GitHub's diff, or null when it cannot.
 *
 * GitHub accepts a comment only on lines inside a diff hunk, and a multi-line
 * one only when its first and last line are inside the SAME hunk — otherwise
 * it answers "could not be resolved". A finding often spans a few lines past
 * the hunk's edge (the closing brace of a function), so the range is trimmed
 * to the part that overlaps the best hunk instead of being refused.
 *
 * `ranges` are the new-side [start, end] line ranges of the file's hunks.
 */
export function anchorInDiff(
  ranges: Array<[number, number]> | undefined,
  line: number | null,
  endLine: number | null,
): { line: number; startLine?: number } | null {
  if (!ranges?.length || !line) return null
  const from = line
  const to = endLine && endLine > line ? endLine : line
  let best: [number, number] | null = null
  let overlap = 0
  for (const [a, b] of ranges) {
    const o = Math.min(b, to) - Math.max(a, from) + 1
    // Prefer the hunk holding the first line — where the finding points.
    if (o > overlap || (o === overlap && o > 0 && from >= a && from <= b)) {
      best = [Math.max(a, from), Math.min(b, to)]
      overlap = o
    }
  }
  if (!best || overlap <= 0) return null
  const [s, e] = best
  return e > s ? { line: e, startLine: s } : { line: s }
}
