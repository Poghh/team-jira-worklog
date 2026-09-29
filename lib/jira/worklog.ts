import 'server-only'

import {
  type BusySpan,
  DEFAULT_TZ,
  clockMinuteIn,
  endOfDay,
  hoursToSeconds,
  jiraStarted,
  startOfDay,
} from '../time'
import { SETTING_KEYS, getSetting, requireProjectKey } from '../settings'
import { type JiraIssue, jiraFetch, searchJql } from './client'

export interface WorklogEntry {
  id: string
  issueKey: string
  issueSummary: string
  timeSpentSeconds: number
  started: string
  /** Local date the entry belongs to, YYYY-MM-DD. */
  date: string
  comment?: string
}

interface RawWorklog {
  id: string
  started?: string
  timeSpentSeconds?: number
  author?: { accountId?: string }
  comment?: unknown
}

function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/**
 * Worklogs this user recorded between two dates, inclusive.
 *
 * Done in two passes because Jira has no "give me my worklogs" endpoint: JQL
 * finds the issues touched in the window, then each issue's worklogs are read
 * and filtered down to this author and these dates. `worklogDate` in JQL matches
 * any author, so the per-entry author check is what makes the result correct on
 * a shared issue.
 */
export async function getWorklogs(
  fromDate: string,
  toDate: string,
  accountId: string,
  tz = DEFAULT_TZ,
  /**
   * Issue ids currently on screen. Logging to an issue that had no worklog in
   * this window yet leaves it out of the JQL result until the index catches up,
   * so the hours appear to vanish right after a successful save. Passing the
   * ids forces Jira to reconcile them first.
   */
  reconcileIds: string[] = [],
  /**
   * Issue keys to read directly, on top of whatever the JQL finds.
   *
   * `worklogDate` is an index query, so an issue whose first worklog of the day
   * was written seconds ago is missing from the result. Reading its worklogs
   * straight from `/issue/{key}/worklog` is index-free and always current —
   * which is what makes "how much have I logged today" correct immediately
   * after logging, rather than one refresh later.
   */
  alwaysInclude: string[] = [],
): Promise<WorklogEntry[]> {
  const projectKey = requireProjectKey()

  const jql =
    `project = "${escapeJql(projectKey)}"` +
    ` AND worklogAuthor = currentUser()` +
    ` AND worklogDate >= "${fromDate}" AND worklogDate <= "${toDate}"` +
    ` ORDER BY updated DESC`

  const issues = await searchJql<JiraIssue>(jql, ['summary'], {
    limit: 200,
    reconcileIssues: reconcileIds,
  })

  const extra = alwaysInclude.filter((key) => key && !issues.some((i) => i.key === key))
  if (extra.length) {
    const found = await searchJql<JiraIssue>(
      `key in (${extra.map((k) => `"${escapeJql(k)}"`).join(',')})`,
      ['summary'],
      { limit: extra.length },
    )
    issues.push(...found)
  }

  if (!issues.length) return []

  const after = startOfDay(fromDate, tz) - 1
  const before = endOfDay(toDate, tz) + 1

  const entries = await Promise.all(
    issues.map(async (issue) => {
      const res = await jiraFetch<{ worklogs?: RawWorklog[] }>(
        `/rest/api/3/issue/${encodeURIComponent(issue.key)}/worklog` +
          `?startedAfter=${after}&startedBefore=${before}&maxResults=200`,
        // `fresh` skips the short read cache. Only the placement query asks for
        // it: that read decides where the next entry starts, and a copy cached
        // seconds ago is precisely the one missing the entry just written.
        { fresh: alwaysInclude.length > 0 },
      )
      return (res.worklogs ?? [])
        .filter((w) => w.author?.accountId === accountId && w.started)
        .map<WorklogEntry>((w) => ({
          id: w.id,
          issueKey: issue.key,
          issueSummary: issue.fields.summary ?? '',
          timeSpentSeconds: w.timeSpentSeconds ?? 0,
          started: w.started!,
          date: localDate(w.started!, tz),
        }))
        .filter((w) => w.date >= fromDate && w.date <= toDate)
    }),
  )

  // One issue can arrive from both passes; a worklog counted twice would push
  // every later entry an hour down the clock.
  const seen = new Set<string>()
  return entries.flat().filter((e) => !seen.has(e.id) && seen.add(e.id))
}

/**
 * Các khoảng giờ user này đã chiếm trong ngày `date`.
 *
 * Đây là thứ quyết định worklog kế tiếp bắt đầu ở đâu, nên `issueKey` được đọc
 * trực tiếp chứ không qua index — xem `alwaysInclude`.
 *
 * Trả về các khoảng chứ không phải một con tổng: tổng không nói được chỗ nào
 * đang trống. Xoá một worklog ở giữa ngày rồi log lại, tính theo tổng sẽ đặt
 * entry mới đè lên một khoảng vẫn còn người — xem {@link placementChoices}.
 */
export async function loggedSpansOnDate(
  date: string,
  accountId: string,
  tz: string,
  issueKey: string,
): Promise<BusySpan[]> {
  const entries = await getWorklogs(date, date, accountId, tz, [], [issueKey])
  return entries
    .map((e) => ({
      start: clockMinuteIn(e.started, tz),
      minutes: Math.round(e.timeSpentSeconds / 60),
    }))
    .filter((s) => s.minutes > 0)
}

export function sumByDate(entries: WorklogEntry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of entries) out.set(e.date, (out.get(e.date) ?? 0) + e.timeSpentSeconds)
  return out
}

export function sumByIssue(entries: WorklogEntry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of entries) out.set(e.issueKey, (out.get(e.issueKey) ?? 0) + e.timeSpentSeconds)
  return out
}

export interface CreateWorklogInput {
  issueKey: string
  hours: number
  date: string
  comment?: string
  /** Local start time as minutes from midnight — 10:00 is 600. */
  startMinute?: number
  tz?: string
}

function toAdf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

/**
 * Logs work against an issue.
 *
 * `notifyUsers=false` because logging several entries in a row would otherwise
 * email every watcher once per entry. `startMinute` is chosen by the caller from
 * what the day already holds, so entries lay end to end across the working day
 * instead of every one of them landing on 09:00.
 */
export async function createWorklog(input: CreateWorklogInput) {
  const tz = input.tz ?? DEFAULT_TZ
  const body: Record<string, unknown> = {
    // Send exactly one of timeSpent / timeSpentSeconds — Jira rejects both.
    timeSpentSeconds: hoursToSeconds(input.hours),
    started: jiraStarted(input.date, tz, input.startMinute ?? 9 * 60),
  }
  if (input.comment?.trim()) body.comment = toAdf(input.comment.trim())

  return jiraFetch<{ id: string; timeSpentSeconds: number }>(
    `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/worklog?notifyUsers=false&adjustEstimate=leave`,
    { method: 'POST', body },
  )
}

export async function deleteWorklog(issueKey: string, worklogId: string) {
  return jiraFetch(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}?notifyUsers=false&adjustEstimate=leave`,
    { method: 'DELETE' },
  )
}
