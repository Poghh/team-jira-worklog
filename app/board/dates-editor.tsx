'use client'

import { useEffect, useState, useTransition } from 'react'

import { setDatesAction } from '@/app/actions'
import { addDays, daysBetween, todayIn } from '@/lib/time'

import { DateInput } from '../date-input'
import { Spinner } from '../spinner'
import { useNav } from './navigation'
import { Popover, PopoverTitle } from './popover'

/** `2026-09-15` → `15/09`. The year is noise on a two-week sprint. */
function short(iso: string | null): string | null {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : null
}

/**
 * Start and due date as one chip, edited in a popover.
 *
 * Both live behind a single control because they are set together and read
 * together — "khi nào làm, khi nào xong". The chip turns amber when either is
 * missing, since the team requires both, and red once the due date has passed
 * on work that is not finished.
 *
 * The presets exist because the common answers are few: today, tomorrow, and
 * the end of the sprint. Typing a full date for those is the slow path.
 */
export function DatesEditor({
  issueKey,
  startDate,
  dueDate,
  sprintEnd,
  isDone = false,
  loggingPastDue = null,
  readOnly = false,
  readOnlyReason,
}: {
  issueKey: string
  startDate: string | null
  dueDate: string | null
  /** End of the sprint being viewed, offered as a one-click due date. */
  sprintEnd?: string | null
  /** A finished issue is never "overdue", however old its due date. */
  isDone?: boolean
  /**
   * The day this finished task was last logged to, when it falls after its
   * due date.
   *
   * A separate thing from `overdue`, which is measured against the real today
   * and is about a deadline being missed. This is about an entry that exists:
   * the dates say the work ended, and there is a worklog after them. Marked on
   * the chip because the chip already carries the two dates the clash is
   * between — the one place where saying it needs no new element.
   *
   * Read off the task, not off the day being viewed: the mistake has to be
   * visible without already knowing which day it happened on.
   */
  loggingPastDue?: string | null
  /**
   * Someone else's task. The dates still colour — a deadline is worth seeing
   * whoever owns it — but the popover never opens.
   */
  readOnly?: boolean
  readOnlyReason?: string
}) {
  const [start, setStart] = useState(startDate)
  const [due, setDue] = useState(dueDate)
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { refresh } = useNav()

  useEffect(() => {
    setStart(startDate)
    setDue(dueDate)
  }, [startDate, dueDate])

  const today = todayIn()
  const missing = !start || !due

  /**
   * Due-date pressure, in the order it matters.
   *
   * "Done" is the only status that silences it: on a ten-column workflow every
   * other one — including VERIFIED ON STAGING — still has work attached to it,
   * and a task sitting there past its date is exactly what should be noticed.
   *
   * Measured against the real today, not the day the board is filtered to.
   * Looking back at last Friday must not repaint every task as overdue.
   */
  const overdue = Boolean(!isDone && due && due < today)
  const dueToday = Boolean(!isDone && due && due === today)
  const daysLate = overdue && due ? daysBetween(due, today) : 0

  /**
   * Sends both dates on every save, never just the changed one.
   *
   * The server compares them to reject a due date before the start, and it can
   * only do that if it sees the pair. Sending one would let a preset click slip
   * an inverted range past the check.
   */
  function save(next: { startDate: string | null; dueDate: string | null }, close?: () => void) {
    const previous = { startDate: start, dueDate: due }
    setStart(next.startDate)
    setDue(next.dueDate)
    setNote(null)

    startTransition(async () => {
      const res = await setDatesAction(issueKey, next)
      if (res.ok) {
        close?.()
        refresh()
      } else {
        setStart(previous.startDate)
        setDue(previous.dueDate)
        setNote(res.message)
      }
    })
  }

  const label = missing
    ? (short(start) ?? short(due) ?? '—')
    : `${short(start)}→${short(due)}`

  const tone = overdue
    ? 'border-crit bg-crit-soft text-crit'
    : dueToday
      ? 'border-warn bg-warn-soft font-semibold text-warn'
      : missing
        ? 'border-warn bg-warn-soft text-warn'
        : null

  if (readOnly) {
    return (
      <span
        title={readOnlyReason ?? (start || due ? `${start ?? '—'} → ${due ?? '—'}` : 'Chưa có ngày')}
        className={
          'inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[10.5px] ' +
          (tone ?? 'border-line bg-surface-2 text-ink-3')
        }
      >
        <CalendarIcon />
        {label}
      </span>
    )
  }

  return (
    <Popover
      align="right"
      panelClassName="w-[236px]"
      trigger={(open) => (
        <button
          type="button"
          disabled={pending}
          title={
            loggingPastDue
              ? `${issueKey} đã Done, làm xong ${start} → ${due}.\nNhưng có giờ log vào ${loggingPastDue}, nằm sau due date.\n\nBấm để dời due date, hoặc kiểm lại entry.`
              : overdue
              ? `Quá hạn ${daysLate} ngày — due ${due}, task chưa Done`
              : dueToday
                ? `Đến hạn hôm nay (${due}) — task chưa Done`
                : missing
                  ? `${issueKey}: ${!start ? 'chưa có start date' : ''}${!start && !due ? ', ' : ''}${!due ? 'chưa có due date' : ''}`
                  : `${issueKey}: ${start} → ${due}`
          }
          className={
            'inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[10.5px] disabled:opacity-60 ' +
            (loggingPastDue
              // Amber, not red: nothing is broken and nothing is late — two
              // facts simply disagree, and which one is wrong is the user's to
              // say. Red is reserved for a deadline actually missed.
              ? 'border-warn bg-warn-soft font-semibold text-warn'
              : overdue
              ? 'border-crit bg-crit-soft text-crit'
              : dueToday
                // Same amber as a missing date — both mean "this needs you
                // today" — but bold, because one is a gap in the data and the
                // other is a deadline landing. The dates in the chip say which.
                ? 'border-warn bg-warn-soft font-semibold text-warn'
                : missing
                  ? 'border-warn bg-warn-soft text-warn'
                  : open
                    ? 'border-accent text-accent-ink'
                    : 'border-line-strong bg-surface text-ink-2 hover:border-accent hover:text-accent-ink')
          }
        >
          {pending ? (
            <Spinner className="size-2.5" />
          ) : (
            <>
              <CalendarIcon />
              {label}
            </>
          )}
        </button>
      )}
    >
      {(close) => (
        <>
          <PopoverTitle>{issueKey} · ngày</PopoverTitle>

          <div className="flex flex-col gap-2">
            <DateField
              label="Start"
              value={start}
              onChange={(v) => setStart(v)}
              max={due ?? undefined}
            />
            <DateField
              label="Due"
              value={due}
              onChange={(v) => setDue(v)}
              min={start ?? undefined}
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <Preset
              label="Hôm nay"
              onClick={() => save({ startDate: today, dueDate: today }, close)}
            />
            <Preset
              label="Hôm nay → mai"
              onClick={() => save({ startDate: today, dueDate: addDays(today, 1) }, close)}
            />
            {sprintEnd && (
              <Preset
                label={`→ hết sprint (${short(sprintEnd)})`}
                onClick={() => save({ startDate: start ?? today, dueDate: sprintEnd }, close)}
              />
            )}
          </div>

          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => save({ startDate: null, dueDate: null }, close)}
              className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2"
            >
              Xoá
            </button>
            <button
              type="button"
              onClick={() => save({ startDate: start, dueDate: due }, close)}
              className="flex-1 rounded-md bg-accent py-1 text-[12px] font-medium text-white hover:bg-accent-2"
            >
              Lưu
            </button>
          </div>

          {note && <p className="mt-2 text-[11px] text-crit">{note}</p>}
        </>
      )}
    </Popover>
  )
}

function DateField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
  min?: string
  max?: string
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-[34px] shrink-0 text-[11.5px] text-ink-3">{label}</span>
      <DateInput
        value={value ?? ''}
        min={min}
        max={max}
        aria-label={label}
        onChange={(v) => onChange(v || null)}
        className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-[12px]"
      />
    </label>
  )
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" />
      <path d="M2 6.5h12M5.5 2v3M10.5 2v3" strokeLinecap="round" />
    </svg>
  )
}

function Preset({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-line px-2 py-[2px] text-[11px] text-ink-2 hover:border-accent hover:text-accent-ink"
    >
      {label}
    </button>
  )
}
