"use server";

import type { ActionResult } from "@/app/actions";
import {
  getGitHubConfig,
  getSeenBuilds,
  getStages,
  setGitHubConfig,
  setSeenBuilds,
  setStages,
  toConfigView,
} from "@/lib/modules/branches/config";
import { fetchEnvBuilds } from "@/lib/modules/branches/build";
import { localIndex, readLocalBranches } from "@/lib/modules/branches/local";
import {
  type EnvBuild,
  type CardBuild,
  buildCarries,
  mergeCardBuild,
  newBuilds,
} from "@/lib/modules/branches/build-model";
import {
  type PinnedPr,
  fetchBranchPrs,
  fetchPrsByNumber,
  fetchRepos,
  fetchViewer,
} from "@/lib/modules/branches/github";
import {
  type GitHubConfigView,
  type Identity,
  type PlanRow,
  type PullRequest,
  advanceStage,
  asPullRequest,
  cardStage,
  mergeCardPrs,
  parseEnvState,
  parseGitHubLink,
  pickPr,
  planSummary,
  prStateTag,
  prsForCard,
  serializeCardPrs,
  serializeCardSides,
  stageFor,
} from "@/lib/modules/branches/github-model";
import {
  type StageConfig,
  type TaskNoteShape,
  envSteps,
  orderSides,
  withLocalState,
} from "@/lib/modules/branches/model";
import {
  type ScanResult,
  applyPlan,
  safeRows,
  scanGitHub,
} from "@/lib/modules/branches/scan";
import {
  deleteTaskNote,
  deleteTaskNotes,
  getTaskNote,
  listTaskNotes,
  moveTaskNote,
  setCardBuilds,
  setCardPrs,
  saveTaskNote,
  setNoteBody,
  type TaskNoteRow,
} from "@/lib/modules/branches/store";

/**
 * Saves a card and hands the stored row back.
 *
 * The row is returned rather than just an id because both callers — the board
 * and the task-board popover — keep their own optimistic copy, and a card
 * created without an explicit stage needs the resolved default sent back or the
 * new card lands in no column at all.
 */
export async function saveNoteAction(
  input: TaskNoteShape & {
    id?: number;
    /**
     * A GitHub URL the user typed to correct a wrong pairing. `undefined`
     * leaves the stored link alone; `''` clears it and unpins the card.
     */
    githubLink?: string;
  },
): Promise<ActionResult & { row?: TaskNoteRow }> {
  const issueKey = input.issueKey.trim();
  if (
    !issueKey &&
    !input.title.trim() &&
    !input.branch.trim() &&
    !input.body.trim()
  ) {
    return {
      ok: false,
      message: "Card trống — cần ít nhất issue key, tiêu đề hoặc nhánh",
    };
  }

  try {
    const stages = getStages();
    // An empty stage would render the card into no column. First stage is the
    // sensible landing spot: a card is created when work starts.
    const stage = stages.some((s) => s.name === input.stage)
      ? input.stage
      : (stages[0]?.name ?? "");

    // Only touched when the field was actually edited, so an ordinary save of
    // the notes never disturbs what the scan worked out.
    let github:
      | { repo: string; prNumber: number | null; prUrl: string }
      | null
      | undefined;
    let branch = input.branch;
    if (input.githubLink !== undefined) {
      const typed = input.githubLink.trim();
      if (!typed) github = null;
      else {
        const link = parseGitHubLink(typed);
        if (!link) {
          return {
            ok: false,
            message:
              "Link GitHub không đọc được. Dán URL nhánh, URL pull request, hoặc chỉ owner/repo.",
          };
        }
        github = {
          repo: link.repo,
          prNumber: link.prNumber ?? null,
          prUrl: link.prNumber
            ? `https://github.com/${link.repo}/pull/${link.prNumber}`
            : "",
        };
        // A branch in the URL is the more specific statement, so it wins over
        // whatever is sitting in the branch box.
        if (link.branch) branch = link.branch;
      }
    }

    const id = saveTaskNote({ ...input, issueKey, stage, branch, github });
    // Read back rather than rebuild: the row carries GitHub fields this form
    // never sees, and reconstructing it here would hand the caller a copy with
    // the PR link blanked out.
    const row = getTaskNote(id);
    return {
      ok: true,
      message: issueKey ? `Đã lưu ghi chú ${issueKey}` : "Đã lưu ghi chú",
      ...(row ? { row } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không lưu được",
    };
  }
}

/**
 * Writes only the notes.
 *
 * Ticking an item off is a one-click action on the card, and routing it through
 * the full save would make it carry — and risk overwriting — every other field
 * from a copy of the row the browser may be holding stale.
 */
export async function updateNoteBodyAction(
  id: number,
  body: string,
): Promise<ActionResult> {
  try {
    setNoteBody(id, body);
    return { ok: true, message: "Đã lưu" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không lưu được",
    };
  }
}

export async function moveNoteAction(
  id: number,
  stage: string,
): Promise<ActionResult> {
  try {
    moveTaskNote(id, stage);
    return { ok: true, message: `Đã chuyển sang "${stage}"` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không chuyển được",
    };
  }
}

export async function deleteNoteAction(id: number): Promise<ActionResult> {
  try {
    deleteTaskNote(id);
    return { ok: true, message: "Đã xoá" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không xoá được",
    };
  }
}

/* ------------------------------- GitHub ---------------------------------- */

/** Named once: the token is a core setting, so every path here points at the same place. */
const NO_TOKEN =
  "Chưa có token GitHub — điền GITHUB_TOKEN vào .env.local, hoặc dán vào Settings › GitHub.";

/** Reads GitHub and reports what it *would* change. Writes nothing. */
export async function scanGitHubAction(): Promise<
  ActionResult & { result?: ScanResult }
> {
  try {
    const result = await scanGitHub();
    const actionable = result.rows.filter((r) => r.action !== "match").length;
    return {
      ok: true,
      message: actionable
        ? `${planSummary(result.rows)} — xem lại rồi áp dụng`
        : `${planSummary(result.rows)} — không có gì để đổi`,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Không quét được GitHub",
    };
  }
}

/**
 * Scan and write, in one press — the "I just pushed a branch, show it" path.
 *
 * Applies only what {@link safeRows} allows, so the button can never overwrite
 * a hand-typed branch. Anything it declines is reported by count and stays
 * waiting in the GitHub tab, where it can be read before being accepted.
 */
export async function quickScanAction(): Promise<
  ActionResult & {
    created?: number;
    updated?: number;
    held?: number;
    gone?: number;
  }
> {
  try {
    const scan = await scanGitHub();
    const safe = safeRows(scan.rows);
    const created = safe.filter((r) => r.action === "create").length;
    const updated = safe.filter((r) => r.action === "fill").length;
    // Only the ones that became cards. `scan.localOnly` counts every unpushed
    // branch found, most of which carry no ticket and never reach the board —
    // reporting that number here read as "10 new cards" when three were made.
    const unpushed = safe.filter((r) => r.branch.local?.onlyLocal).length;
    const held = scan.rows.filter((r) => r.action === "conflict").length;

    // Only branches that *became* missing this run, so a board already carrying
    // the flag stops re-announcing it on every press.
    const { markedGone } = applyPlan(
      safe,
      scan.gone.map((g) => g.id),
    );

    const bits = [
      created && `${created} card mới`,
      updated && `${updated} cập nhật`,
      unpushed && `${unpushed} trong đó chưa push`,
      markedGone && `${markedGone} nhánh đã mất`,
      held && `${held} khác nhánh — cần xem ở tab GitHub`,
    ].filter(Boolean);

    return {
      ok: true,
      message: bits.length
        ? `Đã quét: ${bits.join(" · ")}`
        : `Đã quét ${scan.mine} nhánh — không có gì mới`,
      created,
      updated,
      held,
      gone: markedGone,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Không quét được GitHub",
    };
  }
}

export async function applyPlanAction(
  rows: PlanRow[],
  /** Cards whose branch the same scan found missing — marked, never deleted. */
  goneIds: number[] = [],
): Promise<ActionResult> {
  try {
    const { written, markedGone } = applyPlan(rows, goneIds);
    const marked = markedGone ? `, đánh dấu ${markedGone} nhánh đã mất` : "";
    return {
      ok: true,
      message:
        written || markedGone
          ? `Đã cập nhật ${written} card${marked}`
          : "Không có gì để cập nhật",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không áp dụng được",
    };
  }
}

/**
 * Removes cards from the board, and only from the board.
 *
 * The board is a place to look at work, not a place work happens: nothing here
 * touches the branch on GitHub or the ticket in Jira. That is what makes
 * deleting safe enough to offer in bulk — the worst case is losing notes the
 * user typed, which is why the count comes back and the UI confirms first.
 */
export async function deleteNotesAction(
  ids: number[],
): Promise<ActionResult & { deleted?: number }> {
  if (!ids.length) return { ok: false, message: "Chưa chọn card nào" };
  try {
    const deleted = deleteTaskNotes(ids);
    return {
      ok: true,
      message: `Đã xoá ${deleted} card khỏi bảng — nhánh trên GitHub và ticket Jira không bị đụng tới`,
      deleted,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không xoá được",
    };
  }
}

export async function saveGitHubConfigAction(input: {
  repos: string[];
  identity: Identity;
  projectKeys: string[];
  useEvents: boolean;
  localPaths: string[];
  repoLabels: Record<string, string>;
  repoColors: Record<string, string>;
  buildWorkflow: string;
  buildRepo: string;
  buildApps: Record<string, string>;
  buildEnabled: boolean;
  buildNotify: boolean;
}): Promise<ActionResult & { view?: GitHubConfigView }> {
  try {
    setGitHubConfig(input);
    const cfg = getGitHubConfig();
    return {
      ok: true,
      message: "Đã lưu cấu hình GitHub",
      view: toConfigView(cfg),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không lưu được",
    };
  }
}

/**
 * Fills in who the user is and which orgs they can see, from the token itself.
 *
 * Typing a GitHub login into a settings box is the step most likely to be got
 * wrong — a display name instead of a login, the work email instead of the one
 * git is configured with — and every mistake shows up as a scan that silently
 * finds nothing.
 */
export async function detectGitHubAction(): Promise<
  ActionResult & { login?: string; email?: string; orgs?: string[] }
> {
  try {
    const { token } = getGitHubConfig();
    if (!token) return { ok: false, message: NO_TOKEN };
    const v = await fetchViewer(token);
    return {
      ok: true,
      message: `Token của ${v.login}${v.orgs.length ? ` · ${v.orgs.length} org` : ""}`,
      login: v.login,
      email: v.email,
      orgs: v.orgs,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không đọc được token",
    };
  }
}

export async function listReposAction(
  owner: string,
): Promise<ActionResult & { repos?: string[] }> {
  try {
    const { token } = getGitHubConfig();
    if (!token) return { ok: false, message: NO_TOKEN };
    const repos = await fetchRepos(token, owner.trim());
    return { ok: true, message: `${repos.length} repo trong ${owner}`, repos };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không đọc được repo",
    };
  }
}

export async function saveStagesAction(
  list: StageConfig[],
): Promise<ActionResult> {
  if (!list.some((s) => s.name.trim())) {
    return { ok: false, message: "Cần ít nhất một cột" };
  }
  try {
    setStages(list);
    return { ok: true, message: "Đã lưu các cột" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không lưu được",
    };
  }
}

/**
 * New builds for the environments the board watches.
 *
 * Environment-level and deliberately separate from the branch scan: a build is
 * a fact about a branch, and which cards it carries is an inference the board
 * does not make. Cheap enough to poll on its own — two requests per configured
 * environment, no repository walk.
 */
/**
 * Re-read the pull requests of branches the board already has cards for.
 *
 * The cheap half of a scan, made to run on a timer. A full scan walks every
 * ref in both repositories and compares each against three environments — far
 * too much to repeat every few minutes to answer "did that request get
 * merged". This asks for a dozen named refs and their requests, one GraphQL
 * round trip per repository.
 *
 * What it deliberately does not do: find branches nobody has a card for,
 * delete cards, measure containment, or touch `syncedAt`. A card's environment
 * state stays as the last real scan measured it.
 *
 * The column can still move, because `stageFor` reads the requests as well as
 * the environments — a request opened against `develop` puts a card in
 * "integration" with no measuring at all. What it cannot do is notice a merge
 * landing: that is containment, and containment is the part left out. So a
 * merged request shows as merged here while the card waits for a full scan to
 * move columns.
 */
/**
 * Check the clone paths without running a scan.
 *
 * The paths were only ever validated as a side effect of a full GitHub scan —
 * two repositories walked, every branch compared against three environments —
 * which is a long way to go to be told a path has a typo in it. This reads
 * `git remote get-url origin` and a ref count, nothing more, and says for each
 * path which repository it actually is.
 *
 * Reporting the repository matters as much as reporting the failure: a clone
 * that opens fine but whose origin is not one of the watched repositories is
 * useless to the board, and nothing said so.
 */
export async function checkLocalPathsAction(paths: string[]): Promise<
  ActionResult & {
    rows?: Array<{
      path: string;
      repo: string;
      branches: number;
      watched: boolean;
      why: string;
    }>;
  }
> {
  try {
    const clean = paths.map((p) => p.trim()).filter(Boolean);
    if (!clean.length) return { ok: true, message: "Chưa điền đường dẫn nào" };

    const cfg = getGitHubConfig();
    const watched = new Set(cfg.repos);
    const scan = await readLocalBranches(clean);
    const why = new Map(scan.bad.map((b) => [b.path, b.why]));

    const rows = clean.map((path) => {
      const mine = scan.branches.filter((b) => b.path === path);
      const repo = mine[0]?.repo ?? "";
      return {
        path,
        repo,
        branches: mine.length,
        watched: Boolean(repo) && watched.has(repo),
        why: why.get(path) ?? "",
      };
    });

    const bad = rows.filter((r) => r.why || !r.watched).length;
    return {
      ok: true,
      message: bad
        ? `${bad}/${rows.length} đường dẫn có vấn đề`
        : `${rows.length} đường dẫn đều đọc được`,
      rows,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Không kiểm được đường dẫn",
    };
  }
}

export async function refreshPrsAction(): Promise<
  ActionResult & { changed?: number }
> {
  try {
    const cfg = getGitHubConfig();
    if (!cfg.token) return { ok: true, message: "", changed: 0 };

    const cards = listTaskNotes().filter((c) => c.sides.length);
    if (!cards.length) return { ok: true, message: "", changed: 0 };

    // One entry per (repo, branch): two cards can name the same branch, and a
    // card can have a side in each repository.
    const wanted = new Map<string, { repo: string; branch: string }>();
    for (const c of cards)
      for (const side of c.sides)
        if (side.repo && side.branch.trim())
          wanted.set(`${side.repo}#${side.branch.trim()}`, {
            repo: side.repo,
            branch: side.branch.trim(),
          });

    const found = await fetchBranchPrs(cfg.token, [...wanted.values()]);

    // Requests pinned to one environment row are usually not among their
    // branch's own — that is why they had to be pinned — so their state has to
    // be asked for by number or it would freeze at whatever it was when pinned.
    const pinsByRepo = new Map<string, number[]>();
    const wantPin = (repo: string, n: number) =>
      pinsByRepo.set(repo, [...(pinsByRepo.get(repo) ?? []), n]);
    for (const c of cards)
      for (const side of c.sides)
        for (const p of side.prs)
          if (p.pinned && p.number) wantPin(side.repo, p.number);
    const livePins = new Map<number, PullRequest>();
    for (const [repo, numbers] of pinsByRepo) {
      const got = await fetchPrsByNumber(cfg.token, repo, numbers).catch(
        () => ({}) as Record<number, PinnedPr>,
      );
      for (const pr of Object.values(got)) livePins.set(pr.number, pr);
    }

    /**
     * The clones, re-read on the same tick.
     *
     * Until this was here, "chưa push" was written once by a full scan and
     * never revisited: this refresh rewrote the GitHub half of every side and
     * carried the local half through, so a branch that had since been pushed
     * kept its warning — beside its own merged pull request. Four `git
     * for-each-ref` calls against local disks is nothing next to the GitHub
     * round-trips this function already makes.
     *
     * Skipped entirely when no clone is configured, so the feature being off
     * cannot wipe what an earlier scan legitimately recorded.
     */
    const local = cfg.localPaths.length
      ? localIndex(
          await readLocalBranches(cfg.localPaths).catch(() => ({
            branches: [],
            bad: [],
          })),
        )
      : null;

    const stages = cfg.stages;
    const stageNames = stages.map((s) => s.name);
    const built = (c: (typeof cards)[number]) =>
      c.builds.flatMap((b) => (b.branch ? [b.branch] : []));

    const writes = cards.flatMap((c) => {
      // `local` null means no clone is configured — leave the stored values
      // alone rather than clearing them, which an empty index would do.
      const judged = (local ? withLocalState(c.sides, local) : c.sides).map((side) => {
        const prs = found.get(`${side.repo}#${side.branch.trim()}`);
        // Absent, not empty: the branch was not in the reply, so nothing is
        // known about it and this side is carried through untouched.
        if (!prs) return { side, target: null as string | null };
        const merged = mergeCardPrs(prsForCard(prs), side.prs, livePins);
        const target = stageFor(
          parseEnvState(side.envState),
          pickPr(merged.map(asPullRequest)),
          stages,
          merged.map(asPullRequest),
          built(c),
        );
        return { side: { ...side, prs: merged }, target };
      });

      // Least advanced first, same rule the scan uses: a ticket is only as far
      // along as its slowest repository.
      // Same rule as the scan and the hand-edit path, from the same function.
      // A side GitHub said nothing about is carried through as it was, so it
      // contributes whatever it already held rather than counting as behind.
      const target = cardStage(
        judged.map((j) => j.side),
        c.builds,
        stages,
      );
      const stage = target ? advanceStage(c.stage, target, stageNames) : "";

      // Stored in the configured order, the same order the card is read in.
      const next = orderSides(
        judged.map((x) => x.side),
        cfg.repos,
      );
      // The columns are compared too, not just the JSON. They hold the same
      // three facts and the board draws *them*, so a card whose `sides` are
      // already right but whose columns are stale has to still be written —
      // otherwise the very drift this refresh exists to fix is the thing that
      // makes it skip the fix.
      const head = next[0];
      const columnsMatch =
        c.localAhead === (head?.localAhead ?? 0) &&
        c.localOnly === Boolean(head?.localOnly) &&
        c.localPath === (head?.localPath ?? "");
      if (
        serializeCardSides(c.sides) === serializeCardSides(next) &&
        !stage &&
        columnsMatch
      )
        return [];
      return [{ id: c.id, sides: next, stage }];
    });

    const changed = setCardPrs(writes);
    return {
      ok: true,
      message: changed ? `${changed} card đổi PR` : "",
      changed,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Không đọc được PR từ GitHub",
    };
  }
}

export async function checkBuildsAction(
  /** Set by the "kiểm ngay" button; the timer never sets it. */
  fresh = false,
): Promise<
  ActionResult & { news?: EnvBuild[]; tagged?: number; pending?: boolean }
> {
  try {
    const cfg = getGitHubConfig();
    const envs = envSteps(cfg.stages);
    // The master switch, checked before anything else: a team that does not
    // ship builds must not reach App Store Connect at all, not even from the
    // button. `fresh` bypasses the read cache, so without this a hand press
    // would spend real requests on a channel nobody configured.
    if (!cfg.buildEnabled) return { ok: true, message: "", news: [] };
    if (!cfg.token || !envs.length) return { ok: true, message: "", news: [] };

    const { builds: current, skipped } = await fetchEnvBuilds(
      cfg.token,
      cfg,
      envs,
      fresh,
    );

    // The build's own note names the tickets it carries, so this is where a
    // card learns which build it shipped in — stated by whoever published it,
    // not deduced from timing.
    const cards = listTaskNotes();
    // One build per environment per card, so shipping to integration does not
    // erase the develop build the work also went out in.
    const best = new Map<number, CardBuild[]>();
    for (const list of current.values()) {
      // Oldest first, so a newer build of the same environment supersedes it.
      for (const b of [...list].sort((x, y) => x.at - y.at)) {
        const carried = new Set(buildCarries(b, cfg.projectKeys));
        if (!carried.size) continue;
        for (const c of cards) {
          if (!c.issueKeys.some((k) => carried.has(k))) continue;
          const next = mergeCardBuild(best.get(c.id) ?? c.builds, b);
          if (next) best.set(c.id, next);
        }
      }
    }
    // The card goes with the builds: recording one has to be able to move the
    // column, and that needs the sides and the column it is in now.
    const byId = new Map(cards.map((c) => [c.id, c]));
    const tagged = setCardBuilds(
      [...best].map(([id, builds]) => ({
        id,
        builds,
        sides: byId.get(id)?.sides ?? [],
        stage: byId.get(id)?.stage ?? "",
      })),
    );

    // The news is about the newest build of each environment.
    const newest = new Map(
      [...current].flatMap(([branch, list]) =>
        list[0] ? [[branch, list[0]] as const] : [],
      ),
    );
    const news = newBuilds(newest, getSeenBuilds());
    return {
      ok: true,
      message:
        [
          // First, because it is the only line that says something is wrong.
          // An environment that cannot be read produces no builds at all, and
          // "chưa có bản build nào mới" reads as good news for it.
          ...skipped.map((s) => `${s.env}: ${s.why}`),
          news.length && `${news.length} bản build mới`,
          tagged && `${tagged} card được gắn bản build`,
        ]
          .filter(Boolean)
          .join(" · ") || "Chưa có bản build nào mới",
      news,
      tagged,
      /**
       * A build is uploaded but not yet handed to testers.
       *
       * Worth saying, because that state is short and it is exactly when the
       * board is wrong: the "What to Test" note — the only thing that says
       * which tickets a build carries — is written at publish time, so until
       * then the build exists with nothing to read. The caller polls faster
       * while this holds rather than waiting out a half-hour it knows the
       * answer will change inside.
       */
      pending: [...newest.values()].some(
        (b) => b.externalState && b.externalState !== "IN_BETA_TESTING",
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Không đọc được kênh build",
    };
  }
}

/**
 * Marks build news as read, per environment.
 *
 * Stored rather than kept in the page so a build that lands while the app is
 * closed is still news when it opens.
 */
export async function markBuildsSeenAction(
  builds: Array<{ branch: string; build: string }>,
): Promise<ActionResult> {
  try {
    const next = { ...getSeenBuilds() };
    for (const b of builds) if (b.branch && b.build) next[b.branch] = b.build;
    setSeenBuilds(next);
    return { ok: true, message: "Đã đánh dấu đã xem" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Không đánh dấu được",
    };
  }
}
