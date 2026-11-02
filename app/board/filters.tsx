'use client'

import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

import { sprintForDay } from '@/lib/sprint-name'
import { todayIn } from '@/lib/time'

import { NavSpinner, useNav } from './navigation'

interface SprintOption {
  id: number
  name: string
  current: boolean
  start: string | null
  end: string | null
}

function dm(iso: string | null) {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : ''
}

/** Remembers the board's created-date sort direction per browser. */
const SORT_KEY = 'board:sort'

/** Filter params remembered across navigation, so returning keeps the view. */
const FILTERS_KEY = 'board:filters'
const REMEMBERED = ['status', 'q', 'epic', 'parent', 'sprint'] as const

export function BoardFilters({
  sprints,
  sprintId,
  status,
  search,
  noSprintMatch,
  epics,
  epicKey,
  parents,
  parentKey,
  sort,
}: {
  sprints: SprintOption[]
  sprintId: number | null
  status: string
  search: string
  noSprintMatch: boolean
  epics: Array<{ key: string; name: string }>
  epicKey: string
  parents: Array<{ key: string; summary: string }>
  parentKey: string
  sort: string
}) {
  const params = useSearchParams()
  const { navigate, pending } = useNav()
  const [term, setTerm] = useState(search)

  useEffect(() => setTerm(search), [search])

  // Re-apply the remembered filters (and sort) when arriving with a clean URL —
  // i.e. returning to the board from another screen. If any of these params is
  // already present, the user opened a specific view, so it is left untouched.
  // "Bỏ lọc" lands on a clean URL too, but it doesn't remount this component, so
  // it never trips this mount-only restore.
  useEffect(() => {
    if ([...REMEMBERED, 'sort'].some((k) => params.has(k))) return

    let saved: Record<string, unknown> = {}
    let savedSort: string | null = null
    try {
      saved = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') || {}
      savedSort = localStorage.getItem(SORT_KEY)
    } catch {
      saved = {}
    }

    const q = new URLSearchParams()
    for (const k of REMEMBERED) {
      const v = saved[k]
      if (typeof v === 'string' && v) q.set(k, v)
    }
    if (savedSort === 'old') q.set('sort', 'old')

    if ([...q.keys()].length) navigate(`/?${q}`)
    // Mount-only: restoring once is the whole intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Snapshot the remembered filters, then navigate. Saving here — on the user's
  // own actions only, never on mount — keeps a restore from ever racing a save.
  function go(q: URLSearchParams) {
    const snap: Record<string, string> = {}
    for (const k of REMEMBERED) {
      const v = q.get(k)
      // A sprint of 'none' is bound to a specific date; restoring it without the
      // date would wrongly read as "date outside every sprint", so skip it.
      if (v && !(k === 'sprint' && v === 'none')) snap[k] = v
    }
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(snap))
    } catch {
      // Private mode / disabled storage — filters just won't be remembered.
    }
    navigate(q.size ? `/?${q}` : '/')
  }

  function set(key: string, value: string | null) {
    const q = new URLSearchParams(params.toString())
    if (value === null || value === '') q.delete(key)
    else q.set(key, value)
    go(q)
  }

  function pickSort(value: string) {
    try {
      localStorage.setItem(SORT_KEY, value)
    } catch {
      // Private mode / disabled storage — the choice just won't be remembered.
    }
    // 'new' is the default, so drop the param rather than pinning it.
    set('sort', value === 'new' ? null : 'old')
  }

  /**
   * Moves the logging date along with the sprint.
   *
   * Keeping the old date after switching sprints leaves the capacity bar showing
   * a day outside the sprint you are now looking at, which reads as a bug. The
   * current sprint lands on today; any other sprint lands on its first day,
   * since that is where you would start reviewing it.
   */
  function pickSprint(value: string) {
    const q = new URLSearchParams(params.toString())
    q.set('sprint', value)

    const sprint = sprints.find((s) => String(s.id) === value)
    const today = todayIn()
    // Includes the days just after its end that still count for it.
    const coversToday = Boolean(sprint && sprintForDay(sprints, today)?.sprint.id === sprint.id)

    // No `date` param means today, so deleting it is how we select today.
    if (!sprint || coversToday) q.delete('date')
    else if (sprint.start) q.set('date', sprint.start)

    // These name issues in the sprint being left, so they would filter the new
    // one down to nothing.
    q.delete('epic')
    q.delete('parent')

    go(q)
  }

  // Jira returns sprints ordered by state then backlog position, so they are
  // split by date here instead — otherwise stale un-closed sprints outrank the
  // real one.
  const current = sprints.filter((s) => s.current)
  const past = sprints.filter((s) => !s.current)

  const control =
    'rounded-md border border-line bg-surface px-[9px] py-[5px] text-[12.5px] text-ink disabled:opacity-60'

  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
      <select
        className={control}
        disabled={pending}
        value={sprintId === null ? (noSprintMatch ? 'none' : 'all') : String(sprintId)}
        onChange={(e) => pickSprint(e.target.value)}
      >
        {current.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {dm(s.start)} – {dm(s.end)} (đang chạy)
          </option>
        ))}
        {noSprintMatch && <option value="none">Ngày ngoài mọi sprint</option>}
        <option value="all">Mọi sprint</option>
        {past.length > 0 && (
          <optgroup label="Sprint khác">
            {past.slice(0, 30).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {dm(s.start)} – {dm(s.end)}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <select
        className={control}
        disabled={pending}
        value={status}
        onChange={(e) => set('status', e.target.value)}
      >
        <option value="open">Chưa Done</option>
        <option value="all">Mọi trạng thái</option>
      </select>

      <select
        className={control}
        disabled={pending}
        value={sort}
        onChange={(e) => pickSort(e.target.value)}
        title="Sắp xếp epic, task cha và task con theo ngày tạo"
      >
        <option value="new">Mới nhất trước</option>
        <option value="old">Cũ nhất trước</option>
      </select>

      {epics.length > 1 && (
        <select
          className={control + ' max-w-[190px]'}
          disabled={pending}
          value={epicKey}
          onChange={(e) => {
            const q = new URLSearchParams(params.toString())
            if (e.target.value) q.set('epic', e.target.value)
            else q.delete('epic')
            q.delete('parent')
            go(q)
          }}
        >
          <option value="">Mọi epic</option>
          {epics.map((ep) => (
            <option key={ep.key} value={ep.key}>
              {ep.name}
            </option>
          ))}
        </select>
      )}

      {parents.length > 1 && (
        <select
          className={control + ' max-w-[190px]'}
          disabled={pending}
          value={parentKey}
          onChange={(e) => set('parent', e.target.value)}
        >
          <option value="">Mọi task cha</option>
          {parents.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} — {p.summary}
            </option>
          ))}
        </select>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          set('q', term)
        }}
      >
        <input
          type="search"
          value={term}
          disabled={pending}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Lọc task…"
          className={control + ' w-[150px]'}
        />
      </form>

      {(search || sprintId === null || status === 'all' || epicKey || parentKey) && (
        <button
          // Clears the remembered filters too; the sort preference stays, since
          // it's a display choice rather than a filter.
          onClick={() => {
            const q = new URLSearchParams()
            if (sort === 'old') q.set('sort', 'old')
            go(q)
          }}
          disabled={pending}
          className="rounded-md border border-line px-[9px] py-[5px] text-[12.5px] text-ink-3 hover:border-line-strong hover:text-ink disabled:opacity-60"
        >
          Bỏ lọc
        </button>
      )}

      <NavSpinner />
    </div>
  )
}
