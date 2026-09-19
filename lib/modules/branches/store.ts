import "server-only";

import { desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { getStages } from "./config";
import {
  type CardBuild,
  newestCardBuild,
  parseBuildNumber,
  parseCardBuilds,
  serializeCardBuilds,
} from "./build-model";
import {
  advanceStage,
  asPullRequest,
  cardStage,
  mergeCardPrs,
  parseCardPrs,
  parseCardSides,
  pickPr,
  serializeCardSides,
  prStateTag,
  serializeCardPrs,
} from "./github-model";
import { taskNotes } from "@/lib/db/schema";

import {
  type CardSide,
  type TaskNoteRow,
  type TaskNoteShape,
  parseIssueKeys,
  parseJiraUrls,
  serializeJiraUrls,
} from "./model";

export type { TaskNoteRow } from "./model";

const stamp = () => sql`(strftime('%s','now'))` as unknown as number;

function toRow(r: typeof taskNotes.$inferSelect): TaskNoteRow {
  return {
    id: r.id,
    issueKey: r.issueKey,
    issueKeys: parseIssueKeys(r.issueKeys, r.issueKey),
    title: r.title,
    branch: r.branch,
    stage: r.stage,
    body: r.body,
    repo: r.repo,
    prUrl: r.prUrl,
    sides: parseCardSides(r.sides, r),
    branchPins: parseCardSides(r.sides, r)
      .filter((side) => side.pinned)
      .map((side) => ({ repo: side.repo, branch: side.branch })),
    prPins: parseCardSides(r.sides, r).flatMap((side) =>
      side.prs
        .filter((p) => p.pinned && p.number)
        .map((p) => ({ repo: side.repo, base: p.base, number: p.number })),
    ),
    envState: r.envState,
    branchGone: r.branchGone,
    githubPinned: r.githubPinned,
    localAhead: r.localAhead,
    localOnly: r.localOnly,
    localPath: r.localPath,
    jiraUrls: parseJiraUrls(r.jiraUrls, r.jiraUrl, r.issueKey),
    build: r.build,
    buildBranch: r.buildBranch,
    buildAt: r.buildAt,
    builds: parseCardBuilds(r.builds, r),
    syncedAt: r.syncedAt,
    updatedAt: r.updatedAt,
  };
}

export function listTaskNotes(): TaskNoteRow[] {
  return db
    .select()
    .from(taskNotes)
    .orderBy(desc(taskNotes.updatedAt))
    .all()
    .map(toRow);
}

/**
 * The cards for a set of Jira issues, keyed by issue key.
 *
 * The task board calls this with every subtask on screen, so it is one query
 * rather than one per row. Keys the caller has no card for are simply absent.
 */
export function taskNotesByIssue(keys: string[]): Record<string, TaskNoteRow> {
  const wanted = new Set(
    keys.filter(Boolean).map((k) => k.trim().toUpperCase()),
  );
  if (!wanted.size) return {};

  // Scanned in memory rather than matched in SQL: a card's secondary keys live
  // in a JSON column, and one branch fixing two tickets means the task board
  // must find the same card under either of them. This table holds tens of
  // rows, so the whole-table read costs nothing worth optimising away.
  const out: Record<string, TaskNoteRow> = {};
  for (const r of db.select().from(taskNotes).all()) {
    const row = toRow(r);
    for (const k of row.issueKeys) if (wanted.has(k)) out[k] = row;
  }
  return out;
}

export function getTaskNote(id: number): TaskNoteRow | null {
  const row = db.select().from(taskNotes).where(eq(taskNotes.id, id)).get();
  return row ? toRow(row) : null;
}

/**
 * Creates or updates a card.
 *
 * Resolution order is id, then issue key: the task board saves without knowing
 * whether a card already exists for the row it is on, and a second card for the
 * same issue would split that issue's notes in two — the exact failure this is
 * meant to prevent. Ticketless cards (`issueKey === ''`) always insert, since
 * there is nothing to match them on.
 *
 * `github` is the one way the editor may touch fields a scan owns. It exists
 * because the scan can pair a card with the wrong branch — the same branch name
 * lives in two repos here — and a board with no way to correct that would be
 * worse than one that never guessed. Supplying it pins the card.
 */
export function saveTaskNote(
  input: TaskNoteShape & {
    id?: number;
    github?: { repo: string; prNumber: number | null; prUrl: string } | null;
  },
): number {
  // Where the card points *now*, so a link edit that only names a pull request
  // does not throw away environment data measured for the same branch.
  const before =
    input.id !== undefined
      ? db.select().from(taskNotes).where(eq(taskNotes.id, input.id)).get()
      : input.issueKey.trim()
        ? db
            .select()
            .from(taskNotes)
            .where(eq(taskNotes.issueKey, input.issueKey.trim()))
            .get()
        : undefined;

  const movedTarget = Boolean(
    input.github &&
    (input.github.repo !== (before?.repo ?? "") ||
      input.branch.trim() !== (before?.branch ?? "")),
  );

  /**
   * Recomputed on save, not only on a scan.
   *
   * Hand-editing exists because a build can ship without the note that names
   * its tickets — so someone types the number in. Writing that number and then
   * leaving the card in its old column until the next scan makes the edit look
   * like it did nothing. `cardStage` needs no network: every input is on the
   * card already.
   *
   * Forward only, through the same `advanceStage` a scan uses, so the column
   * the user picked in the form is never dragged backwards by this.
   */
  const recomputed = (sides: CardSide[], builds: CardBuild[]): string => {
    const stages = getStages();
    const target = cardStage(sides, builds, stages);
    const forward = advanceStage(
      input.stage,
      target,
      stages.map((x) => x.name),
    );
    return forward || input.stage;
  };

  const sideValues = (() => {
    const was = parseCardSides(before?.sides ?? "", {
      repo: before?.repo ?? "",
      branch: before?.branch ?? "",
      prs: before?.prs ?? "",
      prNumber: before?.prNumber ?? null,
      prUrl: before?.prUrl ?? "",
      prState: before?.prState ?? "",
      prBase: before?.prBase ?? "",
      envState: before?.envState ?? "",
      landedVia: before?.landedVia ?? "",
      branchGone: Boolean(before?.branchGone),
      localAhead: before?.localAhead ?? 0,
      localOnly: Boolean(before?.localOnly),
      localPath: before?.localPath ?? "",
      branchUpdatedAt: before?.branchUpdatedAt ?? null,
    });
    const sides = was.map((side) => ({
      ...side,
      prs: mergeCardPrs(
        side.prs.filter((p) => !p.pinned),
        input.prPins
          .filter((p) => p.repo === side.repo && p.number)
          .map((p) => ({
            number: p.number,
            url: side.prs.find((x) => x.number === p.number)?.url ?? "",
            state: side.prs.find((x) => x.number === p.number)?.state ?? "",
            base: p.base,
            pinned: true as const,
          })),
      ),
    }));
    // The branch box at the top of the form still edits the first side; the
    // per-repository boxes below edit the rest. A pinned branch is one the
    // scan may not re-point.
    if (sides[0]) sides[0] = { ...sides[0], branch: input.branch.trim() };
    for (const pin of input.branchPins) {
      const at = sides.findIndex((x) => x.repo === pin.repo);
      if (at < 0 || !pin.branch.trim()) continue;
      sides[at] = { ...sides[at], branch: pin.branch.trim(), pinned: true };
    }
    // Cleared boxes drop the pin and hand the repository back to the scan.
    for (let i = 0; i < sides.length; i++) {
      const kept = input.branchPins.some(
        (p) => p.repo === sides[i].repo && p.branch.trim(),
      );
      if (sides[i].pinned && !kept) sides[i] = { ...sides[i], pinned: false };
    }
    const head = sides[0];
    const best = head ? pickPr(head.prs.map(asPullRequest)) : null;
    return {
      list: sides,
      sides: serializeCardSides(sides),
      prUrl: best?.url ?? "",
    };
  })();

  // A build number is a wall-clock stamp, so one typed in by hand can be
  // ordered against the ones a scan finds. Without this it sorted as zero and
  // the next scan could replace a deliberate entry with an older build.
  const buildValues = (() => {
    const list = input.builds.flatMap((b) =>
      b.build.trim()
        ? [
            {
              branch: b.branch.trim(),
              build: b.build.trim(),
              at: b.at || parseBuildNumber(b.build.trim()),
            },
          ]
        : [],
    );
    return {
      list,
      builds: serializeCardBuilds(list),
      ...newestCardBuild(list),
    };
  })();

  const values = {
    issueKey: input.issueKey.trim(),
    issueKeys: JSON.stringify(
      parseIssueKeys(JSON.stringify(input.issueKeys), input.issueKey),
    ),
    title: input.title.trim(),
    branch: input.branch.trim(),
    stage: recomputed(sideValues.list, buildValues.list),
    body: input.body,
    jiraUrls: serializeJiraUrls(input.jiraUrls),
    ...(({ list: _s, ...rest }) => rest)(sideValues),
    ...(({ list: _b, ...rest }) => rest)(buildValues),
    // Kept in step with the map so the column it grew out of never disagrees
    // with it — the task board still reads this one.
    jiraUrl: (input.jiraUrls[input.issueKey.trim().toUpperCase()] ?? "").trim(),
    updatedAt: stamp(),
    // Undefined leaves the stored link alone; null is the explicit "clear it".
    ...(input.github === undefined
      ? {}
      : input.github === null
        ? {
            repo: "",
            prNumber: null,
            prUrl: "",
            prState: "",
            prBase: "",
            envState: "",
            landedVia: "",
            githubPinned: false,
          }
        : {
            repo: input.github.repo,
            prNumber: input.github.prNumber,
            prUrl: input.github.prUrl,
            githubPinned: true,
            // Only wipe the measured position when the card now points somewhere
            // else. Pasting a pull-request URL for the branch already on the card
            // changes nothing about where that code is, and blanking it there
            // made the environment strip vanish until the next scan.
            ...(movedTarget
              ? {
                  envState: "",
                  prState: "",
                  prBase: "",
                  landedVia: "",
                }
              : {}),
          }),
  };

  const id =
    input.id ??
    (values.issueKey
      ? db
          .select()
          .from(taskNotes)
          .where(eq(taskNotes.issueKey, values.issueKey))
          .get()?.id
      : undefined);

  if (id) {
    db.update(taskNotes).set(values).where(eq(taskNotes.id, id)).run();
    return id;
  }
  return db
    .insert(taskNotes)
    .values(values)
    .returning({ id: taskNotes.id })
    .get().id;
}

/**
 * One branch from a GitHub scan, written onto its card.
 *
 * Deliberately narrow: it touches the branch, the PR fields and — only when
 * given one — the stage. `body` and `title` on an existing card are the user's
 * writing and are never rewritten by a scan, which is the difference between a
 * sync that helps and one nobody dares run twice.
 */
export function applyGitHubBranch(input: {
  /** Existing card, or null to create one. */
  id: number | null;
  issueKey: string;
  /** Every ticket the branch names. Replaces the card's list on each scan. */
  issueKeys: string[];
  /** Only used when creating — an existing card keeps the title it has. */
  title: string;
  /** One per repository, least advanced first. */
  sides: CardSide[];
  /** '' leaves the card in the column it is in. */
  stage: string;
}): number {
  // The flat columns are the first side, derived here so a scan cannot leave a
  // card whose columns and side list disagree.
  const head = input.sides[0];
  const best = head ? pickPr(head.prs.map(asPullRequest)) : null;
  const github = {
    sides: serializeCardSides(input.sides),
    // Only the columns another screen reads are copied out of the first side.
    // Everything else lives in `sides` alone — the same fact in two places,
    // written from three functions, is a fact that drifts with nothing to
    // notice it.
    branch: head?.branch ?? "",
    repo: head?.repo ?? "",
    prUrl: best?.url ?? "",
    envState: head?.envState ?? "",
    localAhead: head?.localAhead ?? 0,
    localOnly: Boolean(head?.localOnly),
    // A branch the scan just read is by definition still there, so this clears
    // any earlier "gone" mark — a deleted branch that gets pushed again must
    // not stay flagged as finished.
    issueKeys: JSON.stringify(input.issueKeys),
    branchGone: false,
    syncedAt: stamp(),
    updatedAt: stamp(),
  };

  const id =
    input.id ??
    (input.issueKey
      ? db
          .select()
          .from(taskNotes)
          .where(eq(taskNotes.issueKey, input.issueKey))
          .get()?.id
      : undefined);

  if (id) {
    db.update(taskNotes)
      .set(input.stage ? { ...github, stage: input.stage } : github)
      .where(eq(taskNotes.id, id))
      .run();
    return id;
  }

  return db
    .insert(taskNotes)
    .values({
      ...github,
      issueKey: input.issueKey,
      title: input.title,
      stage: input.stage,
      body: "",
      jiraUrl: "",
      jiraUrls: "",
    })
    .returning({ id: taskNotes.id })
    .get().id;
}

/** Ticking a checklist item — the other edit made without opening the card. */
export function setNoteBody(id: number, body: string) {
  db.update(taskNotes)
    .set({ body, updatedAt: stamp() })
    .where(eq(taskNotes.id, id))
    .run();
}

/** Moving a card between columns — the one edit made without opening the card. */
export function moveTaskNote(id: number, stage: string) {
  db.update(taskNotes)
    .set({ stage, updatedAt: stamp() })
    .where(eq(taskNotes.id, id))
    .run();
}

export function deleteTaskNote(id: number) {
  db.delete(taskNotes).where(eq(taskNotes.id, id)).run();
}

/**
 * Deletes several cards at once. Returns how many rows actually went.
 *
 * The count is returned rather than assumed from the input length because the
 * board deletes from an optimistic client list, and a card already removed in
 * another tab would otherwise be reported as deleted twice.
 */
export function deleteTaskNotes(ids: number[]): number {
  const wanted = ids.filter((n) => Number.isInteger(n));
  if (!wanted.length) return 0;
  return db.delete(taskNotes).where(inArray(taskNotes.id, wanted)).run()
    .changes;
}

/**
 * Records that a scan could no longer find these branches on GitHub.
 *
 * Deliberately does not delete them. The branch vanishing is what *starts* the
 * conversation — the notes on the card may still be worth reading, and throwing
 * them away on the app's own initiative is not a decision this code gets to
 * make. It marks; the user clears.
 */
export function markBranchesGone(ids: number[]): number {
  const wanted = ids.filter((n) => Number.isInteger(n));
  if (!wanted.length) return 0;

  const stages = getStages();
  const names = stages.map((s) => s.name);
  let n = 0;

  for (const id of wanted) {
    const row = db.select().from(taskNotes).where(eq(taskNotes.id, id)).get();
    // Skips rows already flagged, so the count is what actually became gone
    // this time. Without it every scan re-reported the same cards and the
    // button said "2 nhánh đã mất" forever.
    if (!row || row.branchGone) continue;

    /**
     * Flipped on every side, not only the flat columns.
     *
     * The scan only lists a card here once *all* of its repositories have lost
     * their branch, so this is not a guess — and the card reads its sides, not
     * the flat copy, to decide whether there is anything left to clean up.
     * Writing one and not the other left the board asking for a branch to be
     * deleted that had been deleted a week earlier.
     */
    const sides = parseCardSides(row.sides, row).map((side) => ({
      ...side,
      branchGone: true,
    }));

    // The branch going is the last column's entry condition, so this is the
    // one write that can complete a card — same `advanceStage` guard as every
    // other automatic move, which is what stops it dragging anything back.
    const stage = advanceStage(
      row.stage,
      cardStage(sides, parseCardBuilds(row.builds, row), stages),
      names,
    );

    db.update(taskNotes)
      .set({
        branchGone: true,
        sides: serializeCardSides(sides),
        ...(stage ? { stage } : {}),
        updatedAt: stamp(),
      })
      .where(eq(taskNotes.id, id))
      .run();
    n++;
  }

  return n;
}

/**
 * Records which build a card's work shipped in.
 *
 * Driven by the build's own release note, so this is the one place the board
 * states a build's contents rather than inferring them. Returns how many cards
 * changed, which is what the strip reports.
 */
/**
 * Write back just the pull requests, per repository, and the column if it moved.
 *
 * Deliberately narrow. `applyGitHubBranch` is the scan's write and touches
 * everything a scan measured — environment state, `syncedAt`, the "branch
 * gone" mark. Reusing it here would have the cheap refresh claim to have
 * measured things it never looked at, and would clear a gone-branch mark on
 * the strength of a query that cannot tell whether the branch exists.
 */
/**
 * Moves cards whose tickets Jira has closed into the pipeline's last column.
 *
 * Lives here, driven by the page, because the page is the only place that
 * holds both halves — the cards and a fresh answer from Jira — and it already
 * has that answer for the drift badges, so this costs no extra call.
 *
 * Only forward, through the same `advanceStage` guard as every other automatic
 * move. A card dragged past the last column cannot exist, so in practice this
 * either moves a card to the end or does nothing; what the guard really buys
 * is that a pipeline with no terminal column is left entirely alone.
 */
export function settleFinishedCards(ids: number[]): number {
  const wanted = ids.filter((n) => Number.isInteger(n));
  if (!wanted.length) return 0;

  const stages = getStages();
  const names = stages.map((s) => s.name);
  let n = 0;

  for (const id of wanted) {
    const row = db.select().from(taskNotes).where(eq(taskNotes.id, id)).get();
    if (!row) continue;
    const stage = advanceStage(
      row.stage,
      cardStage(
        parseCardSides(row.sides, row),
        parseCardBuilds(row.builds, row),
        stages,
        true,
      ),
      names,
    );
    if (!stage) continue;
    db.update(taskNotes)
      .set({ stage, updatedAt: stamp() })
      .where(eq(taskNotes.id, id))
      .run();
    n++;
  }

  return n;
}

export function setCardPrs(
  rows: Array<{
    id: number;
    sides: CardSide[];
    /** '' leaves the card in the column it is in. */
    stage: string;
  }>,
): number {
  let n = 0;
  for (const r of rows) {
    const head = r.sides[0];
    const best = head ? pickPr(head.prs.map(asPullRequest)) : null;
    n += db
      .update(taskNotes)
      .set({
        sides: serializeCardSides(r.sides),
        prUrl: best?.url ?? "",
        // Copied out of the first side for the same reason `saveCardGithub`
        // copies them: the board reads these columns, not the JSON. Leaving
        // them out here is how a card went on saying "chưa push" long after
        // the branch was pushed — `sides` had been corrected, the column had
        // not, and the column is what the screen draws. The header on
        // `saveCardGithub` warns about exactly this: one fact in two places,
        // written from more than one function, drifts with nothing to notice.
        localAhead: head?.localAhead ?? 0,
        localOnly: Boolean(head?.localOnly),
        localPath: head?.localPath ?? "",
        ...(r.stage ? { stage: r.stage } : {}),
        updatedAt: stamp(),
      })
      .where(eq(taskNotes.id, r.id))
      .run().changes;
  }
  return n;
}

export function setCardBuilds(
  rows: Array<{
    id: number;
    builds: CardBuild[];
    /** The card as it stands, so the column can be recomputed from it. */
    sides: CardSide[];
    stage: string;
  }>,
): number {
  const stages = getStages();
  const names = stages.map((x) => x.name);
  let n = 0;
  for (const r of rows) {
    // A build is the strongest evidence the board has, so recording one has to
    // move the card. This write is where a build first lands — the release
    // note named the ticket, nobody typed anything — and it used to set the
    // number and leave the column alone, so the card sat in `đã merge` with
    // the build plainly printed on it until the next full scan.
    //
    // Forward only, through the same `advanceStage` everything else uses.
    const stage = advanceStage(
      r.stage,
      cardStage(r.sides, r.builds, stages),
      names,
    );
    n += db
      .update(taskNotes)
      .set({
        // The flat fields are derived, never passed in: one source of truth
        // for "which build" is the list, and these follow from it.
        ...newestCardBuild(r.builds),
        builds: serializeCardBuilds(r.builds),
        ...(stage ? { stage } : {}),
        updatedAt: stamp(),
      })
      .where(eq(taskNotes.id, r.id))
      .run().changes;
  }
  return n;
}
