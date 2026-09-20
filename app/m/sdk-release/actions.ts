"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/app/actions";
import { isModuleEnabled } from "@/lib/modules/state";
import {
  type SdkConfigView,
  getSdkConfig,
  setSdkConfig,
  toConfigView,
} from "@/lib/modules/sdk-release/config";
import {
  type RecoveryPlan,
  type SdkRelease,
  type VersionProposal,
  nextVersion,
  recoveryPlan,
  releasesForBranch,
} from "@/lib/modules/sdk-release/model";
import { type Check, runChecks } from "@/lib/modules/sdk-release/preflight";
import {
  type BranchChoice,
  type CommitFiles,
  type FileDiff,
  aheadOfRemote,
  checkoutBranch,
  commitFiles,
  fastForward,
  fetchBoth,
  gitSays,
  fileDiff,
  listBranches,
  listTags,
  readHead,
  recentBumps,
  remoteSlug,
  remoteState,
} from "@/lib/modules/sdk-release/repo";
import { type RunView, cancelRun, reapRuns, startRun, viewRun } from "@/lib/modules/sdk-release/runner";
import { type RunRow, getRun, listRuns, liveRun } from "@/lib/modules/sdk-release/store";
import { DEFAULT_TZ, todayIn } from "@/lib/time";

/**
 * Whether the module is on — and never a reason for the action to reject.
 *
 * A synchronous SQLite read, which is to say a thing that can throw: a locked
 * database, a file that moved. Every action here calls it on its first line,
 * outside its own `try`, so a throw became a rejected server action — which the
 * browser reports as nothing at all: no message, the button simply stops.
 * Treating an unreadable setting as "off" keeps the failure on screen.
 */
function enabled() {
  try {
    return isModuleEnabled("sdk-release");
  } catch {
    return false;
  }
}

/**
 * Today in Asia/Saigon, as the tag format spells it.
 *
 * Not UTC. Every tag in the history carries a `+0700` date, so at 00:30 local
 * a UTC date would name yesterday — and then collide on an ordinal that has
 * already been used.
 */
function releaseDate(): string {
  return todayIn(DEFAULT_TZ).replace(/-/g, ".");
}

/**
 * Jira project keys — deliberately none.
 *
 * This used to borrow the branches module's configured list, on the reasoning
 * that one branch should not resolve one way on one screen and another way on
 * the next. That reasoning was sound and the coupling it created was not: it
 * made this module unbuildable without that one, for a rule that is now only a
 * `guess` anyway — the guide names no Jira keys at all, and reading the ticket
 * matched what shipped just 63% of the times it fired.
 *
 * With no list, `extractIssueKeys` falls back to reading any `WORD-123` that is
 * not an obvious non-ticket. Looser, listed among the guesses, and it needs no
 * configuration from any team.
 */
function projectKeys(): string[] {
  return [];
}

export interface Readiness {
  /** The branch the SDK repo is standing on — what will actually be built. */
  head: string;
  headSha: string;
  /** Subject, author and time of the commit that will be built. */
  headSubject: string;
  headAuthor: string;
  headAt: number;
  /** Uncommitted tracked files in the SDK clone; a checkout would carry these. */
  headDirty: number;
  /**
   * What the commit being built actually changes.
   *
   * The sha and the subject say which commit it is; they do not say whether it
   * is the one carrying your work. On a branch standing on a merge — three of
   * this clone's fourteen do — the subject is "Merge branch …" and tells you
   * nothing at all.
   */
  headFiles: CommitFiles;
  branches: BranchChoice[];
  proposal: VersionProposal;
  checks: Check[];
  tagsFromRemote: boolean;
  liveRunId: number | null;
  /** The last few releases cut from the branch being previewed. */
  recent: SdkRelease[];
  /**
   * Recent runs, so the history is not frozen at whatever the server rendered.
   *
   * It is here rather than on its own action because every caller already wants
   * it at the same moments: after a run ends, after a release starts. A row
   * stuck at "đang chạy" beside a log that says it failed is the same stale
   * read as the blocker that used to lock the Release button.
   */
  runs: RunRow[];
}

/**
 * Everything the screen needs to decide whether a release can start.
 *
 * `fetch` optional and explicit, because it is the one thing here that writes —
 * refs only, never a working tree. The screen says so before offering it.
 */
/**
 * Nội dung thay đổi của một file trong commit sắp được build.
 *
 * Từng file một, theo yêu cầu — không đẩy sẵn cả commit xuống trình duyệt:
 * commit lớn nhất đo được ở repo này chạm 363 file.
 */
export async function commitDiffAction(input: {
  path: string;
}): Promise<ActionResult & { diff?: FileDiff }> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  try {
    const cfg = getSdkConfig();
    if (!cfg.sdkPath) return { ok: false, message: "Chưa điền đường dẫn clone SDK" };
    return {
      ok: true,
      message: "",
      diff: await fileDiff(cfg.sdkPath, "HEAD", input.path),
    };
  } catch (error) {
    return { ok: false, message: gitSays(error, "Không đọc được thay đổi") };
  }
}

export async function checkReadinessAction(input: {
  /** Preview the version for a branch other than the one checked out. */
  branch?: string;
  fetch?: boolean;
}): Promise<ActionResult & { readiness?: Readiness }> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  try {
    const cfg = getSdkConfig();
    if (!cfg.sdkPath || !cfg.packagePath)
      return { ok: false, message: "Chưa điền đường dẫn hai clone — xem phần Cấu hình." };

    await reapRuns();
    const head = await readHead(cfg.sdkPath);
    // Of HEAD, not of the branch being previewed: the question is what the
    // build will contain, and the build reads the working tree as it stands.
    const headFiles = await commitFiles(cfg.sdkPath).catch(
      () => ({ files: [], total: 0, merge: false, added: 0, removed: 0 }) as CommitFiles,
    );

    let fetchNote = "";
    if (input.fetch) {
      const res = await fetchBoth({
        sdkPath: cfg.sdkPath,
        packagePath: cfg.packagePath,
        branch: head.branch,
      });
      if (!res.ok) fetchNote = res.message;
      // Fetch only moved the refs; the branches themselves still have to reach
      // them. Both repositories, for different stakes: the swift repo's `main`
      // or the push at the far end is rejected after the build, and the SDK
      // branch or the build is of code that is days old.
      const notes: string[] = [];
      for (const ff of [
        await fastForward(cfg.sdkPath, head.branch),
        await fastForward(cfg.packagePath, "main"),
      ])
        if (!ff.ok || ff.moved) notes.push(ff.message);
      if (notes.length) fetchNote = [fetchNote, ...notes].filter(Boolean).join(" · ");
    }

    const [branches, tagInfo, bumps] = await Promise.all([
      listBranches(cfg.sdkPath),
      listTags(cfg.packagePath),
      recentBumps(cfg.packagePath),
    ]);
    // The version is proposed for whichever branch the screen is asking about,
    // but the *build* always uses HEAD — the tool reads it and takes no flag.
    // That gap is what the warning on screen is about.
    const forBranch = input.branch?.trim() || head.branch;
    const proposal = nextVersion({
      branch: forBranch,
      date: releaseDate(),
      tags: tagInfo.tags,
      suffixes: cfg.suffixes,
      projectKeys: projectKeys(),
      history: bumps,
    });
    const live = liveRun();
    const checks = await runChecks({
      cfg,
      proposal,
      tags: tagInfo.tags,
      tagsFromRemote: tagInfo.remote,
      liveRunId: live?.id ?? null,
    });

    return {
      ok: true,
      message: fetchNote || (input.fetch ? "Đã fetch hai repo" : ""),
      readiness: {
        head: head.branch,
        headSha: head.sha,
        headSubject: head.subject,
        headAuthor: head.author,
        headAt: head.at,
        headDirty: head.dirty.length,
        headFiles,
        branches,
        proposal,
        checks,
        tagsFromRemote: tagInfo.remote,
        liveRunId: live?.id ?? null,
        // For whichever branch the screen is asking about, not for HEAD: the
        // point is to answer "what has this branch shipped" while you are still
        // deciding whether to switch to it.
        recent: releasesForBranch(bumps, forBranch),
        runs: listRuns(10),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không kiểm được",
    };
  }
}

/**
 * Fetch, then stand the SDK clone on `branch`.
 *
 * Fetch first and always: for a branch that exists only on the remote there is
 * nothing to check out until its ref is here, and for one that exists locally
 * the fetch is what makes "up to date with origin" a current answer rather than
 * a remembered one.
 *
 * The refusals live in `checkoutBranch` — dirty tree above all — and the one
 * added here is the module's own: not while a build is running. The running
 * build reads that working tree for another half hour.
 */
export async function checkoutAction(branch: string): Promise<ActionResult> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  try {
    const cfg = getSdkConfig();
    if (!cfg.sdkPath) return { ok: false, message: "Chưa điền đường dẫn repo SDK." };

    await reapRuns();
    const live = liveRun();
    if (live)
      return {
        ok: false,
        message: `Đang có lần chạy #${live.id} — build đang đọc chính cây làm việc này.`,
      };

    const fetched = await fetchBoth({
      sdkPath: cfg.sdkPath,
      packagePath: cfg.packagePath,
      branch,
    });
    const res = await checkoutBranch(cfg.sdkPath, branch);
    if (!res.ok)
      return {
        ok: false,
        message: fetched.ok ? res.message : `${res.message} (${fetched.message})`,
      };

    // Standing on the branch is not the same as being up to date on it. The
    // fetch above only moved `origin/<branch>`; without this the app would
    // switch you onto a branch days behind the remote and then offer to build
    // it — the silent wrong build, arrived at by a different road.
    const ff = await fastForward(cfg.sdkPath, branch);
    revalidatePath("/m/sdk-release");
    return {
      ok: ff.ok,
      message: [res.message, ff.message, fetched.ok ? "" : fetched.message]
        .filter(Boolean)
        .join(" · "),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không checkout được",
    };
  }
}

/**
 * Starts a real release. There is no dry run any more.
 *
 * `--local-only` was offered until the user removed it, and the reason it was
 * never much of a safety net is worth keeping written down: it still ran the
 * full forty-minute build and it still committed to `main` in the swift clone —
 * only the `git push` was skipped. It cost a morning and left a stray commit to
 * clean up. What actually guards this call is the checklist below plus the
 * typed-version confirmation on screen.
 */
export async function startReleaseAction(input: {
  version: string;
}): Promise<ActionResult & { id?: number }> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  if (!input.version.trim()) return { ok: false, message: "Chưa có tên version" };

  try {
    const cfg = getSdkConfig();
    const head = await readHead(cfg.sdkPath);
    if (!head.branch)
      return { ok: false, message: "Repo SDK đang ở detached HEAD — không chạy được." };

    /**
     * Last-moment sync, before anything expensive starts.
     *
     * The readiness on screen may be minutes old and a colleague may have
     * pushed since. The whole cost of being wrong lands at the far end: the
     * tool builds for forty minutes and *then* pushes, and a `main` that does
     * not contain `origin/main` has that push rejected — with the release and
     * its tag already created on the customer's repository.
     *
     * A refusal here is a hard stop, not a warning. Diverged history is the one
     * thing that cannot be resolved without choosing what to keep.
     */
    const fetched = await fetchBoth({
      sdkPath: cfg.sdkPath,
      packagePath: cfg.packagePath,
      branch: head.branch,
    });
    if (!fetched.ok) return { ok: false, message: fetched.message };
    for (const ff of [
      await fastForward(cfg.sdkPath, head.branch),
      await fastForward(cfg.packagePath, "main"),
    ])
      if (!ff.ok) return { ok: false, message: ff.message };

    // Re-checked here, not trusted from the browser: the readiness the user saw
    // may be minutes old, and the tree can have changed under it.
    const [tagInfo, bumps] = await Promise.all([
      listTags(cfg.packagePath),
      recentBumps(cfg.packagePath),
    ]);
    const proposal = nextVersion({
      branch: head.branch,
      date: releaseDate(),
      tags: tagInfo.tags,
      suffixes: cfg.suffixes,
      projectKeys: projectKeys(),
      history: bumps,
    });
    const checks = await runChecks({
      cfg,
      proposal,
      tags: tagInfo.tags,
      tagsFromRemote: tagInfo.remote,
      liveRunId: liveRun()?.id ?? null,
    });
    const blocker = checks.find((c) => c.state === "fail");
    if (blocker) return { ok: false, message: `${blocker.label}: ${blocker.detail}` };

    // The baseline the watcher compares against for the next forty minutes.
    // Read after the fast-forward, so it is what `main` is now, not what it was
    // when the screen was drawn.
    const now = await remoteState(cfg.packagePath, []);

    const res = await startRun({
      version: input.version.trim(),
      branch: head.branch,
      commitSha: head.sha,
      suffix: proposal.suffix,
      ordinal: proposal.ordinal,
      localOnly: false,
      mainSha: now?.mainSha ?? "",
    });
    if (res.ok) revalidatePath("/m/sdk-release");
    return res;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không chạy được",
    };
  }
}

/** The run and its log tail. Reaps first, so a finished run stops reporting itself running. */
export async function pollRunAction(
  id: number,
): Promise<ActionResult & { run?: RunView }> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  try {
    await reapRuns();
    const run = await viewRun(id);
    return run
      ? { ok: true, message: "", run }
      : { ok: false, message: "Không thấy lần chạy này." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không đọc được",
    };
  }
}

/**
 * What a finished run left behind, and what to do about it.
 *
 * Asked of the remote rather than inferred from the exit code, because the exit
 * code cannot tell `makeRelease` dying on a taken tag apart from `git push`
 * being rejected — and those leave the customer's repository in states that
 * need opposite treatment. `ls-remote` is a read that writes nothing.
 */
export async function diagnoseRunAction(
  id: number,
): Promise<ActionResult & { plan?: RecoveryPlan }> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  try {
    const row = getRun(id);
    if (!row) return { ok: false, message: "Không thấy lần chạy này." };
    const cfg = getSdkConfig();
    if (!cfg.packagePath) return { ok: false, message: "Chưa cấu hình repo swift." };

    const [state, slug] = await Promise.all([
      remoteState(cfg.packagePath, [
        `refs/tags/${row.version}`,
        `refs/tags/pre-${row.version}`,
      ]),
      remoteSlug(cfg.packagePath),
    ]);
    if (!state) return { ok: false, message: "Không hỏi được remote — kiểm lại mạng." };

    return {
      ok: true,
      message: "",
      plan: recoveryPlan(
        {
          version: row.version,
          slug,
          tagged: state.present.has(`refs/tags/${row.version}`),
          preTagged: state.present.has(`refs/tags/pre-${row.version}`),
          unpushed: await aheadOfRemote(cfg.packagePath, "main"),
          remoteMoved: Boolean(
            row.mainSha && state.mainSha && row.mainSha !== state.mainSha,
          ),
        },
        cfg.sdkPath,
        cfg.packagePath,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không chẩn đoán được",
    };
  }
}

export async function cancelRunAction(id: number): Promise<ActionResult> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  const res = await cancelRun(id);
  if (res.ok) revalidatePath("/m/sdk-release");
  return res;
}

export async function saveSdkConfigAction(input: {
  sdkPath: string;
  packagePath: string;
  suffixes: Record<string, string>;
}): Promise<ActionResult & { view?: SdkConfigView }> {
  if (!enabled()) return { ok: false, message: "Module đang tắt" };
  try {
    setSdkConfig(input);
    revalidatePath("/m/sdk-release");
    return { ok: true, message: "Đã lưu", view: toConfigView(getSdkConfig()) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không lưu được",
    };
  }
}
