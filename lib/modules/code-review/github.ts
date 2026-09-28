import 'server-only'

import { SETTING_KEYS, getSetting } from '@/lib/settings'

import { REVIEW_EVENTS, assertGithubRequest, assertGraphql } from './guard'

/**
 * The part of GitHub this module talks to: reading PRs and their discussion,
 * and — only ever on an explicit click by the reviewer — posting review
 * comments, replies and thread resolutions as the token's owner.
 *
 * The token is the core `github_token` setting. A public repo reads without
 * one, at 60 requests an hour; a private one, and every write, needs it —
 * with "Pull requests: read and write" for the writes.
 */

export interface PullSummary {
  number: number
  title: string
  author: string
  headRef: string
  headSha: string
  baseRef: string
  url: string
  draft: boolean
  updatedAt: string
}

export interface PullDetail extends PullSummary {
  body: string
}

export interface PullComment {
  author: string
  body: string
  /** File path for an inline comment, '' for a conversation comment. */
  path: string
  line: number | null
  createdAt: string
}

export class GithubError extends Error {}

async function gh<T>(pathname: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  // Before anything leaves the machine: only the comment / review endpoints
  // may be written to, whatever the token itself is allowed to do.
  assertGithubRequest(init?.method ?? 'GET', pathname, init?.body)
  const token = getSetting(SETTING_KEYS.githubToken)?.trim()
  if (init && !token) throw new GithubError('Cần GitHub token (Settings) có quyền ghi Pull requests để gửi comment.')
  const res = await fetch(`https://api.github.com${pathname}`, {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    // GitHub explains a refused write in `message` / `errors` — e.g. "line
    // must be part of the diff", "Can not approve your own pull request".
    let detail = ''
    try {
      const j = (await res.json()) as { message?: string; errors?: Array<string | { message?: string }> }
      detail = [j.message, ...(j.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? ''))]
        .filter(Boolean)
        .join(' · ')
    } catch {}
    if (init && (res.status === 403 || res.status === 404)) {
      throw new GithubError(`GitHub từ chối ghi (${res.status}) — token cần quyền "Pull requests: Read and write" cho repo này.${detail ? ` (${detail})` : ''}`)
    }
    if (init && res.status === 422) throw new GithubError(`GitHub không nhận: ${detail || 'dữ liệu không hợp lệ'}`)
    const hint =
      res.status === 401
        ? 'GitHub token sai hoặc hết hạn (Settings → GitHub token).'
        : res.status === 404
          ? token
            ? 'Không thấy repo — kiểm tra owner/name, hoặc token chưa có quyền đọc repo này.'
            : 'Không thấy repo — repo private cần GitHub token trong Settings.'
          : res.status === 403
            ? 'GitHub từ chối (có thể hết rate limit) — thêm token trong Settings.'
            : `GitHub trả ${res.status}.`
    throw new GithubError(hint)
  }
  return (await res.json()) as T
}

interface RawPull {
  number: number
  title: string
  user: { login: string } | null
  head: { ref: string; sha: string }
  base: { ref: string }
  html_url: string
  draft?: boolean
  updated_at: string
  body: string | null
}

const toSummary = (p: RawPull): PullSummary => ({
  number: p.number,
  title: p.title,
  author: p.user?.login ?? '',
  headRef: p.head.ref,
  headSha: p.head.sha,
  baseRef: p.base.ref,
  url: p.html_url,
  draft: Boolean(p.draft),
  updatedAt: p.updated_at,
})

export async function listOpenPulls(repo: string): Promise<PullSummary[]> {
  const rows = await gh<RawPull[]>(`/repos/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`)
  return rows.map(toSummary)
}

export async function getPull(repo: string, number: number): Promise<PullDetail> {
  const p = await gh<RawPull>(`/repos/${repo}/pulls/${number}`)
  return { ...toSummary(p), body: p.body ?? '' }
}

/**
 * What people have already said on the PR, so the review does not repeat it.
 * Best-effort: a failure here costs context, not the review.
 */
export async function listPullComments(repo: string, number: number): Promise<PullComment[]> {
  try {
    const [inline, convo] = await Promise.all([
      gh<Array<{ user: { login: string } | null; body: string; path: string; line: number | null; original_line: number | null; created_at: string }>>(
        `/repos/${repo}/pulls/${number}/comments?per_page=100`,
      ),
      gh<Array<{ user: { login: string } | null; body: string; created_at: string }>>(
        `/repos/${repo}/issues/${number}/comments?per_page=100`,
      ),
    ])
    return [
      ...inline.map((c) => ({
        author: c.user?.login ?? '',
        body: c.body,
        path: c.path,
        line: c.line ?? c.original_line,
        createdAt: c.created_at,
      })),
      ...convo.map((c) => ({
        author: c.user?.login ?? '',
        body: c.body,
        path: '',
        line: null,
        createdAt: c.created_at,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } catch {
    return []
  }
}

/* ── writing ─────────────────────────────────────────────────────────────── */

export interface InlineComment {
  path: string
  line: number
  /** First line of a multi-line comment. */
  startLine?: number
  body: string
}

export interface PostedComment {
  id: number
  url: string
}

/** One inline comment, posted on its own (notifies immediately). */
export async function postInlineComment(
  repo: string,
  number: number,
  commitId: string,
  c: InlineComment,
): Promise<PostedComment> {
  const r = await gh<{ id: number; html_url: string }>(`/repos/${repo}/pulls/${number}/comments`, {
    method: 'POST',
    body: {
      body: c.body,
      commit_id: commitId,
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine, start_side: 'RIGHT' } : {}),
    },
  })
  return { id: r.id, url: r.html_url }
}

/** A conversation comment on the PR (not tied to a line). */
export async function postIssueComment(repo: string, number: number, body: string): Promise<PostedComment> {
  const r = await gh<{ id: number; html_url: string }>(`/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: { body },
  })
  return { id: r.id, url: r.html_url }
}

export async function replyToComment(repo: string, number: number, commentId: number, body: string): Promise<PostedComment> {
  const r = await gh<{ id: number; html_url: string }>(`/repos/${repo}/pulls/${number}/comments/${commentId}/replies`, {
    method: 'POST',
    body: { body },
  })
  return { id: r.id, url: r.html_url }
}

export type ReviewEvent = (typeof REVIEW_EVENTS)[number]

/**
 * A whole review in one go — summary, verdict and inline comments — so the
 * author gets one notification instead of one per comment. Returns the inline
 * comments GitHub created, in the order they were sent.
 */
export async function submitReview(
  repo: string,
  number: number,
  input: { commitId: string; body: string; event: ReviewEvent; comments: InlineComment[] },
): Promise<{ url: string; comments: PostedComment[] }> {
  const review = await gh<{ id: number; html_url: string }>(`/repos/${repo}/pulls/${number}/reviews`, {
    method: 'POST',
    body: {
      commit_id: input.commitId,
      body: input.body,
      event: input.event,
      comments: input.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: 'RIGHT',
        body: c.body,
        ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine, start_side: 'RIGHT' } : {}),
      })),
    },
  })
  let posted: PostedComment[] = []
  if (input.comments.length) {
    const rows = await gh<Array<{ id: number; html_url: string; path: string; body: string }>>(
      `/repos/${repo}/pulls/${number}/reviews/${review.id}/comments?per_page=100`,
    ).catch(() => [])
    // Matched by path + body rather than trusting order alone.
    const pool = [...rows]
    posted = input.comments.map((c) => {
      const i = pool.findIndex((r) => r.path === c.path && r.body.trim() === c.body.trim())
      const hit = i >= 0 ? pool.splice(i, 1)[0] : null
      return hit ? { id: hit.id, url: hit.html_url } : { id: 0, url: review.html_url }
    })
  }
  return { url: review.html_url, comments: posted }
}

/* ── discussion (GraphQL: threads carry resolved state REST does not) ─────── */

export interface GhComment {
  id: number
  author: string
  avatar: string
  body: string
  createdAt: string
  url: string
}

export interface GhThread {
  /** GraphQL node id, for resolve / unresolve. */
  id: string
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: GhComment[]
}

export interface GhReview {
  id: number
  author: string
  state: string
  body: string
  submittedAt: string
  url: string
}

export interface Discussion {
  viewer: string
  threads: GhThread[]
  comments: GhComment[]
  reviews: GhReview[]
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  assertGraphql(query)
  const token = getSetting(SETTING_KEYS.githubToken)?.trim()
  if (!token) throw new GithubError('Cần GitHub token trong Settings để xem thảo luận trên PR.')
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  })
  const j = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }>; message?: string }
  if (!res.ok || j.errors?.length) {
    throw new GithubError(`GitHub: ${j.errors?.map((e) => e.message).join(' · ') || j.message || res.status}`)
  }
  return j.data as T
}

const COMMENT_FIELDS = 'databaseId author { login avatarUrl } body createdAt url'

interface RawComment {
  databaseId: number
  author: { login: string; avatarUrl: string } | null
  body: string
  createdAt: string
  url: string
}

const toComment = (c: RawComment): GhComment => ({
  id: c.databaseId,
  author: c.author?.login ?? 'ghost',
  avatar: c.author?.avatarUrl ?? '',
  body: c.body,
  createdAt: c.createdAt,
  url: c.url,
})

export async function getDiscussion(repo: string, number: number): Promise<Discussion> {
  const [owner, name] = repo.split('/')
  const data = await graphql<{
    viewer: { login: string }
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string
            path: string
            line: number | null
            originalLine: number | null
            isResolved: boolean
            isOutdated: boolean
            comments: { nodes: RawComment[] }
          }>
        }
        comments: { nodes: RawComment[] }
        reviews: {
          nodes: Array<{ databaseId: number; author: { login: string } | null; state: string; body: string; submittedAt: string; url: string }>
        }
      } | null
    }
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { id path line originalLine isResolved isOutdated comments(first: 100) { nodes { ${COMMENT_FIELDS} } } }
          }
          comments(last: 100) { nodes { ${COMMENT_FIELDS} } }
          reviews(last: 50) { nodes { databaseId author { login } state body submittedAt url } }
        }
      }
    }`,
    { owner, name, number },
  )
  const pr = data.repository.pullRequest
  if (!pr) throw new GithubError('Không thấy PR này trên GitHub.')
  return {
    viewer: data.viewer.login,
    threads: pr.reviewThreads.nodes.map((t) => ({
      id: t.id,
      path: t.path,
      line: t.line ?? t.originalLine,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.nodes.map(toComment),
    })),
    comments: pr.comments.nodes.map(toComment),
    reviews: pr.reviews.nodes
      .filter((r) => r.body.trim() || r.state !== 'COMMENTED')
      .map((r) => ({
        id: r.databaseId,
        author: r.author?.login ?? 'ghost',
        state: r.state,
        body: r.body,
        submittedAt: r.submittedAt,
        url: r.url,
      })),
  }
}

export async function setThreadResolved(threadId: string, resolved: boolean) {
  const m = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
  await graphql(`mutation($id: ID!) { ${m}(input: { threadId: $id }) { thread { id isResolved } } }`, { id: threadId })
}

/**
 * When anyone but `viewer` commented on each PR of a repo since `since` —
 * the "phản hồi mới" badge. Two calls per repo, however many PRs are tracked;
 * the caller compares each PR's timestamps with when it was last read.
 */
export async function repliesSince(repo: string, since: string, viewer: string): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const [inline, convo] = await Promise.all([
    gh<Array<{ user: { login: string } | null; pull_request_url: string; created_at: string }>>(
      `/repos/${repo}/pulls/comments?since=${encodeURIComponent(since)}&per_page=100&sort=created&direction=desc`,
    ),
    gh<Array<{ user: { login: string } | null; issue_url: string; created_at: string }>>(
      `/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100&sort=created&direction=desc`,
    ),
  ])
  const add = (url: string, who: string | undefined, at: string) => {
    if (!who || who === viewer) return
    const n = Number(url.split('/').pop())
    if (n) out.set(n, [...(out.get(n) ?? []), at])
  }
  for (const c of inline) add(c.pull_request_url, c.user?.login, c.created_at)
  for (const c of convo) add(c.issue_url, c.user?.login, c.created_at)
  return out
}

const g = globalThis as unknown as {
  __crViewer?: { token: string; login: string }
  __crAccess?: Map<string, GithubAccess & { at: number }>
}

export interface GithubAccess {
  /** Token present and the repo readable — the discussion can be shown. */
  read: boolean
  /** Token may create PR comments / reviews — the send buttons can be shown. */
  write: boolean
  /** Why not, in the reviewer's words, when either is false. */
  reason: string
}

const ACCESS_TTL = 10 * 60_000

/**
 * Whether the token can comment on this repo's PRs. Decides which UI the
 * reviewer gets: send / reply / resolve, or Copy only.
 *
 * A classic token says what it may do in `X-OAuth-Scopes` — `repo` (or
 * `public_repo` on a public repo) — so a GET answers it. A fine-grained token
 * says nothing about itself, so it is asked the only way GitHub allows: a
 * comment POST with an empty body, which cannot create anything. 403 means no
 * write permission; 422 ("body is missing") or 404 means the permission check
 * passed.
 */
export async function checkAccess(repo: string, prNumber: number | null, force = false): Promise<GithubAccess> {
  const token = getSetting(SETTING_KEYS.githubToken)?.trim() ?? ''
  const key = `${token.slice(-6)}|${repo}`
  const cache = (g.__crAccess ??= new Map())
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < ACCESS_TTL) return hit

  const result = await probeAccess(repo, prNumber, token)
  cache.set(key, { ...result, at: Date.now() })
  return result
}

async function probeAccess(repo: string, prNumber: number | null, token: string): Promise<GithubAccess> {
  if (!token) return { read: false, write: false, reason: 'Chưa có GitHub token trong Settings — chỉ Copy được.' }
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  }
  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${repo}`, { headers, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  } catch {
    return { read: false, write: false, reason: 'Không kết nối được GitHub để kiểm tra quyền token.' }
  }
  if (!res.ok) {
    return { read: false, write: false, reason: res.status === 401 ? 'GitHub token sai hoặc hết hạn.' : 'Token không đọc được repo này — chỉ Copy được.' }
  }
  const info = (await res.json().catch(() => ({}))) as { private?: boolean }

  const scopesHeader = res.headers.get('x-oauth-scopes')
  if (scopesHeader !== null) {
    const scopes = scopesHeader.split(',').map((s) => s.trim())
    const write = scopes.includes('repo') || (!info.private && scopes.includes('public_repo'))
    return {
      read: true,
      write,
      reason: write ? '' : `Token (classic) thiếu scope \`${info.private ? 'repo' : 'public_repo'}\` — chỉ xem được thảo luận, comment thì Copy rồi dán trên GitHub.`,
    }
  }

  const path = `/repos/${repo}/pulls/${prNumber ?? 0}/comments`
  assertGithubRequest('POST', path, {})
  try {
    const probe = await fetch(`https://api.github.com${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // Deliberately empty: missing `body`, `path` and `commit_id`, so even
      // with every permission GitHub can only refuse it.
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
    const write = probe.status === 422 || probe.status === 404
    return {
      read: true,
      write,
      reason: write ? '' : 'Token (fine-grained) chưa có quyền "Pull requests: Read and write" — chỉ xem được thảo luận, comment thì Copy rồi dán trên GitHub.',
    }
  } catch {
    return { read: true, write: false, reason: 'Không kiểm tra được quyền ghi — tạm chỉ cho Copy.' }
  }
}

/** Who the token belongs to — cached per token, it does not change. */
export async function viewerLogin(): Promise<string> {
  const token = getSetting(SETTING_KEYS.githubToken)?.trim() ?? ''
  if (g.__crViewer?.token === token) return g.__crViewer.login
  const login = (await gh<{ login: string }>('/user')).login
  g.__crViewer = { token, login }
  return login
}
