import Link from 'next/link'
import { connection } from 'next/server'

import { JiraError, getMyself, jiraBlockedBy } from '@/lib/jira/client'
import {
  type FoundIssue,
  type OwnerFilter,
  findByJql,
  findInProject,
  findInSprint,
  listPresets,
} from '@/lib/jira/find'
import { getSprints } from '@/lib/jira/sprints'
import { SETTING_KEYS, getSetting } from '@/lib/settings'

import { NavProvider } from '../board/navigation'
import { FindControls } from './controls'
import { ResultList } from './results'
import { JiraDown } from '../jira-down'

type Tab = 'sprint' | 'project' | 'jql'

export default async function FindPage(props: PageProps<'/find'>) {
  await connection()

  if (!getSetting(SETTING_KEYS.jiraApiToken)) {
    return (
      <div className="rounded-[9px] border border-line bg-surface p-[17px]">
        <span className="text-[13px]">Chưa cấu hình Jira — </span>
        <Link href="/settings" className="text-[13px] text-accent-ink underline underline-offset-2">
          mở Settings
        </Link>
      </div>
    )
  }

  const sp = await props.searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const tab = (one(sp.tab) ?? 'sprint') as Tab
  const search = one(sp.q) ?? ''
  const owner = (one(sp.owner) ?? 'unassigned') as OwnerFilter
  const status = one(sp.status) === 'all' ? 'all' : 'open'
  const scope = one(sp.scope) === 'backlog' ? 'backlog' : 'all'
  const jql = one(sp.jql) ?? ''

  let me
  let sprints
  let current
  try {
    me = await getMyself()
    ;({ sprints, current } = await getSprints())
  } catch (e) {
    // The search below already reports its own failures inline, but these two
    // run before there is any page to report into.
    if (!jiraBlockedBy(e)) throw e
    return <JiraDown error={e} retryHref="/find" />
  }
  const sprintId = one(sp.sprint) ? Number(one(sp.sprint)) : (current?.id ?? null)
  const presets = await listPresets()

  let results: FoundIssue[] = []
  let error: string | null = null

  try {
    if (tab === 'sprint' && sprintId) results = await findInSprint(sprintId, owner, search)
    else if (tab === 'project') results = await findInProject(search, status, scope)
    else if (tab === 'jql' && jql.trim()) results = await findByJql(jql)
  } catch (e) {
    error =
      e instanceof JiraError && e.status === 400
        ? `JQL không hợp lệ — ${e.message}`
        : e instanceof Error
          ? e.message
          : 'Truy vấn thất bại'
  }

  return (
    <NavProvider>
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Tìm &amp; nhận task</h1>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Tìm task chưa ai nhận hoặc của người khác, rồi tự assign cho mình.
        </p>
      </header>

      <FindControls
        tab={tab}
        sprints={sprints.map((s) => ({
          id: s.id,
          name: s.name,
          current: Boolean(s.current),
          start: s.startDate?.slice(0, 10) ?? null,
          end: s.endDate?.slice(0, 10) ?? null,
        }))}
        sprintId={sprintId}
        owner={owner}
        status={status}
        scope={scope}
        search={search}
        jql={jql}
        presets={presets}
        resultCount={results.length}
      />

      {error ? (
        <div className="rounded-[9px] border border-crit/40 bg-crit-soft p-[17px]">
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-crit">
            Truy vấn lỗi
          </div>
          <p className="text-[13px]">{error}</p>
        </div>
      ) : (
        <ResultList
          issues={results}
          myAccountId={me.accountId}
          emptyHint={
            tab === 'jql' && !jql.trim()
              ? 'Nhập JQL rồi bấm Chạy, hoặc chọn một preset bên trên.'
              : 'Không có issue nào khớp. Thử nới bộ lọc hoặc đổi sprint.'
          }
        />
      )}
    </NavProvider>
  )
}
