'use client'

import { useSearchParams } from 'next/navigation'
import { useRef } from 'react'

import { addDays, todayIn } from '@/lib/time'

import { NavSpinner, useNav } from './navigation'

interface SprintRange {
  id: number
  start: string | null
  end: string | null
}

export function DatePicker({
  date,
  label,
  sprints,
  sprintId,
  isToday,
  today,
}: {
  date: string
  label: string
  sprints: SprintRange[]
  sprintId: number | null
  isToday: boolean
  /**
   * Hôm nay theo múi giờ cấu hình, để phân biệt ngày trước với ngày sau.
   *
   * Không đọc từ đồng hồ trình duyệt: app chạy theo một múi giờ đặt trong
   * settings, và một người ngồi múi khác sẽ thấy "hôm nay" lệch một ngày so
   * với chính con số bảng đang cộng.
   */
  today: string
}) {
  const params = useSearchParams()
  const { navigate, pending } = useNav()
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Moves the sprint to match the chosen date.
   *
   * The pair has to stay consistent in both directions: picking a day inside
   * sprint 64 while the board still lists sprint 66 shows a capacity bar and a
   * task list describing different fortnights, which reads as broken data.
   */
  function go(next: string) {
    const q = new URLSearchParams(params.toString())
    if (next === todayIn()) q.delete('date')
    else q.set('date', next)

    const match = sprints.find((s) => s.start && s.end && next >= s.start && next <= s.end)

    if (!match) {
      // No sprint covers this day. Holding on to the previous one would show a
      // task list from a different fortnight, so say so instead.
      q.set('sprint', 'none')
      q.delete('epic')
      q.delete('parent')
    } else if (match.id !== sprintId) {
      q.set('sprint', String(match.id))
      // Epic and parent filters name issues from the sprint being left behind,
      // so keeping them would filter the new sprint down to nothing.
      q.delete('epic')
      q.delete('parent')
    }

    navigate(q.size ? `/?${q}` : '/')
  }

  /**
   * Opens the native calendar straight away. `showPicker()` is the reliable way
   * to do that from a styled control; clicking a transparent input on top of a
   * label only opens it in some browsers, which made the picker feel missing.
   */
  function openCalendar() {
    const el = inputRef.current
    if (!el) return
    if (typeof el.showPicker === 'function') el.showPicker()
    else el.click()
  }

  const arrow =
    'h-[30px] w-[26px] rounded-md border border-line-strong bg-surface leading-none text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50'

  return (
    /* `items-start`, không phải `items-end`.
     *
     * Hồi nó còn nằm ở góc trên bên phải của trang thì căn phải là đúng — nó
     * dính vào mép. Giờ nó là ô **đầu tiên** của dải tổng quan, nơi mọi ô khác
     * căn trái, nên căn phải làm nhãn "NGÀY ĐANG LOG" trôi khỏi cột chữ của
     * chính nó. */
    <div className="flex flex-col items-start gap-1">
      {/* The warning used to be a banner across the middle of the board. It
          belongs on the control it describes, where it costs no vertical room. */}
      <span
        className={
          'flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.09em] ' +
          (isToday ? 'text-ink-3' : 'text-ot')
        }
      >
        <NavSpinner />
        {/* "Ngày cũ" cho mọi ngày không phải hôm nay là sai một nửa số ca:
            chọn 19/10 trong khi hôm nay 18/10 thì nó vẫn kêu "ngày cũ", trong
            khi đó là ngày sau — và cảnh báo sai chỗ thì lần sau không ai đọc. */}
        {isToday
          ? 'Ngày đang log'
          : date < today
            ? 'Đang log vào ngày cũ'
            : 'Đang log vào ngày sau'}
      </span>

      <div className="flex items-center gap-1">
        <button
          className={arrow}
          disabled={pending}
          onClick={() => go(addDays(date, -1))}
          aria-label="Ngày trước"
        >
          ‹
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={openCalendar}
            disabled={pending}
            className={
              'flex h-[30px] items-center gap-2 rounded-md border px-[11px] font-mono text-[12.5px] hover:bg-surface-2 disabled:opacity-60 ' +
              (isToday
                ? 'border-line-strong bg-surface'
                : 'border-ot bg-ot-soft font-semibold text-ot')
            }
          >
            {label}
            <svg viewBox="0 0 16 16" className="size-3.5 text-ink-3" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" />
              <path d="M2 6.5h12M5.5 2v3M10.5 2v3" strokeLinecap="round" />
            </svg>
          </button>

          {/* Sits under the button purely so the native picker has an anchor. */}
          <input
            ref={inputRef}
            type="date"
            value={date}
            onChange={(e) => e.target.value && go(e.target.value)}
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 h-0 w-full opacity-0"
          />
        </div>

        <button
          className={arrow}
          disabled={pending}
          onClick={() => go(addDays(date, 1))}
          aria-label="Ngày sau"
        >
          ›
        </button>

        {date !== todayIn() && (
          <button
            onClick={() => go(todayIn())}
            disabled={pending}
            className="ml-1 h-[30px] rounded-md border border-line-strong bg-surface px-[9px] text-[12.5px] hover:bg-surface-2 disabled:opacity-60"
          >
            Hôm nay
          </button>
        )}
      </div>
    </div>
  )
}
