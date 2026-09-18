import Link from 'next/link'
import { connection } from 'next/server'

import { getMyself, jiraBlockedBy } from '@/lib/jira/client'
import { getBoard, getSprintPoints, getSprintTasks } from '@/lib/jira/issues'
import { getProjectMeta } from '@/lib/jira/meta'
import { type SprintTask, summarisePoints } from '@/lib/jira/types'
import { getSprints } from '@/lib/jira/sprints'
import { getWorklogs, sumByDate, sumByIssue } from '@/lib/jira/worklog'
import { listDaysOff } from '@/lib/days-off'
import { type QuotaRules, quotaForDate } from '@/lib/quota'
import { SETTING_KEYS, getSetting, getTeamScope, getWorkSchedule } from '@/lib/settings'
import { DEFAULT_TZ, formatDateVi, isWeekend, todayIn, weekOf } from '@/lib/time'

import { JiraDown } from './jira-down'
import { LinkPending } from './link-pending'
import { BoardFilters } from './board/filters'
import { NavDimmer, NavProvider } from './board/navigation'
import { CapacityBar } from './board/capacity'
import { DatePicker } from './board/date-picker'
import { EpicHeader, groupByEpic } from './board/epic-section'
import { ParentGroup } from './board/parent-group'
import { PendingTasks } from './board/pending-tasks'
import { PointsPanel } from './board/points-panel'
import { SprintPanel } from './board/sprint-panel'
import { WeekPanel } from './board/week-panel'

/**
 * Same boundary as the report page: every panel here is a view of Jira, so a
 * dropped VPN leaves nothing to draw. The inner function keeps its own catch
 * around the first two calls — that one can name the page it failed on before
 * anything has been fetched — and this one covers the rest of the body, which
 * used to throw straight through to a stack trace.
 */
export default async function BoardPage(props: PageProps<'/'>) {
  try {
    return await boardPage(props)
  } catch (error) {
    if (!jiraBlockedBy(error)) throw error
    return <JiraDown error={error} retryHref="/" />
  }
}

async function boardPage(props: PageProps<'/'>) {
  await connection()

  if (!getSetting(SETTING_KEYS.jiraApiToken)) return <NotConfigured />

  const sp = await props.searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  // `getMyself` and `getSprints` don't depend on each other, so fetch both at
  // once — one fewer serial Jira round-trip before the board can render.
  let me
  let sprintsResult
  try {
    ;[me, sprintsResult] = await Promise.all([getMyself(), getSprints()])
  } catch (error) {
    return <JiraDown error={error} retryHref="/" />
  }

  const tz = me.timeZone ?? DEFAULT_TZ
  const date = one(sp.date) ?? todayIn(tz)
  const status = one(sp.status) === 'all' ? 'all' : 'open'
  const search = one(sp.q) ?? ''
  const epicFilter = one(sp.epic) ?? ''
  const parentFilter = one(sp.parent) ?? ''
  // How the three levels are ordered by creation date. 'new' (default) puts the
  // most recently created task at the top; 'old' flips it. Remembered per
  // browser by <BoardFilters>.
  const sort = one(sp.sort) === 'old' ? 'old' : 'new'
  const newestFirst = sort === 'new'
  // Ids of issues created moments ago. Jira's search is eventually consistent,
  // so without these a brand-new subtask stays invisible until the index catches
  // up — which looked like the create had silently failed.
  const reconcileIds = (one(sp.reconcile) ?? '').split(',').filter(Boolean)

  const { sprints, current } = sprintsResult
  const sprintParam = one(sp.sprint)
  // Three states, not two: a specific sprint, every sprint, or a date that sits
  // outside every sprint — which must not silently fall back to "every".
  const noSprintMatch = sprintParam === 'none'
  const sprintId =
    sprintParam === 'all' || noSprintMatch
      ? null
      : sprintParam
        ? Number(sprintParam)
        : (current?.id ?? null)

  // With a sprint selected, statistics cover the whole sprint: a sprint runs two
  // weeks, so a single calendar week cannot show whether it is fully covered.
  const selectedSprint = sprints.find((s) => s.id === sprintId) ?? null
  const sprintStart = selectedSprint?.startDate?.slice(0, 10) ?? null
  const sprintEnd = selectedSprint?.endDate?.slice(0, 10) ?? null

  const weekDays = weekOf(date)
  const rangeFrom = sprintStart ?? weekDays[0]
  const rangeTo = sprintEnd ?? weekDays[6]

  // Read before the fetch below, which is gated on it. Explicitly `=== 'true'`:
  // off is the default, and an unseeded key must not read as on.
  const showPoints = getSetting(SETTING_KEYS.showSprintPoints) === 'true'

  const board = noSprintMatch ? [] : await getBoard({ sprintId, status, search, reconcileIds })

  // A project without these fields must not offer a date chip that can only
  // fail on save. Cached with the rest of the project meta, so this is free.
  const projectMeta = await getProjectMeta()
  const datesSupported = projectMeta.startDateFieldId !== null || projectMeta.dueDateOnScreen

  // Ids of everything on screen, so a worklog written seconds ago is guaranteed
  // to be reflected rather than lost to Jira's eventually-consistent search.
  const visibleIds = board.flatMap((g) => g.subtasks.map((s) => s.id)).slice(0, 50)

  const [entries, sprintTasks, pointRows] = await Promise.all([
    getWorklogs(
      // The selected day can sit outside the sprint window; widen so its own
      // logged hours still show on the capacity bar.
      date < rangeFrom ? date : rangeFrom,
      date > rangeTo ? date : rangeTo,
      me.accountId,
      tz,
      visibleIds,
    ),
    noSprintMatch ? Promise.resolve([]) : getSprintTasks(sprintId, status),
    // Only with a sprint picked, and only when the panel is on. "Point in this
    // sprint" has no answer across every sprint at once, and a panel nobody
    // shows must not be paying for its own query — switching it off in
    // Settings has to remove the request, not just the markup.
    !showPoints || sprintId === null || noSprintMatch
      ? Promise.resolve([])
      : getSprintPoints(sprintId).catch(() => []),
  ])
  const week = { days: weekDays, entries }

  const byDate = sumByDate(week.entries)
  const byIssueToday = sumByIssue(week.entries.filter((e) => e.date === date))

  // Latest worklog day per issue, across the whole window already fetched —
  // the sprint, widened to take in the selected day. Costs no extra request.
  const lastLogByIssue = new Map<string, string>()
  for (const e of week.entries) {
    const prev = lastLogByIssue.get(e.issueKey)
    if (!prev || e.date > prev) lastLogByIssue.set(e.issueKey, e.date)
  }

  for (const group of board) {
    for (const st of group.subtasks) {
      st.loggedTodaySeconds = byIssueToday.get(st.key) ?? 0
      st.lastLogDate = lastLogByIssue.get(st.key) ?? null
    }
  }

  const epicOptions = [
    ...new Map(
      board
        .filter((g) => g.epicKey)
        .map((g) => [g.epicKey!, { key: g.epicKey!, name: g.epicName ?? g.epicKey! }]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name))

  const parentOptions = board
    .filter((g) => g.key !== '__orphan__' && (!epicFilter || g.epicKey === epicFilter))
    .map((g) => ({ key: g.key, summary: g.summary }))

  const visibleBoard = board.filter(
    (g) =>
      (!epicFilter || g.epicKey === epicFilter) && (!parentFilter || g.key === parentFilter),
  )

  // Order subtasks within each parent, then the parents themselves, by creation
  // date in the chosen direction; epics get ordered inside groupByEpic.
  const dir = newestFirst ? -1 : 1
  for (const g of visibleBoard) g.subtasks.sort((a, b) => (a.created - b.created) * dir)
  const sortedParents = [...visibleBoard].sort((a, b) => (a.created - b.created) * dir)

  // Parents with no sprint of their own are pulled out into their own block, so
  // the epic grouping above keeps describing the sprint and nothing else. Their
  // children are the user's work either way — see `sprintlessChildren`.
  const inSprintParents = sortedParents.filter((g) => !g.outOfSprint)
  const strayParents = sortedParents.filter((g) => g.outOfSprint)

  const coveredParents = new Set(board.map((g) => g.key))
  const uncovered = sprintTasks
    // Not already shown as a group above…
    .filter((t) => !coveredParents.has(t.key))
    // …and genuinely has no subtask. `coveredParents` alone is not enough: it
    // comes from the filtered board, so a parent whose subtasks are all Done
    // would reappear here as "chưa có task con" while it plainly has some.
    .filter((t) => t.subtaskCount === 0)
    // Same epic together, matching how the board above is grouped.
    .filter((t) => !epicFilter || t.epicKey === epicFilter)
    .filter((t) => !parentFilter || t.key === parentFilter)
    // Same epic together, matching how the board above is grouped.
    .sort((a, b) => (a.epicKey ?? 'zz').localeCompare(b.epicKey ?? 'zz') || a.key.localeCompare(b.key))

  // One rule object, shared by every panel — the calculation used to be copied
  // into each of them and could drift apart.
  const rules: QuotaRules = {
    dailyHours: Number(getSetting(SETTING_KEYS.dailyQuotaHours) ?? '8') || 8,
    // A half day is measured off the clock rather than halved — this workplace
    // runs 09:00–18:00 around lunch, so its halves are three hours and five.
    schedule: getWorkSchedule(),
    weekendCounts: getSetting(SETTING_KEYS.weekendCountsToQuota) === 'true',
    daysOff: listDaysOff(rangeFrom < weekDays[0] ? rangeFrom : weekDays[0], rangeTo > weekDays[6] ? rangeTo : weekDays[6]),
  }
  const dayIsWeekend = isWeekend(date)
  const dayQuota = quotaForDate(date, rules)

  // Everything except `date`, so the side panel's day links keep the sprint and
  // filters instead of resetting them.
  const baseQuery = (() => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'date' || k === 'reconcile') continue
      const one = Array.isArray(v) ? v[0] : v
      if (one) q.set(k, one)
    }
    return q.toString()
  })()

  const isToday = date === todayIn(tz)
  const dateLabel = formatDateVi(date)
  const todaysEntries = week.entries.filter((e) => e.date === date)

  return (
    <NavProvider>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
            {current
              ? `${current.name} · ${current.startDate?.slice(8, 10)}/${current.startDate?.slice(5, 7)} – ${current.endDate?.slice(8, 10)}/${current.endDate?.slice(5, 7)} · đang chạy`
              : 'Không xác định được sprint hiện tại'}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Task board</h1>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Subtask đang giao cho <b className="font-medium text-ink-2">{me.displayName}</b> — dùng
            bộ lọc bên dưới để thu hẹp.
          </p>
        </div>
        <DatePicker
          date={date}
          label={dateLabel}
          isToday={isToday}
          sprintId={sprintId}
          sprints={sprints.map((s) => ({
            id: s.id,
            start: s.startDate?.slice(0, 10) ?? null,
            end: s.endDate?.slice(0, 10) ?? null,
          }))}
        />
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_296px]">
        <div>
          <BoardFilters
            sprints={sprints.map((s) => ({
              id: s.id,
              name: s.name,
              current: Boolean(s.current),
              start: s.startDate?.slice(0, 10) ?? null,
              end: s.endDate?.slice(0, 10) ?? null,
            }))}
            sprintId={sprintId}
            status={status}
            search={search}
            noSprintMatch={noSprintMatch}
            epics={epicOptions}
            epicKey={epicFilter}
            parents={parentOptions}
            parentKey={parentFilter}
            sort={sort}
          />

          <NavDimmer>
          {visibleBoard.length === 0 ? (
            <EmptyBoard
              sprintName={sprints.find((s) => s.id === sprintId)?.name}
              status={status}
              hasTasks={uncovered.length > 0}
              noSprintMatch={noSprintMatch}
              dateLabel={dateLabel}
              teamLabel={getTeamScope().label}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {groupByEpic(inSprintParents, newestFirst).map((epic) => (
                <div key={epic.key ?? '__none__'}>
                  <EpicHeader group={epic} boardSprintId={sprintId} />
                  <div className="flex flex-col gap-3">
                    {epic.parents.map((group) => (
                      <ParentGroup
                        key={group.key}
                        group={group}
                        date={date}
                        dateLabel={dateLabel}
                        isToday={isToday}
                        sprintEnd={sprintEnd}
                        datesSupported={datesSupported}
                        dayLoggedSeconds={byDate.get(date) ?? 0}
                        myAccountId={me.accountId}
                        currentSprint={
                          selectedSprint ? { id: selectedSprint.id, name: selectedSprint.name } : null
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}

              {/* Below the sprint, never mixed into it: these are the user's own
                  subtasks under a parent nobody put in a sprint. Hiding them lost
                  real work; merging them in would make the sprint filter a lie. */}
              {strayParents.length > 0 && (
                <div>
                  <div className="mb-2 flex flex-wrap items-baseline gap-2">
                    <span className="rounded-[3px] border border-warn bg-warn-soft px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-warn">
                      Ngoài sprint
                    </span>
                    <span className="text-[12.5px] text-ink-3">
                      Task cha chưa được gán sprint nào — task con của bạn vẫn log giờ được ở đây.
                    </span>
                  </div>
                  <div className="flex flex-col gap-3">
                    {strayParents.map((group) => (
                      <ParentGroup
                        key={group.key}
                        group={group}
                        date={date}
                        dateLabel={dateLabel}
                        isToday={isToday}
                        sprintEnd={sprintEnd}
                        datesSupported={datesSupported}
                        dayLoggedSeconds={byDate.get(date) ?? 0}
                        myAccountId={me.accountId}
                        currentSprint={
                          selectedSprint ? { id: selectedSprint.id, name: selectedSprint.name } : null
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
            <PendingTasks tasks={uncovered} />
          </NavDimmer>
        </div>

        <NavDimmer label="Đang cập nhật…">
        <div className="flex flex-col gap-3.5">
        <CapacityBar
          date={date}
          quotaHours={dayQuota}
          isWeekend={dayIsWeekend}
          entries={todaysEntries.map((e) => ({ key: e.issueKey, seconds: e.timeSpentSeconds }))}
        />

        {showPoints && selectedSprint && (
          <PointsPanel
            sprintName={selectedSprint.name}
            summary={summarisePoints(pointRows)}
          />
        )}

        {selectedSprint && sprintStart && sprintEnd ? (
          <SprintPanel
            sprintName={selectedSprint.name}
            start={sprintStart}
            end={sprintEnd}
            today={todayIn(tz)}
            selectedDate={date}
            secondsByDate={Object.fromEntries(byDate)}
            rules={rules}
            baseQuery={baseQuery}
          />
        ) : (
          <WeekPanel
            days={week.days}
            today={date}
            hoursByDate={Object.fromEntries([...byDate].map(([d, s]) => [d, s / 3600]))}
            rules={rules}
          />
        )}
        </div>
        </NavDimmer>
      </div>
    </NavProvider>
  )
}

/**
 * Shown when no subtask matches. The list of parent tasks lives in
 * <PendingTasks> below, which renders whether or not the board is empty — so
 * this only needs to explain the emptiness and point at the next move.
 */
function EmptyBoard({
  sprintName,
  status,
  hasTasks,
  noSprintMatch,
  dateLabel,
  teamLabel,
}: {
  sprintName?: string
  status: string
  hasTasks: boolean
  noSprintMatch: boolean
  dateLabel: string
  /** Set when the board is narrowed to one team — the likeliest reason for an
      empty screen, and invisible unless said out loud. */
  teamLabel: string | null
}) {
  if (noSprintMatch) {
    return (
      <div className="rounded-[9px] border border-dashed border-line-strong bg-surface p-6 text-center">
        <p className="text-[13.5px]">
          <b className="font-mono font-semibold">{dateLabel}</b> không nằm trong sprint nào.
        </p>
        <p className="mx-auto mt-2 max-w-lg text-[12.5px] leading-relaxed text-ink-3">
          Ngày này rơi ngoài khoảng của mọi sprint trên board — thường là khoảng nghỉ giữa hai
          sprint. Chọn ngày khác, hoặc đổi bộ lọc sang{' '}
          <b className="font-medium text-ink-2">Mọi sprint</b> để xem hết task.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-[9px] border border-dashed border-line-strong bg-surface p-6 text-center">
      <p className="text-[13.5px]">
        Không có task con nào đang giao cho bạn
        {sprintName ? ` trong ${sprintName}` : ''}
        {status === 'open' ? ' và chưa Done' : ''}
        {teamLabel ? (
          <>
            {' '}
            với label <b className="font-mono font-semibold">{teamLabel}</b>
          </>
        ) : null}
        .
      </p>
      {teamLabel && (
        <p className="mx-auto mt-2 max-w-lg text-[12.5px] leading-relaxed text-ink-3">
          Board đang lọc theo team — task thiếu label{' '}
          <b className="font-mono text-ink-2">{teamLabel}</b> sẽ không hiện ở đây, kể cả khi được
          giao cho bạn. Bỏ trống ô label trong Settings để xem tất cả.
        </p>
      )}
      <p className="mx-auto mt-2 max-w-lg text-[12.5px] leading-relaxed text-ink-3">
        {hasTasks ? (
          'Bạn có task cấp trên ở sprint này — xem danh sách bên dưới để tạo task con rồi log giờ.'
        ) : (
          <>
            Thử đổi sang <b className="font-medium text-ink-2">Mọi sprint</b>, hoặc sang màn{' '}
            <Link href="/find" className="text-accent-ink underline underline-offset-2">
              Tìm &amp; nhận task
            </Link>{' '}
            để nhận việc mới.
          </>
        )}
      </p>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className="rounded-[9px] border border-line bg-surface p-[17px]">
      <div className="flex flex-wrap items-center gap-3">
        <i className="inline-block size-[6px] shrink-0 rounded-full bg-warn" />
        <span className="text-[13px]">Chưa có API token — vào Settings để điền.</span>
        <Link
          href="/settings"
          className="rounded-md border border-line-strong bg-surface px-[9px] py-1 text-[12.5px] hover:bg-surface-2"
        >
          <span className="inline-flex items-center gap-1.5">
            Mở Settings
            <LinkPending />
          </span>
        </Link>
      </div>
    </div>
  )
}
