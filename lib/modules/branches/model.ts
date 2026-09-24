/**
 * Types and rules for the branches board — pure, no `server-only`, so the
 * client board and the server share them.
 *
 * The board answers one question the rest of the app cannot: *where did I leave
 * this branch*. Jira tracks the ticket, not the code — a ticket sitting in
 * "In Progress" says nothing about whether the branch is still being written,
 * waiting on review, or merged a week ago. That gap is what gets forgotten.
 */

import { statusRank, statusTone } from "@/lib/jira/types";

/**
 * One column of the board, which is also one step of the pipeline the code
 * travels along.
 *
 * These used to be three separate settings — the columns, a PR-state-to-column
 * map, and a list of environments — which meant the same ordering had to be
 * kept consistent by hand in three places. They are one list because they were
 * always describing one thing: how far the work has got.
 *
 * A step is identified by what evidence puts a card in it:
 *   - `branch` set  → an environment. The card lands here when its branch is
 *     fully contained in that branch.
 *   - `branch` empty → a pre-merge step, chosen by `phase` from the PR.
 *
 * `expects` is what makes the drift warning possible. Names are the user's own
 * and can be renamed or reordered freely, so the rule cannot key off a name —
 * each step states its own expectation instead.
 */
export interface StageConfig {
  name: string;
  /** Status the ticket should have reached by this step. '' = no expectation. */
  expects: "" | "prog" | "test" | "done";
  /** Long-lived branch this step *is*, e.g. `develop`. '' = not an environment. */
  branch: string;
  /** Which PR state lands here. Only meaningful when `branch` is empty. */
  phase: "" | "nopr" | "open";
  /**
   * For a step that names a branch, how far into that environment the work is.
   *
   * `queued` — a pull request is open against that branch. Not in it yet.
   * `merged` — the content is on the branch.
   * `built`  — a build of that branch carries it, and says so.
   *
   * `built` was tried, withdrawn, and brought back on better evidence. The
   * first version asked which branch a build came from, which App Store Connect
   * does not record — too weak a footing for a column, whose emptiness is
   * itself a claim about every card not in it. It now rests on the build's own
   * release note naming the ticket, which is a statement rather than a guess.
   *
   * `gone` is the odd one out: it names no environment, and belongs on a step
   * with an empty `branch`. It is the end of the work rather than a place the
   * code got to — the ticket is closed, and what the column is *for* is asking
   * that the branch go with it. Only one step should carry it, and it should
   * be last.
   */
  reach: "queued" | "merged" | "built" | "gone";
}

/**
 * Seeded with this team's actual pipeline: two steps before the code goes
 * anywhere, then the three branches it flows through — `ctalk/develop` is the
 * team's own environment, `develop` is where the teams meet, `staging` is last.
 */
const env = (
  name: string,
  branch: string,
  reach: StageConfig["reach"],
  expects: StageConfig["expects"],
): StageConfig => ({ name, expects, branch, phase: "", reach });

export const DEFAULT_STAGES: StageConfig[] = [
  {
    name: "đang code",
    expects: "prog",
    branch: "",
    phase: "nopr",
    reach: "queued",
  },
  {
    name: "review",
    expects: "prog",
    branch: "",
    phase: "open",
    reach: "queued",
  },

  // Merging is not shipping: until a build carries it, nobody can test it —
  // and that is true of every environment, not just the first. So each
  // environment's build column is the only one that asks for a test status,
  // and the two before it ask for no more than "đang làm". Demanding it at the
  // merge would warn about a ticket behaving exactly as it should.
  env("develop", "ctalk/develop", "queued", "prog"),
  env("đã merge develop", "ctalk/develop", "merged", "prog"),
  env("đã build develop", "ctalk/develop", "built", "test"),

  env("integration", "develop", "queued", "prog"),
  env("đã merge integration", "develop", "merged", "prog"),
  env("đã build integration", "develop", "built", "test"),

  env("staging", "staging", "queued", "prog"),
  env("đã merge staging", "staging", "merged", "prog"),
  env("đã build staging", "staging", "built", "done"),

  // The end of the line. Without it the last build column holds two different
  // kinds of card — work QC is still testing, and work closed months ago — and
  // a column that means two things cannot be read at a glance.
  //
  // A card arrives when Jira closes every ticket it names, which is the one
  // event that genuinely ends a piece of work; the branch is what the column
  // then asks for, loudly, until it is gone. See {@link branchesToDelete}.
  { name: "done", expects: "done", branch: "", phase: "", reach: "gone" },
];

/**
 * What a column actually asks, as one sentence of plain Vietnamese.
 *
 * The editor shows three controls per row and none of them says what the row
 * *does*; worse, two of them decide where a card lands and the third only
 * raises a warning, which nothing on screen distinguishes. Rather than ask the
 * reader to hold the rules in their head, the row says its own rule out loud —
 * generated from the same fields the engine reads, so it cannot drift from it.
 *
 * Placement only. `expects` is deliberately left out: it never moves a card.
 */
export function stageRule(stage: StageConfig): string {
  const b = stage.branch.trim();
  if (stage.reach === "gone")
    return "nhánh của card đã bị xoá khỏi mọi repo";

  if (!b) {
    if (stage.phase === "open") return "PR đang mở";
    if (stage.phase === "nopr")
      return "chưa mở PR — hoặc PR còn draft, hoặc đã đóng";
    return "không khớp điều kiện của cột nào khác";
  }

  // `queued` already means "an open request aimed here", so naming the branch
  // is the whole of it — see the `queued` set in `stageFor`.
  const main =
    stage.reach === "built"
      ? `đã có bản build của ${b} mang code này`
      : stage.reach === "merged"
        ? `code đã nằm trong ${b}`
        : `có PR đang mở nhắm vào ${b}`;

  if (stage.phase === "open") return `${main}, và PR đang mở`;
  if (stage.phase === "nopr") return `${main}, và chưa mở PR`;
  return main;
}

/** Nhánh đã lấy bản mới của môi trường về chưa, đọc thành một câu. */
export interface BaseFreshness {
  /** `null` khi chưa đo được — khác hẳn với "đã up to date". */
  upToDate: boolean | null;
  /** Gốc chung già bao nhiêu ngày; `null` khi chưa đo được. */
  days: number | null;
  text: string;
}

/**
 * Nhánh đang dựng trên bản môi trường của bao giờ.
 *
 * Trả lời đúng câu hỏi "đã up to date chưa" bằng `behind === 0` — một sự thật
 * nhị phân, không cần ngưỡng nào cả.
 *
 * So với `master`, nên số commit tụt lại mới đọc được: đo trên repo này ra 0,
 * 11, 62, 174. Cùng những nhánh ấy so với môi trường `ctalk/develop` ra 127,
 * 137, 301, 501 — môi trường nhận hàng trăm commit một tuần nên con số ở đó vô
 * nghĩa, và còn nói ngược: nhánh mới tách một ngày tụt 127, nhánh ngâm 145
 * ngày chỉ tụt 301.
 *
 * Tuổi của gốc vẫn đứng trước, vì đó là thứ nói ngay "nhánh này cũ tới mức
 * nào" mà không cần biết repo chạy nhanh hay chậm.
 *
 * Không tô màu theo ngưỡng "bao nhiêu ngày là cũ": ba nhánh không đủ để rút ra
 * một con số, và bịa ra một con số rồi trình bày như đã đo là chuyện khác hẳn.
 */
export function baseFreshness(
  side: { baseAt?: number | null; behind?: number | null; baseBranch?: string },
  now = Math.floor(Date.now() / 1000),
): BaseFreshness {
  const env = side.baseBranch ?? "";
  if (!env || side.behind === null || side.behind === undefined || !side.baseAt)
    return { upToDate: null, days: null, text: "" };

  if (side.behind === 0)
    return { upToDate: true, days: 0, text: `đã có bản mới nhất của ${env}` };

  const days = Math.max(0, Math.floor((now - side.baseAt) / 86400));
  const age =
    days === 0 ? "hôm nay" : days === 1 ? "hôm qua" : `${days} ngày trước`;
  return {
    upToDate: false,
    days,
    text: `dựng trên ${env} của ${age} · tụt ${side.behind} commit`,
  };
}

/**
 * The steps a containment check can answer — one per environment.
 *
 * Only the `merged` half: both halves name the same branch, and letting both
 * through would draw every environment twice on the ladder and measure it
 * twice on every scan.
 */
export function envSteps(stages: StageConfig[]): StageConfig[] {
  const out: StageConfig[] = [];
  const seen = new Set<string>();
  for (const s of stages) {
    if (!s.branch || s.reach !== "merged" || seen.has(s.branch)) continue;
    seen.add(s.branch);
    // Named after the column the user calls that environment — `develop`, not
    // `đã merge develop`. The ladder is a joined strip that cannot wrap without
    // breaking its rounded ends, and three column names that long overflowed
    // the card. The environment and the column meaning "the code got there" are
    // two names for one place, and the shorter one is the environment's.
    const label = stages.find(
      (o) => o.branch === s.branch && o.reach === "queued",
    )?.name;
    out.push(label ? { ...s, name: label } : s);
  }
  return out;
}

/**
 * One pull request as a card keeps it.
 *
 * A branch reaches three environments through three separate requests — into
 * `ctalk/develop`, then into `develop`, then into `staging` — and a card used
 * to remember only one, so the earlier links were simply gone from the board.
 * `state` is the single word `prStateTag` writes, DRAFT folded in with
 * GitHub's three.
 *
 * Declared here rather than beside the functions that build it: the card shape
 * below names it, and `github-model` already imports this file.
 */
export interface CardPr {
  number: number;
  url: string;
  state: string;
  /** Branch it is aimed at. '' when GitHub reported none. */
  base: string;
  /**
   * The user named this request for this branch; a scan must not replace it.
   *
   * Needed because GitHub's own answer is sometimes the wrong one. This team
   * lands work through a resolve branch, so the request that actually carried
   * it has a different head and is not among the feature branch's requests at
   * all — the scan picks the abandoned first attempt instead. Pinning says
   * "for this environment it was that request", and only the number is pinned:
   * the state still tracks whatever GitHub says about it.
   */
  pinned?: boolean;
}

/**
 * A build of one environment, as a card keeps it.
 *
 * Keyed by environment branch rather than by build number: the question a card
 * answers is "has this shipped to integration yet", and two builds of the same
 * environment are the same answer with a newer number.
 */
export interface CardBuild {
  /** Environment branch. '' when typed by hand for an environment not named. */
  branch: string;
  /** Build number as App Store Connect shows it. */
  build: string;
  /** When the build's contents were frozen, epoch seconds. 0 when hand-typed. */
  at: number;
}

/**
 * Sides in the order they should be *read*, which is not the order they are
 * stored in.
 *
 * Stored order is slowest-first, because the first side decides the card's
 * column and fills the flat columns everything outside this board still reads.
 * That order flips from card to card — iOS ahead here, the SDK ahead there —
 * and a header whose chips reorder themselves is a header nobody can scan.
 *
 * Read order is the order the repositories are configured in Settings, so it
 * is fixed across the whole board and the user owns it. A repository no longer
 * configured sorts last rather than vanishing.
 */
export function orderSides<T extends { repo: string }>(
  sides: T[],
  repos: string[],
): T[] {
  const rank = (repo: string) => {
    const i = repos.indexOf(repo);
    return i < 0 ? repos.length : i;
  };
  return [...sides].sort((a, b) => rank(a.repo) - rank(b.repo));
}

/** One environment's line on a card: its request and its build, side by side. */
export interface LadderRow {
  /** Environment name as the columns and the editor spell it. */
  name: string;
  /** Long-lived branch it stands for. */
  branch: string;
  pr: CardPr | null;
  build: CardBuild | null;
  /**
   * False for a request aimed somewhere that is not an environment — a task
   * branch going into a feature branch. Such a row has a request but can never
   * have a build, so it must not be shown as missing one.
   */
  isEnv: boolean;
}

/**
 * The card's environment ladder: one row per environment, requests and builds
 * lined up against it.
 *
 * Built as rows rather than as two independent lists because the environment
 * is the thing being tracked, and naming it once per row instead of once per
 * value is what stops the card repeating "ctalk/develop" six times over.
 *
 * Rows are never dropped for being empty. An absent build is a fact about how
 * far the work has got, and a ladder that only listed what exists could not
 * tell "not shipped to integration" from "integration is not a thing".
 */
export function cardLadder(
  prs: CardPr[],
  builds: CardBuild[],
  stages: StageConfig[],
): LadderRow[] {
  const envs = envSteps(stages);
  const known = new Set(envs.map((e) => e.branch));
  return [
    // A feature branch comes first: that is where it happened in time.
    ...prs
      .filter((p) => !known.has(p.base))
      .sort((a, b) => a.number - b.number)
      .map((p) => ({
        name: p.base || "(không rõ)",
        branch: p.base,
        pr: p,
        build: null,
        isEnv: false,
      })),
    ...envs.map((e) => ({
      name: e.name,
      branch: e.branch,
      pr: prs.find((p) => p.base === e.branch) ?? null,
      build: builds.find((b) => b.branch === e.branch) ?? null,
      isEnv: true,
    })),
    // A build stored against a branch the pipeline no longer names: an
    // environment renamed in settings must not eat a hand-typed number.
    ...builds
      .filter((b) => !known.has(b.branch))
      .map((b) => ({
        name: b.branch || "(không rõ)",
        branch: b.branch,
        pr: null,
        build: b,
        isEnv: true,
      })),
  ];
}

/**
 * One repository's half of a card.
 *
 * A fix here often spans two repositories — the Rust SDK and the iOS app — and
 * the two halves move at their own pace: the SDK request can be merged for a
 * fortnight while the iOS side is still being written. Nine of the board's
 * fifty-one tickets are like that. A card used to hold one branch and silently
 * drop the other, which made the column a claim about whichever half happened
 * to have the newer commit.
 *
 * Builds are deliberately not here. A build is of the iOS app, which contains
 * whatever SDK revision it pinned, so there is one build per environment for
 * the whole card no matter how many repositories the work touched.
 */
export interface CardSide {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** One request per branch it targets, plus any the user pinned. */
  prs: CardPr[];
  /** JSON of env branch → commits behind. Parsed with `parseEnvState`. */
  envState: string;
  /** Head branch that carried the work in, '' when it went in under its own. */
  landedVia: string;
  branchGone: boolean;
  localAhead: number;
  localOnly: boolean;
  localPath: string;
  branchUpdatedAt: number | null;
  /**
   * Nhánh này đang dựng trên bản môi trường của lúc nào — epoch giây.
   *
   * Là ngày của **merge-base** giữa nhánh và môi trường đầu tiên, tức điểm nó
   * tách ra. `null` khi chưa đo được.
   *
   * Tuổi chứ không phải số commit, và đó là kết luận từ đo đạc chứ không phải
   * sở thích: trên repo này `VT-451` mới tách 1 ngày đã tụt 127 commit, còn
   * `scanner_suggestion` ngâm 145 ngày chỉ tụt 301. Hiện số commit thì nhánh
   * tươi trông gần bằng nhánh cổ — chỉ số đó nói ngược.
   */
  baseAt?: number | null;
  /** Số commit của nhánh gốc mà nhánh này chưa có. 0 = đã up to date. */
  behind?: number | null;
  /** Nhánh gốc đã so — `master`, hoặc nhánh mặc định của repo. */
  baseBranch?: string;
  /**
   * The user named this branch for this repository; a scan must not re-point
   * it.
   *
   * Per repository because that is where the mistake happens: the same branch
   * name lives in both repos here, and the scan pairs by newest tip. Pinning
   * used to be one flag for the whole card, which could only ever protect the
   * first repository — the second was left to whatever the scan picked, with
   * no way to correct it.
   */
  pinned?: boolean;
}

/** What a clone on this machine says about one branch. */
export interface LocalState {
  ahead: number;
  onlyLocal: boolean;
  path: string;
}

/**
 * Re-reads every side's local state from a fresh scan of the clones.
 *
 * These three fields are the only ones on a card that describe *this machine*
 * rather than GitHub, and that is exactly why they went stale: every refresh
 * path re-measured what the server said and carried the local half through
 * untouched, so a branch marked "chưa push" before it was pushed stayed marked
 * for ever — on a card that was, at the same time, showing the merged pull
 * request for it.
 *
 * A branch the scan did not find is reset, not left alone. Absent from every
 * clone means there is nothing local to report — the branch was deleted after
 * the merge, most often — and the honest answer is silence, not the last thing
 * that was true.
 *
 * Returns the same array when nothing changed, so a caller can use identity to
 * decide whether a write is needed.
 */
export function withLocalState<T extends Pick<CardSide, "repo" | "branch" | "localAhead" | "localOnly" | "localPath">>(
  sides: T[],
  index: Map<string, LocalState>,
): T[] {
  let changed = false;
  const out = sides.map((side) => {
    const now = index.get(`${side.repo}#${side.branch.trim()}`) ?? {
      ahead: 0,
      onlyLocal: false,
      path: "",
    };
    if (
      side.localAhead === now.ahead &&
      side.localOnly === now.onlyLocal &&
      side.localPath === now.path
    )
      return side;
    changed = true;
    return { ...side, localAhead: now.ahead, localOnly: now.onlyLocal, localPath: now.path };
  });
  return changed ? out : sides;
}

/** A request the user named by hand, for one environment of one repository. */
export interface PrPin {
  repo: string;
  /** Environment branch the request targets. */
  base: string;
  number: number;
}

export interface TaskNoteShape {
  /** The card's primary key — what pairing and the unique index use. */
  issueKey: string;
  /**
   * Every ticket this card covers, primary first. One branch often fixes two.
   * Always contains `issueKey` when that is set.
   */
  issueKeys: string[];
  title: string;
  branch: string;
  stage: string;
  body: string;
  /**
   * Where each ticket actually lives, when the derived link would be wrong.
   *
   * The board builds `{jiraBaseUrl}/browse/{issueKey}` by default, which breaks
   * on both shapes this board really holds: a key from a project the app is not
   * pointed at, and a hand-written key that is not a key at all
   * ("VT-365 REFS: VT-17252"). Keyed by issue key rather than being a single
   * URL because one branch fixing two tickets is normal here, and those two
   * tickets are as likely as not to sit in different projects. A key absent
   * from the map keeps the derived link.
   */
  jiraUrls: Record<string, string>;
  /**
   * The build this work shipped in.
   *
   * Editor-owned rather than scan-owned, unlike everything in {@link GitHubLink}
   * — a build that went out without its "What to Test" note leaves no record of
   * what it carried, and typing it in is the only way to recover that. A scan
   * fills it when the note does name the ticket, and only ever moves it
   * forward, so a value put here by hand is not quietly undone.
   */
  /**
   * Requests the user named by hand, one per environment.
   *
   * Only these, never the full list: which request belongs to an environment
   * is a thing a person can know better than the scan, but whether it is open
   * or merged is GitHub's to say, and a form able to write that could only
   * record a stale guess. The store layers these over the scan's answer.
   */
  prPins: PrPin[];
  /**
   * Branches the user named by hand, one per repository. Only these; which
   * requests that branch has and where its commits are stay the scan's to say.
   */
  branchPins: Array<{ repo: string; branch: string }>;
  build: string;
  /** Environment that build belongs to. '' when typed by hand for an unknown one. */
  buildBranch: string;
  /** When the build's contents were frozen — how "newer build wins" is decided. */
  buildAt: number;
  /**
   * One build per environment, which is what the work actually goes through.
   *
   * The three fields above are the newest of these, kept because a card wants
   * one build to name in a warning and one date to compare. This is the record
   * of where the work has shipped: a ticket can be in a `ctalk/develop` build
   * and an `integration` build at once, and those are different things for QC.
   */
  builds: CardBuild[];
}

/** A ticket named by a pinned link: which Jira site, and which key there. */
export interface JiraRef {
  /** Lower-cased host, e.g. `theboys2024.atlassian.net`. */
  host: string;
  key: string;
}

/**
 * The ticket a pinned link actually points at.
 *
 * The link is the authority, not the card's key. A card keyed `VT-365` whose
 * link reads `/browse/VT-17252` is about VT-17252, and asking Jira for VT-365
 * answers a different question — or, when the key belongs to another Jira site
 * entirely, no question at all.
 */
export function jiraRefFromUrl(url: string): JiraRef | null {
  const m = url
    .trim()
    .match(
      /^https?:\/\/([^/]+)\/(?:.*\/)?browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i,
    );
  if (m) return { host: m[1].toLowerCase(), key: m[2].toUpperCase() };

  // The other shape Jira hands out — a board link carrying the issue.
  const q = url
    .trim()
    .match(
      /^https?:\/\/([^/]+)\/.*[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/i,
    );
  return q ? { host: q[1].toLowerCase(), key: q[2].toUpperCase() } : null;
}

/** Host of the configured Jira, for comparing against a pinned link's. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Where to look each of a card's tickets up.
 *
 * Falls back to the card's own key on the configured site, which is what the
 * board did everywhere before links could be pinned.
 */
export function jiraLookups(
  keys: string[],
  urls: Record<string, string>,
  baseUrl: string,
): Record<string, JiraRef> {
  const home = hostOf(baseUrl);
  const out: Record<string, JiraRef> = {};
  for (const k of keys) {
    out[k] = jiraRefFromUrl(urls[k] ?? "") ?? { host: home, key: k };
  }
  return out;
}

/** The link to open for one key: the override if there is one, else derived. */
export function jiraLinkFor(
  key: string,
  urls: Record<string, string>,
  baseUrl: string,
): string {
  return urls[key]?.trim() || (baseUrl ? `${baseUrl}/browse/${key}` : "");
}

/**
 * Reads the stored map, folding in the single-URL column it replaced.
 *
 * The legacy value only ever meant the primary key, and it loses to an explicit
 * entry — otherwise clearing a link in the editor could not stick.
 */
export function parseJiraUrls(
  raw: string,
  legacy: string,
  primary: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const seed = legacy.trim();
  if (seed && primary) out[primary.trim().toUpperCase()] = seed;
  try {
    const v = JSON.parse(raw || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, url] of Object.entries(v)) {
        const key = String(k).trim().toUpperCase();
        const t = String(url).trim();
        if (!key) continue;
        if (t) out[key] = t;
        else delete out[key];
      }
    }
  } catch {
    /* keep whatever the legacy column gave */
  }
  return out;
}

/** Back to the stored form: blanks dropped, so an emptied field really clears. */
export function serializeJiraUrls(urls: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const [k, url] of Object.entries(urls)) {
    const key = k.trim().toUpperCase();
    const t = (url ?? "").trim();
    if (key && t) out[key] = t;
  }
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

/**
 * What a GitHub scan knows about a card, kept apart from {@link TaskNoteShape}
 * because the editor must never write these — they are GitHub's answer, and a
 * form that could overwrite them would only ever be recording a stale guess.
 */
export interface GitHubLink {
  /**
   * One entry per repository this fix touches, in the order they are
   * configured. Everything a scan measures lives here.
   *
   * The handful of fields below are copies of the first side's, kept only
   * because screens outside this module read them — the task board's branch
   * popover and its subtask row. Every field they do *not* read was removed:
   * the same fact stored twice, in three write paths, is a fact that can drift
   * with nothing to notice.
   */
  sides: CardSide[];
  /** `owner/name`, '' for a branch typed by hand. */
  repo: string;
  prUrl: string;
  /** JSON blob of env branch → commits behind. Parsed with `parseEnvState`. */
  envState: string;
  /**
   * The branch is gone from GitHub as of the last scan.
   *
   * Not an error state — this team deletes branches on release, so it is the
   * normal end of a branch's life and the signal that the card has nothing
   * left to track.
   */
  branchGone: boolean;
  /** The GitHub link was set by hand; a scan must not re-point the card. */
  githubPinned: boolean;
  /** Commits in the local clone the server has not seen. 0 when in sync. */
  localAhead: number;
  /** Branch exists only on this machine — nothing to look up on GitHub. */
  localOnly: boolean;
  /** The clone it was read from. Matters once there is more than one. */
  localPath: string;
  /** Last scan that wrote here. Null means this card is entirely hand-made. */
  syncedAt: number | null;
}

/**
 * A stored card. Lives here rather than in `store.ts` because client components
 * render these, and `store.ts` is `server-only` — importing a type from it would
 * work only by virtue of the type being erased, which is the kind of thing that
 * breaks the moment someone imports a value alongside it.
 */
export interface TaskNoteRow extends TaskNoteShape, GitHubLink {
  id: number;
  updatedAt: number;
}

/**
 * How far along a status is. Mirrors the tones in `lib/jira/types.ts`, which
 * derive from the status *name* because this instance reports everything
 * between To Do and Done as the same category.
 */
const TONE_RANK: Record<string, number> = {
  todo: 0,
  prog: 1,
  test: 2,
  ver: 3,
  done: 4,
};

/**
 * Threshold each expectation is satisfied at.
 *
 * `done` is satisfied by Verified as well as Done — both are terminal here, and
 * flagging a Verified ticket as behind would be noise on every shipped task.
 */
const EXPECT_RANK: Record<string, number> = { prog: 1, test: 2, done: 3 };

export interface StageDrift {
  /** Short phrase naming what is behind — the badge's text. */
  label: string;
  /** The full sentence, for the tooltip. */
  detail: string;
}

/**
 * Whether the ticket is lagging the branch, and how to say so.
 *
 * Returns null when they agree, when the stage has no expectation, or when the
 * card has no ticket to compare against. Deliberately one-directional: a ticket
 * *ahead* of its branch is normal (someone closes the ticket after deploying)
 * and warning about it would train the user to ignore the badge.
 *
 * Pure, so a card can call it while rendering.
 */
export function stageDrift(
  stage: string,
  statusName: string | null,
  statusTone: string | null,
  stages: StageConfig[],
  /**
   * The ticket that is behind. Named in the warning because a card covering two
   * tickets otherwise says only *that* something is lagging, leaving the reader
   * to guess which of the two it means.
   */
  statusKey = "",
): StageDrift | null {
  if (!statusName || !statusTone) return null;

  const step = stages.find((s) => s.name === stage);
  const expects = step?.expects;
  if (!expects || !step) return null;

  /**
   * Compared per environment, not by colour.
   *
   * `statusTone` files every "READY TO TEST ON …" together and every
   * "VERIFIED ON …" together, which is the right grain for a badge and the
   * wrong one here: a ticket verified on *develop* looked past testing while
   * its card had already reached the integration build, so the one warning
   * that mattered never appeared. `statusRank` keeps the environment, and the
   * column knows which environment it is.
   */
  const envs = envSteps(stages);
  const envNames = envs.map((e) => e.name);
  const at = envs.findIndex((e) => e.branch === step.branch);
  const need =
    expects === "done" ? 99 : expects === "test" && at >= 0 ? 2 + at * 2 : 1;
  const have = statusRank(statusName, envNames);
  if (have >= need) return null;

  const wanted =
    expects === "done"
      ? "xong"
      : expects === "test"
        ? `chờ test trên ${envNames[at] ?? "môi trường này"}`
        : "đang làm";
  const who = statusKey || "ticket";
  return {
    label: `${who} vẫn: ${statusName}`,
    detail:
      `Nhánh đã ở "${stage}" nhưng ${who} vẫn đang "${statusName}" — ` +
      `đáng lẽ phải là trạng thái ${wanted}. Bấm để chuyển.`,
  };
}

/**
 * Board order: the status you asked for first, then the workflow's own sequence.
 *
 * Never filters. Lifting a status answers "show me these first"; hiding the
 * rest answers a different question and would make the column counts lie.
 *
 * Three tiers, because a card covering two tickets is genuinely between the
 * other two cases and both simpler rules were wrong on the real board:
 *
 *  0. the card *is* at that status — its laggard matches
 *  1. one of its tickets is, but an earlier one holds it back
 *  2. it has nothing at that status
 *
 * Lifting on any ticket (tier 0 and 1 merged) put a card reading "COMMITED CODE
 * FEATURE BRANCH" above cards that really were verified. Lifting only on the
 * laggard (tier 1 and 2 merged) dropped that same card below cards with no
 * verified work at all. It belongs between them: partly there.
 *
 * Stable, so cards sharing a tier and a status keep the order they arrived in.
 */
export function sortByStatus<
  T extends {
    statusName: string | null;
    statuses: Array<{ name: string | null }>;
  },
>(cards: T[], pinned: string, rank: (status: string | null) => number): T[] {
  const tier = (c: T) => {
    if (!pinned) return 0;
    if (c.statusName === pinned) return 0;
    return c.statuses.some((s) => s.name === pinned) ? 1 : 2;
  };
  return [...cards].sort(
    (a, b) => tier(a) - tier(b) || rank(a.statusName) - rank(b.statusName),
  );
}

/**
 * A build carries this work, but its ticket has not reached a test state.
 *
 * The one thing the withdrawn "đã build" columns were for. They had to go —
 * App Store Connect records nothing about branches, so the column rested on a
 * guess — but the question they answered is real and the answer no longer is a
 * guess: the build's own release note names the ticket. So the warning is
 * driven by that record rather than by which column the card sits in.
 *
 * Only ever a warning. Moving the ticket writes to a Jira other people watch,
 * and a release note can name the wrong key or miss one; a wrong transition is
 * seen by QC before anybody notices the app made it.
 */
export function builtButNotTested(build: string, tone: string | null): boolean {
  return Boolean(build) && (tone === "todo" || tone === "prog");
}

/**
 * Whether Jira says this card is over.
 *
 * Every ticket the card names, not just the primary one: a branch fixing two
 * tickets is finished when both are, and taking the first would close a card
 * over work still open. A ticket Jira did not answer for — off-site, deleted,
 * or asked while the VPN was down — reads as not done, so a Jira that cannot
 * be reached moves nothing rather than clearing the board.
 *
 * `DONE` only. `VERIFIED ON STAGING` is the tester's verdict, not the ticket's
 * close, and this team files a fair number of tickets that are verified and
 * then reopened.
 */
export function ticketsDone(statuses: Array<string | null>): boolean {
  return (
    statuses.length > 0 &&
    statuses.every((s) => s !== null && statusTone(s) === "done")
  );
}

/**
 * The pipeline's terminal step, if it has one.
 *
 * Found by `reach` rather than by name, for the same reason every other rule
 * here avoids names: the user owns the wording and may well call it "xong" or
 * "đã release".
 *
 * `gone` alone, whatever else the column says. It used to require an empty
 * branch as well, which left `gone` on a column that names one meaning nothing
 * in particular — it fell through to "chờ merge" in `stageFor`. One reading
 * everywhere: the card's branches are deleted.
 */
export function cleanupStep(stages: StageConfig[]): StageConfig | null {
  return stages.find((s) => s.reach === "gone") ?? null;
}

/**
 * Whether the card has nothing left on GitHub — every repository it touches
 * has had its branch deleted.
 *
 * `every` over an empty list is true, so the emptiness is checked first: a
 * card with no sides at all has not been cleaned up, it has never been
 * scanned.
 */
export function branchesCleanedUp(
  sides: ReadonlyArray<{ branchGone: boolean }>,
): boolean {
  return sides.length > 0 && sides.every((s) => s.branchGone);
}

/**
 * The branches a finished card is still holding open.
 *
 * The other half of the terminal column, and the point of having one. A card
 * arrives here because its ticket was closed, which says nothing about the
 * branch — so the board asks for it, per repository, until it is gone. Two
 * reasons it is worth asking rather than letting it slide: a stale branch
 * shows up in every branch list and every `git fetch` from then on, and a
 * branch left behind on a closed ticket is the one nobody ever comes back to.
 *
 * Deliberately a list of sides rather than a boolean: a fix spanning the SDK
 * and the iOS app has two branches to delete, and "xoá nhánh đi" without
 * saying which repository is an instruction the reader has to go and decode.
 *
 * The app never deletes anything itself. It only ever reads from GitHub, and a
 * branch deletion is not the kind of write to start with.
 */
export function branchesToDelete<
  T extends { repo: string; branch: string; branchGone: boolean },
>(stage: string, sides: readonly T[], stages: StageConfig[]): T[] {
  const step = cleanupStep(stages);
  if (!step || stage !== step.name) return [];
  return sides.filter((s) => !s.branchGone && s.branch);
}


/**
 * One line of a card's notes.
 *
 * Notes are a checklist because that is what they are used for — "nhớ test lại
 * iOS 16" is a thing to do, not a thing to read — and a list you cannot tick
 * off gets re-read in full every time instead of shrinking as work lands.
 */
export interface NoteItem {
  done: boolean;
  text: string;
}

/**
 * Reads the stored body into items.
 *
 * Tolerant on input, strict on output. Anything already written as a plain
 * bullet, or as a bare line, reads back as an unticked item rather than being
 * dropped — the body is a text column that a person may well have edited by
 * hand, and losing their words to a format change would be unforgivable.
 */
export function parseNotes(body: string): NoteItem[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const bare = line.replace(/^[-*•]\s*/, "");
      const box = bare.match(/^\[([ xX])\]\s*(.*)$/);
      if (box)
        return { done: box[1].toLowerCase() === "x", text: box[2].trim() };
      return { done: false, text: bare };
    })
    .filter((i) => i.text);
}

/** Back to the stored form. Always writes checkboxes, so a round trip is stable. */
export function serializeNotes(items: NoteItem[]): string {
  return items
    .map((i) => ({ ...i, text: i.text.trim() }))
    .filter((i) => i.text)
    .map((i) => `- [${i.done ? "x" : " "}] ${i.text}`)
    .join("\n");
}

/** Ticked over total — the one number a card has room to show. */
export function noteProgress(items: NoteItem[]): {
  done: number;
  total: number;
} {
  return { done: items.filter((i) => i.done).length, total: items.length };
}

/**
 * A branch name suggested from the issue, e.g. `VT-412` + "Sửa crash khi vào
 * room" → `VT-412-sua-crash-khi-vao-room`. Only a starting point the user edits;
 * the point is to not have to type the key and the slug by hand every time.
 */
export function suggestBranch(issueKey: string, title: string): string {
  const slug = title
    .normalize("NFD")
    // Combining accents, stripped after NFD split them off their base letter.
    // `đ` has no decomposition, so it needs its own pass.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    // Bracketed tags (`[CTALK][spt 69]`) are filing metadata, not a description.
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return [issueKey, slug].filter(Boolean).join("-");
}

/** Reads the stored JSON list, falling back to the primary key alone. */
export function parseIssueKeys(raw: string, primary: string): string[] {
  const out: string[] = [];
  try {
    const v = JSON.parse(raw || "[]");
    if (Array.isArray(v))
      for (const k of v) {
        const t = String(k).trim().toUpperCase();
        if (t && !out.includes(t)) out.push(t);
      }
  } catch {
    /* fall through to the primary key */
  }
  const p = primary.trim().toUpperCase();
  if (p && !out.includes(p)) out.unshift(p);
  return out;
}
