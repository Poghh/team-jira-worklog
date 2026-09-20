"use client";

import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";

import { StatusPill } from "@/app/board/status-pill";
import { NavProvider, useNav } from "@/app/board/navigation";
import { BuildNews, useBuildWatch } from "@/app/build-watch";
import { statusRank, statusTone } from "@/lib/jira/types";
import {
  type GitHubConfigView,
  asPullRequest,
  parsePrRef,
  githubLinkOf,
  parseEnvState,
  parseGitHubLink,
  prBadge,
  repoChip,
  repoEdgeVar,
  repoLabel,
} from "@/lib/modules/branches/github-model";
import {
  type NoteItem,
  type StageConfig,
  type TaskNoteRow,
  type CardBuild,
  type CardPr,
  type CardSide,
  type LadderRow,
  type PrPin,
  branchesToDelete,
  cardLadder,
  stageRule,
  envSteps,
  orderSides,
  jiraLinkFor,
  parseNotes,
  builtButNotTested,
  serializeNotes,
  sortByStatus,
  stageDrift,
  suggestBranch,
} from "@/lib/modules/branches/model";

import {
  deleteNoteAction,
  refreshPrsAction,
  deleteNotesAction,
  moveNoteAction,
  quickScanAction,
  saveNoteAction,
  saveStagesAction,
  updateNoteBodyAction,
} from "./actions";
import { GitHubPanel, PR_CLS } from "./github-panel";

const CARD = "rounded-[9px] border border-line bg-surface p-[17px]";
const CTITLE = "font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3";
const BTN =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-2";
const BTN_PRI =
  "rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:bg-accent-2 disabled:opacity-50";

export interface IssueStatus {
  statusName: string;
  issueTypeName: string;
  summary: string;
  /**
   * The ticket Jira was actually asked about — the pinned link's key when the
   * card has one, otherwise the card's own.
   */
  key: string;
}

/** A stored card plus whatever Jira currently says about its issue. */
type Card = TaskNoteRow & {
  /** Status of the card's least advanced ticket. */
  statusName: string | null;
  /** Which ticket that status belongs to — not necessarily the primary key. */
  statusKey: string;
  /**
   * Every ticket on the card; `name` is null when Jira does not have it.
   *
   * `key` is the card's own — what it is filed under and what the reader looks
   * for. `real` is the ticket that status belongs to and that any write must
   * go to; they differ exactly when a Jira link is pinned.
   */
  statuses: Array<{ key: string; real: string; name: string | null }>;
  issueTypeName: string | null;
};

export function BranchBoard({
  initial,
  stages,
  statuses,
  baseUrl,
  jiraLive,
  jiraError,
  offSite,
  ghView,
}: {
  initial: TaskNoteRow[];
  stages: StageConfig[];
  statuses: Record<string, IssueStatus>;
  baseUrl: string;
  /** Jira was actually asked, so an absent status means "not found". */
  jiraLive: boolean;
  /** '' khi Jira trả lời được; lý do khi gọi hỏng. */
  jiraError: string;
  /** Ticket key → the other Jira host its pinned link points at. */
  offSite: Record<string, string>;
  ghView: GitHubConfigView;
}) {
  const [tab, setTab] = useState<"board" | "config" | "github">(
    stages.length ? "board" : "config",
  );

  return (
    <NavProvider>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className={CTITLE}>Ghi chú local · không đẩy lên Jira</div>
          <h1 className="text-xl font-semibold tracking-tight">
            Nhánh &amp; ghi chú
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Nhánh của từng task đang ở đâu, và những gì không được quên trong
            task đó.
          </p>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line-strong text-[12.5px]">
          <TabBtn on={tab === "board"} onClick={() => setTab("board")}>
            Bảng
          </TabBtn>
          <TabBtn on={tab === "config"} onClick={() => setTab("config")}>
            Cột
          </TabBtn>
          <TabBtn on={tab === "github"} onClick={() => setTab("github")}>
            GitHub
            {!ghView.hasToken && (
              <span title="Chưa cấu hình" className="ml-1 text-warn">
                ●
              </span>
            )}
          </TabBtn>
        </div>
      </header>

      {tab === "board" && (
        <Board
          initial={initial}
          stages={stages}
          statuses={statuses}
          baseUrl={baseUrl}
          jiraLive={jiraLive}
          jiraError={jiraError}
          offSite={offSite}
          repos={ghView.repos}
          repoLabels={ghView.repoLabels}
          repoColors={ghView.repoColors}
          buildsOn={ghView.buildEnabled}
        />
      )}
      {tab === "config" && <StagesManager stages={stages} />}
      {tab === "github" && (
        <GitHubPanel view={ghView} stages={stages} baseUrl={baseUrl} />
      )}
    </NavProvider>
  );
}

function TabBtn({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "border-l border-line px-3 py-[5px] first:border-l-0 " +
        (on
          ? "bg-accent-soft font-semibold text-accent-ink"
          : "bg-surface text-ink-2 hover:bg-surface-2")
      }
    >
      {children}
    </button>
  );
}

/**
 * One labelled row of a card.
 *
 * A card had grown to eight kinds of chip stacked with nothing to say which was
 * which — key, title, branch, pull request, environments, unpushed count, notes
 * — and read as a pile. A fixed label column turns it into a form: the eye goes
 * down the labels and stops at the one it wants.
 */
/**
 * The environment ladder: one row per environment, its request and its build.
 *
 * Split out because a card with two repositories draws it three times — once
 * per repository for the requests, once more for the builds, which belong to
 * the card rather than to either repository.
 *
 * Widths: a real number or PR keeps every character it has, and the dashed
 * placeholders are what give way when a row runs long. Losing characters off
 * "chưa có bản build" costs nothing; losing them off a build number costs the
 * number.
 */
function Ladder({
  rows,
  repo,
  prs = true,
  builds = true,
}: {
  rows: LadderRow[];
  repo: string;
  /** False on the build-only pass of a multi-repository card. */
  prs?: boolean;
  /** False on the per-repository passes, where builds would be duplicated. */
  builds?: boolean;
}) {
  return (
    <>
      {rows.map((r) => {
        const b = r.pr ? prBadge(asPullRequest(r.pr)) : null;
        return (
          <CardRow key={r.branch || r.name} label={r.name}>
            {/* Its own non-wrapping track. CardRow wraps by design — the
                warnings row is a bag of badges — but a ladder row that wraps
                is two lines tall next to neighbours that are one, which reads
                as breakage rather than as overflow. Here the placeholder
                shortens instead. */}
            <span className="flex w-full min-w-0 items-center gap-1">
              {prs &&
                (b && r.pr ? (
                  <a
                    href={r.pr.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title={`Mở PR #${r.pr.number}${repo ? ` trong ${repo}` : ""}\n${r.pr.url}`}
                    className={
                      "flex shrink-0 justify-center rounded-[3px] border px-1 py-px font-mono text-[9.5px] font-semibold hover:underline " +
                      PR_CLS[b.tone]
                    }
                  >
                    {b.label}
                  </a>
                ) : (
                  <span
                    title={`Chưa có pull request nào của nhánh này nhắm vào ${r.branch}.\n\nPhần lớn task chỉ có một request vào môi trường đầu; các môi trường sau thường đi bằng merge ở mức nhánh chứ không phải theo từng task, nên ô trống ở đây là chuyện bình thường.`}
                    className="flex min-w-0 flex-auto justify-center truncate rounded-[3px] border border-dashed border-line-strong px-1 py-px font-mono text-[9.5px] text-ink-3"
                  >
                    chưa tạo PR
                  </span>
                ))}

              {/* A feature branch never gets a build of its own, so its row is
                  left without a build box rather than shown as missing one. */}
              {builds &&
                r.isEnv &&
                (r.build?.build ? (
                  <span
                    title={`Bản build ${r.build.build} của ${r.branch}\n\nLấy từ ghi chú "What to Test" của chính bản build, nơi người publish liệt kê ticket có trong đó — hoặc do bạn tự điền khi bản build đi ra mà thiếu ghi chú.`}
                    className="flex shrink-0 justify-center rounded-[3px] border border-good bg-good-soft px-1 py-px font-mono text-[9.5px] font-semibold text-good"
                  >
                    ⚙ {r.build.build}
                  </span>
                ) : (
                  <span
                    title={`Chưa có bản build nào của ${r.branch} nhắc tới ticket này.\n\nCó thể là chưa build, cũng có thể bản build đã ra mà quên ghi chú "What to Test" — nếu vậy bấm ✎ và điền số vào ô ${r.name}.`}
                    className="flex min-w-0 flex-auto justify-center truncate rounded-[3px] border border-dashed border-line-strong px-1 py-px font-mono text-[9.5px] text-ink-3"
                  >
                    chưa có bản build
                  </span>
                ))}
            </span>
          </CardRow>
        );
      })}
    </>
  );
}

/**
 * Where a block's colour spine sits: the gap between a row's label column and
 * its values.
 *
 * Derived from `CardRow`'s own geometry — a 62px label and a 6px gap — so the
 * two have to move together. Kept beside them for that reason.
 */
const SPINE_X = "left-[64px] w-[2px] rounded-full";

/**
 * The heading of one block on a card that has more than one repository.
 *
 * A rule above it, because two ladders running together show "DEVELOP" twice
 * with nothing saying the second belongs to a different codebase. The repo
 * label is filled solid, the same chip the header uses, so the block and the
 * header can be paired by colour rather than by reading.
 */
function SideHead({
  label,
  solid,
  title,
  text,
}: {
  label: string;
  /** The repo chip's fill; absent for the build block, which is no repo. */
  solid?: string;
  title: string;
  text: string;
}) {
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 border-t border-line pt-1">
      <span
        className={
          "w-[62px] shrink-0 truncate rounded-[3px] text-center font-mono text-[8.5px] font-bold uppercase leading-[1.5] tracking-[0.06em] " +
          (solid ?? "text-ink-3")
        }
      >
        {label}
      </span>
      <span
        title={title}
        className="min-w-0 truncate font-mono text-[10px] text-ink-3"
      >
        {text}
      </span>
    </span>
  );
}

function CardRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <span className="w-[62px] shrink-0 pt-[3px] font-mono text-[8.5px] uppercase leading-[1.2] tracking-[0.06em] text-ink-3">
        {label}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {children}
      </span>
    </span>
  );
}

/**
 * The readable end of a resolve branch — `resolve_VTL-286_develop` → `resolve`,
 * `ctalk/resolve/VTL-286` → `resolve`.
 *
 * The whole name does not fit on a card and would not earn the space: what
 * matters is that the work took the resolve route, which is this team's normal
 * way of merging. The full name is one hover away in the tooltip.
 */
function shortVia(branch: string): string {
  return /(^|[^a-z])resolve([^a-z]|$)/i.test(branch)
    ? "resolve"
    : (branch.split("/").pop() || branch).slice(0, 18);
}

/** Tone order, least advanced first — mirrors `statusTone` in lib/jira/types. */
const TONE_ORDER = ["todo", "prog", "test", "ver", "done"];

/**
 * The card's least advanced ticket — the name *and* whose it is.
 *
 * Returning only the name was the bug: a card covering two tickets warned
 * "Jira vẫn: COMMITED CODE FEATURE BRANCH" and then offered a status control
 * for its *primary* key, which is not necessarily the ticket that is behind.
 * The one thing the user needs to know — which task is still sitting there —
 * was the one thing the warning did not say.
 */
function laggingStatus(
  keys: string[],
  live: Record<string, string>,
  statuses: Record<string, IssueStatus>,
): { key: string; name: string } | null {
  let worst: { key: string; name: string } | null = null;
  for (const k of keys) {
    const name = live[k] ?? statuses[k]?.statusName;
    if (!name) continue;
    if (
      !worst ||
      TONE_ORDER.indexOf(statusTone(name)) <
        TONE_ORDER.indexOf(statusTone(worst.name))
    ) {
      // Reported under the ticket the status came from, which is the pinned
      // one when there is a pin. Every use of this key is a sentence telling
      // somebody which ticket to go and move, and the card's own key is the
      // wrong answer to that the moment a link is pinned elsewhere.
      worst = { key: statuses[k]?.key ?? k, name };
    }
  }
  return worst;
}

/**
 * Every ticket on the card, with its status or a null saying Jira has none.
 *
 * The nulls are kept rather than filtered out. A key Jira cannot resolve is why
 * a card shows no status and raises no drift warning, and dropping it made the
 * board silently indistinguishable from one where everything was fine — the
 * card simply had no badges and no explanation for their absence.
 */
function keyStatuses(
  keys: string[],
  live: Record<string, string>,
  statuses: Record<string, IssueStatus>,
): Array<{ key: string; real: string; name: string | null }> {
  return keys.map((k) => ({
    key: k,
    real: statuses[k]?.key ?? k,
    name: live[k] ?? statuses[k]?.statusName ?? null,
  }));
}

// ── board ────────────────────────────────────────────────────────────────────

function Board({
  initial,
  stages,
  statuses,
  baseUrl,
  jiraLive,
  jiraError,
  offSite,
  repos,
  repoLabels,
  repoColors,
  buildsOn,
}: {
  initial: TaskNoteRow[];
  stages: StageConfig[];
  statuses: Record<string, IssueStatus>;
  baseUrl: string;
  jiraLive: boolean;
  /** '' khi Jira trả lời được; lý do khi gọi hỏng. */
  jiraError: string;
  offSite: Record<string, string>;
  repos: string[];
  repoLabels: Record<string, string>;
  repoColors: Record<string, string>;
  /**
   * This team ships builds. False strips every mention of one from the board —
   * the boxes on the cards, the editor's fields, the check button — rather
   * than showing controls for a channel nobody configured.
   */
  buildsOn: boolean;
}) {
  /**
   * The cards, seeded from the server and patched locally for the moment
   * between an edit and the server confirming it.
   *
   * Seeded once and never looked at again — which is what this was — froze the
   * board: the server re-renders every three minutes and on tab focus, and a
   * build check writes the build number onto the cards it recognises, but none
   * of that reached the screen. The strip would announce a build while every
   * card still showed the previous one, with no way to tell which cards it was
   * about. Whatever the server last said wins; local state only covers the gap.
   */
  const [rows, setRows] = useState<TaskNoteRow[]>(initial);
  const [seeded, setSeeded] = useState(initial);
  if (initial !== seeded) {
    setSeeded(initial);
    setRows(initial);
  }
  // Status is kept apart from the row so a transition made here updates the
  // badge immediately without inventing a stored value that Jira never saw.
  const [live, setLive] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  /** '' = plain workflow order. Otherwise the status pushed to the top. */
  const [pinned, setPinned] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  // Bulk selection. Deleting is the only bulk action, and it is safe here in a
  // way it would not be elsewhere: this board mirrors work, it does not perform
  // it, so removing a card never touches the branch or the ticket.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  /**
   * The app-wide build watcher, which owns the polling, the notification and
   * the news strip. Null when the branches module is off — impossible on this
   * page, which the module gate guards, but the hook cannot know that.
   *
   * All of this used to live here, which is why a build only ever announced
   * itself to someone already looking at this board. See {@link BuildWatcher}.
   */
  const builds = useBuildWatch();
  const [, startTx] = useTransition();
  const { refresh } = useNav();

  /**
   * Keeps the Jira side current without a scan.
   *
   * Status badges and the drift warnings come from the server render, so they
   * were only as fresh as the last page load — and the only thing on the board
   * that reloads is the GitHub scan button. Pressing "quét GitHub" to find out
   * that a ticket moved is asking for a walk of every branch in two
   * repositories to answer a question Jira alone could.
   *
   * `refresh` re-runs the server component and nothing else: one Jira query,
   * no repository walk, and the client keeps its scroll, its selection and any
   * drag in progress.
   *
   * On becoming visible as well as on a timer, because coming back to the tab
   * is exactly when the board is most likely to be stale and most likely to be
   * read — and that, not the timer, is what makes the board feel current. The
   * timer is only there for a window left open and watched, so three minutes is
   * plenty; ninety seconds was spending twice the Jira requests to shorten a
   * wait nobody sits through.
   *
   * Jira's own search index lags a transition by fifteen to twenty seconds, so
   * polling faster than that cannot help anyway.
   */
  /**
   * Pull-request state, without a scan.
   *
   * The Jira refresh above re-renders from the database; it cannot learn that
   * a request was opened or merged, because only a GitHub scan writes that —
   * and a scan is a walk of every branch in both repositories, far too much to
   * repeat on a timer. `refreshPrsAction` asks GitHub only about the branches
   * that already have cards, so it is cheap enough to run on one.
   *
   * Twelve minutes, and on becoming visible. A request's state changes a
   * handful of times a day, so the timer is a backstop; returning to the tab
   * is what actually makes the board current, exactly as with Jira.
   *
   * `refresh` afterwards because the action writes to the database and the
   * board renders from the server — without it the work would land and nothing
   * on screen would change until the next Jira tick.
   */
  useEffect(() => {
    const tick = () =>
      void refreshPrsAction().then((res) => {
        if (res.ok && res.changed) refresh();
      });
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(tick, 12 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(refresh, 3 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, [refresh]);

  // Reloads rather than patching local state: the scan writes stages, PR data
  // and environment positions across many cards at once, and rebuilding all of
  // that in the browser would be a second implementation of the same rules.
  function quickScan() {
    setScanning(true);
    setScanNote(null);
    startTx(async () => {
      const res = await quickScanAction();
      setScanNote(res.message);
      if (res.ok && (res.created || res.updated || res.gone)) {
        setTimeout(() => window.location.reload(), 600);
      } else {
        setScanning(false);
      }
    });
  }

  const cards: Card[] = useMemo(
    () =>
      rows.map((r) => {
        // The least advanced of the card's tickets. A branch fixing two is only
        // as done as its laggard, and warning about the one already Done would
        // hide the one still sitting in To Do. Worked out once — it used to be
        // asked twice per card, once for the name and once for whose it was.
        const lag = laggingStatus(r.issueKeys, live, statuses);
        return {
          ...r,
          statusName: lag?.name ?? null,
          statusKey: lag?.key ?? r.issueKey,
          statuses: keyStatuses(r.issueKeys, live, statuses),
          issueTypeName: statuses[r.issueKey]?.issueTypeName ?? null,
        };
      }),
    [rows, statuses, live],
  );

  /**
   * The environment names the status names are matched against — `develop`,
   * `integration`, `staging`. Taken from the pipeline so a renamed environment
   * keeps sorting correctly.
   */
  const envNames = useMemo(() => envSteps(stages).map((s) => s.name), [stages]);

  /**
   * Statuses the board is actually showing, in workflow order.
   *
   * Built from the cards rather than from a fixed list: these names are the
   * team's own — "COMMITED CODE FEATURE BRANCH" is not one anybody would think
   * to hard-code — and a status nothing is sitting in is not worth offering.
   */
  const statusOptions = useMemo(() => {
    // The card's own status, not every ticket on it — offering a status that
    // only ever appears as somebody's second ticket would be offering a choice
    // that lifts nothing.
    const seen = new Set<string>();
    for (const c of cards) if (c.statusName) seen.add(c.statusName);
    return [...seen].sort(
      (a, b) =>
        statusRank(a, envNames) - statusRank(b, envNames) || a.localeCompare(b),
    );
  }, [cards, envNames]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = q
      ? cards.filter((c) =>
          [c.issueKey, c.title, c.branch, c.body].some((v) =>
            v.toLowerCase().includes(q),
          ),
        )
      : cards;

    // The workflow's real sequence, not the five colour buckets — those file
    // "READY TO TEST ON DEVELOP" and "READY TO TEST ON STAGING" side by side,
    // and that is most of what there is to see on this board. A card whose
    // ticket Jira cannot resolve sorts as if untouched: unknown is neither
    // finished nor started, and burying it would be the wrong guess.
    return sortByStatus(out, pinned, (s) => (s ? statusRank(s, envNames) : -1));
  }, [cards, search, envNames, pinned]);

  // Cards whose stage no longer matches any column — a stage renamed in config
  // would otherwise make them vanish rather than merely look misplaced.
  const stray = visible.filter((c) => !stages.some((s) => s.name === c.stage));

  function move(id: number, stage: string) {
    setRows((list) => list.map((r) => (r.id === id ? { ...r, stage } : r)));
    void moveNoteAction(id, stage);
  }

  function remove(id: number) {
    setRows((list) => list.filter((r) => r.id !== id));
    void deleteNoteAction(id);
  }

  function openNew() {
    setEditing({
      issueKey: "",
      issueKeys: [],
      title: "",
      branch: "",
      stage: stages[0]?.name ?? "",
      body: "",
      jiraUrls: {},
      build: "",
      buildBranch: "",
      buildAt: 0,
      builds: [],
      sides: [],
      prPins: [],
      branchPins: [],
      githubLink: "",
      githubLinkWas: "",
      githubPinned: false,
    });
  }

  // Cards whose branch the last scan could not find — normally work that
  // shipped and had its branch deleted on release.
  const goneCards = useMemo(() => cards.filter((c) => c.branchGone), [cards]);
  const notesAtRisk = useMemo(
    () =>
      [...selected].reduce(
        (n, id) => n + (rows.find((r) => r.id === id)?.body.trim() ? 1 : 0),
        0,
      ),
    [selected, rows],
  );

  function toggleSel(id: number) {
    setConfirmBulk(false);
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function clearSel() {
    setSelected(new Set());
    setConfirmBulk(false);
  }

  function removeMany() {
    const ids = [...selected];
    if (!ids.length) return;
    setRows((list) => list.filter((r) => !ids.includes(r.id)));
    clearSel();
    startTx(async () => {
      await deleteNotesAction(ids);
    });
  }

  return (
    <>
      {/* The module's own news, on the module's own page. The watcher keeps
          running everywhere so the browser notification still arrives while
          you are elsewhere; the strip waits here. */}
      {buildsOn && builds && builds.news.length > 0 && (
        <BuildNews
          news={builds.news}
          permission={builds.permission}
          onAllow={builds.requestPermission}
          onDismiss={() => builds.dismiss(builds.news)}
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm key / tiêu đề / nhánh / ghi chú…"
          className="min-w-[200px] flex-1 rounded-md border border-line bg-surface px-2.5 py-[5px] text-[12.5px]"
        />

        {/* Offered only when Jira answered for something — with no statuses
            there is nothing to lift. */}
        {statusOptions.length > 0 && (
          <select
            value={pinned}
            onChange={(e) => setPinned(e.target.value)}
            title="Đẩy card có ticket ở trạng thái này lên đầu mỗi cột. Không ẩn card nào."
            className="max-w-[230px] rounded-md border border-line bg-surface px-2 py-[5px] text-[12.5px]"
          >
            <option value="">Không ưu tiên trạng thái nào</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                ↑ {s}
              </option>
            ))}
          </select>
        )}

        <span className="font-mono text-[11px] text-ink-3">
          {visible.length} card
        </span>
        <button
          type="button"
          onClick={quickScan}
          disabled={scanning}
          title="Đọc GitHub và cập nhật bảng. Chỉ tạo/cập nhật card — không bao giờ đè lên nhánh bạn tự gõ."
          className={BTN + " disabled:opacity-50"}
        >
          {scanning ? "Đang quét…" : "↻ Quét GitHub"}
        </button>
        {/* Only while Jira is unreachable. The board already retries every
            three minutes and on tab focus, so this is not the only way back —
            it is for the moment the VPN comes up and waiting out a timer is
            the wrong shape of answer. */}
        {jiraError && (
          <button
            type="button"
            onClick={() => refresh()}
            title={`Không gọi được Jira: ${jiraError}\n\nApp vẫn tự thử lại mỗi 3 phút và mỗi lần bạn quay lại tab. Nút này hỏi ngay.`}
            className={BTN + " border-warn text-warn"}
          >
            ↻ Thử lại Jira
          </button>
        )}

        {/* Separate from the GitHub scan: a build lands on Apple's schedule,
            not on a merge, and the half-hour timer that notices it is tuned for
            the steady case. When somebody already knows a build went out —
            usually from the chat bot, before the board could know — this asks
            at once and skips the five-minute read cache. */}
        {buildsOn && (
        <button
          type="button"
          onClick={() => builds?.checkNow()}
          disabled={builds?.busy ?? true}
          title="Hỏi App Store Connect ngay, bỏ qua cache 5 phút. Nhịp nền vẫn 30 phút và chạy ở mọi màn của app — nút này cho lúc bạn đã biết vừa có bản build."
          className={BTN + " disabled:opacity-50"}
        >
          {builds?.busy ? "Đang hỏi…" : "↻ Bản build"}
        </button>
        )}
        {/* Asked for here rather than only on the strip. The strip appears when
            a build lands, which is far too late to be granting permission for
            the notification about it — and this board is where somebody comes
            looking for build settings. */}
        {buildsOn && builds?.watching && builds.permission === "default" && (
          <button
            type="button"
            onClick={() => builds.requestPermission()}
            title="Cho phép trình duyệt hiện thông báo khi có bản build mới. App vẫn phải đang mở ở một tab nào đó — không cần là tab này."
            className={BTN}
          >
            Bật thông báo build
          </button>
        )}
        {(scanNote || builds?.note) && (
          <span className="text-[12px] text-ink-2">
            {scanNote || builds?.note}
          </span>
        )}
        {goneCards.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set(goneCards.map((c) => c.id)))}
            title="Tick sẵn checkbox của các card mà nhánh không còn tồn tại — đã release và bị xoá, hoặc bạn tự xoá ở clone. Chưa xoá gì cả; nút Xoá nằm ở thanh hiện ra sau đó."
            className={BTN}
          >
            ☑ Tick {goneCards.length} card mất nhánh
          </button>
        )}
        <button type="button" onClick={openNew} className={BTN_PRI}>
          + Card
        </button>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[9px] border border-accent bg-accent-soft px-3 py-2">
          <span className="text-[12.5px] font-medium text-accent-ink">
            Đã chọn {selected.size} card
          </span>
          <span className="text-[12px] text-ink-2">
            Xoá chỉ gỡ card khỏi bảng — nhánh trên GitHub và ticket Jira không
            bị đụng tới.
            {notesAtRisk > 0 && (
              <b> {notesAtRisk} card có ghi chú bạn tự viết, xoá là mất.</b>
            )}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {confirmBulk ? (
              <>
                <button
                  type="button"
                  onClick={removeMany}
                  className="rounded-md bg-crit px-3 py-1 text-[12.5px] font-medium text-white hover:opacity-90"
                >
                  Chắc chắn xoá {selected.size}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmBulk(false)}
                  className={BTN}
                >
                  Khoan
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmBulk(true)}
                className="rounded-md border border-crit px-3 py-1 text-[12.5px] font-medium text-crit hover:bg-crit-soft"
              >
                Xoá {selected.size} card
              </button>
            )}
            <button type="button" onClick={clearSel} className={BTN}>
              Bỏ chọn
            </button>
          </span>
        </div>
      )}

      {/* The floor, not the width: above it the columns are `1fr` and share
          whatever the viewport has. 340 is where the cards stop being squeezed
          — every truncation on a card at 300 was short by the same 7px, so the
          extra 40 clears them with room left rather than landing exactly on
          the limit and breaking again at the next long branch name. */}
      <div
        className="grid gap-3 overflow-x-auto pb-2"
        style={{
          gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(340px, 1fr))`,
        }}
      >
        {stages.map((stage) => {
          const col = visible.filter((c) => c.stage === stage.name);
          return (
            <div
              key={stage.name}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragId !== null) move(dragId, stage.name);
                setDragId(null);
              }}
              className="min-w-0 rounded-[10px] border border-line bg-surface-2 p-2.5"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-semibold">{stage.name}</span>
                <span className="rounded-full border border-line bg-surface px-[7px] font-mono text-[10px] text-ink-3">
                  {col.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {col.map((c) => (
                  <NoteCard
                    key={c.id}
                    card={c}
                    stages={stages}
                    baseUrl={baseUrl}
                    jiraLive={jiraLive}
                    jiraError={jiraError}
                    offSite={offSite}
                    repos={repos}
                    repoLabels={repoLabels}
                    repoColors={repoColors}
                    buildsOn={buildsOn}
                    selected={selected.has(c.id)}
                    onToggleSelect={() => toggleSel(c.id)}
                    onDragStart={() => setDragId(c.id)}
                    onDragEnd={() => setDragId(null)}
                    onEdit={() =>
                      setEditing({
                        ...c,
                        githubLink: githubLinkOf(c),
                        githubLinkWas: githubLinkOf(c),
                      })
                    }
                    onDelete={() => remove(c.id)}
                    onStatusChanged={(key, name) =>
                      setLive((m) => ({ ...m, [key]: name }))
                    }
                  />
                ))}
                {col.length === 0 && (
                  <p className="px-1 py-2 text-[11.5px] text-ink-3">—</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {stray.length > 0 && (
        <section className="mt-3 rounded-[9px] border border-dashed border-line-strong bg-surface p-3">
          <div className={"mb-2 " + CTITLE}>
            Không thuộc cột nào · {stray.length}
          </div>
          <p className="mb-2 text-[12px] text-ink-3">
            Cột{" "}
            <b className="font-mono">
              {[...new Set(stray.map((c) => c.stage || "(trống)"))].join(", ")}
            </b>{" "}
            không còn trong cấu hình. Chọn cột mới cho từng card, hoặc thêm lại
            cột ở tab Cột.
          </p>
          <div className="flex flex-col gap-1.5">
            {stray.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center gap-2 text-[12.5px]"
              >
                <span className="font-mono text-[11.5px] font-semibold text-accent-ink">
                  {c.issueKey || "—"}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {c.title || c.branch}
                </span>
                <select
                  value=""
                  onChange={(e) => e.target.value && move(c.id, e.target.value)}
                  className="rounded border border-line bg-ground px-1 py-0 text-[11px] text-ink-2"
                >
                  <option value="">chuyển sang…</option>
                  {stages.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </section>
      )}

      {editing && (
        <NoteModal
          draft={editing}
          stages={stages}
          baseUrl={baseUrl}
          repos={repos}
          repoLabels={repoLabels}
          repoColors={repoColors}
          buildsOn={buildsOn}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            setRows((list) => [row, ...list.filter((r) => r.id !== row.id)]);
            setEditing(null);
            // The row is patched in place so the card changes under the cursor,
            // but everything Jira knows about it arrives as a server prop —
            // and after an edit to the issue key that is a different ticket
            // entirely. Without this the status pill and the drift warning sit
            // blank until the next timer.
            refresh();
          }}
          onDelete={(id) => {
            remove(id);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

// ── card ─────────────────────────────────────────────────────────────────────

function NoteCard({
  card,
  stages,
  baseUrl,
  jiraLive,
  jiraError,
  offSite,
  repos,
  repoLabels,
  repoColors,
  buildsOn,
  selected,
  onToggleSelect,
  onDragStart,
  onDragEnd,
  onEdit,
  onDelete,
  onStatusChanged,
}: {
  card: Card;
  stages: StageConfig[];
  baseUrl: string;
  jiraLive: boolean;
  /** '' khi Jira trả lời được; lý do khi gọi hỏng. */
  jiraError: string;
  offSite: Record<string, string>;
  repos: string[];
  repoLabels: Record<string, string>;
  repoColors: Record<string, string>;
  /** This team ships builds — see {@link Board}. */
  buildsOn: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatusChanged: (key: string, name: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [items, setItems] = useState(() => parseNotes(card.body));
  /**
   * The body last *seen* on the prop — not the one this list last wrote.
   *
   * The rows are local state so ticking a box is instant, and `useState` runs
   * its initialiser once, so a note added in the editor never reached the
   * card. Resyncing needs a guard, and the guard has to be the incoming value:
   * comparing against what this component emitted looked equivalent and was
   * not. The write here is fire-and-forget, so the parent keeps handing back
   * the *old* body until the server round trip lands — every re-render in
   * between then counted as "changed" and rolled the tick back, and the next
   * click wrote that rolled-back state to the database.
   *
   * Keyed on the prop, a re-render carrying the same old body is not a change
   * and the tick survives; the server's echo is, and it matches what was
   * ticked anyway. Same shape as `rows` above and `StatusPill`.
   */
  const [seenBody, setSeenBody] = useState(card.body);
  if (card.body !== seenBody) {
    setSeenBody(card.body);
    setItems(parseNotes(card.body));
  }
  // Two-step rather than a modal: deleting one card is cheap to undo by hand
  // unless it carried notes, and a second click is enough friction for that.
  const [confirmDel, setConfirmDel] = useState(false);
  const chip = card.repo
    ? repoChip(card.repo, repoLabels, repoColors, repos)
    : null;
  // Pipeline order, so the requests read the way the work actually moved:
  // into the feature branch, then develop, then integration, then staging.
  // Read in the order the repositories are configured, not the order they are
  // stored in — stored order is slowest-first and flips from card to card,
  // which made the header chips and the blocks reshuffle between neighbours.
  const sides = orderSides(card.sides, repos);
  /**
   * A chip per repository the fix touches, not just the first.
   *
   * The header used to say `IOS` on a card whose work is half in the Rust SDK,
   * which is the one thing about such a card worth seeing before the ticket
   * number. Same order as the blocks below.
   */
  const chips = sides
    .filter((side) => side.repo)
    .map((side) => ({
      repo: side.repo,
      ...repoChip(side.repo, repoLabels, repoColors, repos),
    }));

  /**
   * One warning per ticket that is behind, not one per card.
   *
   * The card names a single "least advanced" ticket, which is the right thing
   * for the status pill — but a card covering two tickets can have both of
   * them lagging, and only one of the two was ever named. The reader then
   * moves that one and the card keeps warning, or worse, stops warning while
   * the other is still behind.
   */
  const drifts = card.statuses.flatMap((st) =>
    st.name
      ? (stageDrift(
          card.stage,
          st.name,
          statusTone(st.name),
          stages,
          // The pinned ticket, for the same reason the pill acts on it: the
          // warning ends in "bấm để chuyển", and it has to be naming the
          // ticket that will move.
          st.real,
        ) ?? [])
      : [],
  );
  const drift = drifts[0] ?? null;
  // The columns say which environment the code reached; they cannot say *how*
  // it got there. This team lands work by basing a branch off the environment,
  // merging the feature into it and opening the request from that — so the
  // commits that arrived carry different SHAs from the ones still sitting on
  // the feature branch. That is not the branch being broken, which is what the
  // scan can only see, so the badge names the branch that carried it instead.
  /**
   * A build shipped this, but the ticket still reads as in-progress.
   *
   * The card cannot act on it — moving the ticket is a write to a Jira other
   * people read — so it says so and leaves the pill one click away.
   *
   * Second to `drift`, which says the same thing better whenever the card
   * actually reached a build column: it can name the column. This one is for
   * the case the columns miss — a squash merge the scan cannot confirm, so the
   * card sits back in "review" while a build is already carrying its ticket.
   */
  const needsMoving =
    !drift &&
    builtButNotTested(
      card.build,
      card.statusName ? statusTone(card.statusName) : null,
    );

  /** The branch that carried the first side's work in, when it detoured. */
  const landedVia = sides[0]?.landedVia ?? "";

  const landedEnv =
    Object.entries(parseEnvState(card.envState)).find(
      ([, pos]) => pos.landed,
    )?.[0] ?? "";

  /**
   * The last column's unfinished business: branches still on GitHub.
   *
   * Empty for a card the scan put here, since being here *is* the branches
   * being gone — this is for the card dragged in by hand, which is how a
   * finished ticket normally arrives before anyone has tidied up. One entry
   * per repository, because a fix spanning the SDK and the app has two
   * branches to delete and naming only one of them is how the other gets left
   * behind.
   */
  const toDelete = branchesToDelete(card.stage, sides, stages);

  async function copyBranch() {
    try {
      await navigator.clipboard.writeText(card.branch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  const cardCls =
    // px-1.5, not px-2: the label column has to hold "INTEGRATION" at 62px,
    // and those four pixels are what keeps the boxes beside it from being
    // squeezed into an ellipsis.
    "group flex min-w-0 cursor-grab flex-col gap-1 overflow-hidden rounded-md border px-1.5 py-1.5 active:cursor-grabbing " +
    (selected ? "border-accent bg-accent-soft " : "bg-surface ") +
    // A branch that no longer exists: dashed, in the same purple nothing
    // else on a card uses. Dashed rather than merely a colour because the
    // meaning is "this is no longer a real thing", and because the left
    // edge is already spending colour on the repo.
    (card.branchGone
      ? "border-ot "
      : drift && !selected
        ? "border-warn "
        : selected
          ? ""
          : "border-line ") +
    // The repo, painted down the left edge. Costs no width and is read
    // before the text is: scanning a column, which codebase a card belongs
    // to arrives ahead of its ticket number.
    // A card whose fix spans two repositories gets its own colour on the edge,
    // not either repository's. Reusing one of them makes the same sign mean two
    // things, and it would break outright on a third repository. Which repos
    // they are is said inside, by the spines and the header chips.
    (sides.length > 1
      ? "border-l-[5px] border-l-dual "
      : chip
        ? "border-l-[5px] " + chip.edge
        : "");

  // Pulled out only so both halves of a torn card render it; position is
  // unchanged, because moving it left would push the repo chip onto the tear —
  // the left half is 119px and cannot hold the chip, the key and the buttons.
  const actions = (
    <div
      className={
        "ml-auto flex shrink-0 items-center gap-1.5 text-ink-3 opacity-60 transition-opacity group-hover:opacity-100"
      }
    >
      <button
        type="button"
        onClick={onEdit}
        title="Sửa"
        className="grid size-6 place-items-center rounded text-[14px] hover:bg-surface-2 hover:text-accent-ink"
      >
        ✎
      </button>
      {confirmDel ? (
        <button
          type="button"
          onClick={onDelete}
          onBlur={() => setConfirmDel(false)}
          autoFocus
          title="Bấm lần nữa để xoá card này khỏi bảng. Nhánh và ticket không bị đụng tới."
          className="rounded bg-crit px-1.5 py-px text-[10.5px] font-semibold text-white"
        >
          Xoá?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDel(true)}
          title="Xoá card khỏi bảng (không đụng nhánh / ticket)"
          className="grid size-6 place-items-center rounded text-[14px] hover:bg-crit-soft hover:text-crit"
        >
          ✕
        </button>
      )}
    </div>
  );

  // Rendered twice when the card is torn, so the two halves can rotate away
  // from each other — one element cannot turn its sides in opposite
  // directions. The right copy is inert; see `.torn-right`.
  const body = (
    <>
      {/* Header: whose codebase, and the two buttons. Everything else on the
          card is a labelled row, so the header carries only what needs no
          label at all. */}
      <div className="flex min-w-0 items-start gap-1.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
          title="Chọn để xoá hàng loạt"
          className={
            "mt-[5px] size-3 shrink-0 accent-[var(--accent)] transition-opacity " +
            (selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")
          }
        />
        {chips.map((c) => (
          <span
            key={c.repo}
            title={c.repo}
            className={
              "shrink-0 rounded-[3px] px-1.5 py-px font-mono text-[10.5px] font-bold uppercase leading-[1.45] tracking-[0.06em] " +
              c.solid
            }
          >
            {c.text}
          </span>
        ))}
        {/* Beside the platform rather than on a labelled row of its own: these
            two are what the card *is*, and a header holding only a three-letter
            chip was spending a whole line to say very little. */}
        <span className="min-w-0 flex-1 pt-px text-[12.5px] font-medium leading-tight">
          {card.title || "(chưa có tiêu đề)"}
        </span>
        {actions}
      </div>

      <CardRow label="Jira">
        {card.issueKeys.length > 0 ? (
          card.issueKeys.map((k, n) => (
            <span key={k} className="flex min-w-0 items-center gap-1">
              {n > 0 && <span className="shrink-0 text-ink-3">·</span>}
              <a
                href={jiraLinkFor(k, card.jiraUrls, baseUrl)}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={`Mở ${k} trên Jira\n${jiraLinkFor(k, card.jiraUrls, baseUrl)}`}
                className="min-w-0 truncate font-mono text-[11px] font-semibold text-accent-ink hover:underline"
              >
                {k}
              </a>
            </span>
          ))
        ) : (
          <span className="font-mono text-[11px] text-ink-3">no-ticket</span>
        )}
      </CardRow>

      {/* Only when there is one repository. With sections each names its
          own branch, and this row would repeat the first of them. */}
      {card.branch && sides.length <= 1 && (
        <CardRow label="Nhánh">
          <button
            type="button"
            onClick={copyBranch}
            title={
              "Copy nhánh: " +
              card.branch +
              (card.repo ? `\nRepo: ${card.repo}` : "") +
              (sides[0]?.branchUpdatedAt
                ? `\nCommit cuối: ${new Date(sides[0]!.branchUpdatedAt! * 1000).toLocaleDateString("vi-VN")}`
                : "")
            }
            className="flex min-w-0 items-start gap-1 text-left font-mono text-[10.5px] text-ink-3 hover:text-accent-ink"
          >
            <span className="shrink-0">{copied ? "✓" : "⑂"}</span>
            {card.githubPinned && (
              <span
                title="Link GitHub do bạn tự đặt — quét không đổi nhánh này"
                className="shrink-0 text-accent-ink"
              >
                📌
              </span>
            )}
            <span className="break-all">{card.branch}</span>
          </button>
        </CardRow>
      )}

      {/* One row per environment, its request and its build side by side.
          The environment used to be written twice — once after the build and
          again after the request — which spent most of the card's width on
          repetition and left the branch names truncated. Naming it once, on
          the left where every other row is labelled, buys back the space.

          A fix spanning two repositories gets a section each, because a card
          cannot say "merged" about a ticket whose other half is still being
          written. Builds stay outside the sections: a build is of the iOS app,
          which carries whatever SDK revision it pinned, so there is one per
          environment however many repositories the work touched. */}
      {sides.length <= 1 ? (
        <Ladder
          rows={cardLadder(sides[0]?.prs ?? [], card.builds, stages)}
          repo={card.repo}
          builds={buildsOn}
        />
      ) : (
        <>
          {sides.map((side) => (
            <Fragment key={side.repo}>
              {/* A spine down the block, in that repository's colour. It runs
                  exactly as far as the block it belongs to, which is what the
                  card's own edge could never do — a gradient split at the
                  halfway mark lines up with nothing and reads as decoration.
                  Sits in the gap between the label column and the values, so
                  nothing moves to make room for it. */}
              {/* A rule above each repository. Without it the two ladders run
                  together and "DEVELOP" appears twice with nothing saying the
                  second one belongs to a different codebase. */}
              <span className="relative flex min-w-0 flex-col gap-1">
                <span
                  aria-hidden
                  style={{ background: repoEdgeVar(repoColors[side.repo]) }}
                  className={"absolute top-[3px] bottom-0 " + SPINE_X}
                />
                <SideHead
                  label={repoLabel(side.repo, repoLabels, repos)}
                  solid={
                    repoChip(side.repo, repoLabels, repoColors, repos).solid
                  }
                  title={`${side.repo} · ${side.branch}`}
                  text={`⑂ ${side.branch}`}
                />
                <Ladder
                  rows={cardLadder(side.prs, [], stages)}
                  repo={side.repo}
                  builds={false}
                />
              </span>
            </Fragment>
          ))}
          {/* Headed, or three more environment rows after two repositories
              read as a third repository. */}
          {buildsOn && (
            <>
              <SideHead
                label="Build"
                title="Bản build là của app iOS, và nó mang theo bản SDK đã pin — nên một bản build cho cả card, không phải cho từng repo."
                text="của cả card"
              />
              <Ladder
                rows={cardLadder([], card.builds, stages)}
                repo={card.repo}
                prs={false}
              />
            </>
          )}
        </>
      )}

      {/* Rendered only when it has something in it: an empty flex child still
          consumes the card's row gap, which showed up as a stray blank line. */}
      {(card.localOnly ||
        card.localAhead > 0 ||
        card.branchGone ||
        drift ||
        landedEnv ||
        needsMoving ||
        toDelete.length > 0) && (
        <CardRow label="Lưu tâm">
          {/* First in the row, and the only badge here that is an instruction
              rather than an observation — everything else reports what
              happened, this asks for something. Crit rather than warn because
              the card is claiming to be finished while it plainly is not. */}
          {toDelete.map((side) => (
            <a
              key={side.repo + side.branch}
              href={`https://github.com/${side.repo}/branches/all?query=${encodeURIComponent(side.branch)}`}
              target="_blank"
              rel="noreferrer"
              title={
                `Card đang ở cột "${card.stage}" nhưng nhánh ${side.branch} vẫn còn trên ${side.repo}.\n` +
                `Xong thì phải xoá nhánh: để lại thì nó còn nằm trong mọi danh sách nhánh và mọi lần fetch, ` +
                `và bản thân app cũng không xác nhận được card này đã thực sự xong — cột cuối chính là "nhánh không còn nữa".\n\n` +
                `Bấm để mở danh sách nhánh trên GitHub rồi xoá ở đó. App không tự xoá gì cả.`
              }
              className="rounded-[3px] border border-crit bg-crit-soft px-1.5 py-px font-mono text-[9.5px] font-semibold text-crit hover:underline"
            >
              ⚠ xoá nhánh{" "}
              {repoChip(side.repo, repoLabels, repoColors, repos).text}
            </a>
          ))}
          {(card.localOnly || card.localAhead > 0) && (
            <span
              title={
                (card.localOnly
                  ? "Nhánh này mới chỉ có trên máy bạn — chưa push, nên GitHub không biết gì về nó và cũng chưa đo được môi trường."
                  : `${card.localAhead} commit đang nằm trên máy bạn mà server chưa có — nhớ push.`) +
                // Four clones on this machine, two of them "support" checkouts
                // kept for fast builds. Naming the branch is not enough to find
                // it again; naming the checkout is.
                (sides[0]?.localPath ? `\nClone: ${sides[0]!.localPath}` : "")
              }
              className={
                "rounded-[3px] border px-1.5 py-px font-mono text-[9.5px] font-semibold " +
                (card.localOnly
                  ? "border-warn bg-warn-soft text-warn"
                  : "border-line-strong bg-surface-2 text-ink-2")
              }
            >
              {card.localOnly ? "⇡ chưa push" : `⇡ ${card.localAhead}`}
            </span>
          )}
          {needsMoving && (
            <span
              title={
                `Bản build ${card.build}${card.buildBranch ? ` của ${card.buildBranch}` : ""} đã chứa thay đổi này — ghi chú "What to Test" của nó có nhắc ticket.\n` +
                `Nhưng ${card.statusKey} vẫn đang "${card.statusName}", nên QC không biết là có gì để test.\n\n` +
                `Bấm pill trạng thái bên dưới để chuyển. App không tự ghi vào Jira.`
              }
              className="rounded-[3px] border border-warn bg-warn-soft px-1.5 py-px font-mono text-[9.5px] font-semibold text-warn"
            >
              ⚠ đã build · {card.statusKey} chưa chờ test
            </span>
          )}
          {landedEnv && (
            <span
              title={
                `Code đã vào ${landedEnv}` +
                (landedVia
                  ? ` qua nhánh ${landedVia}, không phải trực tiếp từ nhánh này — nên commit hai bên mang SHA khác nhau. Đúng quy trình, không có gì phải sửa.`
                  : ` nhưng không phải trực tiếp từ nhánh này (nhánh resolve, squash hoặc rebase) — nên commit hai bên mang SHA khác nhau.`)
              }
              className="rounded-[3px] border border-good bg-good-soft px-1.5 py-px font-mono text-[9.5px] font-semibold text-good"
            >
              {landedVia
                ? `✓~ vào bằng ${shortVia(landedVia)}`
                : "✓~ vào gián tiếp"}
            </span>
          )}
          {card.branchGone && (
            <span
              title={
                card.localOnly
                  ? `Nhánh ${card.branch} không còn trong clone trên máy — có vẻ bạn đã xoá nó. Nhánh này chưa từng được push nên GitHub cũng không có bản nào.`
                  : `Nhánh ${card.branch} không còn trên GitHub — thường là đã release và bị xoá. Card này không cập nhật được nữa.`
              }
              className="rounded-[3px] border border-line-strong bg-surface-2 px-1.5 py-px font-mono text-[9.5px] text-ink-3"
            >
              nhánh đã xoá
            </span>
          )}
          {drifts.map((d) => (
            <span
              key={d.label}
              title={d.detail}
              className="rounded-[3px] border border-warn bg-warn-soft px-1.5 py-px font-mono text-[9.5px] font-semibold text-warn"
            >
              ⚠ {d.label}
            </span>
          ))}
        </CardRow>
      )}

      {items.length > 0 && (
        <CardRow label="Lưu ý">
          {/* An unticked note is the one thing on a card nobody else wrote —
              it is there precisely because it would otherwise be forgotten, so
              it gets a block of its own: full-strength ink, a rule down the
              left, a tint behind it. Ticked ones drop back to grey and struck
              through, so a card whose list is done goes quiet again instead of
              shouting the same colour for ever. Accent rather than warn: this
              is the user's own note, not a fault the board found — olive, the one
              hue the palette had left, so it collides with none of them. The ⚠
              badge above already owns amber, and every other colour on the card
              is a repository, a request, a build or a Jira status. */}
          <ul className="flex w-full min-w-0 flex-col gap-[3px]">
            {items.slice(0, 5).map((it, i) => (
              <li
                key={i}
                className={
                  "flex min-w-0 items-start gap-1.5 leading-snug " +
                  (it.done
                    ? "text-[11.5px]"
                    : "rounded-[3px] border-l-2 border-note bg-note-soft px-1.5 py-[3px] text-[12px]")
                }
              >
                <input
                  type="checkbox"
                  checked={it.done}
                  draggable={false}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => {
                    const next = items.map((x, n) =>
                      n === i ? { ...x, done: !x.done } : x,
                    );
                    setItems(next);
                    void updateNoteBodyAction(card.id, serializeNotes(next));
                  }}
                  className="mt-[3px] size-[11px] shrink-0 accent-[var(--accent)]"
                />
                <span
                  className={
                    "min-w-0 " +
                    (it.done
                      ? "text-ink-3 line-through"
                      : "font-medium text-ink")
                  }
                >
                  {it.text}
                </span>
              </li>
            ))}
            {items.length > 5 && (
              <li className="pl-[15px] text-[11px] text-ink-3">
                +{items.length - 5} mục nữa…
              </li>
            )}
          </ul>
        </CardRow>
      )}

      {/* One row per ticket, not one for the card. A card covering two tickets
          used to show a single control bound to its primary key, so "which of
          these two is still on the feature branch" had no answer on screen and
          the control moved whichever ticket happened to be first. No note
          counter beside them: the checklist is right above. */}
      {card.statuses.length > 0 && (
        <div className="mt-px flex flex-col gap-1 border-t border-line pt-1">
          {card.statuses.map((st) => (
            <span key={st.key} className="flex min-w-0 items-center gap-1.5">
              {(card.statuses.length > 1 || st.real !== st.key) && (
                <span
                  title={
                    st.real === st.key
                      ? undefined
                      : `Card ghi ${st.key}, nhưng link Jira ghim trỏ sang ${st.real} — trạng thái và nút chuyển bên cạnh đều là của ${st.real}.`
                  }
                  className="w-[50px] shrink-0 truncate font-mono text-[9.5px] font-semibold text-accent-ink"
                >
                  {/* The ticket the pill will actually move, not the one the
                      card is filed under. A card cloned into the next sprint
                      keeps its old key and pins the clone's link, so those two
                      are different tickets — and the one worth printing beside
                      a control is the one the control writes to. */}
                  {st.real}
                </span>
              )}
              {st.name ? (
                <StatusPill
                  issueKey={st.real}
                  statusName={st.name}
                  compact
                  onChanged={(name) => onStatusChanged(st.key, name)}
                />
              ) : (
                jiraLive && (
                  <span
                    title={
                      jiraError
                        ? `Không gọi được Jira: ${jiraError}\n\nĐây là lỗi kết nối, không phải câu trả lời — app chưa biết gì về ${st.key}. Trạng thái quay lại ngay khi gọi được; bấm "Thử lại Jira" ở thanh trên để hỏi luôn.`
                        : offSite[st.key]
                          ? `Link Jira bạn ghim cho ${st.key} trỏ sang ${offSite[st.key]}, khác site đang cấu hình. App chỉ có credential cho một site nên không đọc được trạng thái, và vì thế cũng không cảnh báo được khi ticket tụt lại sau bản build.`
                          : `Jira không trả về ticket ${st.key} — key không có trong project đang cấu hình, hoặc tài khoản này không được xem. App vì thế không biết trạng thái của nó và không cảnh báo được.`
                    }
                    className={
                      "rounded-[4px] border border-dashed px-[6px] py-[3px] font-mono text-[9.5px] " +
                      (jiraError
                        ? "border-warn text-warn"
                        : "border-line-strong text-ink-3")
                    }
                  >
                    {/* A connection failure is not an answer. Saying "Jira
                        không thấy" when the call never landed asserts something
                        about the customer's Jira that the board cannot know,
                        and sends the reader to check a ticket key when the
                        thing to check is the VPN. */}
                    {st.key} ·{" "}
                    {jiraError
                      ? "chưa gọi được Jira"
                      : offSite[st.key]
                        ? "Jira khác site"
                        : "Jira không thấy"}
                  </span>
                )
              )}
            </span>
          ))}
        </div>
      )}
    </>
  );

  if (card.branchGone) {
    return (
      <div className="torn-shell">
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className={cardCls + " torn-half torn-left"}
        >
          {body}
        </div>
        <div aria-hidden className={cardCls + " torn-half torn-right"}>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cardCls}
    >
      {body}
    </div>
  );
}

/**
 * Notes as a checklist rather than a paragraph.
 *
 * One row per thing to remember, each addable and tickable on its own. A
 * textarea invited writing a wall and re-reading it in full; a list shrinks as
 * work lands, which is the only reason to keep looking at it.
 */
/**
 * The notes checklist, shared with the popover on the task board.
 *
 * Exported because that popover had grown its own copy, and the copy still had
 * the fault this one was rewritten to fix: it derived its rows from
 * `serializeNotes` output, which drops blank rows, so adding one did nothing.
 */
export function NotesEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  /**
   * The rows as edited, which is not the same as the notes as stored.
   *
   * A blank row is a normal state while typing, but `serializeNotes` drops
   * blanks — so deriving the rows from the serialized string, as this did,
   * meant adding one produced the same string back and the row never appeared.
   * "+ Thêm mục" looked dead, and so did Enter.
   */
  const [items, setItems] = useState<NoteItem[]>(() => parseNotes(value));

  /**
   * The last string this component put out.
   *
   * The parent echoes it straight back as `value`, and resyncing on that echo
   * would delete the blank row again. Only a value from somewhere else — a
   * different card, a reset form — reloads the rows.
   */
  const [emitted, setEmitted] = useState(value);
  if (value !== emitted) {
    setEmitted(value);
    setItems(parseNotes(value));
  }

  const write = (next: NoteItem[]) => {
    setItems(next);
    const text = serializeNotes(next);
    setEmitted(text);
    onChange(text);
  };
  const patch = (i: number, p: Partial<NoteItem>) =>
    write(items.map((x, n) => (n === i ? { ...x, ...p } : x)));

  return (
    <div className="mt-1 flex flex-col gap-1">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={it.done}
            onChange={() => patch(i, { done: !it.done })}
            title={it.done ? "Bỏ đánh dấu" : "Đánh dấu xong"}
            className="size-3.5 shrink-0 accent-[var(--accent)]"
          />
          <input
            value={it.text}
            onChange={(e) => patch(i, { text: e.target.value })}
            onKeyDown={(e) => {
              // Enter adds the next one, so a list can be typed without ever
              // reaching for the mouse.
              if (e.key === "Enter") {
                e.preventDefault();
                write([
                  ...items.slice(0, i + 1),
                  { done: false, text: "" },
                  ...items.slice(i + 1),
                ]);
              }
              if (e.key === "Backspace" && !it.text && items.length > 1) {
                e.preventDefault();
                write(items.filter((_, n) => n !== i));
              }
            }}
            placeholder="nhớ test lại trên iOS 16"
            className={
              "min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 text-[12.5px] " +
              (it.done ? "text-ink-3 line-through" : "")
            }
          />
          <button
            type="button"
            onClick={() => write(items.filter((_, n) => n !== i))}
            title="Bỏ mục này"
            className="grid size-6 shrink-0 place-items-center rounded text-[13px] text-ink-3 hover:bg-crit-soft hover:text-crit"
          >
            ✕
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => write([...items, { done: false, text: "" }])}
        className="self-start rounded-md border border-dashed border-line-strong px-2.5 py-1 text-[12.5px] text-ink-2 hover:border-accent hover:text-accent-ink"
      >
        + Thêm mục
      </button>
    </div>
  );
}

// ── editor ───────────────────────────────────────────────────────────────────

interface Draft {
  id?: number;
  issueKey: string;
  issueKeys: string[];
  title: string;
  branch: string;
  stage: string;
  body: string;
  jiraUrls: Record<string, string>;
  build: string;
  buildBranch: string;
  buildAt: number;
  builds: CardBuild[];
  /** What the last scan found, shown beside the pins. Never sent back. */
  sides: CardSide[];
  prPins: PrPin[];
  branchPins: Array<{ repo: string; branch: string }>;
  /** GitHub URL as shown in the editor. Only sent when the user changed it. */
  githubLink: string;
  /** What the field started as, so an untouched field is not treated as an edit. */
  githubLinkWas: string;
  githubPinned: boolean;
}

function NoteModal({
  draft,
  stages,
  baseUrl,
  repos,
  repoLabels,
  repoColors,
  buildsOn,
  onClose,
  onSaved,
  onDelete,
}: {
  draft: Draft;
  stages: StageConfig[];
  baseUrl: string;
  repos: string[];
  repoLabels: Record<string, string>;
  repoColors: Record<string, string>;
  /** This team ships builds — see {@link Board}. */
  buildsOn: boolean;
  onClose: () => void;
  onSaved: (row: TaskNoteRow) => void;
  onDelete: (id: number) => void;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [fetching, setFetching] = useState(false);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((p) => ({ ...p, [k]: v }));

  /**
   * The key rows as edited, which is not the same as the keys as stored.
   *
   * A row being blank is a normal state while typing — the stored list drops
   * blanks, so reading the rows back from it would delete the row out from
   * under the cursor. Always at least one row, so a card with no ticket still
   * has somewhere to type.
   */
  const keyRows = d.issueKeys.length ? d.issueKeys : [d.issueKey];

  /** Writes rows back, keeping the first non-blank as the card's identity. */
  function writeKeys(rows: string[], at?: number, value?: string) {
    const next =
      at === undefined ? rows : rows.map((r, i) => (i === at ? value! : r));
    const clean = next.map((r) => r.trim().toUpperCase()).filter(Boolean);
    setD((p) => ({
      ...p,
      // Rows keep their blanks so typing is not interrupted; the stored list
      // does not.
      issueKeys:
        next.length > 1 || next[0] ? next.map((r) => r.toUpperCase()) : [],
      issueKey: clean[0] ?? "",
    }));
  }

  /**
   * One editable field per environment, plus any build stored against a branch
   * the pipeline no longer names.
   *
   * The stray rows matter: an environment renamed in settings would otherwise
   * hide a build the user typed in by hand, and saving would then delete it.
   */
  const buildFields = useMemo(() => {
    const envs = envSteps(stages);
    const known = new Set(envs.map((e) => e.branch));
    const at = (branch: string) =>
      d.builds.find((b) => b.branch === branch)?.build ?? "";
    return [
      ...envs.map((e) => ({
        branch: e.branch,
        name: e.name,
        build: at(e.branch),
      })),
      ...d.builds
        .filter((b) => !known.has(b.branch))
        .map((b) => ({
          branch: b.branch,
          name: b.branch || "(không rõ)",
          build: b.build,
        })),
    ];
  }, [stages, d.builds]);

  /**
   * The pull request the card would show for each environment, as text.
   *
   * The pin wins when there is one, otherwise the scan's answer is shown — so
   * the box reads as "this is what the card is using", and correcting it is
   * editing what you can already see rather than filling in a blank.
   */
  const prFields = useMemo(() => {
    const envs = envSteps(stages);
    // A card being created has no sides yet — they come from a scan — so it
    // falls back to the repository the picker above is on. Without this the
    // build fields appeared on a new card and the request fields did not,
    // which is the same section of the same form behaving two ways.
    const editable = d.sides.length
      ? d.sides
      : [{ repo: parseGitHubLink(d.githubLink)?.repo ?? "", prs: [] as CardPr[] }];
    return editable.flatMap((side) =>
      envs.map((e) => {
        const pin = d.prPins.find(
          (p) => p.repo === side.repo && p.base === e.branch,
        );
        const shown = side.prs.find((p) => p.base === e.branch);
        return {
          key: `${side.repo}#${e.branch}`,
          repo: side.repo,
          branch: e.branch,
          name: e.name,
          value: pin ? String(pin.number) : shown ? String(shown.number) : "",
          pinned: Boolean(pin),
          state: shown?.state ?? "",
        };
      }),
    );
  }, [stages, d.prPins, d.sides, d.githubLink]);

  /**
   * Pin a request to one environment, or clear the pin when emptied.
   *
   * Only the number is kept. State and URL are left to the next scan, which
   * asks GitHub about the number — a URL typed here would otherwise be the
   * card's only record of a request whose state nothing ever updates.
   */
  function setPrPin(repo: string, branch: string, raw: string) {
    const number = parsePrRef(raw);
    setD((p) => ({
      ...p,
      prPins: [
        ...p.prPins.filter((x) => !(x.repo === repo && x.base === branch)),
        ...(number ? [{ repo, base: branch, number }] : []),
      ],
    }));
  }

  /**
   * One row per configured repository, each with a fixed label.
   *
   * Fixed, not a picker. A dropdown on the first row and a chip on the second
   * read as two different kinds of thing, when they are the same thing — which
   * repository a branch belongs to. Which repository the card is *paired* to
   * is the GitHub link box below; that was always the field doing the work,
   * and the dropdown only wrote through to it.
   *
   * A repository dropped from Settings still shows if a side is on it, so a
   * branch cannot go missing because the list changed.
   */
  const primaryRepo = parseGitHubLink(d.githubLink)?.repo || repos[0] || "";
  const branchFields = [
    ...repos,
    ...d.sides.map((x) => x.repo).filter((r) => r && !repos.includes(r)),
  ].map((repo) => ({
    repo,
    primary: repo === primaryRepo,
    value:
      repo === primaryRepo
        ? d.branch
        : (d.branchPins.find((p) => p.repo === repo)?.branch ??
          d.sides.find((x) => x.repo === repo)?.branch ??
          ""),
    pinned: Boolean(d.sides.find((x) => x.repo === repo)?.pinned),
  }));

  /**
   * Which row owns the card's own repository and branch, and which only pins.
   *
   * A card stores one repository of its own — the first side, the one the task
   * board and the branch link read — plus pins for the rest. So one row writes
   * `branch`, and the others write branch pins.
   *
   * Which row that is used to be settled by a dropdown. With the dropdown gone
   * the rule is: the row you type into claims the card, as long as the card is
   * not already paired with a branch somewhere else. That covers both jobs the
   * dropdown had — pairing a new card, and re-pointing a mis-paired one, which
   * is now "clear the wrong row, type in the right one".
   */
  function setRowBranch(repo: string, value: string) {
    const pairedTo = parseGitHubLink(d.githubLink)?.repo ?? "";
    const claims = !pairedTo || repo === pairedTo || !d.branch.trim();
    if (!claims) return setBranchPin(repo, value);
    setD((p) => ({
      ...p,
      branch: value,
      githubLink: value
        ? `https://github.com/${repo}/tree/${value.trim()}`
        : repo,
    }));
  }

  function setBranchPin(repo: string, value: string) {
    setD((p) => ({
      ...p,
      branchPins: [
        ...p.branchPins.filter((x) => x.repo !== repo),
        ...(value.trim() ? [{ repo, branch: value }] : []),
      ],
    }));
  }

  /** Writes one environment's field back, dropping it when emptied. */
  function setBuild(branch: string, value: string) {
    setD((p) => {
      const rest = p.builds.filter((b) => b.branch !== branch);
      const was = p.builds.find((b) => b.branch === branch);
      return {
        ...p,
        builds: value.trim()
          ? [
              ...rest,
              // Keep the measured timestamp when only the number was retyped;
              // a hand-typed number gets its date from the number itself.
              { branch, build: value, at: was?.build === value ? was.at : 0 },
            ]
          : rest,
      };
    });
  }

  /** Pulls the summary off Jira so the title does not have to be retyped. */
  async function pullFromJira() {
    const key = d.issueKey.trim();
    if (!key) return;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(`/api/jira/issue?key=${encodeURIComponent(key)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Không lấy được issue");
      setD((p) => ({ ...p, title: body.summary ?? p.title }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lấy được issue");
    } finally {
      setFetching(false);
    }
  }

  function save() {
    startTransition(async () => {
      // `prs` is GitHub's answer, shown for reference; only the pins go back.
      const { githubLink, githubLinkWas, githubPinned, sides: _sides, ...rest } = d;
      void _sides;
      const res = await saveNoteAction(
        githubLink.trim() === githubLinkWas.trim()
          ? rest
          : { ...rest, githubLink },
      );
      if (res.ok && res.row) onSaved(res.row);
      else setError(res.message);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-8 w-full max-w-[560px] rounded-[10px] border border-line bg-surface p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">
            {d.id ? "Sửa card" : "Card mới"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[18px] text-ink-3 hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className={CTITLE}>Issue key</span>
              {/* One field per ticket rather than one comma-separated line.
                  The commas were a format to remember, and they made the first
                  key — the card's identity — indistinguishable from the rest.
                  Same shape as the checklist below: a row each, ✕ to drop one,
                  a button to add. */}
              <div className="mt-1 flex flex-col gap-1.5">
                {keyRows.map((k, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      value={k}
                      onChange={(e) => writeKeys(keyRows, i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const next = [...keyRows];
                          next.splice(i + 1, 0, "");
                          writeKeys(next);
                        }
                        if (e.key === "Backspace" && !k && keyRows.length > 1) {
                          e.preventDefault();
                          writeKeys(keyRows.filter((_, n) => n !== i));
                        }
                      }}
                      placeholder={
                        i === 0 ? "VT-412" : "ticket nữa của cùng PR"
                      }
                      className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12.5px]"
                    />
                    {i === 0 ? (
                      // The first key is the card's identity, so it has no
                      // remove button — but it keeps the column, otherwise
                      // every row below it sits a button-width to the left.
                      <span aria-hidden className="w-[42px] shrink-0" />
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          writeKeys(keyRows.filter((_, n) => n !== i))
                        }
                        title="Bỏ ticket này khỏi card"
                        className="grid h-6 w-[42px] shrink-0 place-items-center rounded text-[13px] text-ink-3 hover:bg-crit-soft hover:text-crit"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => writeKeys([...keyRows, ""])}
                  className="self-start rounded-md border border-dashed border-line-strong px-2.5 py-1 text-[12.5px] text-ink-2 hover:border-accent hover:text-accent-ink"
                >
                  + Thêm ticket
                </button>
              </div>
            </label>
            <button
              type="button"
              onClick={pullFromJira}
              disabled={!d.issueKey.trim() || fetching}
              title="Lấy tiêu đề từ Jira"
              // `self-start` because the key list beside it grows a row at a
              // time and the button was stretching to match, ending up a tall
              // empty box with its label stranded at the top.
              className={
                BTN + " mt-[22px] shrink-0 self-start disabled:opacity-50"
              }
            >
              {fetching ? "…" : "Lấy từ Jira"}
            </button>
          </div>

          {/* One row per key rather than one field for the card: the two
              tickets a branch fixes are as likely as not to live in different
              projects, and a single link could only ever be right about the
              first of them. The rows follow the key field above, so adding a
              key adds its link. */}
          <div>
            <span className={CTITLE}>Link Jira</span>
            <div className="mt-1 flex flex-col gap-1.5">
              {[...new Set(keyRows.map((k) => k.trim()).filter(Boolean))].map(
                (k) => (
                  <label key={k} className="flex items-center gap-2">
                    <span className="w-[72px] shrink-0 truncate font-mono text-[11.5px] font-semibold text-accent-ink">
                      {k}
                    </span>
                    <input
                      value={d.jiraUrls[k] ?? ""}
                      onChange={(e) =>
                        setD((p) => ({
                          ...p,
                          jiraUrls: { ...p.jiraUrls, [k]: e.target.value },
                        }))
                      }
                      placeholder={
                        baseUrl
                          ? `${baseUrl}/browse/${k}`
                          : "https://…/browse/" + k
                      }
                      className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </label>
                ),
              )}
              {!keyRows.some((k) => k.trim()) && (
                <span className="text-[11.5px] text-ink-3">
                  Nhập issue key ở trên để thêm link.
                </span>
              )}
            </div>
            <span className="mt-1 block text-[11.5px] text-ink-3">
              Bỏ trống thì app tự dựng từ issue key. Điền vào khi key thuộc
              project khác, hoặc khi key không phải một key thật.
            </span>
          </div>

          <label>
            <span className={CTITLE}>Tiêu đề</span>
            <input
              value={d.title}
              onChange={(e) => set("title", e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12.5px]"
            />
          </label>
          {/* One list, not two. The repo picker and the branch box used to
              describe the first side while a separate "nhánh ở repo khác"
              section held the rest — so a card spanning two repositories
              announced one of them at the top and hid the other further down.
              Reading "which repositories is this card in" took two places. */}
          <div>
            <span className={CTITLE}>Repo &amp; nhánh</span>
            <div className="mt-1 flex flex-col gap-1.5">
              {branchFields.map((f) => (
                <div key={f.repo} className="flex items-center gap-2">
                  <span
                    title={f.repo}
                    className={
                      "w-[92px] shrink-0 truncate rounded-[3px] px-1.5 py-[5px] text-center font-mono text-[10.5px] font-bold uppercase tracking-[0.04em] " +
                      repoChip(f.repo, repoLabels, repoColors, repos).solid
                    }
                  >
                    {repoLabel(f.repo, repoLabels, repos)}
                  </span>
                  <input
                    value={f.value}
                    onChange={(e) => setRowBranch(f.repo, e.target.value)}
                    placeholder={
                      f.primary
                        ? "feature/VT-412-… — trống nếu card không ở repo này"
                        : "ctalk/bugfix/… — trống để app tự chọn"
                    }
                    className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12px]"
                  />
                  {f.primary ? (
                    <button
                      type="button"
                      onClick={() =>
                        setRowBranch(
                          f.repo,
                          suggestBranch(d.issueKey.trim(), d.title),
                        )
                      }
                      disabled={!d.issueKey.trim() && !d.title.trim()}
                      title="Dựng tên nhánh từ key + tiêu đề"
                      className={BTN + " shrink-0 disabled:opacity-50"}
                    >
                      Gợi ý
                    </button>
                  ) : (
                    <span className="w-[52px] shrink-0 font-mono text-[10px] text-ink-3">
                      {f.pinned ? "đã ghim" : ""}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <span className="mt-1 block text-[11.5px] text-ink-3">
              Một dòng cho mỗi repo đang theo dõi. App ghép theo commit mới
              nhất, mà cùng một tên nhánh có ở cả hai repo — sai thì sửa vào
              đây để <b>ghim</b>: các lần quét sau vẫn cập nhật PR và môi
              trường, nhưng không đổi nhánh nữa. Xoá trống để trả lại cho app
              tự chọn. Ghép nhầm repo thì xoá dòng sai rồi gõ vào dòng đúng.
            </span>
          </div>

          <div>
            <span className={CTITLE}>Pull request</span>
            {/* One field per environment, seeded with whatever the card is
                currently showing. The scan gets the request wrong when work
                lands through a resolve branch — GitHub links the merge to the
                resolve branch, so the feature branch's own requests contain
                only the abandoned first attempt. Typing the right number here
                pins it, and later scans keep the number while still refreshing
                whether it is open or merged. */}
            <div className="mt-1 flex flex-col gap-1">
              {prFields.map((f) => (
                <label key={f.key} className="flex items-center gap-2">
                  <span
                    title={`${f.repo} · ${f.branch}`}
                    className="w-[104px] shrink-0 truncate text-right font-mono text-[11px] text-ink-3"
                  >
                    {d.sides.length > 1
                      ? `${repoLabel(f.repo, repoLabels, repos)} ${f.name}`
                      : f.name}
                  </span>
                  <input
                    value={f.value}
                    onChange={(e) => setPrPin(f.repo, f.branch, e.target.value)}
                    placeholder="1322, #1322 hoặc dán URL — trống nếu để app tự chọn"
                    className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12px]"
                  />
                  <span className="w-[62px] shrink-0 font-mono text-[10px] text-ink-3">
                    {f.pinned ? "đã ghim" : f.state.toLowerCase()}
                  </span>
                </label>
              ))}
            </div>
            <span className="mt-1 block text-[11.5px] text-ink-3">
              App tự chọn pull request từ chính nhánh của card. Khi việc vào
              bằng nhánh <b>resolve</b>, GitHub gắn bản merge cho nhánh resolve
              nên app chỉ thấy lần thử đầu đã bị đóng — điền số đúng vào đây để
              <b> ghim</b>. Các lần quét sau giữ nguyên số, chỉ cập nhật trạng
              thái. Xoá trống để bỏ ghim.
            </span>
          </div>

          {buildsOn && (
          <div>
            <span className={CTITLE}>Bản build</span>
            {/* One field per environment: the work ships to each of them
                separately, so one box could only ever hold the latest and
                would quietly drop the rest. */}
            <div className="mt-1 flex flex-col gap-1">
              {buildFields.map((f) => (
                <label key={f.branch} className="flex items-center gap-2">
                  <span
                    title={f.branch}
                    className="w-[104px] shrink-0 truncate text-right font-mono text-[11px] text-ink-3"
                  >
                    {f.name}
                  </span>
                  <input
                    value={f.build}
                    onChange={(e) => setBuild(f.branch, e.target.value)}
                    placeholder="20260904113038 — trống nếu chưa ra bản nào"
                    className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12px]"
                  />
                </label>
              ))}
            </div>
            <span className="mt-1 block text-[11.5px] text-ink-3">
              App tự điền khi ghi chú &ldquo;What to Test&rdquo; của bản build
              có nhắc tới ticket của card. Bản nào ra mà quên ghi chú thì điền
              tay vào đây — app chỉ ghi đè khi tìm được bản <b>mới hơn</b> của
              cùng môi trường đó.
            </span>
          </div>
          )}

          <label>
            <span className={CTITLE}>Cột</span>
            <select
              value={d.stage}
              onChange={(e) => set("stage", e.target.value)}
              className="mt-1 w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12.5px]"
            >
              {stages.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className={CTITLE}>Lưu ý · checklist</span>
            <NotesEditor value={d.body} onChange={(v) => set("body", v)} />
          </div>

          {error && <p className="text-[12px] text-crit">{error}</p>}

          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className={BTN_PRI}
            >
              {pending ? "Đang lưu…" : "Lưu"}
            </button>
            <button type="button" onClick={onClose} className={BTN}>
              Huỷ
            </button>
            {d.id && (
              <button
                type="button"
                onClick={() => onDelete(d.id!)}
                className="ml-auto rounded-md border border-crit/40 px-2.5 py-1 text-[12.5px] text-crit hover:bg-crit-soft"
              >
                Xoá card
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── stage config ─────────────────────────────────────────────────────────────

const EXPECT_LABEL: Array<{ value: StageConfig["expects"]; label: string }> = [
  { value: "", label: "không kiểm tra" },
  { value: "prog", label: "phải đang làm" },
  { value: "test", label: "phải chờ test" },
  { value: "done", label: "phải xong" },
];

function StagesManager({ stages }: { stages: StageConfig[] }) {
  const [list, setList] = useState<StageConfig[]>(
    stages.length
      ? stages
      : [{ name: "", expects: "", branch: "", phase: "nopr", reach: "queued" }],
  );
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const patch = (i: number, p: Partial<StageConfig>) =>
    setList((l) => l.map((s, n) => (n === i ? { ...s, ...p } : s)));

  const move = (i: number, d: -1 | 1) =>
    setList((l) => {
      const j = i + d;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  function save() {
    startTransition(async () => {
      const res = await saveStagesAction(list);
      setNote(res.message);
      // Cards are grouped by stage *name*, so a rename leaves existing cards
      // pointing at a column that no longer exists — the board surfaces them in
      // its "không thuộc cột nào" block rather than dropping them.
      if (res.ok) location.reload();
    });
  }

  return (
    <section className={CARD}>
      <div className={CTITLE}>Cột của bảng = đường đi của code</div>
      <p className="mt-1 max-w-prose text-[12.5px] text-ink-3">
        Một danh sách duy nhất, theo thứ tự. Mỗi cột có <b>một điều kiện</b>{" "}
        quyết định card có vào đó hay không. Cột nào điền <b>nhánh</b> thì là
        một môi trường, và điều kiện của nó hỏi về code; cột không có nhánh thì
        chỉ còn PR để dựa vào. Quét luôn lấy môi trường xa nhất trước, vì đó là
        sự thật trong repo, còn PR chỉ là ý định.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          <span className="w-[52px] shrink-0" />
          <span className="min-w-[130px] flex-1">Tên cột</span>
          <span className="min-w-[150px] flex-1">Nhánh môi trường</span>
          {/* Ô này chưa bao giờ có tiêu đề, nên nó đọc như một cái hộp không rõ
              hỏi gì — trong khi nó mới là ô quyết định chính. */}
          <span className="w-[212px] shrink-0">Card vào cột này khi</span>
          {/* Không cùng loại với ba ô bên trái, nên không được đọc như nhau:
              ba ô kia quyết định card vào cột nào, ô này chỉ bật cảnh báo. */}
          <span className="w-[128px] shrink-0 text-ink-3/70">⚠ Cảnh báo Jira</span>
          <span className="w-7 shrink-0" />
        </div>

        {list.map((s, i) => (
          <div key={i} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex w-[52px] shrink-0 items-center gap-px">
              <span className="w-4 text-center font-mono text-[11px] text-ink-3">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Lên trước"
                className="grid size-[18px] place-items-center rounded text-[10px] text-ink-3 hover:bg-surface-2 disabled:opacity-25"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === list.length - 1}
                title="Xuống sau"
                className="grid size-[18px] place-items-center rounded text-[10px] text-ink-3 hover:bg-surface-2 disabled:opacity-25"
              >
                ▼
              </button>
            </span>
            <input
              value={s.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              placeholder="tên cột"
              className="min-w-[130px] flex-1 rounded-md border border-line bg-ground px-2.5 py-1 text-[12.5px]"
            />
            <input
              value={s.branch}
              onChange={(e) => patch(i, { branch: e.target.value })}
              placeholder="— không phải môi trường —"
              title="Nhánh dài hạn đại diện cho môi trường này. Để trống nếu cột này nằm trước khi merge."
              className="min-w-[150px] flex-1 rounded-md border border-line bg-ground px-2.5 py-1 font-mono text-[12px]"
            />
            {/*
             * Một ô, một câu — không phải hai ô để người đọc tự nối.
             *
             * Bản trước đặt "điều kiện code" và "điều kiện PR" cạnh nhau, và ô
             * PR trên hàng môi trường luôn rỗng vì vế PR đã nằm trong ô kia.
             * Một ô rỗng thì đọc như chỗ bị bỏ quên, và không cách viết nào cứu
             * được điều đó — nên ô ấy biến mất khỏi hàng, thay bằng một link chỉ
             * hiện khi người dùng thật sự muốn chồng thêm điều kiện.
             */}
            <select
              value={
                s.reach === "gone"
                  ? "gone"
                  : s.branch.trim()
                    ? s.reach
                    : `phase:${s.phase}`
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith("phase:"))
                  patch(i, {
                    reach: "queued",
                    phase: v.slice(6) as StageConfig["phase"],
                  });
                else patch(i, { reach: v as StageConfig["reach"] });
              }}
              title="Điều kiện quyết định card có vào cột này hay không."
              className="w-[212px] shrink-0 rounded-md border border-line bg-ground px-2 py-1 text-[12px]"
            >
              {/* Cột có nhánh thì câu hỏi là code đã đi tới đâu; cột không có
                  nhánh thì chỉ còn PR để dựa vào, nên chính ô này là điều kiện
                  PR — và không có ô thứ hai nào để phải giải thích. */}
              {s.branch.trim() ? (
                <>
                  <option value="queued">có PR đang mở vào nhánh</option>
                  <option value="merged">code đã nằm trong nhánh</option>
                  <option value="built">đã có bản build</option>
                </>
              ) : (
                <>
                  <option value="phase:nopr">chưa mở PR</option>
                  <option value="phase:open">PR đang mở</option>
                  <option value="phase:">không khớp cột nào khác</option>
                </>
              )}
              <option value="gone">nhánh của card đã bị xoá</option>
            </select>

            <select
              value={s.expects}
              onChange={(e) =>
                patch(i, { expects: e.target.value as StageConfig["expects"] })
              }
              title={"Chỉ bật cảnh báo, không quyết định card vào cột nào.\nTới cột này mà Jira chưa tới trạng thái đã chọn thì card hiện cảnh báo lệch."}
              className="w-[128px] shrink-0 rounded-md border border-line bg-ground px-2 py-1 text-[12px]"
            >
              {EXPECT_LABEL.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setList((l) => l.filter((_, n) => n !== i))}
              className="w-7 shrink-0 rounded px-2 py-1 text-[13px] text-ink-3 hover:bg-crit-soft hover:text-crit"
              title="Bỏ cột"
            >
              ✕
            </button>
          </div>
          {/* Sinh từ đúng những trường engine đọc, nên không thể lệch với nó. */}
          <p className="pl-[54px] text-[11.5px] leading-snug text-ink-3">
            ↳ <span className="text-ink-2">{stageRule(s)}</span>
          </p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setList((l) => [
              ...l,
              { name: "", expects: "", branch: "", phase: "", reach: "queued" },
            ])
          }
          className={BTN}
        >
          + Cột
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className={BTN_PRI}
        >
          {pending ? "Đang lưu…" : "Lưu"}
        </button>
        {note && <span className="text-[12px] text-ink-3">{note}</span>}
        <span className="text-[11.5px] text-ink-3">
          Đổi cột xong nên chạy lại quét — card sẽ tự xếp về đúng chỗ.
        </span>
      </div>
    </section>
  );
}
