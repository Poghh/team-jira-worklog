import "server-only";

import { getIssueStatuses } from "@/lib/jira/issues";

import { getGitHubConfig, getStages } from "./config";
import {
  type CardBuild,
  type CardSide,
  type StageConfig,
  envSteps,
  orderSides,
  withLocalState,
} from "./model";
import {
  type EnvState,
  type PlanRow,
  type PullRequest,
  type RemoteBranch,
  advanceStage,
  candidateProjectKeys,
  extractIssueKey,
  extractIssueKeys,
  isRevertBranch,
  mineBy,
  asPullRequest,
  cardStage,
  mergeCardPrs,
  parseEnvState,
  pickPr,
  prStateTag,
  prsForCard,
  serializeCardPrs,
  serializeCardSides,
  stageFor,
  titleFromBranch,
} from "./github-model";
import {
  fetchBranches,
  fetchEnvState,
  fetchMergedPrs,
  type PinnedPr,
  fetchPrsByNumber,
  fetchPushedBranches,
  fetchShaContainment,
} from "./github";
import { type LocalScan, localIndex, readLocalBranches } from "./local";
import {
  applyGitHubBranch,
  deleteTaskNotes,
  listTaskNotes,
  markBranchesGone,
} from "./store";

/**
 * The stored form of a measured position.
 *
 * One function for both the write and the freshness check. They used to
 * normalise differently — the write collapsed an empty map to '' while the
 * check compared against '{}' — so a card with no environment data was
 * rewritten on every single scan and the button never reported "nothing new".
 */
function envJson(envs: EnvState): string {
  return Object.keys(envs).length ? JSON.stringify(envs) : "";
}

/** A card left pointing at a branch that no longer exists. */
export interface GoneCard {
  id: number;
  issueKey: string;
  title: string;
  branch: string;
  repo: string;
  stage: string;
  /** Note lines the user wrote — what would be lost by clearing the card. */
  bodyLines: number;
  prUrl: string;
  prState: string;
}

export interface ScanResult {
  rows: PlanRow[];
  /** Every branch fetched, before filtering — the denominator for the rest. */
  scanned: number;
  /** Branches that matched the identity rules. */
  mine: number;
  /** How many branches each rule claimed — so a wrong setting is visible, not guessed at. */
  mineBy: Record<string, number>;
  /** Mine, but naming no configured project key — the usual cause of an empty scan. */
  unmatched: number;
  /** Branch names behind `unmatched`, capped, so the cause is visible not inferred. */
  unmatchedSamples: string[];
  /**
   * Project keys the unmatched branches appear to name, most frequent first.
   *
   * Computed here rather than on a separate settings trip because the moment
   * the user learns their keys are missing is the moment the scan comes back
   * short — offering the fix in the same result turns a dead end into a click.
   */
  candidates: Array<{ key: string; count: number }>;
  /** Repos in the list that could not be read — renamed, deleted, or not visible. */
  skipped: string[];
  /** Repos with more branches than the per-repo ceiling — a scan that stopped early says so. */
  truncated: string[];
  /** Branches found only in a local clone, never pushed. */
  localOnly: number;
  /** Branches on the server that the local clone is ahead of. */
  localAheadOf: number;
  /** Configured paths that could not be read, with the reason. */
  badPaths: Array<{ path: string; why: string }>;
  /**
   * Branches carrying unpushed commits that no card ended up tracking.
   *
   * A ticket worked in two repos gets one card, so the loser's branch — and
   * whatever is sitting unpushed on it — would otherwise vanish silently. Two
   * branches here hold 47 and 43 unpushed commits between them; saying nothing
   * about that would be the worst kind of quiet.
   */
  localHidden: Array<{ repo: string; branch: string; ahead: number }>;
  /**
   * Cards whose branch GitHub no longer has.
   *
   * Normal, not broken: this team deletes branches on release, so this is the
   * list of work that shipped. Reported separately from the plan because the
   * only sensible action is the opposite one — clear the card, not update it.
   */
  gone: GoneCard[];
}

/**
 * Reads GitHub and works out what it would change, without changing anything.
 *
 * Split from {@link applyPlan} because the interesting failure here is not a
 * network error but a misconfiguration — a missing project key, an identity
 * that matches nothing — and those produce a *successful* scan with a wrong
 * plan. Showing the plan first turns that from a mess to undo into a list to
 * read.
 */
export async function scanGitHub(): Promise<ScanResult> {
  const cfg = getGitHubConfig();
  const token = cfg.token;
  if (!token) {
    throw new Error(
      "Chưa có token GitHub — điền GITHUB_TOKEN vào .env.local, hoặc dán vào Settings › GitHub.",
    );
  }
  if (!cfg.repos.length) throw new Error("Chưa chọn repo nào để quét");

  const { logins, emails, prefixes } = cfg.identity;
  if (!logins.length && !emails.length && !prefixes.length) {
    // Without this the scan succeeds and finds nothing, which reads like "you
    // have no branches" rather than "you have not said who you are".
    throw new Error(
      'Chưa khai báo danh tính GitHub — bấm "Dò" ở tab GitHub để điền tự động',
    );
  }

  const { branches, skipped, truncated } = await fetchBranches(
    token,
    cfg.repos,
  );

  // Clones on this machine. A branch that was never pushed exists nowhere else,
  // and one that is ahead of its upstream is work the server cannot see.
  // Read after the server so the server's richer record wins on everything the
  // two both know about.
  const local = cfg.localPaths.length
    ? await readLocalBranches(cfg.localPaths).catch(
        () => ({ branches: [], bad: [] }) as LocalScan,
      )
    : ({ branches: [], bad: [] } as LocalScan);

  // The same scan as a lookup, for sides that never pass through `best` — see
  // the carried-through branch far below.
  const localState = localIndex(local);

  const watched = new Set(cfg.repos);
  // An index, not a membership set: the loop below needs the branch itself, and
  // scanning the array for it turned a few hundred local branches against a few
  // hundred remote ones into a hundred thousand string comparisons.
  const onServer = new Map(branches.map((b) => [`${b.repo}#${b.name}`, b]));
  let localOnlyCount = 0;
  let localAheadCount = 0;

  for (const lb of local.branches) {
    if (!watched.has(lb.repo)) continue;

    const remote = onServer.get(`${lb.repo}#${lb.name}`);
    if (remote) {
      remote.local = { ahead: lb.ahead, onlyLocal: false, path: lb.path };
      if (lb.ahead > 0) localAheadCount++;
      continue;
    }

    // Never pushed: no pull request, no environment position to ask GitHub for.
    // It still deserves a card — that is the whole point of reading the clone.
    localOnlyCount++;
    branches.push({
      repo: lb.repo,
      name: lb.name,
      committedAt: lb.committedAt,
      login: "",
      email: "",
      prs: [],
      pr: null,
      // `lb.onlyLocal` rather than a hardcoded true: a branch whose upstream
      // was deleted still records one, and calling that "never pushed" both
      // mislabels it and hides it from the deleted-branch check below.
      local: { ahead: lb.ahead, onlyLocal: lb.onlyLocal, path: lb.path },
    });
  }

  // Pull requests the user pinned by hand, fetched by number.
  //
  // A pinned request is often not one of its branch's own associations — this
  // team merges through a resolve branch, so the work on a feature branch
  // reaches an environment via a pull request GitHub links to a *different*
  // branch entirely. Looked up directly and folded into the branch's list, so
  // `pickPr` can honour the pin instead of silently falling back to whatever
  // the branch happens to own.
  const allCards = listTaskNotes();
  /**
   * Requests the user pinned, per repository.
   *
   * There used to be a card-level pin beside these, holding one number for the
   * whole card. It could not survive a card spanning two repositories — one
   * number cannot name a request in each — and everything it did is now done
   * by the per-side pins, which say which repository and which environment.
   *
   * Fetched so their state stays live: the number is the user's decision,
   * whether it is open or merged is still GitHub's.
   */
  const pinnedPrs = new Map<string, number[]>();
  const add = (repo: string, n: number) =>
    pinnedPrs.set(repo, [...(pinnedPrs.get(repo) ?? []), n]);
  for (const c of allCards)
    for (const side of c.sides)
      for (const p of side.prs)
        if (p.pinned && p.number) add(side.repo, p.number);

  /** Every pinned request GitHub could be asked about, by number. */
  const livePins = new Map<number, PullRequest>();

  /** `repo#branch` → the pull requests pinned onto that particular branch. */
  const pinnedOn = new Map<string, number[]>();
  for (const c of allCards)
    for (const side of c.sides) {
      if (!side.repo || !side.branch.trim()) continue;
      const k = `${side.repo}#${side.branch.trim()}`;
      for (const p of side.prs)
        if (p.pinned && p.number)
          pinnedOn.set(k, [...(pinnedOn.get(k) ?? []), p.number]);
    }

  /** `repo#issueKey` → merge commit, head branch and merge time, pinned by hand. */
  const pinnedMerge = new Map<
    string,
    { sha: string; head: string; at: number }
  >();

  for (const [repo, numbers] of pinnedPrs) {
    const found = await fetchPrsByNumber(token, repo, numbers).catch(
      () => ({}) as Record<number, PinnedPr>,
    );
    for (const pr of Object.values(found)) livePins.set(pr.number, pr);
    // Onto the branch that pinned it, and no other. Pushing every pinned
    // request onto every branch of the repo — which is what this did — made one
    // card's open request look like a request on all of them, so an untouched
    // branch with no pull request at all was filed under the environment that
    // someone else's request happened to target.
    for (const b of branches) {
      if (b.repo !== repo) continue;
      for (const n of pinnedOn.get(`${b.repo}#${b.name}`) ?? []) {
        const pr = found[n];
        if (pr && !b.prs.some((x) => x.number === n)) b.prs.push(pr);
      }
    }
    for (const c of allCards) {
      if (!c.issueKey) continue;
      const pin = c.sides
        .filter((side) => side.repo === repo)
        .flatMap((side) => side.prs.filter((p) => p.pinned && p.number))[0];
      if (!pin) continue;
      const hit = found[pin.number];
      if (hit?.mergeCommit)
        pinnedMerge.set(`${repo}#${c.issueKey}`, {
          sha: hit.mergeCommit,
          head: hit.headRefName ?? "",
          at: Math.floor(new Date(hit.mergedAt ?? 0).getTime() / 1000) || 0,
        });
    }
  }

  // Branches the user themselves created or pushed. Best-effort: the event feed
  // going missing costs recent branches, not the whole scan.
  const pushed = cfg.useEvents
    ? await fetchPushedBranches(token, logins).catch(() => new Set<string>())
    : new Set<string>();

  const byRule: Record<string, number> = {};
  const mine = branches.filter((b) => {
    // A branch sitting in a clone on this machine is the user's by construction;
    // the identity rules exist to filter the server's shared view, not this one.
    if (b.local?.onlyLocal) {
      byRule.local = (byRule.local ?? 0) + 1;
      return true;
    }
    const how = mineBy(b, cfg.identity, pushed);
    if (how) byRule[how] = (byRule[how] ?? 0) + 1;
    return how !== null;
  });

  // Newest tip wins when several branches name the same ticket: a ticket
  // reopened on a fresh branch is the common case, and the stale branch is
  // exactly the one not worth putting on the board.
  // Indexed by *every* key a card claims: a branch fixing two tickets must find
  // the same card whichever of them the scan looks up.
  const byKey = new Map<string, (typeof allCards)[number]>();
  for (const c of allCards)
    for (const k of c.issueKeys) if (!byKey.has(k)) byKey.set(k, c);

  /**
   * `issueKey` → `repo` → the branch of that repository.
   *
   * Per repository, not one branch per ticket. A fix here often spans the Rust
   * SDK and the iOS app, and keeping only the newest-tip branch meant the other
   * repository's work — merged requests included — never appeared on the board
   * at all. Nine of fifty-one tickets are in that shape.
   */
  const best = new Map<string, Map<string, RemoteBranch>>();
  const putBest = (key: string, b: RemoteBranch) => {
    const byRepo = best.get(key) ?? new Map<string, RemoteBranch>();
    byRepo.set(b.repo, b);
    best.set(key, byRepo);
  };
  /** Every side of a ticket, in no particular order yet. */
  const sidesOf = (key: string) => [...(best.get(key)?.values() ?? [])];
  // Keys the user has corrected by hand. Newest-tip-wins is a guess, and a
  // guess must not outrank an answer someone typed in deliberately.
  const pinnedHit = new Set<string>();
  const unmatchedSamples: string[] = [];
  const unmatchedNames: string[] = [];
  let unmatched = 0;

  /** Every key a chosen branch names, so a card can carry all of them. */
  const keysOf = new Map<string, string[]>();

  /**
   * The keys a card should end up with: its own, plus anything new the branch
   * names. Never fewer.
   *
   * A scan must not drop a ticket somebody typed in. The branch name is only
   * one way a card learns which tickets it covers — a second ticket fixed by
   * the same pull request often is not in the branch name at all, and replacing
   * the list wiped it on the very next scan.
   */
  const mergedKeys = (
    card: { issueKeys: string[] } | null,
    fromBranch: string[],
  ): string[] => {
    const out = [...(card?.issueKeys ?? [])];
    for (const k of fromBranch) if (!out.includes(k)) out.push(k);
    return out;
  };

  for (const b of mine) {
    const all = extractIssueKeys(b.name, cfg.projectKeys);
    const key = all[0] ?? "";
    if (!key) {
      unmatched++;
      unmatchedNames.push(b.name);
      if (unmatchedSamples.length < 8) unmatchedSamples.push(b.name);
      continue;
    }
    const card = byKey.get(key);
    if (
      card?.githubPinned &&
      card.repo === b.repo &&
      card.branch.trim() === b.name
    ) {
      putBest(key, b);
      keysOf.set(key, all);
      pinnedHit.add(`${key}#${b.repo}`);
      continue;
    }
    // A pin settles which branch of *that repository* is the card's; the other
    // repository still picks its own by newest tip.
    if (pinnedHit.has(`${key}#${b.repo}`)) continue;

    const prev = best.get(key)?.get(b.repo);
    if (!prev || b.committedAt > prev.committedAt) {
      putBest(key, b);
      keysOf.set(key, all);
    }
  }

  const stages = getStages();
  const stageNames = stages.map((s) => s.name);

  // Branches a card already claims. One branch, one card: without this a
  // branch whose name yields a Jira key gets a *second*, auto-created card
  // whenever the card that owns it is keyed something else — which happens the
  // moment the user renames a card's key, exactly as it does when they pin one.
  // Pinning is not the point; already pointing at the branch is.
  // Every side, not just the first. A card's SDK branch is claimed just as
  // firmly as its iOS one, and counting only the first meant the other
  // repository's branch looked ownerless — so the scan created a second card
  // for it, keyed off whatever ticket the branch name happened to spell.
  const claimedBranches = new Set(
    allCards.flatMap((c) =>
      c.sides
        .filter((side) => side.repo && side.branch.trim())
        .map((side) => `${side.repo}#${side.branch.trim()}`),
    ),
  );

  for (const [key, byRepo] of [...best]) {
    const card = byKey.get(key);
    if (card) continue;
    // Only drop the side when no card of its own is waiting for it — an
    // existing card must keep being updated even if another card shares its
    // branch. A ticket left with no sides at all drops out entirely.
    for (const [repo, b] of [...byRepo])
      if (claimedBranches.has(`${b.repo}#${b.name}`)) byRepo.delete(repo);
    if (!byRepo.size) best.delete(key);
  }

  /**
   * Keys a card already owns through the name of a branch it points at.
   *
   * A card is identified by its ticket, which is not always the ticket its
   * branch spells: this board has `VT-853` on `ctalk/bugfix/VTL-286_VTL-610`.
   * Matching by key can never connect the two, so the second repository's
   * branch looked ownerless and the scan minted a card for it. These keys are
   * left out of `keys` and picked up further down, where cards are matched by
   * branch name instead — which keeps the card's own ticket list untouched.
   */
  const ownedByBranch = new Map<string, (typeof allCards)[number]>();
  for (const c of allCards)
    for (const side of c.sides)
      for (const k of extractIssueKeys(side.branch, cfg.projectKeys))
        if (!byKey.has(k) && !ownedByBranch.has(k)) ownedByBranch.set(k, c);

  const keys = [...best.keys()].filter((k) => !ownedByBranch.has(k));
  // Titles for cards about to be created. Best-effort: a Jira outage should
  // degrade the card to a bare key, not fail the whole scan.
  const summaries = keys.length
    ? await getIssueStatuses(keys).catch(
        () => ({}) as Record<string, { summary: string }>,
      )
    : {};

  // Environment containment, for the branches that made the cut only — asking
  // it of all 149 refs would be most of a scan's cost spent on other people's
  // work.
  const envs = envSteps(stages);
  // Pinned branches join the measurement list even when no key pointed at them.
  const pinnedTargets = allCards
    .filter((c) => c.githubPinned && c.repo && c.branch.trim())
    .map((c) => ({ repo: c.repo, branch: c.branch.trim() }));
  const measure = [
    ...keys.flatMap((k) =>
      sidesOf(k)
        .filter((b) => !b.local?.onlyLocal)
        .map((b) => ({ repo: b.repo, branch: b.name })),
    ),
    // Every branch a card already points at, in every repository. Cards
    // matched by branch name rather than by key never appear in `keys` — the
    // card is `VT-853`, its branch spells `VTL-286` — so leaving these out
    // meant those cards' environments were simply never measured.
    ...allCards.flatMap((c) =>
      c.sides
        .filter((side) => side.repo && side.branch.trim())
        .map((side) => ({ repo: side.repo, branch: side.branch.trim() })),
    ),
    // And the other repository's branch of such a card, which no card stores
    // yet on the scan that first finds it.
    ...[...ownedByBranch.keys()].flatMap((k) =>
      sidesOf(k).map((b) => ({ repo: b.repo, branch: b.name })),
    ),
    ...pinnedTargets,
  ].filter(
    (t, i, all) =>
      all.findIndex((o) => o.repo === t.repo && o.branch === t.branch) === i,
  );

  const envState = await fetchEnvState(token, measure, envs).catch(
    () => ({}) as Record<string, EnvState>,
  );

  // Content that reached an environment by another route.
  //
  // Comparing commit SHAs alone was wrong for this team: a resolve branch
  // merges the feature with conflicts fixed, so every commit is rewritten and
  // the original branch looks permanently behind. The merged pull request's
  // own merge commit is the thing to ask about instead — it is either in the
  // environment or it is not, and no patches need reading to find out.
  const landed = await landedByKey(
    token,
    keys,
    best,
    envs,
    cfg.projectKeys,
    pinnedMerge,
  ).catch(
    (): Record<
      string,
      { envs: Record<string, boolean>; via: string; at: number }
    > => ({}),
  );

  /** `repo#key` → the branch that carried the work in, when it detoured. */
  const via = new Map<string, string>();

  for (const key of keys) {
    for (const b of sidesOf(key)) {
      const state = envState[`${b.repo}#${b.name}`];
      const hit = landed[`${b.repo}#${key}`];
      if (!state || !hit) continue;
      let detoured = false;
      for (const env of envs) {
        const pos = state[env.branch];
        if (
          pos &&
          pos.ahead !== null &&
          pos.ahead > 0 &&
          hit.envs[env.branch]
        ) {
          pos.landed = true;
          detoured = true;
        }
      }
      if (detoured && hit.via) via.set(`${b.repo}#${key}`, hit.via);
    }
  }

  const rows: PlanRow[] = keys.map((issueKey) => {
    const card = byKey.get(issueKey) ?? null;

    /**
     * One side per repository the ticket touches, each judged on its own.
     *
     * Judging them together was the old bug: a ticket whose SDK half was
     * merged a fortnight ago and whose iOS half is still being written would
     * take the column of whichever branch had the newer commit.
     */
    const byRepoBranchAll = new Map(
      branches.map((b) => [`${b.repo}#${b.name}`, b]),
    );
    /**
     * Repositories the scan found for this ticket, plus any the card pinned.
     *
     * A pinned side is not re-derived: the user said which branch of that
     * repository is the card's, and the scan pairs by newest tip, which is
     * exactly the guess they were correcting.
     */
    const seen = new Map(sidesOf(issueKey).map((b) => [b.repo, b]));
    for (const x of card?.sides ?? []) {
      if (!x.pinned) continue;
      const hit = byRepoBranchAll.get(`${x.repo}#${x.branch}`);
      if (hit) seen.set(x.repo, hit);
    }

    const computed = [...seen.values()].map((raw) => {
      const stored = card?.sides.find((x) => x.repo === raw.repo) ?? null;
      // A pinned card names its own pull request, for its own repository; the
      // scan reports on that one rather than re-deciding which request matters.
      // A side that pins a request names its own; the scan reports on that one
      // rather than re-deciding which of the branch's requests matters.
      const pinned = stored?.prs.find((p) => p.pinned && p.number)?.number;
      const branch = pinned ? { ...raw, pr: pickPr(raw.prs, pinned) } : raw;
      const envs = envState[`${branch.repo}#${branch.name}`] ?? {};
      const prs = mergeCardPrs(
        prsForCard(branch.prs),
        stored?.prs ?? [],
        livePins,
      );
      const target = stageFor(
        envs,
        branch.pr,
        stages,
        branch.prs,
        builtBranchesOf(card),
      );
      const side: CardSide = {
        repo: branch.repo,
        branch: branch.name,
        ...(stored?.pinned ? { pinned: true as const } : {}),
        prs,
        envState: envJson(envs),
        landedVia: via.get(`${branch.repo}#${issueKey}`) ?? "",
        // The scan just read this branch, so it is there. Whether a card's
        // branch has gone is decided further down, per card.
        branchGone: false,
        localAhead: branch.local?.ahead ?? 0,
        localOnly: Boolean(branch.local?.onlyLocal),
        localPath: branch.local?.path ?? "",
        branchUpdatedAt: branch.committedAt || null,
      };
      return { branch, envs, target, side };
    });

    /**
     * The furthest any half of the work has got, not the least far.
     *
     * A branch here is never deleted until release, so a repository keeps an
     * abandoned branch — a closed request, commits that never landed — long
     * after the change itself shipped through some other branch. Reading that
     * as "this half is behind" is reading a leftover as work in progress.
     *
     * The build settles it: a build of an environment exists only because the
     * code reached that environment, so a build naming this ticket is proof
     * for the whole card, whatever the branches look like.
     */
    computed.sort(
      (a, b) => stageNames.indexOf(b.target) - stageNames.indexOf(a.target),
    );
    const furthest = computed[0]!;
    // Stored in the order the repositories are configured, which is the order
    // the card is read in — one order instead of two, and the flat columns
    // then describe the repository the user put first.
    const ordered = orderSides(
      computed.map((c) => ({ ...c, repo: c.side.repo })),
      cfg.repos,
    );
    const head = ordered[0]!;
    const branch = head.branch;
    const sides = ordered.map((c) => c.side);
    const stage = card
      ? advanceStage(card.stage, furthest.target, stageNames)
      : furthest.target;

    if (!card) {
      return {
        branch,
        issueKey,
        action: "create",
        noteId: null,
        issueKeys: keysOf.get(issueKey) ?? [issueKey],
        currentBranch: "",
        currentStage: "",
        stage: stage || stageNames[0] || "",
        title:
          summaries[issueKey]?.summary ||
          titleFromBranch(branch.name, issueKey),
        envState: head.envs,
        landedVia: head.side.landedVia,
        sides,
      };
    }

    const sameBranch = card.branch.trim() === branch.name;
    // A pinned card that resolved to something else means the branch it was
    // pinned to is gone or renamed — never a silent re-point.
    const pinBroken =
      card.githubPinned && !pinnedHit.has(`${issueKey}#${card.repo}`);
    // Every measured field lives on a side now, so one comparison covers the
    // lot — including a request opened against the next environment, which
    // changes nothing else on the card and used to go unnoticed.
    const fresh =
      sameBranch &&
      card.repo === branch.repo &&
      serializeCardSides(card.sides) === serializeCardSides(sides) &&
      JSON.stringify(card.issueKeys) ===
        JSON.stringify(mergedKeys(card, keysOf.get(issueKey) ?? [issueKey])) &&
      !stage;

    return {
      branch,
      issueKey,
      action: fresh
        ? "match"
        : pinBroken || (card.branch.trim() && !sameBranch)
          ? "conflict"
          : "fill",
      noteId: card.id,
      issueKeys: mergedKeys(card, keysOf.get(issueKey) ?? [issueKey]),
      currentBranch: card.branch,
      currentStage: card.stage,
      stage,
      title: card.title,
      envState: head.envs,
      landedVia: head.side.landedVia,
      sides,
    };
  });

  // Cards pointing at a branch that is no longer on GitHub.
  //
  // Scoped to repos this scan actually read: a card from a repo since removed
  // from the list, or from a repo that failed, has not been shown to be gone —
  // only unlooked-for. Reporting those would invite deleting cards over a typo
  // in the repo list.
  const readRepos = new Set(cfg.repos.filter((r) => !skipped.includes(r)));
  const liveBranches = new Set(branches.map((b) => `${b.repo}#${b.name}`));

  // Clones this scan actually opened, and every branch found in them. A
  // never-pushed branch lives nowhere but a clone, so the clone is the only
  // place that can report it deleted — skipping those cards entirely, as this
  // used to, left them on the board forever after the branch was thrown away.
  const readPaths = new Set(
    local.branches
      .map((b) => b.path)
      .concat(
        cfg.localPaths.filter((p) => !local.bad.some((x) => x.path === p)),
      ),
  );
  const localSeen = new Set(local.branches.map((b) => `${b.repo}#${b.name}`));

  /** Whether one repository's branch is provably gone, not merely unlooked-for. */
  const sideGone = (s: {
    repo: string;
    branch: string;
    localOnly: boolean;
    localPath: string;
  }) => {
    const key = `${s.repo}#${s.branch.trim()}`;
    if (!s.repo || !s.branch.trim()) return false;
    // Never pushed: judged against the clone it came from, and only when that
    // clone was readable this time round.
    if (s.localOnly)
      return (
        Boolean(s.localPath) && readPaths.has(s.localPath) && !localSeen.has(key)
      );
    return readRepos.has(s.repo) && !liveBranches.has(key);
  };

  const gone: GoneCard[] = allCards
    .filter((c) => {
      // Every repository the fix touched, not only the first.
      //
      // This read `c.repo`/`c.branch` — the flat columns, which mirror the
      // first side — so a card whose iOS branch had been deleted was reported
      // as shipped while its SDK branch was still open and still being worked
      // on. The suggested action for this list is "clear the card", which is
      // the one action that half-finished work cannot afford.
      const owned = c.sides.filter((s) => s.repo && s.branch.trim());
      return owned.length > 0 && owned.every(sideGone);
    })
    .map((c) => ({
      id: c.id,
      issueKey: c.issueKey,
      title: c.title,
      branch: c.branch,
      repo: c.repo,
      stage: c.stage,
      bodyLines: c.body.split("\n").filter((l) => l.trim()).length,
      prUrl: c.prUrl,
      prState: c.sides[0]?.prs[0]?.state ?? "",
    }));

  // Pinned cards the key-matching above never reached.
  //
  // Pairing runs through the Jira key parsed out of a branch name, so a card
  // whose key is not that exact string is invisible to it — a card keyed
  // "VT-306" will never be found by a branch yielding "VTL-555". Matching on
  // the repo and branch it already names catches those, whether the user said
  // so by pinning a link or by renaming the key. Without it such a card simply
  // stops being updated, which is how it ends up looking like a stray beside a
  // freshly created duplicate. Searched across every branch, not just the ones
  // the identity rules claimed: pointing a card at a colleague's branch is a
  // legitimate thing to do.
  const claimed = new Set(rows.map((r) => r.issueKey));
  const byRepoBranch = new Map(branches.map((b) => [`${b.repo}#${b.name}`, b]));

  for (const card of allCards) {
    if (!card.repo || !card.branch.trim()) continue;
    if (claimed.has(card.issueKey)) continue;

    const found = byRepoBranch.get(`${card.repo}#${card.branch.trim()}`);
    if (!found) continue;
    const pinned = card.sides
      .find((x) => x.repo === card.repo)
      ?.prs.find((p) => p.pinned && p.number)?.number;
    const branch = pinned ? { ...found, pr: pickPr(found.prs, pinned) } : found;

    const envs2 = envState[`${branch.repo}#${branch.name}`] ?? {};
    // A pinned card whose key its branch does not name — "VT-365" on a branch
    // reading VT-17252 — is never in `keys`, so the loop above has nothing for
    // it. Its own pinned request is the better source anyway: the user named
    // the pull request that carried this work, so that is when it landed.
    const target = stageFor(
      envs2,
      branch.pr,
      stages,
      branch.prs,
      builtBranchesOf(card),
    );

    // Only this repository's side is re-measured here; the card's other sides
    // are carried through untouched. This branch of the scan exists for a card
    // whose key its branch does not name, so the loop above never saw it — and
    // it saw only the one branch the card points at.
    const mine: CardSide = {
      repo: branch.repo,
      branch: branch.name,
      prs: mergeCardPrs(
        prsForCard(branch.prs),
        card.sides.find((x) => x.repo === branch.repo)?.prs ?? [],
        livePins,
      ),
      envState: envJson(envs2),
      landedVia: via.get(`${branch.repo}#${card.issueKey}`) ?? "",
      branchGone: false,
      localAhead: branch.local?.ahead ?? 0,
      localOnly: Boolean(branch.local?.onlyLocal),
      localPath: branch.local?.path ?? "",
      branchUpdatedAt: branch.committedAt || null,
    };
    /**
     * The card's other repositories, taken from the scan when it saw them.
     *
     * `best` is keyed by the ticket a *branch name* spells, which is how the
     * SDK half of this fix is found: the card is `VT-853`, its branch is
     * `ctalk/bugfix/VTL-286_VTL-610`, and the SDK branch of the same work is
     * filed under `VTL-286`. Falling back to what the card already stored
     * keeps a side the scan could not see this time.
     */
    const others = new Map<string, CardSide>();
    for (const x of card.sides) {
      if (x.repo === branch.repo) continue;
      // Carried through, but re-measured. Once a side is stored, its branch is
      // "claimed" and drops out of `best`, so nothing below would refresh it —
      // and it would keep the environment state it was first written with for
      // ever. `measure` above asks about every side of every card for exactly
      // this reason.
      const fresh = envState[`${x.repo}#${x.branch}`];
      // Local state is re-read here for the same reason `measure` re-reads the
      // environment: a claimed side never comes back through `best`, so
      // carrying it through untouched froze "chưa push" at whatever it was the
      // day the branch was first seen.
      const [withLocal] = withLocalState(
        [fresh ? { ...x, envState: envJson(fresh) } : x],
        localState,
      );
      others.set(x.repo, withLocal);
    }
    for (const k of extractIssueKeys(branch.name, cfg.projectKeys)) {
      for (const b of [...(best.get(k)?.values() ?? [])]) {
        if (b.repo === branch.repo) continue;
        const envs3 = envState[`${b.repo}#${b.name}`] ?? {};
        others.set(b.repo, {
          repo: b.repo,
          branch: b.name,
          prs: mergeCardPrs(
            prsForCard(b.prs),
            card.sides.find((x) => x.repo === b.repo)?.prs ?? [],
            livePins,
          ),
          envState: envJson(envs3),
          landedVia: via.get(`${b.repo}#${k}`) ?? "",
          branchGone: false,
          localAhead: b.local?.ahead ?? 0,
          localOnly: Boolean(b.local?.onlyLocal),
          localPath: b.local?.path ?? "",
          branchUpdatedAt: b.committedAt || null,
        });
      }
    }

    // Least advanced first, same rule the key-matched rows use.
    const sides = orderSides([mine, ...others.values()], cfg.repos);

    // One rule, one function — the same one the key-matched rows above, the
    // cheap refresh and the editor's save use.
    void target;
    const stage = advanceStage(
      card.stage,
      cardStage(sides, card.builds, stages),
      stageNames,
    );
    const fresh =
      serializeCardSides(card.sides) === serializeCardSides(sides) && !stage;

    rows.push({
      branch,
      issueKey: card.issueKey,
      action: fresh ? "match" : "fill",
      noteId: card.id,
      issueKeys: card.issueKeys,
      currentBranch: card.branch,
      currentStage: card.stage,
      stage,
      title: card.title,
      envState: envs2,
      landedVia: mine.landedVia,
      sides,
    });
  }

  const shown = new Set(rows.map((r) => `${r.branch.repo}#${r.branch.name}`));
  const localHidden = branches
    .filter(
      (b) => (b.local?.ahead ?? 0) > 0 && !shown.has(`${b.repo}#${b.name}`),
    )
    .map((b) => ({ repo: b.repo, branch: b.name, ahead: b.local!.ahead }))
    .sort((a, b) => b.ahead - a.ahead);

  // Most recent branch first: the plan is read top-down and today's work is
  // what the user can actually verify at a glance.
  rows.sort((a, b) => b.branch.committedAt - a.branch.committedAt);

  return {
    rows,
    scanned: branches.length,
    mine: mine.length,
    mineBy: byRule,
    unmatched,
    unmatchedSamples,
    candidates: candidateProjectKeys(unmatchedNames).filter(
      (c) => !cfg.projectKeys.some((k) => k.toUpperCase() === c.key),
    ),
    skipped,
    truncated,
    localOnly: localOnlyCount,
    localAheadOf: localAheadCount,
    badPaths: local.bad,
    localHidden,
    gone,
  };
}

/**
 * For each (repo, issue key): which environments already hold that key's work,
 * judged by the merge commit of the newest merged pull request naming it.
 *
 * A revert is disqualifying rather than merely ignored. Its merge commit sits
 * in the environment exactly like the original's, so skipping it would leave
 * the earlier merge saying "arrived" about code that has since been taken out.
 * When the newest merge for a key is a revert, the key is treated as not
 * landed at all.
 */
async function landedByKey(
  token: string,
  keys: string[],
  /** `issueKey` → `repo` → that repository's branch. */
  best: Map<string, Map<string, RemoteBranch>>,
  envs: StageConfig[],
  projectKeys: string[],
  /** `repo#key` → merge commit and head branch of a request pinned by hand. */
  pinnedMerge: Map<string, { sha: string; head: string; at: number }>,
): Promise<
  Record<string, { envs: Record<string, boolean>; via: string; at: number }>
> {
  const out: Record<
    string,
    { envs: Record<string, boolean>; via: string; at: number }
  > = {};
  if (!envs.length || !keys.length) return out;

  const repos = [
    ...new Set(keys.flatMap((k) => [...(best.get(k)?.keys() ?? [])])),
  ];

  for (const repo of repos) {
    const prs = await fetchMergedPrs(token, repo).catch(() => []);
    if (!prs.length) continue;

    // Newest merge per key wins, so a later revert displaces an earlier merge.
    const newest = new Map<string, (typeof prs)[number]>();
    for (const pr of prs) {
      const key = extractIssueKey(pr.headRefName, projectKeys);
      if (!key) continue;
      const prev = newest.get(key);
      if (!prev || pr.mergedAt > prev.mergedAt) newest.set(key, pr);
    }

    // A pinned pull request outranks everything worked out here, revert guard
    // included. The user looked at the repository and said "this is the merge
    // that carried it" — this function only ever guessed at that, and it can
    // guess wrong.
    const inRepo = keys.filter((k) => best.get(k)?.has(repo));
    const chosen = new Map<string, { sha: string; head: string; at: number }>();
    for (const k of inRepo) {
      const pinned = pinnedMerge.get(`${repo}#${k}`);
      if (pinned) chosen.set(k, pinned);
      else if (newest.has(k) && !isRevertBranch(newest.get(k)!.headRefName)) {
        const pr = newest.get(k)!;
        chosen.set(k, {
          sha: pr.mergeCommit,
          head: pr.headRefName,
          at: Math.floor(new Date(pr.mergedAt).getTime() / 1000) || 0,
        });
      }
    }
    const usable = [...chosen.keys()];
    if (!usable.length) continue;

    const shas = [...new Set(usable.map((k) => chosen.get(k)!.sha))];
    const contained = await fetchShaContainment(token, repo, shas, envs).catch(
      () => ({}) as Record<string, Record<string, boolean>>,
    );

    for (const key of usable) {
      const pick = chosen.get(key)!;
      const per = contained[pick.sha];
      // The head branch is only meaningful when it is not the card's own: a
      // branch merged under its own name did not take a detour, and saying it
      // did would invent a warning.
      if (per)
        out[`${repo}#${key}`] = {
          envs: per,
          via: pick.head === best.get(key)?.get(repo)?.name ? "" : pick.head,
          at: pick.at,
        };
    }
  }

  return out;
}

/**
 * Rows a one-click refresh may write without being read first.
 *
 * `conflict` is excluded: it overwrites a branch name typed by hand, which is
 * the one change here that destroys something, and destroying it silently on a
 * refresh button would be indefensible.
 */
/** Environments a card has a recorded build for. */
function builtBranchesOf(card: { builds: CardBuild[] } | null): string[] {
  return card ? card.builds.flatMap((b) => (b.branch ? [b.branch] : [])) : [];
}

export function safeRows(rows: PlanRow[]): PlanRow[] {
  return rows.filter((r) => r.action === "create" || r.action === "fill");
}

/**
 * Writes the chosen rows. Returns how many cards were touched.
 *
 * Takes the rows back from the client rather than re-scanning so that what is
 * applied is exactly what was reviewed — a second scan could return different
 * data and quietly apply something nobody agreed to.
 */
export function applyPlan(
  rows: PlanRow[],
  goneIds: number[] = [],
): { written: number; markedGone: number } {
  const markedGone = markBranchesGone(goneIds);

  let n = 0;
  for (const row of rows) {
    if (row.action === "match") continue;
    applyGitHubBranch({
      id: row.noteId,
      issueKey: row.issueKey,
      issueKeys: row.issueKeys,
      title: row.title,
      // Every GitHub field now travels as a side; the store derives the flat
      // columns from the first, so the two can never disagree.
      sides: row.sides,
      stage: row.stage,
    });
    n++;
  }
  return { written: n, markedGone };
}
