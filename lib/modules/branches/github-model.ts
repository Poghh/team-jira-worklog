import {
  type CardBuild,
  type CardPr,
  type CardSide,
  type StageConfig,
  branchesCleanedUp,
  cleanupStep,
  envSteps,
} from "./model";

/**
 * GitHub side of the branches board — pure types and rules, no `server-only`,
 * so the scanner and the UI that reviews its plan share one definition.
 *
 * The board's weak point is that it only knows what was typed into it. Branch
 * names already exist on GitHub and already carry the Jira key by convention
 * (`task/vtl-560-pin-messages`), so the thing most likely to be forgotten is
 * the thing most easily read from somewhere else.
 */

export interface PullRequest {
  number: number;
  url: string;
  /** GitHub's own vocabulary: OPEN | CLOSED | MERGED. */
  state: string;
  isDraft: boolean;
  /** Branch it is aimed at — what tells "queued for an environment" apart. */
  baseRefName?: string;
}

/**
 * Which of a branch's pull requests to show.
 *
 * A branch here routinely has several: one closed after review, another opened
 * against a different base, a third that actually merged. Taking whichever
 * GitHub returns first is wrong — `associatedPullRequests` does not honour
 * `orderBy`, and it handed back `#341 CLOSED` ahead of `#348 OPEN` on a live
 * branch, so cards showed a rejected PR while the work sat merged.
 *
 * Ranked by what a reader needs: an open request is the live thing, a merge is
 * the outcome, a draft is not ready, a closed one is the least informative.
 * `prefer` wins outright — that is a pull request the user pinned by hand.
 */
const PR_RANK = (pr: PullRequest): number => {
  if (pr.state === "OPEN" && !pr.isDraft) return 4;
  if (pr.state === "MERGED") return 3;
  if (pr.state === "OPEN") return 2;
  return 1;
};

export function pickPr(
  prs: PullRequest[],
  prefer?: number | null,
): PullRequest | null {
  if (!prs.length) return null;
  if (prefer) {
    const hit = prs.find((p) => p.number === prefer);
    if (hit) return hit;
  }
  // Highest number breaks ties: pull requests are numbered in creation order,
  // so the later one is the more recent attempt.
  return [...prs].sort(
    (a, b) => PR_RANK(b) - PR_RANK(a) || b.number - a.number,
  )[0];
}

/** One branch as GitHub reports it. */
export interface RemoteBranch {
  /** `owner/name`. */
  repo: string;
  name: string;
  /** Tip commit time, epoch seconds. */
  committedAt: number;
  /** Tip commit author's login. '' when GitHub cannot map the commit email. */
  login: string;
  email: string;
  /** Every pull request GitHub links to this branch. */
  prs: PullRequest[];
  /** The one worth showing, by {@link pickPr}. */
  pr: PullRequest | null;
  /**
   * What the clone on this machine says, when there is one. Absent means the
   * branch was only ever seen on the server.
   */
  local?: { ahead: number; onlyLocal: boolean; path: string };
}

/**
 * Who counts as me.
 *
 * One box, after two others were removed for not earning their place.
 *
 * A commit email rule went first. It only ever mattered when GitHub could not
 * resolve the author's email to an account, and measured against the 204
 * branches actually being scanned it claimed **nothing**: every branch of the
 * user's carried a `login`, and no branch anywhere carried their email. The 47
 * branches with no `login` all belong to other people committing from machines
 * with an unset `user.email`.
 *
 * A branch-name prefix rule went too: a prefix is a naming habit, not evidence
 * of authorship, and it claimed every branch under `hir/` including the ones
 * somebody else opened.
 *
 * What covers the case both were there for — a branch you pushed whose last
 * commit is not yours — is the event feed, and it covers it with a fact rather
 * than a resemblance.
 */
export interface Identity {
  logins: string[];
}

/** Which rule claimed this branch — shown so the list is auditable. */
export type MineBy = "push" | "login" | null;

/**
 * Whether this branch is the user's, and on what evidence.
 *
 * `pushed` is checked first because it is the only direct answer: it comes from
 * the user's own event feed, so it means "I created or pushed this", not "the
 * last commit happens to carry my name". The author rules stay behind it to
 * cover work older than the feed reaches.
 */
export function mineBy(
  branch: RemoteBranch,
  me: Identity,
  pushed?: Set<string>,
): MineBy {
  const lower = (s: string) => s.trim().toLowerCase();
  if (pushed?.has(`${branch.repo}#${branch.name}`)) return "push";
  if (branch.login && me.logins.some((l) => lower(l) === lower(branch.login)))
    return "login";
  return null;
}

/**
 * Re-exported, not defined here.
 *
 * It moved to `lib/jira/branch-keys.ts` when the SDK release module turned out
 * to need it too: importing it across a module boundary made that module
 * unbuildable without this one. Kept exported from here so this module's own
 * call sites read the same as they always did.
 */
export { extractIssueKeys } from "@/lib/jira/branch-keys";

/**
 * The Jira key a branch names, uppercased — `task/vtl-560-pin` → `VTL-560`.
 *
 * Matching is restricted to project keys the user has listed rather than to a
 * general `LETTERS-DIGITS` shape, because that shape is far too common in
 * branch names to guess at: `feature/release-2026-08-31` would yield the key
 * "RELEASE-2026" and quietly create a card for a ticket that does not exist.
 * {@link candidateProjectKeys} exists to make listing them a one-click job.
 */
export function extractIssueKey(branch: string, projectKeys: string[]): string {
  for (const raw of projectKeys) {
    const key = raw.trim();
    if (!key) continue;
    // Bounded on both sides so `VT` does not match inside `VTL-560`, and the
    // digits are not clipped short by a following `-`.
    const m = branch.match(
      new RegExp(`(?:^|[^a-z0-9])(${escapeRe(key)})[-_]?(\\d+)(?![0-9])`, "i"),
    );
    if (m) return `${key.toUpperCase()}-${m[2]}`;
  }
  return "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words that take the `WORD-123` shape in branch names without being tickets. */
const NOT_A_PROJECT = new Set([
  "release",
  "feature",
  "task",
  "fix",
  "hotfix",
  "bugfix",
  "chore",
  "refactor",
  "test",
  "tests",
  "build",
  "ci",
  "docs",
  "doc",
  "wip",
  "tmp",
  "temp",
  "dev",
  "develop",
  "main",
  "master",
  "staging",
  "prod",
  "v",
  "version",
  "rc",
  "beta",
  "alpha",
  "sprint",
  "week",
  "day",
  "part",
  "step",
  "phase",
  "ios",
  "android",
]);

/**
 * Project keys that plausibly appear in these branch names, most used first.
 *
 * Feeds the "detect" button on the config screen, so a false positive costs
 * nothing — the user picks from the list. Anything looking like a date is
 * dropped, since `release-2026-08-31` is the single most common false hit.
 */
export function candidateProjectKeys(
  branches: string[],
): Array<{ key: string; count: number }> {
  const seen = new Map<string, number>();
  for (const b of branches) {
    for (const m of b.matchAll(
      /(?:^|[^a-z0-9])([a-z]{2,10})[-_](\d{1,6})(?![0-9])/gi,
    )) {
      const key = m[1].toUpperCase();
      if (NOT_A_PROJECT.has(key.toLowerCase())) continue;
      // A four-digit number in 19xx/20xx is a year, not an issue number.
      if (/^(19|20)\d{2}$/.test(m[2])) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * What a PR says about the branch, collapsed to the three states that change
 * where a card belongs.
 *
 * A closed-but-unmerged PR reports `none`: the branch is back to being open
 * work, and advancing a card because its PR was rejected would be backwards.
 */
export type PrPhase = "none" | "open" | "merged";

export function prPhase(pr: PullRequest | null): PrPhase {
  if (!pr) return "none";
  if (pr.state === "MERGED") return "merged";
  // A draft is explicitly "not ready to look at", so it is still coding.
  if (pr.state === "OPEN" && !pr.isDraft) return "open";
  return "none";
}

export interface PrBadge {
  label: string;
  tone: "done" | "prog" | "warn" | "muted";
}

export function prBadge(pr: PullRequest | null): PrBadge | null {
  if (!pr) return null;
  if (pr.state === "MERGED")
    return { label: `#${pr.number} merged`, tone: "done" };
  if (pr.state === "CLOSED")
    return { label: `#${pr.number} đóng`, tone: "warn" };
  if (pr.isDraft) return { label: `#${pr.number} nháp`, tone: "muted" };
  return { label: `#${pr.number} chờ review`, tone: "prog" };
}

/**
 * The single string a card stores for its PR.
 *
 * `DRAFT` is folded in alongside GitHub's three states rather than kept as a
 * separate flag: a card needs one column to compare and one word to show, and
 * "open but draft" is a different thing to a reader than "open".
 */
export function prStateTag(pr: PullRequest | null): string {
  if (!pr) return "";
  return pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state;
}

/**
 * What a GitHub URL pasted into the card editor points at.
 *
 * Accepts whatever the user has in the clipboard rather than demanding a
 * particular page: the branch view, the pull request, or just the repository.
 * Branch names here contain slashes (`ctalk/bugfix/VTL-737`), so everything
 * after `/tree/` is the branch — splitting on the last slash would truncate it.
 */
export interface GitHubLink2 {
  /** `owner/name`. */
  repo: string;
  branch?: string;
  prNumber?: number;
}

export function parseGitHubLink(input: string): GitHubLink2 | null {
  const raw = input.trim();
  if (!raw) return null;

  // Bare `owner/name`, which is what people usually type when they mean a repo.
  const bare = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) return { repo: `${bare[1]}/${bare[2]}` };

  const m = raw.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(.*))?$/i,
  );
  if (!m) return null;

  const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  const rest = (m[3] ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!rest) return { repo };

  const pr = rest.match(/^pull\/(\d+)/);
  if (pr) return { repo, prNumber: Number(pr[1]) };

  const tree = rest.match(/^(?:tree|blob)\/(.+)$/);
  if (tree) return { repo, branch: decodeURIComponent(tree[1]) };

  // Some other page under the repo (commits, issues…). The repo is still useful.
  return { repo };
}

/**
 * A repo name short enough for a card, e.g. `atthetalk/viptalk-ios-x` → `ios-x`.
 *
 * The owner is dropped — every watched repo shares it — and so is whatever
 * prefix all the watched repos have in common, which here is the product name
 * stamped on each one. What is left is the part that actually distinguishes
 * them. With a single repo configured there is nothing to distinguish, so the
 * common prefix is not stripped and the name stays whole.
 */
export function shortRepo(repo: string, all: string[]): string {
  const name = (repo.split("/")[1] ?? repo).trim();
  if (!name) return "";

  const names = all.map((r) => (r.split("/")[1] ?? r).trim()).filter(Boolean);
  if (names.length < 2) return name;

  // Longest shared prefix, then trimmed back to a separator so a name is never
  // cut mid-word: `viptalk-ios-x` and `viptalk-ipad` must not yield `ios-x` and
  // `pad` from a shared `viptalk-i`.
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = Math.max(
    prefix.lastIndexOf("-"),
    prefix.lastIndexOf("_"),
    prefix.lastIndexOf("."),
  );
  if (cut <= 0) return name;

  const trimmed = name.slice(cut + 1);
  return trimmed || name;
}

/**
 * What to print on a card for a repo.
 *
 * A name the user chose wins, because the shortest true name is still not the
 * one in their head: `matrix-rust-sdk-ruma` is "SDK" to the person who works in
 * it, and a card has room for one of those but not the other.
 */
export function repoLabel(
  repo: string,
  labels: Record<string, string>,
  all: string[],
): string {
  return labels[repo]?.trim() || shortRepo(repo, all);
}

/**
 * Colours a repo chip can take.
 *
 * Named after the app's own tokens rather than fixed hex, so a chip keeps its
 * contrast when the theme flips — `warn` is amber on white and a lighter amber
 * on black, which a hardcoded `#b8791b` would not be.
 */
export const REPO_COLORS = [
  "cam",
  "đen",
  "đỏ",
  "vàng",
  "xanh lá",
  "xanh dương",
  "tím",
  "ngọc",
] as const;

/**
 * Written out in full because Tailwind reads class names literally — building
 * them by interpolation would leave every one of these out of the stylesheet.
 */
const REPO_COLOR_CLASS: Record<string, string> = {
  cam: "border-orange bg-orange-soft text-orange",
  đen: "border-ink bg-surface-2 text-ink",
  đỏ: "border-crit bg-crit-soft text-crit",
  vàng: "border-warn bg-warn-soft text-warn",
  "xanh lá": "border-good bg-good-soft text-good",
  "xanh dương": "border-blue bg-blue-soft text-blue",
  tím: "border-ot bg-ot-soft text-ot",
  ngọc: "border-accent bg-accent-soft text-accent-ink",
};

const REPO_COLOR_NEUTRAL = "border-line-strong bg-surface-2 text-ink-2";

/**
 * The card's left edge, painted in the repo's colour.
 *
 * A stripe costs no horizontal room and is readable before anything is read —
 * scanning a column of cards, which repo each one belongs to lands before the
 * ticket key does. Written out literally for the same reason as the chip
 * classes: Tailwind never sees an interpolated name.
 */
const REPO_EDGE_CLASS: Record<string, string> = {
  cam: "border-l-orange",
  đen: "border-l-ink",
  đỏ: "border-l-crit",
  vàng: "border-l-warn",
  "xanh lá": "border-l-good",
  // The same darker blue the chip fills with — a pale edge on a white card
  // is barely an edge at all.
  "xanh dương": "border-l-blue-ink",
  tím: "border-l-ot",
  ngọc: "border-l-accent",
};

/**
 * The CSS custom property each repo colour resolves to.
 *
 * The class map above cannot paint two colours at once, and a card whose fix
 * spans two repositories has to say so at a glance — the left edge is the one
 * thing read before the text is. Keeping the same tokens means the pair
 * follows the light/dark flip exactly as the single-colour edge does.
 */
const REPO_EDGE_VAR: Record<string, string> = {
  cam: "var(--color-orange)",
  đen: "var(--color-ink)",
  đỏ: "var(--color-crit)",
  vàng: "var(--color-warn)",
  "xanh lá": "var(--color-good)",
  "xanh dương": "var(--color-blue-ink)",
  tím: "var(--color-ot)",
  ngọc: "var(--color-accent)",
};

export function repoEdgeVar(color: string | undefined): string {
  return REPO_EDGE_VAR[(color ?? "").trim()] ?? "var(--color-line-strong)";
}

export function repoEdgeClass(color: string | undefined): string {
  return REPO_EDGE_CLASS[(color ?? "").trim()] ?? "border-l-line-strong";
}

/**
 * The chip, filled solid rather than tinted.
 *
 * A tinted chip shows mostly its pale background, and those backgrounds are far
 * closer together than the colours they are derived from — measured on this
 * palette, `orange-soft` and `crit-soft` are ΔE 6 apart while the full-strength
 * pair is ΔE 26. Red and orange side by side were unreadable for exactly that
 * reason: the eye was being given the weakest version of the difference.
 *
 * `text-ground` rather than a fixed white: ground is near-white in the light
 * theme and near-black in the dark one, which is the right side of each of
 * these fills in both — the same token flip the rest of the app relies on.
 */
const REPO_SOLID_CLASS: Record<string, string> = {
  cam: "bg-orange text-ground",
  // Rust's mark is black, and a monochrome mark is black on light and white on
  // dark — which is exactly what `ink` already does. Nothing else in the
  // palette separates from orange this far, in colour or in lightness.
  đen: "bg-ink text-ground",
  đỏ: "bg-crit text-ground",
  vàng: "bg-warn text-ground",
  "xanh lá": "bg-good text-ground",
  "xanh dương": "bg-blue-ink text-ground",
  tím: "bg-ot text-ground",
  ngọc: "bg-accent text-ground",
};

export function repoSolidClass(color: string | undefined): string {
  return REPO_SOLID_CLASS[(color ?? "").trim()] ?? "bg-ink-3 text-ground";
}

export function repoColorClass(color: string | undefined): string {
  return REPO_COLOR_CLASS[(color ?? "").trim()] ?? REPO_COLOR_NEUTRAL;
}

/** Everything needed to draw one repo chip. */
export function repoChip(
  repo: string,
  labels: Record<string, string>,
  colors: Record<string, string>,
  all: string[],
): { text: string; cls: string; edge: string; solid: string } {
  return {
    text: repoLabel(repo, labels, all),
    cls: repoColorClass(colors[repo]),
    edge: repoEdgeClass(colors[repo]),
    solid: repoSolidClass(colors[repo]),
  };
}

/** The link a card should show — the branch when known, else the PR, else the repo. */
export function githubLinkOf(card: {
  repo: string;
  branch: string;
  prUrl: string;
}): string {
  if (card.repo && card.branch) {
    return `https://github.com/${card.repo}/tree/${card.branch.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (card.prUrl) return card.prUrl;
  return card.repo ? `https://github.com/${card.repo}` : "";
}

/**
 * One request per branch it targets, best of each.
 *
 * A branch often has several requests at the same environment — a first
 * attempt closed, a second merged — and a card wants the one that says where
 * the work stands, not all the attempts. {@link pickPr} already knows that
 * order, so this is only the grouping around it.
 */
export type { CardPr };

export function prsForCard(prs: PullRequest[]): CardPr[] {
  const byBase = new Map<string, PullRequest[]>();
  for (const p of prs) {
    const base = p.baseRefName ?? "";
    const at = byBase.get(base);
    if (at) at.push(p);
    else byBase.set(base, [p]);
  }
  return (
    [...byBase.values()]
      .flatMap((group) => {
        const best = pickPr(group);
        return best
          ? [
              {
                number: best.number,
                url: best.url,
                state: prStateTag(best),
                base: best.baseRefName ?? "",
              },
            ]
          : [];
      })
      // Sorted so the same set of requests always serializes the same way: the
      // scan compares this against what a card stores to decide whether to
      // write, and an order that follows GitHub's reply would make every card
      // look changed on the scan after GitHub shuffled it.
      .sort((a, b) => a.number - b.number)
  );
}


/**
 * A pull request reference as somebody would paste it.
 *
 * A full URL, a `#1322`, or the bare number — all three are things a person
 * copies out of GitHub, and rejecting two of them would only teach the user
 * which one this box wanted.
 */
export function parsePrRef(raw: string): number {
  const text = raw.trim();
  if (!text) return 0;
  const fromUrl = text.match(/\/pull\/(\d+)/);
  const n = Number(fromUrl ? fromUrl[1] : text.replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The scan's answer, with the user's pins put back.
 *
 * Only the *number* is pinned. Its state comes from `fresh` when GitHub was
 * asked about that number, and otherwise from what the card already held —
 * never from whichever request the scan would have chosen instead, which is
 * the wrong one by definition or it would not have been pinned.
 *
 * A pin also survives GitHub having nothing to say. The request that carried
 * the work often belongs to a resolve branch, so it is absent from the feature
 * branch's own requests every single scan; treating that absence as "the pin
 * is stale" would undo the correction on the next tick.
 */
export function mergeCardPrs(
  scanned: CardPr[],
  stored: CardPr[],
  fresh: Map<number, PullRequest> = new Map(),
): CardPr[] {
  const pins = stored.filter((p) => p.pinned && p.number);
  if (!pins.length) return scanned;

  const pinnedBases = new Set(pins.map((p) => p.base));
  const out = scanned.filter((p) => !pinnedBases.has(p.base));
  for (const pin of pins) {
    const live = fresh.get(pin.number);
    out.push(
      live
        ? {
            number: live.number,
            url: live.url,
            state: prStateTag(live),
            base: pin.base,
            pinned: true,
          }
        : pin,
    );
  }
  return out.sort((a, b) => a.number - b.number);
}

export function serializeCardPrs(list: CardPr[]): string {
  return list.length ? JSON.stringify(list) : "";
}

/**
 * Read the stored list, falling back to the card's single PR fields.
 *
 * The fallback is what a card written before this column existed looks like,
 * and it is also the shape a hand-edited card keeps — so nothing has to be
 * rescanned before its request shows up again.
 */
export function parseCardPrs(
  raw: string,
  card: { prNumber: number | null; prUrl: string; prState: string; prBase: string },
): CardPr[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      const out = v.flatMap((x) => {
        const o = x as Record<string, unknown>;
        return typeof o?.number === "number" && o.number
          ? [
              {
                number: o.number,
                url: String(o.url ?? ""),
                state: String(o.state ?? ""),
                base: String(o.base ?? ""),
                ...(o.pinned ? { pinned: true as const } : {}),
              },
            ]
          : [];
      });
      if (out.length) return out;
    }
  } catch {
    /* fall through to the single-PR fields */
  }
  return card.prNumber && card.prState
    ? [
        {
          number: card.prNumber,
          url: card.prUrl,
          state: card.prState,
          base: card.prBase,
        },
      ]
    : [];
}

/** The flat GitHub columns a card has always had, as one side. */
export interface FlatSide {
  repo: string;
  branch: string;
  prs: string;
  prNumber: number | null;
  prUrl: string;
  prState: string;
  prBase: string;
  envState: string;
  landedVia: string;
  branchGone: boolean;
  localAhead: number;
  localOnly: boolean;
  localPath: string;
  branchUpdatedAt: number | null;
}

export function serializeCardSides(list: CardSide[]): string {
  return list.length ? JSON.stringify(list) : "";
}

/**
 * Read the stored sides, falling back to the card's flat columns as one side.
 *
 * The fallback is what every card looks like before this column existed, and
 * it is also what a card touched by an older build of the app keeps — so no
 * rescan is needed before a card works again.
 */
export function parseCardSides(raw: string, row: FlatSide): CardSide[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      const out = v.flatMap((x) => {
        const o = x as Record<string, unknown>;
        return typeof o?.repo === "string" && o.repo
          ? [
              {
                repo: o.repo,
                branch: String(o.branch ?? ""),
                prs: parseCardPrs(
                  typeof o.prs === "string" ? o.prs : JSON.stringify(o.prs ?? []),
                  { prNumber: null, prUrl: "", prState: "", prBase: "" },
                ),
                envState: String(o.envState ?? ""),
                landedVia: String(o.landedVia ?? ""),
                branchGone: Boolean(o.branchGone),
                localAhead: Number(o.localAhead) || 0,
                localOnly: Boolean(o.localOnly),
                localPath: String(o.localPath ?? ""),
                branchUpdatedAt:
                  typeof o.branchUpdatedAt === "number" ? o.branchUpdatedAt : null,
              },
            ]
          : [];
      });
      if (out.length) return out;
    }
  } catch {
    /* fall through to the flat columns */
  }
  return row.repo || row.branch
    ? [
        {
          repo: row.repo,
          branch: row.branch,
          prs: parseCardPrs(row.prs, row),
          envState: row.envState,
          landedVia: row.landedVia,
          branchGone: row.branchGone,
          localAhead: row.localAhead,
          localOnly: row.localOnly,
          localPath: row.localPath,
          branchUpdatedAt: row.branchUpdatedAt,
        },
      ]
    : [];
}

/**
 * The side whose fields the card's flat columns hold.
 *
 * The first, which the scan orders by how far behind the work is — so the flat
 * columns, and everything still reading them, describe the half that is
 * holding the ticket up rather than whichever repository was scanned first.
 */
export function primarySide(sides: CardSide[]): CardSide | null {
  return sides[0] ?? null;
}

/** A {@link CardPr} back in the shape {@link prBadge} reads. */
export function asPullRequest(p: CardPr): PullRequest {
  return {
    number: p.number,
    url: p.url,
    state: p.state === "DRAFT" ? "OPEN" : p.state,
    isDraft: p.state === "DRAFT",
    baseRefName: p.base || undefined,
  };
}

/** A card's stored PR fields, back in the shape {@link prBadge} reads. */
export function cardPr(card: {
  prNumber: number | null;
  prUrl: string;
  prState: string;
  prBase?: string;
}): PullRequest | null {
  if (!card.prNumber || !card.prState) return null;
  return {
    number: card.prNumber,
    url: card.prUrl,
    state: card.prState === "DRAFT" ? "OPEN" : card.prState,
    isDraft: card.prState === "DRAFT",
    baseRefName: card.prBase || undefined,
  };
}

/**
 * Which column a branch belongs in, given where its code actually is.
 *
 * Read from the far end backwards: the furthest environment the code has
 * reached wins, because that is a fact about the repository rather than an
 * intention recorded on a PR. Only when it has reached none of them does the
 * PR get a say.
 *
 * A merged PR whose commits are in no environment lands on the last pre-merge
 * step rather than the first. That is the squash-merge case — the original
 * commits never appear in the target branch, so containment can never confirm
 * it — and "merged, not yet seen anywhere" is nearer the truth than "still
 * being written".
 */
export function stageFor(
  envState: EnvState,
  pr: PullRequest | null,
  stages: StageConfig[],
  /** Every request on the branch, so "queued for an environment" can be seen. */
  prs: PullRequest[] = pr ? [pr] : [],
  /** Environments a build carries this work in, from those builds' release notes. */
  builtBranches: readonly string[] = [],
): string {
  const queued = new Set(
    prs
      .filter((p) => p.state === "OPEN" && !p.isDraft && p.baseRefName)
      .map((p) => p.baseRefName as string),
  );
  /**
   * Environments a request of this branch was actually merged into.
   *
   * Containment alone was not enough. This team merges through a resolve
   * branch, so what landed carries different SHAs from what is on the feature
   * branch; and a branch keeps growing after its request merges, so its tip is
   * permanently "ahead" of the environment its work is already in. Both make
   * containment answer "no" about work that is plainly there — a request
   * merged into `develop` is direct evidence, the same kind as a build.
   */
  const mergedInto = new Set(
    prs
      .filter((p) => p.state === "MERGED" && p.baseRefName)
      .map((p) => p.baseRefName as string),
  );
  /**
   * Whether this branch ever contributed anything at all.
   *
   * `aheadBy: 0` says the branch adds nothing the environment does not already
   * have — which is what a merged branch looks like, and equally what an empty
   * one looks like. A branch cut from `ctalk/develop` and then abandoned is
   * zero ahead of every environment for ever, and reading that as "its work is
   * in staging" put a card in `đã merge staging` with a closed request, no
   * staging request and no staging build anywhere on it.
   *
   * A merged request is the thing that tells the two apart. Work here reaches
   * the later environments by the branches themselves being promoted, not by a
   * request per ticket, so containment is still the right signal — it just has
   * to be about a branch that put something in.
   */
  const everMerged = prs.some((p) => p.state === "MERGED");

  for (let i = stages.length - 1; i >= 0; i--) {
    const step = stages[i];
    if (!step.branch) continue;
    // `merged` asks the repository; `queued` asks the pull requests.
    //
    // A pull request aimed straight at an environment branch belongs to that
    // environment, review or not — a bugfix here is reviewed and merged
    // directly into `ctalk/develop`, so "waiting on review" and "queued for
    // develop" are the same day of work. The review column is for a request
    // aimed somewhere that is *not* an environment: a task branch going into a
    // feature branch, which is still a long way from anywhere runnable.
    // `merged` asks the repository, `queued` asks the pull requests, and
    // `built` asks the build that named this ticket in its release notes. The
    // build is the only one of the three that is a claim by a person rather
    // than a fact about a graph, which is why it is only trusted for the exact
    // branch it names: a build of the team's own environment says nothing
    // about integration, even though the code may well be in both.
    const reached =
      step.reach === "built"
        ? builtBranches.includes(step.branch)
        : step.reach === "merged"
          ? (everMerged && hasArrived(envState, step)) ||
            mergedInto.has(step.branch)
          : queued.has(step.branch);
    if (reached) return step.name;
  }

  // The terminal step also has no branch, but it is not a pre-merge step and a
  // squash merge must not land in it — "merged, not yet seen anywhere" would
  // otherwise read as "shipped and cleaned up", which is the far end of the
  // board. Only {@link cardStage} may put a card there.
  const pre = stages.filter((s) => !s.branch && s.reach !== "gone");
  const phase = prPhase(pr);
  if (phase === "merged")
    return pre[pre.length - 1]?.name ?? stages[0]?.name ?? "";

  const want = phase === "open" ? "open" : "nopr";
  return (pre.find((s) => s.phase === want) ?? pre[0] ?? stages[0])?.name ?? "";
}

/**
 * The column a card belongs in, from what the card itself stores.
 *
 * One rule, one place. It was written out three times — the key-matched scan
 * rows, the branch-matched ones, and the cheap pull-request refresh — and a
 * rule copied three times is a rule that drifts. The hand-edit path had no
 * copy at all, which is why typing a build number in moved nothing until the
 * next scan.
 *
 * Needs no network: every input is already on the card. The furthest half
 * decides, and the build counts — see {@link stageFor}.
 */
export function cardStage(
  sides: CardSide[],
  builds: CardBuild[],
  stages: StageConfig[],
  /**
   * Whether Jira says the card is over — {@link ticketsDone}.
   *
   * `null` means nobody asked, which is the case for every caller that has no
   * Jira credentials in hand: the scan, the pull-request refresh, the editor.
   * They must not be able to *un*-finish a card, and they cannot, because
   * `advanceStage` only ever moves forward.
   */
  finished: boolean | null = null,
): string {
  const names = stages.map((s) => s.name);
  const built = builds.flatMap((b) => (b.branch ? [b.branch] : []));
  let best = "";
  for (const side of sides) {
    const prs = side.prs.map(asPullRequest);
    const target = stageFor(
      parseEnvState(side.envState),
      pickPr(prs),
      stages,
      prs,
      built,
    );
    if (names.indexOf(target) > names.indexOf(best)) best = target;
  }

  /**
   * The last column, on either of two witnesses to the same fact — this work
   * is over.
   *
   * Jira closing the ticket is the primary one and the only one that needs no
   * interpretation. It wins outright, from any column: a ticket closed while
   * its card sat in `review` is a won't-fix or a duplicate, and those are
   * finished in the only sense the board cares about.
   *
   * The branch being gone is the fallback, for the cards Jira cannot speak
   * for — a branch naming a ticket in a project this app is not pointed at,
   * which is routine here mid-migration. It is the weaker witness so it is
   * fenced in twice: *every* side, because a fix that deleted its iOS branch
   * while the SDK one is still open is not finished; and only from an
   * environment, because a branch deleted from `đang code` is abandoned work
   * rather than delivered work.
   */
  const end = cleanupStep(stages);
  if (end) {
    if (finished === true) return end.name;
    const reachedEnv = Boolean(stages.find((s) => s.name === best)?.branch);
    // Only when nobody asked. A caller holding a live "In Progress" is not
    // short of information, and letting the weaker witness overrule it would
    // file work still in flight as finished.
    if (finished === null && reachedEnv && branchesCleanedUp(sides))
      return end.name;
  }

  return best;
}

/**
 * The stage a sync should write, or '' to leave the card alone.
 *
 * Only ever moves a card forward. The user drags cards themselves, and always
 * in the direction of progress; a sync that could also drag them back would
 * undo that work every time GitHub's view lagged — a branch merged and then
 * deployed would be pulled from "đã deploy" back to "đã merge" on every scan.
 */
export function advanceStage(
  current: string,
  target: string,
  stageNames: string[],
): string {
  if (!target || target === current) return "";
  const to = stageNames.indexOf(target);
  if (to < 0) return "";
  const from = stageNames.indexOf(current);
  // A card in no known column has nowhere to fall back to, so let it land.
  return from < 0 || to > from ? target : "";
}

/**
 * A readable title from the branch alone — `hir/bugfix/vtl-122-calling-timeout`
 * → `calling timeout`.
 *
 * Used when Jira has nothing to offer, which is not an error case here: the
 * team is mid-migration between boards, so a branch routinely names a ticket
 * the configured project has never heard of. Those cards are still worth
 * having, and a wall of "(chưa có tiêu đề)" would make them unreadable.
 */
export function titleFromBranch(branch: string, issueKey: string): string {
  const tail = branch.split("/").pop() ?? branch;
  const key = issueKey.split("-")[0];
  // No key means there is no ticket reference to strip, and stripping anyway
  // would eat every number in the name — `upgrade_26.09.09_phase1` came out as
  // `upgrade phase`.
  const stripped = key
    ? // Drop every ticket reference, not just the matched one: a branch named
      // for two tickets would otherwise keep the second as noise.
      tail.replace(new RegExp(`${escapeRe(key)}[-_]?\\d+[-_]?`, "gi"), "")
    : tail;
  return stripped.replace(/[-_]+/g, " ").trim() || tail;
}

/* ----------------------------- environments ------------------------------ */

/**
 * Where a branch stands against one environment.
 *
 * Two numbers rather than one because "arrived" has two very different shapes.
 * `ahead === 0` means the environment literally contains the branch's commits.
 * `landed` means the *content* is there while the commits are not — the normal
 * outcome of this team's workflow, where a resolve branch merges the feature
 * with conflicts fixed, so every commit is rewritten on the way in. Squash and
 * rebase merges do the same thing.
 *
 * Reporting `landed` as "not arrived" was this module's worst bug: `git cherry`
 * on a real branch showed 6 commits ahead by SHA and 0 ahead by patch, while
 * the board told the user their shipped work had not shipped.
 */
export interface EnvPos {
  /** Commits the tip has that the environment lacks. null = env branch absent here. */
  ahead: number | null;
  /** Content reached the environment by another route. */
  landed?: boolean;
}

export type EnvState = Record<string, EnvPos>;

export function hasArrived(state: EnvState, env: { branch: string }): boolean {
  const p = state[env.branch];
  return Boolean(p && (p.ahead === 0 || p.landed));
}

/**
 * One environment's status as a card should show it.
 *
 * `behind` carries the commit count because "not there yet" and "not there yet,
 * 47 commits of yours are missing" call for different reactions.
 */
export interface EnvCell {
  env: StageConfig;
  /**
   * `arrived` — the environment contains these exact commits.
   * `landed`  — the content is there, carried in by rewritten commits.
   * `behind`  — genuinely not there yet.
   * `absent`  — this repo has no branch for that environment.
   */
  kind: "arrived" | "landed" | "behind" | "absent";
  ahead: number;
}

export function envLadder(state: EnvState, envs: StageConfig[]): EnvCell[] {
  return envSteps(envs).map((env) => {
    const p = state[env.branch];
    if (!p || p.ahead === null || p.ahead === undefined)
      return { env, kind: "absent" as const, ahead: 0 };
    if (p.ahead === 0) return { env, kind: "arrived" as const, ahead: 0 };
    if (p.landed) return { env, kind: "landed" as const, ahead: p.ahead };
    return { env, kind: "behind" as const, ahead: p.ahead };
  });
}

/**
 * Reads the stored blob, accepting the shape that predates `landed`.
 *
 * Cards written before the patch-vs-SHA fix hold a bare number per environment.
 * Those stay readable as "ahead by N, nothing known about content" until the
 * next scan replaces them.
 */
export function parseEnvState(raw: string): EnvState {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: EnvState = {};
    for (const [branch, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) out[branch] = { ahead: null };
      else if (typeof val === "number") out[branch] = { ahead: val };
      else if (val && typeof val === "object") {
        const o = val as { ahead?: unknown; landed?: unknown };
        out[branch] = {
          ahead: typeof o.ahead === "number" ? o.ahead : null,
          ...(o.landed ? { landed: true } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A branch name that undoes work rather than delivering it.
 *
 * Needed because a revert PR carries the same Jira key as the work it removes,
 * and would otherwise be read as proof the work arrived. Observed live:
 * `ctalk/bugfix/VT-17252` merged on 18/08 and `ctalk/bugfix/VT-17252-revert`
 * merged on 27/08, both into `ctalk/develop`.
 */
export function isRevertBranch(name: string): boolean {
  return /(^|[^a-z])revert([^a-z]|$)/i.test(name);
}

/** Everything a scan needs. Server-side only — it carries the token. */
export interface GitHubConfig {
  token: string;
  repos: string[];
  identity: Identity;
  projectKeys: string[];
  /**
   * Consult the user's GitHub event feed for branches they created or pushed.
   * On by default — it is the only signal that catches a branch pushed before
   * its first own commit, which is the shape of "I just made this branch".
   */
  useEvents: boolean;
  /** Git clones on this machine, read to find branches never pushed. */
  localPaths: string[];
  /**
   * The build channel, which is what "ready to test" really depends on.
   *
   * `buildWorkflow` is the GitHub Actions workflow that produces the installable
   * build (`build.yml` here); `buildRepo` is where those runs live when it is not
   * the repo a card belongs to — the SDK has no build of its own, the iOS app
   * builds for it. `buildApps` maps each environment branch to the App Store
   * Connect app its build is published under, which is how a run is confirmed
   * to have actually reached TestFlight rather than merely compiled.
   */
  buildWorkflow: string;
  buildRepo: string;
  buildApps: Record<string, string>;
  /**
   * This team ships builds at all.
   *
   * Off means the board never mentions one: no boxes on the cards, no "↻ Bản
   * build", no request to Apple even when asked by hand. Everything about
   * TestFlight is written for a team with a mobile app, and for everybody else
   * it is a column that can never be reached and a question with no answer.
   */
  buildEnabled: boolean;
  /**
   * Watch that channel in the background and say so when a build lands.
   *
   * Its own switch because this module is not only for a team that ships an
   * app: branches and notes are useful with no build channel at all, and for
   * that team the watcher is pure cost — requests to Apple about nothing, and
   * a permission prompt for a notification that can never arrive.
   */
  buildNotify: boolean;
  /** `owner/repo` → short name to print on cards. */
  repoLabels: Record<string, string>;
  /** `owner/repo` → one of {@link REPO_COLORS}. */
  repoColors: Record<string, string>;
  /** The pipeline, which is also the board's columns. */
  stages: StageConfig[];
}

/**
 * The same settings as the browser is allowed to see.
 *
 * The token becomes a yes/no rather than a masked string: this screen cannot
 * edit it — that happens on the Settings page, alongside the Jira token — so
 * the only thing it needs to convey is whether the scan can run at all.
 */
export interface GitHubConfigView extends Omit<
  GitHubConfig,
  "token" | "stages"
> {
  hasToken: boolean;
  /** Apps iOS publish holds credentials for — names only, never the keys. */
  ascApps: string[];
}

/**
 * What a scan proposes to do with one branch.
 *
 * `conflict` is kept separate from `fill` on purpose: overwriting a branch name
 * the user typed by hand is the one edit here that destroys information, so it
 * is surfaced for a decision rather than folded into the happy path.
 */
export type PlanAction = "create" | "fill" | "conflict" | "match";

export interface PlanRow {
  branch: RemoteBranch;
  issueKey: string;
  action: PlanAction;
  /** Card this branch resolved to, when one exists. */
  noteId: number | null;
  /** Branch currently on that card — the losing side of a conflict. */
  currentBranch: string;
  currentStage: string;
  /** Stage this row would set. '' = leave the card where it is. */
  stage: string;
  /** Every ticket the branch names, primary first. */
  issueKeys: string[];
  /** Title the card would get, when creating one. */
  title: string;
  /** How far the branch is from each environment. */
  envState: EnvState;
  /** Branch that carried the work in, when it was not this one. */
  landedVia: string;
  /**
   * One entry per repository the ticket touches, least advanced first — the
   * whole GitHub half of what this row would store.
   */
  sides: CardSide[];
}

export function planSummary(rows: PlanRow[]): string {
  const n = (a: PlanAction) => rows.filter((r) => r.action === a).length;
  const parts = [
    n("create") && `${n("create")} tạo mới`,
    n("fill") && `${n("fill")} cập nhật`,
    n("conflict") && `${n("conflict")} khác nhánh`,
    n("match") && `${n("match")} đã khớp`,
  ].filter(Boolean);
  return `${rows.length} nhánh${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}
