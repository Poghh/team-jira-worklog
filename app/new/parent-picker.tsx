'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { searchParentsAction } from './actions'

import type { ParentOption } from './composer'

/**
 * Searchable picker over candidate parents.
 *
 * Scoped to the current sprint by default because that is where nearly every
 * new subtask belongs; the toggle widens it to the whole project for the
 * occasional older task. Matching covers key, summary and epic so any of the
 * three can be typed.
 */
export function ParentPicker({
  parents,
  value,
  onChange,
  currentSprintId,
  epicMode = false,
}: {
  parents: ParentOption[]
  value: string | null
  onChange: (key: string | null) => void
  currentSprintId: number | null
  epicMode?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [wide, setWide] = useState(!currentSprintId)
  // Off by default: most parents worth picking are still open, and closed ones
  // would bury them. A parent arriving from a board link is exempt — see below.
  const [showDone, setShowDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * Kết quả Jira trả về cho chữ đang gõ.
   *
   * Lọc trên `parents` là chưa đủ: danh sách đó là 150 issue mới nhất, mà
   * project này có hơn 400 task cha **đang mở** — nên một task đang chạy như
   * `VT-626` không nằm trong đó và ô tìm trả về "Không tìm thấy" cho thứ đang
   * hiện trên board. Danh sách tải sẵn vẫn giữ để mở ra là thấy ngay, nhưng
   * chữ gõ vào thì hỏi thẳng Jira.
   */
  const [remote, setRemote] = useState<ParentOption[]>([])
  const [seeking, setSeeking] = useState(false)

  const selected = parents.find((p) => p.key === value) ?? null
  const doneCount = parents.filter((p) => p.isDone).length

  useEffect(() => {
    const q = term.trim()
    if (epicMode || q.length < 2) {
      setRemote([])
      setSeeking(false)
      return
    }
    setSeeking(true)
    let alive = true
    // Chờ 250ms: gõ `VT-626` là sáu lần đổi, mà năm lần đầu không ai cần.
    const id = setTimeout(() => {
      void searchParentsAction(q, currentSprintId)
        .then((res) => {
          if (alive) setRemote(res.options ?? [])
        })
        .catch(() => {
          if (alive) setRemote([])
        })
        .finally(() => {
          if (alive) setSeeking(false)
        })
    }, 250)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [term, currentSprintId, epicMode])

  const options = useMemo(() => {
    const q = term.trim().toLowerCase()
    // Kết quả từ Jira nối sau phần khớp sẵn, bỏ trùng. Không thay thế: phần
    // sẵn hiện ngay lúc gõ, còn Jira trả về sau vài trăm mili-giây.
    const seen = new Set<string>()
    const merged = [...parents, ...remote].filter((p) =>
      seen.has(p.key) ? false : (seen.add(p.key), true),
    )
    return merged
      // `currentSprintId` absent means there is nothing to narrow by — epics are
      // not sprint-scoped — so every option must pass regardless of `wide`,
      // which may be stale if React reused this instance across a type switch.
      //
      // Đang gõ thì bỏ qua bộ lọc sprint: người ta gõ hẳn một mã task ra là
      // đang gọi đúng task đó, không phải đang duyệt sprint. Giữ bộ lọc ở đây
      // là lại "Không tìm thấy" cho thứ vừa tìm ra.
      .filter((p) => q.length >= 2 || !currentSprintId || wide || p.inCurrentSprint)
      // The already-selected one always stays visible, otherwise arriving from
      // "+ Task con" on a Done Bug would show an empty field.
      .filter((p) => showDone || !p.isDone || p.key === value || q.length >= 2)
      .filter(
        (p) =>
          !q ||
          `${p.key} ${p.summary} ${p.epicName ?? ''}`.toLowerCase().includes(q),
      )
      .slice(0, 60)
  }, [parents, remote, term, wide, currentSprintId, showDone, value])

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          value={open ? term : (selected ? `${selected.key} — ${selected.summary}` : '')}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => {
            setOpen(true)
            setTerm('')
          }}
          onBlur={() => setTimeout(() => setOpen(false), 100)}
          placeholder={epicMode ? 'Gõ tên epic để tìm…' : 'Gõ key hoặc tên để tìm…'}
          className="w-full rounded-md border border-line bg-ground py-[7px] pl-[10px] pr-7 text-[13px]"
        />
        {value && (
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(null)
              setTerm('')
            }}
            className="absolute right-1.5 top-1/2 grid size-[18px] -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Xoá"
          >
            ×
          </button>
        )}
      </div>

      {open && (
        <div className="absolute inset-x-0 top-[calc(100%+4px)] z-30 max-h-[232px] overflow-y-auto rounded-md border border-line-strong bg-surface p-1 shadow-lg">
          {currentSprintId && (
            <div className="mb-1 flex gap-1">
              {[
                [false, 'Sprint đang chạy'],
                [true, 'Toàn project'],
              ].map(([v, label]) => (
                <button
                  key={String(v)}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setWide(Boolean(v))
                  }}
                  aria-pressed={wide === v}
                  className={
                    'flex-1 rounded border px-1.5 py-[3px] text-[11px] ' +
                    (wide === v
                      ? 'border-accent bg-accent-soft font-semibold text-accent-ink'
                      : 'border-line text-ink-3 hover:text-ink')
                  }
                >
                  {label as string}
                </button>
              ))}
            </div>
          )}

          {!epicMode && (
            <label className="mb-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-ink-3 hover:text-ink">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
                onMouseDown={(e) => e.stopPropagation()}
                className="accent-accent"
              />
              Hiện cả task đã Done
              {doneCount > 0 && <span className="font-mono">({doneCount})</span>}
            </label>
          )}

          {options.length === 0 ? (
            <div className="p-2.5 text-center text-[12.5px] text-ink-3">
              {seeking ? 'Đang tìm…' : 'Không tìm thấy'}
            </div>
          ) : (
            options.map((p) => (
              <button
                key={p.key}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(p.key)
                  setOpen(false)
                  inputRef.current?.blur()
                }}
                className="block w-full rounded px-[9px] py-1.5 text-left hover:bg-accent-soft"
              >
                <span className="font-mono text-[11px] font-semibold text-accent-ink">{p.key}</span>
                {p.isDone && (
                  <span className="ml-1.5 rounded-[3px] bg-good-soft px-1 py-px font-mono text-[9.5px] uppercase text-good">
                    {p.statusName || 'Done'}
                  </span>
                )}
                {(p.epicName || p.sprintName) && (
                  <span className="ml-1.5 font-mono text-[10.5px] text-ink-3">
                    {[p.epicName, p.sprintName].filter(Boolean).join(' · ')}
                  </span>
                )}
                <span className="block text-[12.5px] leading-[1.4]">{p.summary}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
