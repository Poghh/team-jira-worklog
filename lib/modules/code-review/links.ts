import 'server-only'

import fs from 'node:fs/promises'
import path from 'node:path'

import { getRepo } from './config'
import {
  WORKTREE_ROOT,
  addWorktree,
  commitExists,
  diffText,
  fetchAll,
  fetchPull,
  gitSays,
  mergeBase,
  removeWorktree,
  revParse,
  withRepoLock,
} from './git'
import type { PrLink, RoundLink } from './model'

/**
 * The other half of a cross-repo change — the SDK PR an iOS PR builds on, or
 * the reverse — made readable to Claude next to the PR under review.
 *
 * For each link the round gets a detached worktree of the linked PR's head and
 * that PR's diff written to a file; both directories go to `--add-dir`. The
 * diff is a file rather than a command because Claude's git access is
 * `Bash(git diff:*)` in its own directory only, and `git -C <elsewhere> …`
 * would need a wider rule than this module is willing to grant (guard.ts).
 *
 * A link that cannot be prepared does not fail the review: the round goes on
 * without it and says so.
 */

const linkDir = (roundId: number) => path.join(WORKTREE_ROOT, `r${roundId}-links`)

/** Fetches every linked PR at its current head and lays it out for Claude. */
export async function prepareLinks(roundId: number, links: PrLink[]): Promise<RoundLink[]> {
  if (!links.length) return []
  await fs.mkdir(linkDir(roundId), { recursive: true })
  const out: RoundLink[] = []
  for (const [i, l] of links.entries()) {
    const repo = getRepo(l.repoId)
    const base: RoundLink = { ...l, repoName: repo?.name ?? '?', baseSha: '', headSha: '', workdir: '', diffPath: '', error: '' }
    if (!repo) {
      out.push({ ...base, error: 'repo đã bị xoá khỏi Cấu hình' })
      continue
    }
    try {
      const resolved = await withRepoLock(repo.localPath, async () => {
        let headSha: string
        if (l.prNumber && repo.githubRepo) {
          headSha = await fetchPull(repo.localPath, l.prNumber, l.baseRef)
        } else {
          await fetchAll(repo.localPath)
          headSha = await revParse(repo.localPath, `origin/${l.headRef}`)
        }
        const baseSha = await mergeBase(repo.localPath, `origin/${l.baseRef}`, headSha)
        const workdir = await addWorktree(repo.localPath, `r${roundId}-l${i}`, headSha)
        return { headSha, baseSha, workdir }
      })
      const diffPath = path.join(await fs.realpath(linkDir(roundId)), `link${i}-${repo.name.replace(/[^\w.-]+/g, '_')}.diff`)
      await fs.writeFile(diffPath, await diffText(repo.localPath, resolved.baseSha, resolved.headSha))
      out.push({ ...base, ...resolved, diffPath })
    } catch (err) {
      out.push({ ...base, error: gitSays(err) })
    }
  }
  return out
}

/**
 * Lays a round's links out again exactly as the round saw them — same shas,
 * same paths — so a resumed chat session finds what it read before.
 */
export async function restoreLinks(roundId: number, links: RoundLink[]): Promise<RoundLink[]> {
  const ready = links.filter((l) => !l.error && l.workdir && l.headSha)
  if (!ready.length) return []
  await fs.mkdir(linkDir(roundId), { recursive: true })
  const out: RoundLink[] = []
  for (const l of ready) {
    const repo = getRepo(l.repoId)
    if (!repo || !(await commitExists(repo.localPath, l.headSha))) continue
    try {
      await withRepoLock(repo.localPath, () => addWorktree(repo.localPath, path.basename(l.workdir), l.headSha))
      await fs.writeFile(l.diffPath, await diffText(repo.localPath, l.baseSha, l.headSha))
      out.push(l)
    } catch {}
  }
  return out
}

export async function cleanupLinks(roundId: number, links: RoundLink[]) {
  for (const l of links) {
    const repo = getRepo(l.repoId)
    if (repo && l.workdir) await withRepoLock(repo.localPath, () => removeWorktree(repo.localPath, l.workdir))
  }
  await fs.rm(linkDir(roundId), { recursive: true, force: true }).catch(() => {})
}

/** Directories Claude needs to read the links: each worktree and the diff folder. */
export function linkDirs(links: RoundLink[]): string[] {
  const dirs = new Set<string>()
  for (const l of links) {
    if (l.error) continue
    if (l.workdir) dirs.add(l.workdir)
    if (l.diffPath) dirs.add(path.dirname(l.diffPath))
  }
  return [...dirs]
}
