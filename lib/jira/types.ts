/**
 * Types and pure helpers shared by server and client code.
 *
 * Kept free of any server import on purpose: a Client Component that reached
 * into `issues.ts` for something as small as `statusTone` would drag the whole
 * chain — meta → db → node:fs — into the browser bundle and fail the build.
 */

export interface BoardSubtask {
  id: string;
  key: string;
  summary: string;
  statusId: string;
  statusName: string;
  parentKey: string | null;
  storyPoints: number | null;
  /** Total logged by everyone, all time — Jira's own `timespent`. */
  timeSpentSeconds: number;
  /** Logged by this user on the selected day; filled in by the worklog pass. */
  loggedTodaySeconds: number;
  /**
   * Latest day this user logged to it, `YYYY-MM-DD`, within the range the
   * board already fetched. Null when there is none in that window.
   *
   * Day-independent on purpose: "this task has time logged after it was
   * finished" is a fact about the task, not about the day being looked at, and
   * it has to be visible without hunting through the calendar for the day it
   * happened on.
   */
  lastLogDate: string | null;
  /** Creation time as epoch ms, for the board's created-date sort. 0 if unknown. */
  created: number;
  /** Planned start, YYYY-MM-DD. Null when the team has not filled it in. */
  startDate: string | null;
  /** Due date, YYYY-MM-DD. */
  dueDate: string | null;
  labels: string[];
}

export interface BoardParent {
  key: string;
  summary: string;
  issueTypeName: string;
  statusName: string;
  /** The epic above this task. `parent` on a standard issue IS the epic. */
  epicKey: string | null;
  epicName: string | null;
  /** What the parent currently records. */
  storyPoints: number | null;
  /**
   * Sum of its children's points — what it *should* record. Always the total
   * over every child, even when the board hides Done subtasks, so the "save"
   * suggestion never proposes overwriting the parent with a filtered subtotal.
   */
  childPointsTotal: number;
  /** How many children the parent has in total, matching `childPointsTotal`. */
  childCount: number;
  /**
   * Total time logged across *all* the parent's children, in seconds — the full
   * figure even when the board hides Done ones, so the header total never shrinks
   * with the status filter.
   */
  childTimeSpentTotal: number;
  /** Creation time as epoch ms, for the board's created-date sort. 0 if unknown. */
  created: number;
  startDate: string | null;
  dueDate: string | null;
  labels: string[];
  /**
   * Who owns the parent. Null when nobody has taken it, which is treated as
   * editable — an unowned task blocks nobody.
   */
  assigneeAccountId: string | null;
  assigneeName: string | null;
  /**
   * True when this parent carries no sprint at all, while the board is filtered
   * to one. Its children would otherwise be invisible here despite being the
   * user's own work — see {@link getBoard}.
   */
  outOfSprint: boolean;
  /** The children shown on the board — narrowed by the status filter. */
  subtasks: BoardSubtask[];
}

export interface SprintTask {
  key: string;
  summary: string;
  statusName: string;
  issueTypeName: string;
  storyPoints: number | null;
  subtaskCount: number;
  /** The epic this sits under. `parent` on a standard issue IS the epic. */
  epicKey: string | null;
  epicName: string | null;
  startDate: string | null;
  dueDate: string | null;
  labels: string[];
}

export interface Transition {
  id: string;
  name: string;
  toStatusId: string;
  toStatusName: string;
}

export type StatusTone = "todo" | "prog" | "test" | "ver" | "done";

/**
 * Colour bucket for a status. Derived from the name, not `statusCategory`:
 * this instance reports every status between To Do and Done as `indeterminate`,
 * so the category carries no usable signal. Casing is inconsistent in Jira
 * ("Ready For Test On Develop" vs "READY FOR TEST ON INTEGRATION"), hence the
 * case-insensitive compare — but callers must display Jira's exact string.
 *
 * The preposition varies too. This workflow's statuses read "READY TO TEST ON
 * DEVELOP"; matching only "READY FOR TEST" filed every one of them as work in
 * progress, which coloured them wrong everywhere and left the branches board
 * warning that a ticket was behind after it had already been moved — a warning
 * nothing the user did could clear.
 */
export function statusTone(name: string): StatusTone {
  const s = name.trim().toUpperCase();
  if (s === "DONE") return "done";
  if (s.startsWith("VERIFIED")) return "ver";
  if (/^READY\b.*\bTEST\b/.test(s)) return "test";
  if (s === "TO DO" || s === "TODO") return "todo";
  return "prog";
}

/**
 * Where a status sits in the workflow, for ordering cards by how far along they
 * are. Lower is earlier.
 *
 * `statusTone` answers a coarser question — which of five colours — so it files
 * "In Progress", "BLOCKED" and "COMMITED CODE FEATURE BRANCH" together, and all
 * three "READY TO TEST ON …" together. Sorting needs the real sequence.
 *
 * That sequence is not hard-coded: the names carry it. A status reading
 * "… ON DEVELOP" belongs to whichever environment the user's own pipeline calls
 * `develop`, and "READY TO TEST" precedes "VERIFIED" in the same environment.
 * So the order comes from the environment list the board is already configured
 * with, and renaming an environment keeps it working.
 *
 * Anything the rule cannot place — "In Progress", "BLOCKED", a status invented
 * next month — lands in the in-progress band rather than at either extreme:
 * unrecognised is neither finished nor untouched.
 */
export function statusRank(name: string, envNames: string[]): number {
  const s = name.trim().toUpperCase();
  if (s === "DONE") return 99;
  if (s === "TO DO" || s === "TODO") return 0;

  const test = /^READY\b.*\bTEST\b/.test(s);
  const verified = s.startsWith("VERIFIED");
  if (!test && !verified) return 1;

  // Which environment the status names. Matched on the environment's own name,
  // longest first so "integration" is not claimed by a shorter name inside it.
  const byLength = envNames
    .map((n, i) => ({ token: n.trim().toUpperCase(), i }))
    .filter((e) => e.token)
    .sort((a, b) => b.token.length - a.token.length);
  const hit = byLength.find((e) => s.includes(e.token));
  // An environment the pipeline does not list still sorts after the ones it
  // does, since it is a test state and those are the late ones.
  const env = hit ? hit.i : envNames.length;

  return 2 + env * 2 + (verified ? 1 : 0);
}

/* ── point rollup ────────────────────────────────────────────────────────── */

/** One subtask reduced to what a points rollup needs. */
export interface PointRow {
  key: string;
  statusName: string;
  storyPoints: number | null;
  /** Jira's own `timespent` on that subtask, seconds. */
  timeSpentSeconds: number;
}

export interface PointBucket {
  tone: StatusTone;
  points: number;
  tasks: number;
  seconds: number;
}

export interface PointsSummary {
  points: number;
  tasks: number;
  seconds: number;
  /**
   * Tasks carrying no estimate.
   *
   * Counted apart rather than folded in as zero, because the two are different
   * facts and only one is a problem: a task genuinely worth nothing does not
   * exist, so an unpointed one is an estimate nobody has written down. It
   * still contributes its hours, which is what makes the "giờ mỗi point"
   * figure drift on a sprint full of them — hence saying so.
   */
  unpointed: number;
  /**
   * Hours sitting on those unpointed tasks.
   *
   * Cannot be recovered from the buckets — an unpointed task lands in whichever
   * bucket its status puts it, mixed in with estimated ones — and without it
   * the "giờ mỗi point" figure would charge their hours to the tasks that do
   * carry an estimate.
   */
  unpointedSeconds: number;
  /** Non-empty buckets in workflow order, earliest first. */
  buckets: PointBucket[];
  /** Points on tasks Jira has closed — the numerator of "how much landed". */
  donePoints: number;
}

/**
 * Order the five tones sit in, earliest work first.
 *
 * Tone rather than {@link statusRank}: rank resolves "READY TO TEST ON
 * INTEGRATION" against a configured environment list, which belongs to the
 * branches board and has no business being dragged into the task board for the
 * sake of sorting five rows.
 */
const TONE_ORDER: StatusTone[] = ["todo", "prog", "test", "ver", "done"];

/**
 * A sprint's story points, grouped by how far along the work is.
 *
 * Pure so it can be checked without a network, and so the panel can be handed
 * rows from anywhere — the sprint, one epic, a filtered board.
 *
 * `done` here is the tone, so it is Jira's own closed state and nothing else.
 * Verified is kept as its own bucket rather than counted as landed: on this
 * workflow a verified ticket can still be reopened, and a completion figure
 * that moves backwards is worse than one that lags.
 */
export function summarisePoints(rows: PointRow[]): PointsSummary {
  const byTone = new Map<StatusTone, PointBucket>();
  let points = 0;
  let seconds = 0;
  let unpointed = 0;
  let unpointedSeconds = 0;

  for (const r of rows) {
    const tone = statusTone(r.statusName);
    const p = r.storyPoints ?? 0;
    if (r.storyPoints === null) {
      unpointed++;
      unpointedSeconds += r.timeSpentSeconds;
    }
    points += p;
    seconds += r.timeSpentSeconds;

    const b = byTone.get(tone) ?? { tone, points: 0, tasks: 0, seconds: 0 };
    b.points += p;
    b.tasks += 1;
    b.seconds += r.timeSpentSeconds;
    byTone.set(tone, b);
  }

  return {
    points,
    tasks: rows.length,
    seconds,
    unpointed,
    unpointedSeconds,
    buckets: TONE_ORDER.flatMap((t) => byTone.get(t) ?? []),
    donePoints: byTone.get("done")?.points ?? 0,
  };
}

/**
 * What a team requires of every issue it owns, checked against one issue.
 *
 * The board's saved filter is `labels in (ctalk)`, so an issue missing that
 * label is not merely untidy — it is invisible on the team's own board while
 * still being perfectly visible here, which is the confusing half. The prefix
 * and the two dates are the team's own conventions, unenforced by Jira.
 *
 * Pure and free of server imports so a row can call it while rendering.
 */
export interface IssueHygiene {
  missingLabel: boolean;
  missingPrefix: boolean;
  missingStartDate: boolean;
  missingDueDate: boolean;
  /** True when anything above is true — the badge's on/off switch. */
  any: boolean;
  /** One short Vietnamese phrase per problem, for the tooltip. */
  problems: string[];
}

export function issueHygiene(
  issue: {
    summary: string;
    labels: string[];
    startDate: string | null;
    dueDate: string | null;
  },
  team: { label: string | null; prefix: string | null },
): IssueHygiene {
  const missingLabel = Boolean(
    team.label &&
    !issue.labels.some((l) => l.toLowerCase() === team.label!.toLowerCase()),
  );
  const missingPrefix = Boolean(
    team.prefix &&
    !issue.summary.trim().toLowerCase().startsWith(team.prefix.toLowerCase()),
  );
  const missingStartDate = !issue.startDate;
  const missingDueDate = !issue.dueDate;

  const problems: string[] = [];
  if (missingLabel) problems.push(`thiếu label ${team.label}`);
  if (missingPrefix) problems.push(`thiếu tiền tố ${team.prefix}`);
  if (missingStartDate) problems.push("chưa có start date");
  if (missingDueDate) problems.push("chưa có due date");

  return {
    missingLabel,
    missingPrefix,
    missingStartDate,
    missingDueDate,
    any: problems.length > 0,
    problems,
  };
}

/**
 * An issue with time logged against it that is still sitting in To Do.
 *
 * The one status slip that needs no extra bookkeeping to detect: hours are
 * recorded against the issue, so somebody plainly started it, and the status
 * says otherwise. Bugs filed by QC are where this bites — they arrive To Do,
 * get worked on, and nobody remembers to move them, so they read as untouched
 * on the sprint board while carrying a day of logged work.
 *
 * Only To Do counts. Anything further along is a judgement call about how far
 * the work has got, and guessing at that would put a warning on every row.
 *
 * Pure and server-free so a row can call it while rendering.
 */
/**
 * Logging onto a day that falls after a finished task's due date.
 *
 * Two things that cannot both be right. A task marked Done carries a due date
 * saying when the work ended; a worklog dated after it says the work was still
 * going. One of the two is wrong — usually the due date, occasionally the
 * status, sometimes the day picked on the board — and nothing on screen used
 * to say they disagreed.
 *
 * Only for a task that is actually finished. Logging past the due date of a
 * task still in progress is an overrun, which is ordinary and frequent here;
 * warning about it would bury the case that matters.
 *
 * Dates are `YYYY-MM-DD`, so a string comparison is the date comparison.
 */
export function logDatePastDue(
  dueDate: string | null,
  logDate: string,
  statusName: string,
): boolean {
  if (!dueDate || !logDate) return false;
  if (statusTone(statusName) !== "done") return false;
  return logDate > dueDate;
}

export function loggedButTodo(
  timeSpentSeconds: number,
  statusName: string,
): boolean {
  return timeSpentSeconds > 0 && statusTone(statusName) === "todo";
}

/**
 * Whether a parent task belongs to somebody else, and so must not be edited
 * from this board.
 *
 * Three cases collapse into "editable": the task is mine, nobody has taken it,
 * or we do not know who is looking. Only a task explicitly assigned to another
 * person is locked — an unowned task blocks nobody, and failing open keeps a
 * missing account id from freezing every control on the board.
 *
 * Pure and server-free so the row can call it while rendering.
 */
export function isOwnedByOther(
  assigneeAccountId: string | null,
  myAccountId: string | null | undefined,
): boolean {
  if (!assigneeAccountId || !myAccountId) return false;
  return assigneeAccountId !== myAccountId;
}
