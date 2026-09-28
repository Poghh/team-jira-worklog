/**
 * What this module is allowed to do to the outside world — in one place, as
 * allowlists, so "review and comment, nothing else" is a property of the code
 * rather than a habit of whoever edits it next.
 *
 * Three layers, each enough on its own:
 *
 *   1. GitHub: the token may be able to merge, push, delete branches. The app
 *      may only POST to the four endpoints that create comments / reviews, and
 *      run the two GraphQL mutations that (un)resolve a thread. Anything else
 *      throws before a request is made. No PATCH, PUT or DELETE exists here.
 *   2. Git, run by the app on the review clones: reads, `fetch` into local
 *      refs, and temporary worktrees. No push, commit, reset, checkout, merge.
 *   3. Claude, run on code written by someone else: read-only tools, write and
 *      network commands denied by name, the PR's own `.claude/` settings,
 *      hooks and `.mcp.json` ignored, and an environment with no GitHub token,
 *      no SSH agent and git transport switched off.
 *
 * Pure and free of server imports so tests/code-review-guard.mts can hold it
 * to its word.
 */

export class ForbiddenAction extends Error {}

/* ── 1. GitHub ──────────────────────────────────────────────────────────── */

const REPO = String.raw`/repos/[\w.-]+/[\w.-]+`
const GITHUB_WRITES: RegExp[] = [
  // Inline review comment on a PR.
  new RegExp(String.raw`^${REPO}/pulls/\d+/comments$`),
  // Reply in an existing review thread.
  new RegExp(String.raw`^${REPO}/pulls/\d+/comments/\d+/replies$`),
  // Conversation comment on a PR.
  new RegExp(String.raw`^${REPO}/issues/\d+/comments$`),
  // A review: summary + inline comments + COMMENT / REQUEST_CHANGES.
  new RegExp(String.raw`^${REPO}/pulls/\d+/reviews$`),
]

/**
 * The events a review may carry. APPROVE is deliberately absent: an approval
 * can be the last thing standing between a PR and auto-merge, which makes it
 * an action on the branch, not a comment.
 */
export const REVIEW_EVENTS = ['COMMENT', 'REQUEST_CHANGES'] as const

export function assertGithubRequest(method: string, pathname: string, body?: unknown) {
  if (method === 'GET') return
  if (method !== 'POST') throw new ForbiddenAction(`Chặn: module chỉ được đọc và comment, không được ${method} lên GitHub.`)
  const bare = pathname.split('?')[0]
  if (!GITHUB_WRITES.some((re) => re.test(bare))) {
    throw new ForbiddenAction(`Chặn: ${bare} không nằm trong danh sách được phép (chỉ comment / review).`)
  }
  if (/\/reviews$/.test(bare)) {
    const event = (body as { event?: unknown } | undefined)?.event
    if (!(REVIEW_EVENTS as readonly unknown[]).includes(event)) {
      throw new ForbiddenAction(`Chặn: review chỉ được là Comment hoặc Request changes (nhận "${String(event)}").`)
    }
  }
}

const GRAPHQL_MUTATIONS = ['resolveReviewThread', 'unresolveReviewThread']

/** Queries pass; a mutation must be exactly one of the thread-resolve pair. */
export function assertGraphql(query: string) {
  const q = query.replace(/#[^\n]*/g, '')
  if (!/\bmutation\b/.test(q)) {
    if (/^\s*(query\b|\{)/.test(q)) return
    throw new ForbiddenAction('Chặn: GraphQL không rõ loại thao tác.')
  }
  const calls = [...q.matchAll(/\{\s*(\w+)\s*\(/g)].map((m) => m[1])
  const top = calls[0]
  const others = [...q.matchAll(/\b(\w+)\s*\(\s*input\s*:/g)].map((m) => m[1])
  if (!top || !GRAPHQL_MUTATIONS.includes(top) || others.some((m) => !GRAPHQL_MUTATIONS.includes(m)) || others.length > 1) {
    throw new ForbiddenAction(`Chặn: GraphQL mutation "${top ?? '?'}" không được phép (chỉ resolve / unresolve thread).`)
  }
}

/* ── 2. Git run by the app ─────────────────────────────────────────────── */

const GIT_ALLOWED = new Set([
  'rev-parse',
  'for-each-ref',
  'fetch',
  'merge-base',
  'cat-file',
  'diff',
  'show',
  'worktree',
])
const WORKTREE_ALLOWED = new Set(['add', 'remove', 'prune'])

/**
 * Checked on every git command this module runs. `fetch` only ever writes
 * local refs, so it stays; everything that can change a branch — here or on
 * the remote — is simply not on the list.
 */
export function assertGitArgs(args: string[]) {
  const [cmd, sub] = args
  if (!GIT_ALLOWED.has(cmd)) throw new ForbiddenAction(`Chặn lệnh git "${cmd}" — module chỉ đọc repo.`)
  if (cmd === 'worktree' && !WORKTREE_ALLOWED.has(sub)) throw new ForbiddenAction(`Chặn "git worktree ${sub}".`)
  if (cmd === 'fetch') {
    // Refspecs may only land in this module's own namespace or the ordinary
    // remote-tracking refs — never into a local branch.
    for (const a of args.slice(1)) {
      if (a.startsWith('-') || a === 'origin') continue
      const dst = a.split(':')[1]
      if (!dst || !(dst.startsWith('refs/review/') || dst.startsWith('refs/remotes/origin/'))) {
        throw new ForbiddenAction(`Chặn fetch vào "${dst ?? a}".`)
      }
    }
  }
}

/* ── 3. Claude on untrusted code ───────────────────────────────────────── */

export const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
  'Bash(git ls-files:*)',
  'Bash(git grep:*)',
]

/**
 * Denied by name, on top of `dontAsk` refusing anything not allowed above —
 * belt and braces for the commands that would matter most if one slipped
 * through.
 */
export const DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  ...[
    'git push',
    'git commit',
    'git reset',
    'git checkout',
    'git switch',
    'git restore',
    'git branch',
    'git tag',
    'git merge',
    'git rebase',
    'git pull',
    'git fetch',
    'git remote',
    'git config',
    'git worktree',
    'git update-ref',
    'git clean',
    'git stash',
    'git cherry-pick',
    'git revert',
    'git am',
    'git apply',
    'gh',
    'curl',
    'wget',
    'ssh',
    'scp',
    'rm',
    'mv',
    'cp',
  ].map((c) => `Bash(${c}:*)`),
]

/** Flags that keep the reviewed repository from configuring its own reviewer. */
export const ISOLATION_FLAGS = [
  // Only the reviewer's own ~/.claude settings: a PR can ship
  // `.claude/settings.json` granting itself tools or adding hooks that run
  // shell commands. Project and local sources are exactly that file.
  '--setting-sources',
  'user',
  // Likewise `.mcp.json` in the repo.
  '--strict-mcp-config',
  // Anything not pre-approved is refused, never prompted for.
  '--permission-mode',
  'dontAsk',
]

const SECRET_ENV = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
  'GITLAB_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  // A dev server started from inside Claude Code inherits these, and the CLI
  // refuses to start "inside another Claude Code session".
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
]

/**
 * The environment Claude reviews in. Even if a write command got past every
 * rule above, it would find no token, no SSH agent, no credential helper, and
 * git refusing every network transport — a push has nowhere to go.
 */
export function reviewEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const k of SECRET_ENV) delete env[k]
  for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k]
  const config: Array<[string, string]> = [
    ['protocol.allow', 'never'],
    ['credential.helper', ''],
    ['remote.origin.pushurl', 'https://push-disabled.invalid/'],
    ['core.sshCommand', 'false'],
    ['core.hooksPath', '/dev/null'],
  ]
  env.GIT_CONFIG_COUNT = String(config.length)
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
