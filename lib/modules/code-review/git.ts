import 'server-only'

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { assertGitArgs } from './guard'

const run = promisify(execFile)

/**
 * Git against the reviewer's dedicated clones.
 *
 * The clones exist for reviewing and nothing else, so fetching into them is
 * fine — but nothing is ever checked out *in* them, and nothing is ever
 * pushed: every command passes `assertGitArgs` first. Each round gets its own
 * detached worktree, which is what lets three PRs of the same repo be reviewed
 * at the same time: one checkout can only stand on one commit.
 *
 * Worktrees live under the OS temp dir, not under `data/`. Claude Code reads
 * `CLAUDE.md` from every parent directory of where it runs, and a worktree
 * inside this app would hand the review this app's own instructions.
 */

export const WORKTREE_ROOT = path.join(os.tmpdir(), 'jira-logwork-review')

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  // Reads, local fetches and temp worktrees only — never push/commit/reset.
  assertGitArgs(args)
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    // A fetch that wants a password must fail, not hang the queue on a prompt
    // nobody can see.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

export function gitSays(err: unknown): string {
  const raw =
    typeof (err as { stderr?: unknown })?.stderr === 'string'
      ? (err as { stderr: string }).stderr
      : err instanceof Error
        ? err.message
        : String(err)
  const text = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Command failed:'))
    .join(' ')
  return (text.length > 400 ? `${text.slice(0, 400)}…` : text) || 'git không nói lý do'
}

/**
 * Serialises git writes per clone. Two fetches into one repository race on
 * `.git/*.lock`; worktree creation touches the same admin files. Everything
 * after — the review itself — runs in parallel.
 */
const g = globalThis as unknown as { __codeReviewGitLocks?: Map<string, Promise<unknown>> }
const locks = (g.__codeReviewGitLocks ??= new Map())

export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repoPath) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(repoPath, next.catch(() => {}))
  return next
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--git-dir'], 10_000)
    return true
  } catch {
    return false
  }
}

export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    'refs/remotes/origin',
  ])
  return out
    .split('\n')
    .map((l) => l.trim().replace(/^origin\//, ''))
    .filter((b) => b && b !== 'HEAD' && b !== 'origin')
}

export async function fetchAll(repoPath: string) {
  await git(repoPath, ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], 180_000)
}

/** Fetches a PR's head into a private ref; returns its sha. */
export async function fetchPull(repoPath: string, number: number, baseRef: string): Promise<string> {
  const ref = `refs/review/pr-${number}`
  await git(
    repoPath,
    ['fetch', 'origin', `+refs/pull/${number}/head:${ref}`, `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`],
    180_000,
  )
  return (await git(repoPath, ['rev-parse', ref])).trim()
}

export async function revParse(repoPath: string, rev: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', '--verify', `${rev}^{commit}`])).trim()
}

export async function mergeBase(repoPath: string, a: string, b: string): Promise<string> {
  return (await git(repoPath, ['merge-base', a, b])).trim()
}

export async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}

export async function commitExists(repoPath: string, sha: string): Promise<boolean> {
  if (!sha) return false
  try {
    await git(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

export async function addWorktree(repoPath: string, name: string, sha: string): Promise<string> {
  await fs.mkdir(WORKTREE_ROOT, { recursive: true })
  const dir = path.join(WORKTREE_ROOT, name)
  // A leftover from a crashed round would make `worktree add` refuse.
  await removeWorktree(repoPath, dir)
  await git(repoPath, ['worktree', 'prune'])
  await git(repoPath, ['worktree', 'add', '--detach', '--force', dir, sha], 180_000)
  // macOS's temp dir is a symlink (/var → /private/var) and Claude reports
  // paths resolved, so hand back the real path or nothing will match it.
  return fs.realpath(dir)
}

export async function removeWorktree(repoPath: string, dir: string) {
  if (!dir || !(dir.startsWith(WORKTREE_ROOT) || dir.includes('/jira-logwork-review/'))) return
  try {
    await git(repoPath, ['worktree', 'remove', '--force', dir], 60_000)
  } catch {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await git(repoPath, ['worktree', 'prune']).catch(() => {})
  }
}

/** The whole diff as text — handed to Claude as a file when it is another repo's PR. */
export async function diffText(repoPath: string, from: string, to: string): Promise<string> {
  return git(repoPath, ['diff', '--no-color', '--no-ext-diff', from, to], 120_000)
}

export async function diffStat(repoPath: string, from: string, to: string): Promise<string> {
  return (await git(repoPath, ['diff', '--stat=120', from, to])).trim()
}

/**
 * New-side line ranges GitHub shows for each file of `from..to` — the lines a
 * review comment may be anchored to. Context lines count: GitHub accepts a
 * comment on any line inside a hunk, not only on changed ones.
 */
export async function diffRanges(
  repoPath: string,
  from: string,
  to: string,
): Promise<Map<string, Array<[number, number]>>> {
  const out = await git(repoPath, ['diff', '-U3', '--no-color', '--no-ext-diff', from, to])
  const ranges = new Map<string, Array<[number, number]>>()
  let file = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : ''
      continue
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m && file) {
      const start = Number(m[1])
      const len = m[2] === undefined ? 1 : Number(m[2])
      if (len > 0) ranges.set(file, [...(ranges.get(file) ?? []), [start, start + len - 1]])
    }
  }
  return ranges
}

/** A few lines of `file` at `sha`, around `line`. */
export async function snippetAt(
  repoPath: string,
  sha: string,
  file: string,
  line: number,
  endLine: number | null,
): Promise<{ text: string; start: number }> {
  try {
    const content = await git(repoPath, ['show', `${sha}:${file}`])
    const lines = content.split('\n')
    const last = Math.min(endLine && endLine >= line ? endLine : line, line + 30)
    const start = Math.max(1, line - 2)
    const end = Math.min(lines.length, last + 2)
    return { text: lines.slice(start - 1, end).join('\n'), start }
  } catch {
    return { text: '', start: 0 }
  }
}
