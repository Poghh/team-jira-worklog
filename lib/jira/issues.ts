import "server-only";

import {
  SETTING_KEYS,
  getSetting,
  getTeamScope,
  requireProjectKey,
} from "../settings";
import { textToAdf } from "./adf";
import { getBoardConfig } from "./board-config";
import {
  JiraError, type JiraIssue, jiraFetch, searchJql } from "./client";
import { getProjectMeta } from "./meta";
import type {
  BoardParent,
  BoardSubtask,
  PointRow,
  SprintTask,
  Transition,
} from "./types";

export type {
  BoardParent,
  BoardSubtask,
  PointRow,
  SprintTask,
  Transition,
} from "./types";
export { issueHygiene, statusTone } from "./types";

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Parses a Jira `created` timestamp to epoch ms; 0 when missing or unparseable. */
function ms(v: unknown): number {
  return typeof v === "string" ? Date.parse(v) || 0 : 0;
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * The clause that narrows every read to the team's own issues.
 *
 * One project can host several teams' boards, told apart by nothing but a label
 * — VipTalk splits CTALK-TEAM from HIR-TEAM that way. Without this the app shows
 * issues that do not appear on the board the user actually works from. Returns
 * an empty array when no team label is configured, leaving single-team setups
 * exactly as they were.
 */
function teamClauses(): string[] {
  const { label } = getTeamScope();
  return label ? [`labels = "${escapeJql(label)}"`] : [];
}

export interface BoardQuery {
  sprintId?: number | null;
  /** Substring match on summary or key. */
  search?: string;
  /** 'open' hides Done, 'all' shows everything. */
  status?: "open" | "all";
  /**
   * Issue ids that must appear even if Jira's index has not caught up.
   * An issue created seconds ago is missing from `search/jql` results until it
   * is indexed, which made a freshly created subtask invisible until the user
   * switched sprints and back.
   */
  reconcileIds?: string[];
}

/**
 * Keys of the standard-level issues sitting in a sprint.
 *
 * Needed because JQL cannot filter subtasks by sprint. A subtask *carries* a
 * sprint value when you read the field, but `sprint = X AND issuetype in
 * subTaskIssueTypes()` matches nothing — verified against this instance, and
 * true for `"Sprint"`, `sprint in (…)` and `cf[10020]` alike. So the sprint is
 * resolved on the parents, and subtasks are then fetched by `parent in (…)`.
 *
 * Parents are not filtered by assignee: someone else may own the parent Task
 * while the subtask is yours.
 */
async function sprintParentKeys(
  sprintId: number,
  projectKey: string,
): Promise<string[]> {
  const issues = await searchJql<JiraIssue>(
    `project = "${escapeJql(projectKey)}" AND sprint = ${sprintId} AND issuetype not in subTaskIssueTypes()`,
    ["summary"],
    { limit: 300 },
  );
  return issues.map((i) => i.key);
}

/**
 * The user's own subtasks whose parent belongs to no sprint at all.
 *
 * Sprint membership is resolved through the parent, so a task nobody remembered
 * to put in the sprint takes its children down with it — the work is assigned,
 * logged against, and invisible on the board it belongs to. That is a data slip
 * rather than a decision, so those children are pulled back in.
 *
 * A parent sitting in a *different* sprint is deliberate and stays hidden: that
 * set only grows as sprints go by, and showing it would empty the sprint filter
 * of meaning.
 *
 * Costs one extra search over the user's own subtasks — a small set, since it is
 * bounded by what one person has been assigned rather than by the project.
 */
async function sprintlessChildren(
  base: string[],
  fields: string[],
  alreadyShown: JiraIssue[],
  query: BoardQuery,
): Promise<{ issues: JiraIssue[]; parents: Set<string> }> {
  const meta = await getProjectMeta();
  const empty = { issues: [], parents: new Set<string>() };
  if (!meta.sprintFieldId) return empty;

  const mine = await searchJql<JiraIssue>(
    `${base.join(" AND ")} ORDER BY created DESC`,
    fields,
    { limit: 200, reconcileIssues: query.reconcileIds },
  );

  const shown = new Set(alreadyShown.map((i) => i.key));
  const candidates = mine.filter(
    (i) => !shown.has(i.key) && i.fields.parent?.key,
  );
  if (!candidates.length) return empty;

  // The child's own sprint field mirrors its parent's, but reading the parents
  // directly is what distinguishes "no sprint" from "a sprint we did not ask
  // for" — and it is the parent the fix button has to write to.
  const parentKeys = [...new Set(candidates.map((i) => i.fields.parent!.key))];
  const parents = await searchJql<JiraIssue>(
    `key in (${parentKeys.map((k) => `"${escapeJql(k)}"`).join(",")})`,
    ["summary", meta.sprintFieldId],
    { limit: parentKeys.length },
  );

  const sprintless = new Set(
    parents
      .filter((p) => {
        const raw = p.fields[meta.sprintFieldId!];
        return !Array.isArray(raw) || raw.length === 0;
      })
      .map((p) => p.key),
  );

  return {
    issues: candidates.filter((i) => sprintless.has(i.fields.parent!.key)),
    parents: sprintless,
  };
}

/**
 * The board shows subtasks assigned to the current user — nothing cleverer.
 * Narrowing is the filters' job, and picking up someone else's work belongs to
 * the search screen instead.
 */
export async function getBoard(query: BoardQuery = {}): Promise<BoardParent[]> {
  const meta = await getProjectMeta();
  const projectKey = requireProjectKey();

  const base = [
    `project = "${escapeJql(projectKey)}"`,
    "assignee = currentUser()",
    "issuetype in subTaskIssueTypes()",
    ...teamClauses(),
  ];

  if (query.status !== "all") base.push("statusCategory != Done");
  if (query.search?.trim()) {
    const term = escapeJql(query.search.trim());
    base.push(`(summary ~ "${term}*" OR key = "${term}")`);
  }

  const fields = [
    "summary",
    "status",
    "parent",
    "issuetype",
    "timespent",
    "created",
    "duedate",
    "labels",
  ];
  if (meta.storyPointsFieldId) fields.push(meta.storyPointsFieldId);
  if (meta.startDateFieldId) fields.push(meta.startDateFieldId);

  let issues: JiraIssue[];
  /** Parents that carry no sprint, whose children are shown in their own block. */
  let sprintlessParents = new Set<string>();

  if (query.sprintId) {
    const parentKeys = await sprintParentKeys(query.sprintId, projectKey);

    // `parent in (…)` with hundreds of keys makes an unwieldy query, so chunk it.
    const CHUNK = 50;
    const batches: Promise<JiraIssue[]>[] = [];
    for (let i = 0; i < parentKeys.length; i += CHUNK) {
      const chunk = parentKeys
        .slice(i, i + CHUNK)
        .map((k) => `"${k}"`)
        .join(",");
      batches.push(
        searchJql<JiraIssue>(
          `${[...base, `parent in (${chunk})`].join(" AND ")} ORDER BY created DESC`,
          fields,
          { limit: 200, reconcileIssues: query.reconcileIds },
        ),
      );
    }
    issues = (await Promise.all(batches)).flat();

    const stray = await sprintlessChildren(base, fields, issues, query);
    issues = issues.concat(stray.issues);
    sprintlessParents = stray.parents;
  } else {
    issues = await searchJql<JiraIssue>(
      `${base.join(" AND ")} ORDER BY created DESC`,
      fields,
      { limit: 200, reconcileIssues: query.reconcileIds },
    );
  }

  const subtasks: BoardSubtask[] = issues.map((issue) => ({
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary ?? "",
    statusId: issue.fields.status?.id ?? "",
    statusName: issue.fields.status?.name ?? "",
    parentKey: issue.fields.parent?.key ?? null,
    storyPoints: meta.storyPointsFieldId
      ? num(issue.fields[meta.storyPointsFieldId])
      : null,
    timeSpentSeconds: issue.fields.timespent ?? 0,
    loggedTodaySeconds: 0,
    lastLogDate: null,
    created: ms(issue.fields.created),
    startDate: meta.startDateFieldId
      ? str(issue.fields[meta.startDateFieldId])
      : null,
    dueDate: str(issue.fields.duedate),
    labels: strings(issue.fields.labels),
  }));

  // When the board hides Done subtasks, the fetched list is a subset of each
  // parent's children — so the child-points sum must be recovered separately,
  // otherwise the "save" suggestion would offer to overwrite the parent with a
  // filtered subtotal.
  const childrenFiltered = query.status !== "all";
  return groupByParent(
    subtasks,
    issues,
    {
      storyPointsFieldId: meta.storyPointsFieldId,
      startDateFieldId: meta.startDateFieldId,
    },
    projectKey,
    childrenFiltered,
    sprintlessParents,
  );
}

async function groupByParent(
  subtasks: BoardSubtask[],
  issues: JiraIssue[],
  fieldIds: {
    storyPointsFieldId: string | null;
    startDateFieldId: string | null;
  },
  projectKey: string,
  /** True when Done children were excluded from `subtasks` by the status filter. */
  childrenFiltered: boolean,
  /** Parents carrying no sprint, rendered in their own block on the board. */
  sprintlessParents: Set<string> = new Set(),
): Promise<BoardParent[]> {
  const { storyPointsFieldId, startDateFieldId } = fieldIds;
  const parentInfo = new Map<
    string,
    {
      summary: string;
      issueTypeName: string;
      statusName: string;
      epicKey: string | null;
      epicName: string | null;
      created: number;
      startDate: string | null;
      dueDate: string | null;
      labels: string[];
      assigneeAccountId: string | null;
      assigneeName: string | null;
    }
  >();
  for (const issue of issues) {
    const p = issue.fields.parent;
    if (p?.key && !parentInfo.has(p.key)) {
      parentInfo.set(p.key, {
        summary: p.fields?.summary ?? "",
        issueTypeName: p.fields?.issuetype?.name ?? "Task",
        statusName: "",
        epicKey: null,
        epicName: null,
        // A child's `parent` object carries no created date, dates or labels —
        // the direct fetch below fills them in.
        created: 0,
        startDate: null,
        dueDate: null,
        labels: [],
        assigneeAccountId: null,
        assigneeName: null,
      });
    }
  }

  // A parent's own story points do not come back on the child's `parent` object,
  // so fetch the parents directly. Without this the rollup mismatch — the whole
  // point of showing the parent row — cannot be computed.
  const parentPoints = new Map<string, number | null>();
  const keys = [...parentInfo.keys()];
  if (keys.length) {
    const fields = [
      "summary",
      "issuetype",
      "parent",
      "status",
      "created",
      "duedate",
      "labels",
      // Who owns the parent decides whether its controls are editable here.
      "assignee",
    ];
    if (storyPointsFieldId) fields.push(storyPointsFieldId);
    if (startDateFieldId) fields.push(startDateFieldId);
    const fetched = await searchJql<JiraIssue>(
      `key in (${keys.map((k) => `"${k}"`).join(",")})`,
      fields,
      { limit: keys.length },
    );
    for (const p of fetched) {
      parentPoints.set(
        p.key,
        storyPointsFieldId ? num(p.fields[storyPointsFieldId]) : null,
      );
      parentInfo.set(p.key, {
        summary: p.fields.summary ?? parentInfo.get(p.key)?.summary ?? "",
        issueTypeName: p.fields.issuetype?.name ?? "Task",
        statusName: p.fields.status?.name ?? "",
        epicKey: p.fields.parent?.key ?? null,
        epicName: p.fields.parent?.fields?.summary ?? null,
        created: ms(p.fields.created),
        startDate: startDateFieldId ? str(p.fields[startDateFieldId]) : null,
        dueDate: str(p.fields.duedate),
        labels: strings(p.fields.labels),
        assigneeAccountId: p.fields.assignee?.accountId ?? null,
        assigneeName: p.fields.assignee?.displayName ?? null,
      });
    }
  }

  const groups = new Map<string, BoardParent>();
  const ORPHAN = "__orphan__";

  for (const st of subtasks) {
    const key = st.parentKey ?? ORPHAN;
    if (!groups.has(key)) {
      const info = parentInfo.get(key);
      groups.set(key, {
        key,
        summary: info?.summary ?? (key === ORPHAN ? "Không có task cha" : key),
        issueTypeName: info?.issueTypeName ?? "Task",
        statusName: info?.statusName ?? "",
        epicKey: info?.epicKey ?? null,
        epicName: info?.epicName ?? null,
        storyPoints: parentPoints.get(key) ?? null,
        childPointsTotal: 0,
        childCount: 0,
        childTimeSpentTotal: 0,
        created: info?.created ?? 0,
        startDate: info?.startDate ?? null,
        dueDate: info?.dueDate ?? null,
        labels: info?.labels ?? [],
        assigneeAccountId: info?.assigneeAccountId ?? null,
        assigneeName: info?.assigneeName ?? null,
        outOfSprint: sprintlessParents.has(key),
        subtasks: [],
      });
    }
    const group = groups.get(key)!;
    group.subtasks.push(st);
    group.childPointsTotal += st.storyPoints ?? 0;
    group.childCount += 1;
    group.childTimeSpentTotal += st.timeSpentSeconds;
  }

  // The displayed list may be missing Done children, which would undercount the
  // header totals — points, child count and logged time. Recover the true totals
  // from a lightweight all-status query over the same parents (same assignee
  // scope as the board), leaving the shown rows as-is.
  if (childrenFiltered && keys.length) {
    const fields = ["parent", "timespent"];
    if (storyPointsFieldId) fields.push(storyPointsFieldId);

    const totals = new Map<
      string,
      { points: number; count: number; time: number }
    >();
    const CHUNK = 50;
    const batches: Promise<JiraIssue[]>[] = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys
        .slice(i, i + CHUNK)
        .map((k) => `"${k}"`)
        .join(",");
      batches.push(
        searchJql<JiraIssue>(
          `project = "${escapeJql(projectKey)}" AND assignee = currentUser() AND ` +
            `issuetype in subTaskIssueTypes() AND parent in (${chunk})`,
          fields,
          { limit: 200 },
        ),
      );
    }
    for (const child of (await Promise.all(batches)).flat()) {
      const pk = child.fields.parent?.key;
      if (!pk) continue;
      const agg = totals.get(pk) ?? { points: 0, count: 0, time: 0 };
      agg.points += storyPointsFieldId
        ? (num(child.fields[storyPointsFieldId]) ?? 0)
        : 0;
      agg.count += 1;
      agg.time += child.fields.timespent ?? 0;
      totals.set(pk, agg);
    }
    for (const group of groups.values()) {
      const agg = totals.get(group.key);
      if (agg) {
        group.childPointsTotal = agg.points;
        group.childCount = agg.count;
        group.childTimeSpentTotal = agg.time;
      }
    }
  }

  return [...groups.values()];
}

/**
 * Every subtask of the user's in a sprint, reduced to what a point rollup needs.
 *
 * Its own query rather than a sum over {@link getBoard}, for one reason that
 * matters and one that follows from it.
 *
 * The board narrows to `statusCategory != Done` by default, and a parent whose
 * children are *all* finished then has no entry on the board at all — so its
 * points are missing from anything summed off it. On a sprint near its end that
 * is most of the sprint, and a total that shrinks as the work lands is worse
 * than no total. `getBoard` already recovers per-parent totals for exactly this
 * reason, but only for parents it kept, and without each child's status — which
 * is the other half of what a rollup is.
 *
 * Deliberately unfiltered on status and independent of the board's own filter:
 * the answer to "how many points in this sprint" must not change because
 * somebody ticked a checkbox on the left.
 *
 * Scoped to `assignee = currentUser()` like everything else here — this is the
 * user's sprint, not the team's.
 */
export async function getSprintPoints(sprintId: number): Promise<PointRow[]> {
  const meta = await getProjectMeta();
  const projectKey = requireProjectKey();

  const parentKeys = await sprintParentKeys(sprintId, projectKey);
  if (!parentKeys.length) return [];

  const fields = ["status", "timespent"];
  if (meta.storyPointsFieldId) fields.push(meta.storyPointsFieldId);

  const base = [
    `project = "${escapeJql(projectKey)}"`,
    "assignee = currentUser()",
    "issuetype in subTaskIssueTypes()",
    ...teamClauses(),
  ];

  // Same chunking as the board: `parent in (…)` over hundreds of keys is a
  // query Jira will accept and then take its time over.
  const CHUNK = 50;
  const batches: Promise<JiraIssue[]>[] = [];
  for (let i = 0; i < parentKeys.length; i += CHUNK) {
    const chunk = parentKeys
      .slice(i, i + CHUNK)
      .map((k) => `"${k}"`)
      .join(",");
    batches.push(
      searchJql<JiraIssue>(
        `${[...base, `parent in (${chunk})`].join(" AND ")}`,
        fields,
        { limit: 200 },
      ),
    );
  }

  return (await Promise.all(batches)).flat().map((issue) => ({
    key: issue.key,
    statusName: issue.fields.status?.name ?? "",
    storyPoints: meta.storyPointsFieldId
      ? num(issue.fields[meta.storyPointsFieldId])
      : null,
    timeSpentSeconds: issue.fields.timespent ?? 0,
  }));
}

/**
 * Standard-level issues assigned to the user in a sprint, with how many subtasks
 * each already has.
 *
 * Work is only ever logged against subtasks, so a sprint holding nothing but
 * bare Tasks leaves the board empty with no way forward. Surfacing those Tasks
 * turns the dead end into an obvious next step: create a subtask under one.
 */
export async function getSprintTasks(
  sprintId: number | null,
  status: "open" | "all" = "all",
): Promise<SprintTask[]> {
  const meta = await getProjectMeta();
  const projectKey = requireProjectKey();

  const clauses = [
    `project = "${escapeJql(projectKey)}"`,
    "assignee = currentUser()",
    "issuetype not in subTaskIssueTypes()",
    ...teamClauses(),
  ];
  // Done issues still matter here: QC files Bug and Improve already closed, and
  // the work on them may not be logged yet.
  if (status === "open") clauses.push("statusCategory != Done");
  if (sprintId) clauses.push(`sprint = ${sprintId}`);

  const fields = [
    "summary",
    "status",
    "issuetype",
    "subtasks",
    "parent",
    "duedate",
    "labels",
  ];
  if (meta.storyPointsFieldId) fields.push(meta.storyPointsFieldId);
  if (meta.startDateFieldId) fields.push(meta.startDateFieldId);

  const issues = await searchJql<JiraIssue>(
    `${clauses.join(" AND ")} ORDER BY created DESC`,
    fields,
    { limit: 50 },
  );

  return issues
    .filter((i) => (i.fields.issuetype?.hierarchyLevel ?? 0) === 0)
    .map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary ?? "",
      statusName: issue.fields.status?.name ?? "",
      issueTypeName: issue.fields.issuetype?.name ?? "Task",
      storyPoints: meta.storyPointsFieldId
        ? num(issue.fields[meta.storyPointsFieldId])
        : null,
      subtaskCount: Array.isArray(issue.fields.subtasks)
        ? issue.fields.subtasks.length
        : 0,
      // On a standard-level issue, `parent` points one level up — at the Epic.
      epicKey: issue.fields.parent?.key ?? null,
      epicName: issue.fields.parent?.fields?.summary ?? null,
      startDate: meta.startDateFieldId
        ? str(issue.fields[meta.startDateFieldId])
        : null,
      dueDate: str(issue.fields.duedate),
      labels: strings(issue.fields.labels),
    }));
}

/**
 * The current user's subtasks in a sprint that sit in the "In Progress" status
 * category — what they are actively working on now. Feeds the daily report's
 * optional "today" list, returning just key + summary, newest activity first.
 *
 * Sprint membership is resolved on the parents first (JQL cannot filter subtasks
 * by sprint — see {@link sprintParentKeys}), then subtasks are matched by
 * `parent in (…)`, same as {@link getBoard}.
 */
export async function getInProgressSubtasks(
  sprintId: number | null,
): Promise<Array<{ key: string; summary: string }>> {
  if (!sprintId) return [];
  const projectKey = requireProjectKey();
  const parentKeys = await sprintParentKeys(sprintId, projectKey);
  if (!parentKeys.length) return [];

  const base = [
    `project = "${escapeJql(projectKey)}"`,
    "assignee = currentUser()",
    "issuetype in subTaskIssueTypes()",
    'statusCategory = "In Progress"',
    ...teamClauses(),
  ];

  const CHUNK = 50;
  const batches: Promise<JiraIssue[]>[] = [];
  for (let i = 0; i < parentKeys.length; i += CHUNK) {
    const chunk = parentKeys
      .slice(i, i + CHUNK)
      .map((k) => `"${k}"`)
      .join(",");
    batches.push(
      searchJql<JiraIssue>(
        `${[...base, `parent in (${chunk})`].join(" AND ")} ORDER BY updated DESC`,
        ["summary"],
        { limit: 100 },
      ),
    );
  }
  const issues = (await Promise.all(batches)).flat();
  return issues.map((i) => ({ key: i.key, summary: i.fields.summary ?? "" }));
}

export interface IssueDetail {
  key: string;
  summary: string;
  statusName: string;
  issueTypeName: string;
  storyPoints: number | null;
  timeSpentSeconds: number;
  parentKey: string | null;
  parentSummary: string | null;
  sprintName: string | null;
  assigneeName: string | null;
  startDate: string | null;
  dueDate: string | null;
  labels: string[];
  /** Raw ADF; the client turns it into blocks. */
  description: unknown;
  url: string;
}

/** Everything the detail panel shows, in one round trip. */
export async function getIssueDetail(issueKey: string): Promise<IssueDetail> {
  const meta = await getProjectMeta();
  const baseUrl =
    getSetting(SETTING_KEYS.jiraBaseUrl)?.replace(/\/+$/, "") ?? "";

  const fields = [
    "summary",
    "status",
    "issuetype",
    "parent",
    "assignee",
    "description",
    "timespent",
    "duedate",
    "labels",
  ];
  if (meta.storyPointsFieldId) fields.push(meta.storyPointsFieldId);
  if (meta.sprintFieldId) fields.push(meta.sprintFieldId);
  if (meta.startDateFieldId) fields.push(meta.startDateFieldId);

  const issue = await jiraFetch<JiraIssue>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields.join(",")}`,
  );

  const rawSprint = meta.sprintFieldId
    ? issue.fields[meta.sprintFieldId]
    : null;
  const sprints = Array.isArray(rawSprint)
    ? (rawSprint as Array<{ name?: string }>)
    : [];

  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    statusName: issue.fields.status?.name ?? "",
    issueTypeName: issue.fields.issuetype?.name ?? "",
    storyPoints: meta.storyPointsFieldId
      ? num(issue.fields[meta.storyPointsFieldId])
      : null,
    timeSpentSeconds: issue.fields.timespent ?? 0,
    parentKey: issue.fields.parent?.key ?? null,
    parentSummary: issue.fields.parent?.fields?.summary ?? null,
    sprintName: sprints[sprints.length - 1]?.name ?? null,
    assigneeName: issue.fields.assignee?.displayName ?? null,
    startDate: meta.startDateFieldId
      ? str(issue.fields[meta.startDateFieldId])
      : null,
    dueDate: str(issue.fields.duedate),
    labels: strings(issue.fields.labels),
    description: issue.fields.description ?? null,
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

export async function getTransitions(issueKey: string): Promise<Transition[]> {
  const res = await jiraFetch<{
    transitions?: Array<{
      id: string;
      name: string;
      to?: { id: string; name: string };
    }>;
  }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);

  // `to.id` is the resulting STATUS id, which is not the transition id — the two
  // are unrelated numbers, and Jira's own transition names can be misleading.
  return (res.transitions ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    toStatusId: t.to?.id ?? "",
    toStatusName: t.to?.name ?? t.name,
  }));
}

/**
 * Sets the story point estimate on an issue.
 *
 * Used mainly on parent tasks: the team enters a parent's points by hand as the
 * sum of its children, so the two drift apart constantly and fixing it should
 * not require a trip to Jira. Field id comes from createmeta — it differs per
 * instance.
 */
export async function updateStoryPoints(
  issueKey: string,
  points: number | null,
): Promise<void> {
  const meta = await getProjectMeta();
  if (!meta.storyPointsFieldId)
    throw new Error("Không tìm thấy field story point");

  // The plain field write is tried first even when createmeta never mentioned
  // the field. That sounds wrong and is not: on this instance `customfield_10033`
  // appears on no create or edit screen, yet a direct PUT sets it — verified by
  // writing a different value and reading it back. It is also the only path that
  // does not depend on the search index, which matters most right after a create.
  try {
    await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: { fields: { [meta.storyPointsFieldId]: points } },
    });
    return;
  } catch (error) {
    // Where the field IS on the screen there is no second route to try, so the
    // failure is the answer. Elsewhere Jira may refuse with "Field cannot be
    // set. It is not on the appropriate screen, or unknown." — and the board
    // still knows how to estimate.
    if (meta.storyPointsOnScreen) throw error;
    await setEstimateViaBoard(issueKey, points, error);
  }
}

/**
 * Writes the estimate through the board instead of the issue.
 *
 * This is how the backlog's own inline estimate works, and it is the only way in
 * when Story Points is off every screen — which is the case on the VipTalk
 * project, where the field holds real values that no issue-edit call can touch.
 * The board id is required: it is what tells Jira which field it means.
 */
async function setEstimateViaBoard(
  issueKey: string,
  points: number | null,
  /** Why the plain field write failed, reported when there is no board to try. */
  fieldError: unknown,
): Promise<void> {
  const board = await getBoardConfig();
  // Nothing left to try — the field write's own error is more useful than any
  // sentence about a board the user has not configured.
  if (!board) throw fieldError;

  await jiraFetch(
    `/rest/agile/1.0/issue/${encodeURIComponent(issueKey)}/estimation?boardId=${encodeURIComponent(board.id)}`,
    // An empty string clears the estimate; the endpoint rejects null.
    { method: "PUT", body: { value: points === null ? "" : String(points) } },
  );
}

/**
 * Đổi tiêu đề issue.
 *
 * Một PUT vào `summary`, không đụng field nào khác — khác `attachToSprint` là
 * chỗ phải đọc trước rồi ghi cả mảng, vì `summary` là một chuỗi đơn nên không
 * có gì để mất.
 *
 * Cắt khoảng trắng hai đầu và chặn chuỗi rỗng: Jira nhận `""` và issue sẽ mất
 * tiêu đề trên mọi màn hình, một cú trượt tay không hoàn tác được từ đây.
 */
export async function updateSummary(
  issueKey: string,
  summary: string,
): Promise<void> {
  const text = summary.trim();
  if (!text) throw new Error("Tiêu đề không được để trống");

  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    body: { fields: { summary: text } },
  });
}

/**
 * Ghi lại mô tả issue, gồm cả khối Definition of Done.
 *
 * Hai ô chứ không một: Jira lưu chung trong một tài liệu ADF, nhưng người dùng
 * soạn chúng riêng — và `textToAdf` là đúng hàm đã dựng mô tả lúc tạo issue,
 * nên sửa xong không làm đổi cấu trúc so với các issue khác.
 *
 * Cho phép để trống cả hai: xoá sạch mô tả là một ý định hợp lệ, khác với đổi
 * tiêu đề thành rỗng.
 */
export async function updateDescription(
  issueKey: string,
  description: string,
  dod: string,
): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    body: { fields: { description: textToAdf(description, dod) } },
  });
}

/**
 * Sets planned start and/or due date.
 *
 * Both are ordinary fields on the edit screen, so one PUT does the job. Passing
 * `null` clears a date — distinct from omitting the key, which leaves it alone.
 */
export async function updateDates(
  issueKey: string,
  dates: { startDate?: string | null; dueDate?: string | null },
): Promise<void> {
  const meta = await getProjectMeta();
  const fields: Record<string, unknown> = {};

  if ("startDate" in dates) {
    if (!meta.startDateFieldId)
      throw new Error("Không tìm thấy field Start date trên project này");
    fields[meta.startDateFieldId] = dates.startDate ?? null;
  }
  if ("dueDate" in dates) fields.duedate = dates.dueDate ?? null;

  if (!Object.keys(fields).length) return;

  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    body: { fields },
  });
}

/**
 * Makes a parent task visible on the team's board: sprint and label together.
 *
 * The two gaps hide it in different places and neither is enough on its own —
 * the sprint is what this app and the burndown filter by, the label is what the
 * board's own saved filter (`labels in (ctalk)`) matches. VT-325 was missing
 * both, so fixing only the sprint would have moved it from invisible-here to
 * invisible-on-Jira, and the user would have had to discover the second gap
 * afterwards.
 *
 * One PUT, so the task never sits half-fixed.
 *
 * Two shapes to be careful with: the sprint field takes a bare integer on write
 * though it reads back as an array of objects, and `labels` is a whole-array
 * write — so existing labels are read first and appended to rather than lost.
 */
export async function attachToSprint(
  issueKey: string,
  sprintId: number,
): Promise<{ labelAdded: string | null }> {
  const meta = await getProjectMeta();
  if (!meta.sprintFieldId)
    throw new Error("Không tìm thấy field Sprint trên project này");

  const fields: Record<string, unknown> = { [meta.sprintFieldId]: sprintId };
  const { label } = getTeamScope();
  let labelAdded: string | null = null;

  if (label && meta.labelsOnScreen) {
    // Read fresh: a cached copy from seconds ago could drop a label someone
    // else just added, and this write replaces the whole array.
    const issue = await jiraFetch<JiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=labels`,
      { fresh: true },
    );
    const current = strings(issue.fields.labels);
    if (!current.some((l) => l.toLowerCase() === label.toLowerCase())) {
      fields.labels = [...current, label];
      labelAdded = label;
    }
  }

  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    body: { fields },
  });

  return { labelAdded };
}

/**
 * Keys this Jira has no answer for, and when it said so.
 *
 * Re-checked occasionally rather than never: a key can be a typo today and a
 * real ticket tomorrow, and a board that stopped asking forever would never
 * notice.
 */
const missing = new Map<string, number>();
const MISSING_TTL = 30 * 60 * 1000;

/**
 * Current status of a set of issues, keyed by issue key.
 *
 * One query for the whole set rather than one per key, and it deliberately does
 * NOT go through `getIssueDetail` — the branches board needs a status and
 * nothing else, and pulling each issue's description to render a badge would
 * cost more than the board itself. Keys that no longer resolve are absent, so a
 * card pointing at a deleted issue degrades to "no status" instead of failing.
 */
export async function getIssueStatuses(
  keys: string[],
): Promise<
  Record<string, { statusName: string; issueTypeName: string; summary: string }>
> {
  const asked = [...new Set(keys.filter(Boolean))];
  // Keys this site has already said it does not have are left out entirely.
  // Without this the batch below fails every single time — one unresolvable key
  // poisons it — and the per-key retry runs on every render, so a board holding
  // a couple of foreign keys was paying one request per card forever rather
  // than one request for the lot.
  const now = Date.now();
  const wanted = asked.filter((k) => {
    const at = missing.get(k);
    if (at === undefined) return true;
    if (now - at < MISSING_TTL) return false;
    missing.delete(k);
    return true;
  });
  if (!wanted.length) return {};

  const out: Record<
    string,
    { statusName: string; issueTypeName: string; summary: string }
  > = {};
  /** First connection failure seen, '' when Jira answered everything. */
  let failed = "";
  const CHUNK = 50;

  const ask = (ks: string[]) =>
    searchJql<JiraIssue>(
      `key in (${ks.map((k) => `"${escapeJql(k)}"`).join(",")})`,
      ["summary", "status", "issuetype"],
      { limit: Math.max(ks.length, 1) },
    );

  /**
   * One batch, retried key by key if it fails.
   *
   * `key in (...)` is all-or-nothing: Jira rejects the whole query when a
   * single key does not resolve, so one hand-typed key on one card would
   * otherwise cost every card its status. Cards here really do carry keys that
   * are not keys, and the fallback is the difference between losing one badge
   * and losing all of them. Only paid on failure.
   */
  /**
   * Whether a failure is Jira answering "no such key" or Jira not answering.
   *
   * JQL rejects a query naming a key that does not resolve, with a 400 — that
   * is a fact about the key. Anything else is a fact about the connection: a
   * 5xx, a timeout, a `fetch` that threw because the VPN went down. Telling
   * them apart is the whole point, because the first is cached for half an
   * hour and the second must never be.
   */
  const isUnknownKey = (e: unknown) =>
    e instanceof JiraError && e.status === 400;

  const batch = async (ks: string[]): Promise<JiraIssue[]> => {
    try {
      return await ask(ks);
    } catch (e) {
      if (ks.length === 1) {
        // Marking a key missing on a connection failure was the bug that made
        // a dropped VPN unrecoverable: every key went into `missing`, and the
        // filter above then skipped asking about them for half an hour — so
        // the board stayed blank long after the network came back.
        if (isUnknownKey(e)) missing.set(ks[0], Date.now());
        else failed ||= e instanceof Error ? e.message : "Không gọi được Jira";
        return [];
      }
      const each = await Promise.all(
        ks.map((k) =>
          ask([k]).catch((err) => {
            if (isUnknownKey(err)) missing.set(k, Date.now());
            else
              failed ||=
                err instanceof Error ? err.message : "Không gọi được Jira";
            return [] as JiraIssue[];
          }),
        ),
      );
      return each.flat();
    }
  };

  const batches: Promise<JiraIssue[]>[] = [];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    batches.push(batch(wanted.slice(i, i + CHUNK)));
  }

  for (const issue of (await Promise.all(batches)).flat()) {
    // A key that resolved is not missing, whatever we thought before.
    missing.delete(issue.key);
    out[issue.key] = {
      statusName: issue.fields.status?.name ?? "",
      issueTypeName: issue.fields.issuetype?.name ?? "",
      summary: issue.fields.summary ?? "",
    };
  }
  // Anything asked for in a *successful* batch that came back empty does not
  // exist here either — Jira answers those with silence rather than an error.
  // Not when the call never landed: then nothing was answered, and writing the
  // keys off would stop the board asking about them.
  if (!failed) for (const k of wanted) if (!out[k]) missing.set(k, Date.now());
  // Thrown rather than returned so callers cannot ignore it by accident — both
  // of them already have a `catch`, and both were treating the empty result as
  // an answer. Partial results are kept: a batch that worked is still worth
  // having, and the error only fires when nothing came back at all.
  if (failed && !Object.keys(out).length) throw new JiraError(failed, 0, "");
  return out;
}

export async function transitionIssue(
  issueKey: string,
  transitionId: string,
): Promise<void> {
  await jiraFetch(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      method: "POST",
      body: { transition: { id: transitionId } },
    },
  );
}
