import "server-only";

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  type ChangedFile,
  type SdkRelease,
  parseBumpMessage,
  parseNameStatus,
  parseNumstat,
} from "./model";

const run = promisify(execFile);

/**
 * Everything this module asks of the two clones on disk.
 *
 * The file is in two halves and stays that way: **reads** above, **the one
 * write** below. That split is not tidiness — until this module existed, the
 * app ran exactly two git commands and both were read-only, with the rule
 * written into `lib/modules/branches/local.ts`:
 *
 *     Every command is read-only. Nothing fetches, nothing writes.
 *
 * `fetch` and `checkout` break the letter of that, so they are the only two
 * things below the line, they are named for what they do, and the screen says
 * so before either runs.
 *
 * `checkout` was deliberately left out at first — the app fetched and warned,
 * and switching branches stayed the user's. It is in now because the user asked
 * for it, and the guard it needs is narrow and absolute: **it refuses on a
 * dirty tree.** A checkout carries uncommitted changes across to the new branch
 * rather than leaving them behind, which is how a release ends up built from
 * code that is on no branch at all. What is still not here: no `pull`, no
 * `merge`, no `reset`, and never `-f` or `-B` — every one of those can destroy
 * work that was never pushed.
 */

/**
 * `execFile` with an argument array, never a shell string: these paths come
 * from a settings box, and a shell would make that box an injection point.
 * Same doctrine as `branches/local.ts`, same 15 s ceiling.
 */
async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * What git actually said, out of the error `execFile` wraps it in.
 *
 * Worth a function because the first attempt at this was
 * `err.message.split("\n").slice(-2)[0]`, and on the failure that matters most
 * it selected the word "Aborting" out of:
 *
 *     error: The following untracked working tree files would be overwritten
 *     	untracked-collision.txt
 *     Please move or remove them before you switch branches.
 *     Aborting
 *
 * Git had named the file and said what to do; the app threw both away. So:
 * read `stderr`, which is where git writes, not the wrapper's `message`, which
 * begins with the command line and is addressed to a programmer. Drop the
 * trailing "Aborting" — it adds nothing once the reason is on screen — and keep
 * the rest in order.
 */
export function gitSays(err: unknown, fallback = "git không nói lý do"): string {
  const raw =
    typeof (err as { stderr?: unknown })?.stderr === "string"
      ? ((err as { stderr: string }).stderr)
      : err instanceof Error
        ? err.message
        : "";
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "Aborting" && !l.startsWith("Command failed:"));
  const text = lines.join(" ");
  return (text.length > 400 ? `${text.slice(0, 400)}…` : text) || fallback;
}

/* ── reads ──────────────────────────────────────────────────────────────── */

/** The repository root `dir` belongs to, for telling a repo from a subfolder. */
export async function topLevel(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

export interface RepoHead {
  /** Branch name, or '' when HEAD is detached. */
  branch: string;
  sha: string;
  /** Subject line of the commit HEAD points at. */
  subject: string;
  /** Who wrote it, and when — epoch seconds. */
  author: string;
  at: number;
  /** Paths with uncommitted changes, tracked files only. */
  dirty: string[];
}

export async function readHead(dir: string): Promise<RepoHead> {
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // One call for all four: a sha alone says nothing about whether this is the
  // commit you meant to build. `%x09` because a subject may contain anything
  // else, tabs excepted.
  const [sha, subject, author, at] = (
    await git(dir, ["log", "-1", "--format=%H%x09%s%x09%an%x09%ct", "HEAD"])
  )
    .trim()
    .split("\t");
  const status = await git(dir, ["status", "--porcelain", "--untracked-files=no"]);
  return {
    // `rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" when
    // detached, which is not a branch and must not be treated as one.
    branch: branch === "HEAD" ? "" : branch,
    sha: sha ?? "",
    subject: subject ?? "",
    author: author ?? "",
    at: Number(at) || 0,
    dirty: status
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean),
  };
}

export type { ChangedFile };

export interface CommitFile extends ChangedFile {
  added: number;
  removed: number;
  /** Git không đếm dòng cho file nhị phân — khác hẳn với "đổi 0 dòng". */
  binary: boolean;
}

export interface CommitFiles {
  files: CommitFile[];
  /** Tổng số file, kể cả phần bị cắt khỏi `files`. */
  total: number;
  /** HEAD là merge commit — danh sách là những gì nó mang vào. */
  merge: boolean;
  /** Tổng dòng thêm/bớt của cả commit, tính trên mọi file kể cả phần bị cắt. */
  added: number;
  removed: number;
}

/**
 * Files the commit brings in, compared against its first parent.
 *
 * Not `diff-tree`, which is the obvious call and the wrong one: on a merge
 * commit it prints nothing at all. Measured across the fourteen `ctalk/*`
 * branches of this clone, three of them stand on a merge — so the obvious call
 * would answer "0 file" on the exact branches carrying the most work
 * (`upgrade_26.09.09_phase2`: 0 by `diff-tree`, 363 against the first parent).
 * An empty list is the one answer this panel must never give wrongly: it exists
 * so somebody can confirm their own code is in what is about to ship.
 *
 * Capped, because that 363 is real. `total` still counts them all.
 */
export async function commitFiles(
  dir: string,
  sha = "HEAD",
  cap = 40,
): Promise<CommitFiles> {
  const parents = (await git(dir, ["rev-list", "--parents", "-n", "1", sha]))
    .trim()
    .split(/\s+/)
    .slice(1);

  const raw = parents.length
    ? await git(dir, ["diff", "--name-status", "-M", `${sha}^1`, sha])
    : // A root commit has no parent to compare against; everything in it is new.
      await git(dir, ["show", "--name-status", "-M", "--format=", sha]);

  // Hai lần đọc vì git không đưa cả hai trong một: `--name-status` nói *kiểu*
  // thay đổi (thêm / xoá / đổi tên), `--numstat` nói *bao nhiêu dòng*. Thiếu vế
  // đầu thì không phân biệt được file mới với file sửa; thiếu vế sau thì danh
  // sách không có sức nặng nào.
  const counts = parseNumstat(
    parents.length
      ? await git(dir, ["diff", "--numstat", "-M", `${sha}^1`, sha])
      : await git(dir, ["show", "--numstat", "-M", "--format=", sha]),
  );

  const files: CommitFile[] = parseNameStatus(raw).map((f) => {
    const c = counts.get(f.path);
    return {
      ...f,
      added: c?.added ?? 0,
      removed: c?.removed ?? 0,
      binary: c?.binary ?? false,
    };
  });

  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }

  return {
    files: files.slice(0, cap),
    total: files.length,
    merge: parents.length > 1,
    added,
    removed,
  };
}

/** Diff của **một** file trong commit, đã cắt bớt nếu quá dài. */
export interface FileDiff {
  text: string;
  truncated: boolean;
}

/**
 * Nội dung thay đổi của một file, dạng unified diff.
 *
 * Đọc từng file một chứ không lấy cả commit: một commit ở repo này có thể chạm
 * 363 file, và `Cargo.lock` một mình đã đủ làm nghẽn cả màn hình. Người đọc bấm
 * vào file nào thì đọc file ấy.
 */
export async function fileDiff(
  dir: string,
  sha: string,
  path: string,
  maxBytes = 400_000,
): Promise<FileDiff> {
  const parents = (await git(dir, ["rev-list", "--parents", "-n", "1", sha]))
    .trim()
    .split(/\s+/)
    .slice(1);

  // `--` tách đường dẫn khỏi revision: một file tên trùng tên nhánh sẽ làm git
  // đoán sai nếu thiếu nó.
  const text = parents.length
    ? await git(dir, ["diff", "-M", `${sha}^1`, sha, "--", path])
    : await git(dir, ["show", "-M", "--format=", sha, "--", path]);

  return text.length > maxBytes
    ? { text: text.slice(0, maxBytes), truncated: true }
    : { text, truncated: false };
}

export interface BranchChoice {
  name: string;
  /**
   * No local branch of this name — `git checkout <name>` alone will not work.
   *
   * Worth surfacing rather than assuming: this clone has 7 local branches
   * against 15 `origin/ctalk/*`, so most branches worth releasing are in this
   * state, and the obvious command fails on all of them.
   */
  remoteOnly: boolean;
}

/** Every branch worth offering, local and remote folded together. */
export async function listBranches(dir: string): Promise<BranchChoice[]> {
  const local = new Set(
    (await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // `lstrip=3` drops exactly `refs/remotes/origin/`, which `:short` does not:
  // `:short` renders `refs/remotes/origin/HEAD` as the bare word `origin`, and
  // that phantom then sat in the branch list as something you could pick and
  // never check out. 56 refs here, one of them that.
  const remote = (
    await git(dir, ["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin"])
  )
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && s !== "HEAD");

  // Danh sách lấy từ **remote**, không gộp với local.
  //
  // Gộp vào thì mọi nhánh cũ còn sót trong clone đều hiện ra — kể cả nhánh đồng
  // nghiệp đã xoá xong việc từ lâu — và không cái nào trong số đó release được:
  // commit bump ghi lại `<repo>/<branch> <sha>`, nên nhánh phải có trên origin
  // thì người khác mới lần ra được. Clone này có 7 nhánh local so với 57 trên
  // remote, và phần chênh lệch đúng là rác.
  const names = [...new Set(remote)].sort();
  return names.map((name) => ({ name, remoteOnly: !local.has(name) }));
}

/**
 * Every release tag, from the clone and from the remote.
 *
 * `ls-remote` is a pure network read that writes nothing into the clone, so it
 * keeps the "do not refresh a repository you do not own" rule while still being
 * authoritative. That matters: a colleague's release pushed ten minutes ago is
 * invisible to a local tag list, and finding out costs a forty-minute build and
 * then a tag collision. Falls back to local tags when the network is not there,
 * and says which it got.
 */
export async function listTags(dir: string): Promise<{ tags: string[]; remote: boolean }> {
  const local = (await git(dir, ["tag", "--list"]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const out = await git(dir, ["ls-remote", "--tags", "origin"], 25_000);
    const remote = out
      .split("\n")
      .flatMap((line) => {
        const ref = line.split("\t")[1] ?? "";
        const m = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref.trim());
        return m ? [m[1]] : [];
      })
      .filter(Boolean);
    return { tags: [...new Set([...local, ...remote])], remote: true };
  } catch {
    return { tags: local, remote: false };
  }
}

/**
 * Releases the tool has already made, newest first, read from its own commits.
 *
 * `origin/main` rather than `main`, because the question is what exists for
 * everybody — a colleague's release that this clone has fetched but not merged
 * still counts, and a local commit that was never pushed does not. Falls back
 * to `HEAD` for a clone that has no `origin/main` yet.
 */
export async function recentBumps(dir: string, n = 200): Promise<SdkRelease[]> {
  for (const ref of ["origin/main", "HEAD"]) {
    try {
      const out = await git(dir, ["log", ref, "--format=%ct%x09%s", `--max-count=${n}`]);
      return out
        .split("\n")
        .flatMap((line) => {
          const [at, ...rest] = line.split("\t");
          const parsed = parseBumpMessage(rest.join("\t"), Number(at) || 0);
          return parsed ? [parsed] : [];
        });
    } catch {
      // Try the next ref; a clone without `origin/main` is not an error here.
    }
  }
  return [];
}

/**
 * Which of `refs` the remote actually has, plus `main`'s current sha.
 *
 * One `ls-remote` for the lot, and it writes nothing into the clone — which is
 * what makes it safe to ask while a build is running in the same directory.
 * Asking the remote rather than the clone is the point: the question is what
 * everybody else can see, and a local tag list cannot answer that.
 */
export async function remoteState(
  dir: string,
  refs: string[],
): Promise<{ present: Set<string>; mainSha: string } | null> {
  try {
    const out = await git(dir, ["ls-remote", "origin", "refs/heads/main", ...refs], 25_000);
    const present = new Set<string>();
    let mainSha = "";
    for (const line of out.split("\n")) {
      const [sha, ref] = line.split("\t");
      if (!ref) continue;
      const name = ref.trim().replace(/\^\{\}$/, "");
      if (name === "refs/heads/main") mainSha = sha.trim();
      else present.add(name);
    }
    return { present, mainSha };
  } catch {
    return null;
  }
}

/** `owner/repo` from the clone's `origin`, for building a GitHub link. */
export async function remoteSlug(dir: string): Promise<string> {
  try {
    const url = (await git(dir, ["remote", "get-url", "origin"])).trim();
    const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    return m ? `${m[1]}/${m[2]}` : "";
  } catch {
    return "";
  }
}

/** Commits on the branch that `origin` has not got. 0 when in sync or unknown. */
export async function aheadOfRemote(dir: string, branch: string): Promise<number> {
  if (!branch) return 0;
  try {
    const out = await git(dir, [
      "for-each-ref",
      "--format=%(upstream:track)",
      `refs/heads/${branch}`,
    ]);
    const m = /ahead (\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Whether `main` here already contains what the remote has.
 *
 * Asked without fetching, from whatever `origin/main` currently says — the
 * caller fetches first when it wants the answer to be current. The stake is
 * concrete: the release tool ends in `git push`, and a `main` that is behind
 * gets that push rejected **after** the forty-minute build.
 */
export async function containsRemote(dir: string, branch = "main"): Promise<boolean | null> {
  try {
    const remote = (await git(dir, ["rev-parse", `origin/${branch}`])).trim();
    await git(dir, ["merge-base", "--is-ancestor", remote, "HEAD"]);
    return true;
  } catch (err) {
    // Exit 1 is the honest answer "no"; anything else means we could not ask.
    const code = (err as { code?: number }).code;
    return code === 1 ? false : null;
  }
}

/* ── the one write ──────────────────────────────────────────────────────── */

export interface FetchResult {
  ok: boolean;
  /** What failed, in Vietnamese, when it did. */
  message: string;
}

/**
 * Bring `origin/*` up to date in both clones. The only write this module makes.
 *
 * `fetch` updates refs and nothing else: no working tree is touched, no branch
 * moves, nothing is merged, and no local commit can be lost by it. That is why
 * it is the one operation the app does on the user's behalf while `checkout`,
 * `pull` and `merge` stay theirs — those all change what is on disk, and the
 * one that matters most here (standing on the right branch) is exactly the one
 * the guide warns about in bold.
 *
 * Both repositories, for different reasons. The wrapper because its `main` has
 * to contain `origin/main` or the push at the far end is rejected. The SDK
 * because the branch being released is compared against its remote, and a
 * branch two days stale builds a release nobody asked for.
 *
 * `--no-tags` on the SDK: its tags are of no interest here, and fetching them
 * is the slow half of the operation.
 */
export async function fetchBoth(input: {
  sdkPath: string;
  packagePath: string;
  branch: string;
}): Promise<FetchResult> {
  const steps: Array<[string, string[], string]> = [
    [input.packagePath, ["fetch", "origin", "main"], "repo swift"],
    ...(input.branch
      ? ([[input.sdkPath, ["fetch", "--no-tags", "origin", input.branch], "repo SDK"]] as Array<
          [string, string[], string]
        >)
      : []),
  ];
  for (const [cwd, args, what] of steps) {
    try {
      await git(cwd, args, 60_000);
    } catch (err) {
      return { ok: false, message: `fetch ${what} thất bại — ${gitSays(err)}` };
    }
  }
  return { ok: true, message: "" };
}

export interface CheckoutResult {
  ok: boolean;
  message: string;
}

/**
 * Stand the SDK clone on `branch`.
 *
 * The second and last write. Three refusals before git is asked anything, in
 * this order, because each is cheaper and more certain than the one after it:
 *
 *   1. **detached HEAD** — nothing to compare against, and leaving a detached
 *      HEAD behind loses commits that nothing points at.
 *   2. **dirty tree** — the reason this is dangerous at all. `git checkout`
 *      does not leave uncommitted work behind on the old branch; it carries it
 *      over. A release built from a branch plus somebody's half-finished edits
 *      is the silent-wrong-build the guide warns about in bold, and the sha
 *      stamped into the release would not describe what was built.
 *   3. **already there** — a no-op said plainly beats a command that looks like
 *      it did something.
 *
 * Plain `git checkout <branch>`. Never `-f` (discards the work item 2 protects)
 * and never `-B` (moves an existing branch onto HEAD, silently orphaning
 * whatever it pointed at). For a branch that exists only on the remote, git's
 * own DWIM creates the tracking branch — and when that is switched off, the
 * explicit `--track` below does it, which is the same thing said out loud.
 */
export async function checkoutBranch(
  dir: string,
  branch: string,
): Promise<CheckoutResult> {
  if (!branch.trim()) return { ok: false, message: "Chưa chọn nhánh." };

  // A configured path that is not a repository reaches here as an exception
  // from `rev-parse`, and unhandled it surfaced to the user as the literal
  // command line. It is an ordinary, correctable mistake — say so.
  let head: RepoHead;
  try {
    head = await readHead(dir);
  } catch (err) {
    return {
      ok: false,
      message: `Không đọc được repo ở ${dir} — ${gitSays(err)}. Kiểm lại đường dẫn ở tab Cấu hình.`,
    };
  }
  if (!head.branch)
    return {
      ok: false,
      message: "Repo SDK đang ở detached HEAD — tự checkout trước rồi quay lại.",
    };
  if (head.dirty.length)
    return {
      ok: false,
      message:
        `Cây làm việc còn ${head.dirty.length} file chưa commit (${head.dirty.slice(0, 3).join(", ")}` +
        `${head.dirty.length > 3 ? "…" : ""}). Checkout sẽ mang những thay đổi đó sang nhánh mới, ` +
        "nên app không làm. Commit hoặc stash trước.",
    };
  if (head.branch === branch)
    return { ok: true, message: `Đang ở ${branch} rồi.` };

  try {
    await git(dir, ["checkout", branch], 60_000);
  } catch (plain) {
    // Only a missing local branch is worth a second attempt. Anything else —
    // an untracked file in the way, a permission problem — fails the same way
    // twice, and reporting the *second* failure would blame a missing remote
    // branch for something that had nothing to do with it.
    const why = gitSays(plain);
    if (!/did not match any file|pathspec|unknown revision/i.test(why))
      return { ok: false, message: `Không checkout được ${branch} — ${why}` };
    try {
      await git(dir, ["checkout", "-b", branch, "--track", `origin/${branch}`], 60_000);
    } catch (tracked) {
      return {
        ok: false,
        message: `Không checkout được ${branch} — ${gitSays(tracked, why)}`,
      };
    }
  }

  const now = await readHead(dir);
  return now.branch === branch
    ? { ok: true, message: `Đã chuyển sang ${branch}` }
    : { ok: false, message: `Chạy xong mà repo vẫn ở ${now.branch || "detached HEAD"}.` };
}

export interface FastForwardResult {
  ok: boolean;
  message: string;
  /** Whether the branch actually moved, as opposed to already being current. */
  moved: boolean;
}

/**
 * Bring a branch up to its `origin/` counterpart, by fast-forward only.
 *
 * The third and last write, and the narrowest. `--ff-only` is the whole of the
 * safety argument: a fast-forward replays nothing and merges nothing, so it
 * cannot produce a conflict, cannot write a merge commit, and cannot invent
 * content. Either local `main` is an ancestor of the remote and the pointer
 * moves, or it is not and this refuses.
 *
 * Refusing is the useful half. "Not possible to fast-forward" means the two
 * have genuinely diverged — somebody pushed while you held a local commit, or
 * an earlier `--local-only` run left one behind — and that is precisely the
 * conflict worth stopping for. Resolving it means choosing what to keep, which
 * is not a choice an app gets to make on somebody's unpushed commit.
 *
 * Never `pull`: that is fetch plus *merge*, and the merge half is exactly what
 * is excluded here. Never `reset --hard`: it discards.
 *
 * Used on both repositories: the swift repo's `main`, because the release ends
 * in a push to it, and the SDK branch just checked out, because a branch that
 * is days behind builds a release nobody asked for — which is the silent wrong
 * build the guide warns about in bold.
 *
 * The local patch to `Release.swift` survives, and git is what guarantees it —
 * a fast-forward that would overwrite a modified file stops with its own error,
 * naming the file.
 */
export async function fastForward(dir: string, branch = "main"): Promise<FastForwardResult> {
  let head: RepoHead;
  try {
    head = await readHead(dir);
  } catch (err) {
    return { ok: false, moved: false, message: `Không đọc được repo swift — ${gitSays(err)}` };
  }
  if (head.branch !== branch)
    return {
      ok: false,
      moved: false,
      message: `Repo đang ở "${head.branch || "detached HEAD"}", không phải ${branch}.`,
    };

  const contains = await containsRemote(dir, branch);
  // `null` means there is no `origin/<branch>` to compare against — a branch
  // that exists only on this machine. Nothing to fast-forward to, and not an
  // error: that is an ordinary state for work in progress.
  if (contains !== false) return { ok: true, moved: false, message: "" };

  try {
    await git(dir, ["merge", "--ff-only", `origin/${branch}`], 60_000);
  } catch (err) {
    const why = gitSays(err);
    const diverged = /not possible to fast-forward|diverged|refusing to merge/i.test(why);
    return {
      ok: false,
      moved: false,
      message: diverged
        ? `${branch} ở máy đã đi lệch so với origin/${branch} — không fast-forward được. ` +
          `Có commit ở máy mà remote không có. ` +
          `Tự xử lý trước: git -C ${dir} log origin/${branch}..${branch} để xem đó là gì.`
        : `Không cập nhật được ${branch} — ${why}`,
    };
  }

  // Asked again rather than assumed: `merge` exiting 0 is not the same claim as
  // "main now contains origin/main", and the push at the far end cares about
  // the second one.
  return (await containsRemote(dir, branch)) === true
    ? { ok: true, moved: true, message: `Đã cập nhật ${branch} lên origin/${branch}` }
    : { ok: false, moved: false, message: `Chạy xong mà ${branch} vẫn chưa chứa origin/${branch}.` };
}
