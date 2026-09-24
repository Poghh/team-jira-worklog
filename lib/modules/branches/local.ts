import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LocalState } from "./model";

const run = promisify(execFile);

/**
 * Reads git clones sitting on this machine.
 *
 * There is no other way to see a branch that has not been pushed: it exists
 * only on disk. The GitHub token answers "what is on the server", and the two
 * questions have genuinely different answers here — one branch carrying a Jira
 * key was never pushed at all, and two more are dozens of commits ahead of what
 * the server has.
 *
 * Every command is read-only. Nothing fetches, nothing writes; a stale
 * `origin/*` is reported rather than quietly refreshed, because refreshing
 * would be this app writing to a repository it does not own.
 */

/** How a local branch stands against the server. */
export interface LocalBranch {
  /** `owner/repo`, from the clone's `origin` remote. */
  repo: string;
  name: string;
  /** Tip commit time, epoch seconds. */
  committedAt: number;
  /** Commits the local branch has that its upstream does not. */
  ahead: number;
  /** No upstream at all — this branch has never been pushed. */
  onlyLocal: boolean;
  /** Which clone it came from, so a duplicate checkout is not a mystery. */
  path: string;
}

export interface LocalScan {
  branches: LocalBranch[];
  /** Paths that are not a git repo, or whose origin is not a GitHub URL. */
  bad: Array<{ path: string; why: string }>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  // execFile with an argument array, never a shell string: these paths come
  // from a settings box, and a shell would make that box an injection point.
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** `git@github.com:owner/repo.git` and `https://github.com/owner/repo` both land here. */
export function repoFromRemote(url: string): string {
  const m = url
    .trim()
    .match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : "";
}

/**
 * The ahead count out of git's own `[ahead 43, behind 1]` tracking summary.
 *
 * `[gone]` — the upstream branch has been deleted — reads as 0 rather than as
 * unknown: whatever is on the branch, none of it is waiting to be pushed to a
 * ref that no longer exists.
 */
function aheadFromTrack(track: string | undefined): number {
  return Number(track?.match(/ahead (\d+)/)?.[1] ?? 0) || 0;
}

/**
 * Branches across every configured clone.
 *
 * `for-each-ref` gives the upstream, the commit date *and* the ahead count in
 * one call, so a repo with 150 branches costs one subprocess rather than 151 —
 * which is what this claimed before it grew a `rev-list` per branch inside the
 * loop.
 */
export async function readLocalBranches(paths: string[]): Promise<LocalScan> {
  const branches: LocalBranch[] = [];
  const bad: Array<{ path: string; why: string }> = [];

  for (const raw of paths) {
    const dir = raw.trim();
    if (!dir) continue;

    let repo = "";
    try {
      repo = repoFromRemote(await git(dir, "remote", "get-url", "origin"));
    } catch {
      bad.push({ path: dir, why: "không phải git repo, hoặc không mở được" });
      continue;
    }
    if (!repo) {
      bad.push({ path: dir, why: "origin không trỏ về GitHub" });
      continue;
    }

    let out = "";
    try {
      out = await git(
        dir,
        "for-each-ref",
        "--format=%(refname:short)%09%(upstream:short)%09%(committerdate:unix)%09%(upstream:track)",
        "refs/heads",
      );
    } catch {
      bad.push({ path: dir, why: "không đọc được danh sách nhánh" });
      continue;
    }

    for (const line of out.split("\n")) {
      const [name, upstream, when, track] = line.split("\t");
      if (!name) continue;

      // Only the left side: how many commits are here and not on the server.
      // How far behind the branch is says nothing about whether the user's own
      // work has left the machine.
      const ahead = upstream ? aheadFromTrack(track) : 0;

      branches.push({
        repo,
        name,
        committedAt: Number(when) || 0,
        ahead,
        onlyLocal: !upstream,
        path: dir,
      });
    }
  }

  // The same repo can be checked out twice — this machine has two clones of
  // `viptalk-ios-x` with different branch sets. Newest tip wins so the board
  // reflects the checkout actually being worked in.
  const best = new Map<string, LocalBranch>();
  for (const b of branches) {
    const key = `${b.repo}#${b.name}`;
    const prev = best.get(key);
    if (!prev || b.committedAt > prev.committedAt) best.set(key, b);
  }

  return { branches: [...best.values()], bad };
}

/**
 * The scan as a lookup, keyed the way cards name their branches.
 *
 * Only branches in a watched repository would ever match a card, but filtering
 * is the caller's business — an index costs nothing and a missing key already
 * means "nothing local to say".
 */
export function localIndex(scan: LocalScan): Map<string, LocalState> {
  return new Map(
    scan.branches.map((b) => [
      `${b.repo}#${b.name}`,
      { ahead: b.ahead, onlyLocal: b.onlyLocal, path: b.path },
    ]),
  );
}
