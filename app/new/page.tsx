import Link from 'next/link'
import { connection } from 'next/server'

import { listEpics, listParentCandidates } from '@/lib/jira/create'
import { getProjectMeta } from '@/lib/jira/meta'
import { getSprints, sprintPrefix } from '@/lib/jira/sprints'
import { SETTING_KEYS, getSetting, getTeamScope } from '@/lib/settings'
import { getDraft, listDrafts, listPrefixes } from '@/lib/drafts'
import { listTaskTemplates } from '@/lib/task-templates'

import { Composer } from './composer'
import { jiraBlockedBy } from '@/lib/jira/client'
import { JiraDown } from '../jira-down'

/** Same Jira boundary as the board and the report — see {@link JiraDown}. */
export default async function NewTaskPage(props: PageProps<'/new'>) {
  try {
    return await newTaskPage(props)
  } catch (error) {
    if (!jiraBlockedBy(error)) throw error
    return <JiraDown error={error} retryHref="/new" />
  }
}

async function newTaskPage(props: PageProps<'/new'>) {
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
  const parentParam = one(sp.parent) ?? null
  const draftId = one(sp.draft) ? Number(one(sp.draft)) : undefined

  const [meta, { sprints, current }] = await Promise.all([getProjectMeta(), getSprints()])
  const [parents, epics] = await Promise.all([
    // Pass the key from ?parent= so a link always lands on a filled picker.
    listParentCandidates(current?.id ?? null, parentParam),
    listEpics(),
  ])

  const draft = draftId ? getDraft(draftId) : undefined
  const drafts = listDrafts()
  const templates = listTaskTemplates()

  const pattern = getSetting(SETTING_KEYS.sprintPrefixPattern) ?? '[spt {n}]'
  const sprintPx = current ? sprintPrefix(current.name, pattern) : null

  const budgets = {
    1: getSetting(SETTING_KEYS.pointBudget1) ?? '1-2h',
    2: getSetting(SETTING_KEYS.pointBudget2) ?? '4h',
    3: getSetting(SETTING_KEYS.pointBudget3) ?? '1d-2d',
  }

  return (
    <>
      <header className="mb-4">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
          Draft · chưa tạo trên Jira
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Task mới</h1>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Mô tả bằng lời của bạn, Gemini dựng title / description / DoD. Sửa thoải mái trước khi tạo.
        </p>
      </header>

      <Composer
        issueTypes={meta.issueTypes.map((t) => ({
          id: t.id,
          name: t.name,
          subtask: t.subtask,
          hierarchyLevel: t.hierarchyLevel,
        }))}
        parents={parents}
        epics={epics}
        sprints={sprints.map((s) => ({
          id: s.id,
          name: s.name,
          current: Boolean(s.current),
          end: s.endDate?.slice(0, 10) ?? null,
        }))}
        currentSprintId={current?.id ?? null}
        sprintPrefix={sprintPx}
        team={getTeamScope()}
        supportsDates={{
          startDate: meta.startDateFieldId !== null,
          dueDate: meta.dueDateOnScreen,
        }}
        prefixLibrary={listPrefixes()}
        budgets={budgets}
        fieldIds={{
          sprint: meta.sprintFieldId,
          storyPoints: meta.storyPointsFieldId,
          project: meta.projectId,
        }}
        initialParentKey={parentParam}
        draft={
          draft
            ? {
                id: draft.id,
                idea: draft.idea,
                title: draft.title,
                description: draft.description,
                dod: draft.dod,
                prefixes: safeParse(draft.prefixes),
                issueTypeId: draft.issueTypeId,
                parentKey: draft.parentKey,
                sprintId: draft.sprintId,
                storyPoints: draft.storyPoints,
                startDate: draft.startDate,
                dueDate: draft.dueDate,
              }
            : null
        }
        templates={templates.map((t) => ({
          id: t.id,
          name: t.name,
          title: t.title,
          description: t.description,
          dod: t.dod,
          prefixes: safeParse(t.prefixes),
          issueTypeId: t.issueTypeId,
          storyPoints: t.storyPoints,
          useCount: t.useCount,
        }))}
        drafts={drafts.map((d) => ({
          id: d.id,
          title: d.title || d.idea.slice(0, 40) || 'Draft chưa đặt tên',
          updatedAt: d.updatedAt,
        }))}
      />
    </>
  )
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
