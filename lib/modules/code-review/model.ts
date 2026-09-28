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
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'lost'

export const LIVE_STATES: RoundState[] = ['queued', 'preparing', 'running']

export const ROUND_LABEL: Record<RoundState, string> = {
  queued: 'Đang chờ',
  preparing: 'Chuẩn bị',
  running: 'Đang review',
  done: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
  lost: 'Mất dấu',
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nit'
export const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nit']
export const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
  nit: 'Nit',
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
  approve: 'Approve',
  request_changes: 'Request changes',
  comment: 'Comment',
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
export function allClipboard(
  kind: ItemKind,
  summary: string,
  findings: FindingView[],
): string {
  const live = findings.filter((f) => f.status !== 'dismissed' && f.status !== 'fixed')
  const parts: string[] = []
  if (summary.trim()) parts.push(summary.trim())
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
