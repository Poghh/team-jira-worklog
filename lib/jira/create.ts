import 'server-only'

import { SETTING_KEYS, getSetting, getTeamScope, requireProjectKey } from '../settings'
import { textToAdf } from './adf'
import { type JiraIssue, JiraError, jiraFetch, searchJql } from './client'
import { updateStoryPoints } from './issues'
import { getProjectMeta } from './meta'

export interface CreateIssueInput {
  issueTypeId: string
  summary: string
  description: string
  dod: string
  /** Required for a subtask; on a standard issue this is the epic. */
  parentKey?: string | null
  sprintId?: number | null
  storyPoints?: number | null
  assignToMe?: boolean
  /** YYYY-MM-DD. The team requires both on every issue it files. */
  startDate?: string | null
  dueDate?: string | null
  /** Extra labels beyond the team label, which is always added. */
  labels?: string[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Guarantees the team's mandatory tag leads the summary.
 *
 * The UI locks the chip on, but this is the last gate before Jira and the rule
 * matters: a summary without `[CTALK]` is a task the team cannot recognise as
 * theirs at a glance. Idempotent — an already-prefixed title is left alone.
 */
function withTeamPrefix(summary: string, prefix: string | null): string {
  const value = summary.trim()
  if (!prefix || value.toLowerCase().startsWith(prefix.toLowerCase())) return value
  // Tags run together (`[CTALK][SPT-69]`) but a tag never runs into words, so
  // the separator depends on what it is being glued to.
  return value.startsWith('[') ? `${prefix}${value}` : `${prefix} ${value}`
}

/**
 * `AND labels = "ctalk"`, or nothing when no team label is set.
 *
 * The pickers must offer the same issues the team's board shows. Without this a
 * subtask can be hung off another team's task, which is invisible on the board
 * it was created for.
 */
function teamLabelClause(): string {
  const { label } = getTeamScope()
  return label ? ` AND labels = "${label.replace(/"/g, '\\"')}"` : ''
}

/** Team label first, de-duplicated case-insensitively. */
function composeLabels(extra: string[] | undefined, teamLabel: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const label of [...(teamLabel ? [teamLabel] : []), ...(extra ?? [])]) {
    // Jira rejects a label containing a space; the UI never produces one, but a
    // template or a draft from an older version might.
    const value = label.trim().replace(/\s+/g, '-')
    if (!value || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    out.push(value)
  }
  return out
}

export interface CreatedIssue {
  id: string
  key: string
  url: string
  /**
   * True when the issue was created but its estimate could not be written. The
   * caller must say so: the issue is real and correct in every other way, and a
   * silent miss is how a whole sprint ends up unestimated.
   */
  storyPointsPending?: boolean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Jira's wording when the board's filter has not yet seen the issue. */
const NOT_ON_BOARD = /does not exist on the board/i

/**
 * Writes the estimate on an issue created moments ago.
 *
 * Normally instant: {@link updateStoryPoints} writes the field directly, which
 * needs no index. The ladder below is for the instances where that write is
 * refused and the estimate has to go through the board instead — the board
 * resolves an issue through its saved filter, that filter runs on the search
 * index, and the index lags creation by a second or two. So a write issued
 * immediately after a create is answered with `Issue 'VT-431' does not exist on
 * the board 'CTALK-TEAM'` for an issue that plainly exists. Same eventual
 * consistency the board queries work around with `reconcileIssues`; here the
 * only remedy is to wait and try again.
 *
 * Returns false if it never landed, so the caller can report it instead of
 * leaving the user to notice an empty point chip later.
 */
async function setPointsAfterCreate(issueKey: string, points: number): Promise<boolean> {
  // The first attempt carries the usual case and costs no delay; the rest only
  // run on the board fallback, where the index needs a moment.
  const delays = [700, 1500, 3000]

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1])
    try {
      await updateStoryPoints(issueKey, points)
      return true
    } catch (error) {
      const indexLag =
        error instanceof JiraError && error.status === 404 && NOT_ON_BOARD.test(error.message)
      // Anything else — a bad field, no permission — will fail identically on
      // every retry, so stop rather than making the user wait out the ladder.
      if (!indexLag) return false
    }
  }

  return false
}

/**
 * Creates an issue.
 *
 * `parent` is polymorphic in this hierarchy: on a Task it points at the Epic,
 * on a Subtask it points at the Task. Both are the same field — what it means
 * is decided by the issue type sent alongside it.
 *
 * Field ids come from createmeta and are never hardcoded; they differ per
 * instance and per project style.
 */
export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const meta = await getProjectMeta()
  const projectKey = requireProjectKey()
  const baseUrl = getSetting(SETTING_KEYS.jiraBaseUrl)?.replace(/\/+$/, '') ?? ''

  const type = meta.issueTypes.find((t) => t.id === input.issueTypeId)
  if (!type) throw new Error('Issue type không hợp lệ')

  // Jira itself would accept a Task with no epic, but this team requires every
  // task to sit under one — so the rule is enforced here rather than left to
  // whoever remembers. Both levels use the same `parent` field.
  if (!input.parentKey) {
    throw new Error(
      type.subtask ? 'Subtask bắt buộc phải có task cha' : 'Task bắt buộc phải thuộc một epic',
    )
  }

  const team = getTeamScope()

  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { id: input.issueTypeId },
    summary: withTeamPrefix(input.summary, team.prefix),
    description: textToAdf(input.description, input.dod),
  }

  if (input.parentKey) fields.parent = { key: input.parentKey }

  // The label is what puts the issue on the team's board — its saved filter is
  // `labels in (ctalk)`. Without it the issue exists, is assigned, and is
  // nowhere to be seen, which is the hardest kind of missing.
  const labels = composeLabels(input.labels, team.label)
  if (labels.length && meta.labelsOnScreen) fields.labels = labels

  if (input.startDate) {
    if (!ISO_DATE.test(input.startDate)) throw new Error('Start date không hợp lệ')
    if (!meta.startDateFieldId) throw new Error('Project này không có field Start date')
    fields[meta.startDateFieldId] = input.startDate
  }

  if (input.dueDate) {
    if (!ISO_DATE.test(input.dueDate)) throw new Error('Due date không hợp lệ')
    fields.duedate = input.dueDate
  }

  if (input.startDate && input.dueDate && input.dueDate < input.startDate) {
    throw new Error('Due date không được sớm hơn start date')
  }

  // Never send a sprint on a subtask. Reading one back makes it look settable —
  // a subtask does carry its parent's sprint — but writing it is rejected:
  // "subtasks cannot be associated to a sprint. It's associated to the same
  // sprint as its parent." Enforced here rather than in the UI so no caller can
  // reintroduce it.
  if (input.sprintId && meta.sprintFieldId && !type.subtask) {
    // Bare integer, not an array — the write shape differs from the read shape.
    fields[meta.sprintFieldId] = input.sprintId
  }

  // Only inline when the field is on the create screen. Where it is not — a
  // company-managed project estimating through the backlog — sending it fails
  // the whole create, so it goes in a second call once the issue exists.
  const inlinePoints = input.storyPoints != null && meta.storyPointsFieldId && meta.storyPointsOnScreen
  if (inlinePoints) {
    fields[meta.storyPointsFieldId!] = input.storyPoints
  }

  if (input.assignToMe) {
    const me = await jiraFetch<{ accountId: string }>('/rest/api/3/myself')
    fields.assignee = { id: me.accountId }
  }

  const created = await jiraFetch<{ id: string; key: string }>('/rest/api/3/issue', {
    method: 'POST',
    body: { fields },
  })

  // Not fatal: the issue exists and is correct in every other way, so failing
  // the whole create over an estimate would be the worse outcome — but it is
  // reported, not swallowed.
  let storyPointsPending = false
  if (input.storyPoints != null && !inlinePoints && meta.storyPointsFieldId) {
    storyPointsPending = !(await setPointsAfterCreate(created.key, input.storyPoints))
  }

  return {
    id: created.id,
    key: created.key,
    url: `${baseUrl}/browse/${created.key}`,
    storyPointsPending,
  }
}

export interface ParentOption {
  key: string
  summary: string
  epicName: string | null
  sprintId: number | null
  sprintName: string | null
  inCurrentSprint: boolean
  statusName: string
  /** Hidden by default in the picker; QC files Bugs already closed. */
  isDone: boolean
}

export interface EpicOption {
  key: string
  summary: string
}

/**
 * Epics available to attach a standard-level issue to.
 *
 * A separate query from `listParentCandidates` on purpose: that one returns
 * hierarchy level 0 (Task, Bug, …) for subtasks to hang off, while an epic sits
 * at level 1. Reusing one list for both is how the epic picker ended up with
 * nothing selectable.
 */
export async function listEpics(): Promise<EpicOption[]> {
  const meta = await getProjectMeta()
  const projectKey = requireProjectKey()
  const epic = meta.issueTypes.find((t) => t.hierarchyLevel === 1)
  if (!epic) return []

  const issues = await searchJql<JiraIssue>(
    `project = "${projectKey}" AND issuetype = ${epic.id} AND statusCategory != Done` +
      `${teamLabelClause()} ORDER BY created DESC`,
    ['summary'],
    { limit: 100 },
  )

  return issues.map((i) => ({ key: i.key, summary: i.fields.summary ?? '' }))
}

/**
 * Candidate parents for a subtask: standard-level issues.
 *
 * Done issues are deliberately included. QC files Bug and Improve already
 * closed, and the developer still has to log hours against them — filtering by
 * `statusCategory != Done` made those impossible to select, which is why the
 * "+ Task con" shortcut appeared to do nothing. Recent-first ordering keeps the
 * list from filling with ancient closed work.
 *
 * `mustInclude` guarantees a specific key is present even if it falls outside
 * that window, so arriving from a link never lands on an empty picker.
 */
export async function listParentCandidates(
  currentSprintId: number | null,
  mustInclude?: string | null,
): Promise<ParentOption[]> {
  const meta = await getProjectMeta()
  const projectKey = requireProjectKey()

  const fields = ['summary', 'issuetype', 'parent', 'status']
  if (meta.sprintFieldId) fields.push(meta.sprintFieldId)

  const issues = await searchJql<JiraIssue>(
    `project = "${projectKey}" AND issuetype not in subTaskIssueTypes()` +
      `${teamLabelClause()} ORDER BY created DESC`,
    fields,
    { limit: 150 },
  )

  if (mustInclude && !issues.some((i) => i.key === mustInclude)) {
    const extra = await searchJql<JiraIssue>(`key = "${mustInclude}"`, fields, { limit: 1 })
    issues.unshift(...extra)
  }

  return issues
    .filter((i) => (i.fields.issuetype?.hierarchyLevel ?? 0) === 0)
    .map((issue) => {
      const raw = meta.sprintFieldId ? issue.fields[meta.sprintFieldId] : null
      const sprints = Array.isArray(raw) ? (raw as Array<{ id?: number; name?: string }>) : []
      const last = sprints[sprints.length - 1]
      return {
        key: issue.key,
        summary: issue.fields.summary ?? '',
        // A Task's parent IS its epic — same field, one level up.
        epicName: issue.fields.parent?.fields?.summary ?? null,
        sprintId: last?.id ?? null,
        sprintName: last?.name ?? null,
        inCurrentSprint: Boolean(currentSprintId && last?.id === currentSprintId),
        statusName: issue.fields.status?.name ?? '',
        isDone: issue.fields.status?.statusCategory?.key === 'done',
      }
    })
}
