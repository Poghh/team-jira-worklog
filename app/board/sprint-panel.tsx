import Link from 'next/link'

import {
  DAY_OFF_LABEL,
  DAY_OFF_SHORT,
  type DayOffKind,
  type QuotaRules,
  halfDayHours,
  quotaForDate,
} from '@/lib/quota'
import { addDays, formatDuration } from '@/lib/time'

import { LinkPending } from '../link-pending'
import { DayBar } from './day-bar'
import { DayOffButton } from './day-off-button'

const VI_DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

function label(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${VI_DAYS[dow]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < 60; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * Day-by-day coverage for the whole sprint.
 *
 * A sprint runs two weeks, so a single calendar week cannot show whether the
 * sprint as a whole is covered — which is the thing worth checking before it
 * closes. Days after today are listed but not counted as short: they simply
 * have not happened yet.
 */
export function SprintPanel({
  sprintName,
  start,
  end,
  today,
  selectedDate,
  secondsByDate,
  rules,
  baseQuery,
}: {
  sprintName: string
  start: string
  end: string
  today: string
  selectedDate: string
  secondsByDate: Record<string, number>
  rules: QuotaRules
  /** Current filters minus `date`, so day links keep the sprint they belong to. */
  baseQuery: string
}) {
  /**
   * A bare `?date=…` href replaces the whole query string, which silently drops
   * `sprint` and bounces the board back to the current sprint. Every day link
   * has to carry the existing filters forward.
   */
  const hrefFor = (d: string) => `/?${baseQuery ? baseQuery + '&' : ''}date=${d}`
  const all = daysBetween(start, end)
  const elapsed = all.filter((d) => d <= today)
  const upcoming = all.filter((d) => d > today)

  const quotaFor = (d: string) => quotaForDate(d, rules)
  /**
   * Where lunch falls across the bar, as a fraction of the working day.
   *
   * Passed down rather than assumed to be the middle: on a 09:00–18:00 day the
   * morning is three hours of eight, so a half-day bar drawn at 50/50 would
   * show the wrong half as the larger one.
   */
  const halves = halfDayHours(rules.schedule)
  const span = halves.morning + halves.afternoon
  const split = span > 0 ? halves.morning / span : 0.5

  const workdays = elapsed.filter((d) => quotaFor(d) > 0)
  const short = workdays.filter((d) => (secondsByDate[d] ?? 0) < quotaFor(d) * 3600)
  const complete = workdays.length - short.length

  const totalSeconds = all.reduce((n, d) => n + (secondsByDate[d] ?? 0), 0)
  const expectedSeconds = workdays.reduce((n, d) => n + quotaFor(d) * 3600, 0)
  const missingSeconds = short.reduce(
    (n, d) => n + Math.max(0, quotaFor(d) * 3600 - (secondsByDate[d] ?? 0)),
    0,
  )

  return (
    <aside className="flex flex-col gap-3.5 lg:sticky lg:top-5">
      <section className="rounded-[9px] border border-line bg-surface p-[17px]">
        <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
          {sprintName}
        </div>

        <div className="mb-3 flex items-baseline gap-2">
          <span className="font-mono text-[22px] font-medium tracking-[-0.03em] tabular">
            {complete}
          </span>
          <span className="font-mono text-[13px] text-ink-3">/ {workdays.length} ngày đủ giờ</span>
          {short.length > 0 && (
            <span className="ml-auto rounded-full bg-warn-soft px-2 py-[2.5px] text-[11.5px] font-medium text-warn">
              thiếu {formatDuration(missingSeconds)}
            </span>
          )}
          {short.length === 0 && workdays.length > 0 && (
            <span className="ml-auto rounded-full bg-good-soft px-2 py-[2.5px] text-[11.5px] font-medium text-good">
              đủ hết ✓
            </span>
          )}
        </div>

        <div className="flex flex-col gap-px">
          {elapsed.map((d) => (
            <DayRow
              key={d}
              date={d}
              href={hrefFor(d)}
              seconds={secondsByDate[d] ?? 0}
              quota={quotaFor(d)}
              dayOff={rules.daysOff[d] ?? null}
              split={split}
              selected={d === selectedDate}
              isToday={d === today}
            />
          ))}

          {upcoming.length > 0 && (
            <div className="mt-1.5 border-t border-line pt-1.5">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                còn lại {upcoming.length} ngày
              </div>
              {upcoming.map((d) => (
                <DayRow
                  key={d}
                  date={d}
                  href={hrefFor(d)}
                  seconds={secondsByDate[d] ?? 0}
                  quota={quotaFor(d)}
                  dayOff={rules.daysOff[d] ?? null}
                  split={split}
                  selected={d === selectedDate}
                  future
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-2.5 flex justify-between border-t border-line pt-2.5 font-mono text-xs">
          <span className="text-ink-3">Tổng sprint</span>
          <b className="tabular">
            {formatDuration(totalSeconds)}
            <span className="font-normal text-ink-3"> / {formatDuration(expectedSeconds)}</span>
          </b>
        </div>
      </section>

      {short.length > 0 && (
        <section className="rounded-[9px] border border-line bg-surface p-[17px]">
          <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
            Ngày chưa đủ ({short.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {short.map((d) => (
              <Link
                key={d}
                href={hrefFor(d)}
                className="rounded-md border border-warn/40 bg-warn-soft px-2 py-[3px] font-mono text-[11.5px] text-warn hover:border-warn"
                title={`Thiếu ${formatDuration(quotaFor(d) * 3600 - (secondsByDate[d] ?? 0))} — bấm để log bù`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {label(d)}
                  <LinkPending />
                </span>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            Bấm một ngày để chuyển sang ngày đó rồi log bù.
          </p>
        </section>
      )}
    </aside>
  )
}

function DayRow({
  date,
  href,
  seconds,
  quota,
  dayOff,
  split,
  selected,
  isToday,
  future,
}: {
  date: string
  href: string
  seconds: number
  quota: number
  dayOff: DayOffKind | null
  /** Where the morning ends as a fraction of the day — see {@link DayBar}. */
  split: number
  selected: boolean
  isToday?: boolean
  future?: boolean
}) {
  const pct = quota > 0 ? Math.min(100, (seconds / (quota * 3600)) * 100) : seconds > 0 ? 100 : 0
  const short = quota > 0 && seconds < quota * 3600 && !future
  const over = quota > 0 && seconds > quota * 3600

  const tone = dayOff || quota === 0 || over ? 'bg-ot' : short ? 'bg-warn' : 'bg-accent'

  return (
    <div
      className={
        'group grid grid-cols-[58px_minmax(0,1fr)_38px_18px] items-center gap-1.5 rounded px-1.5 py-1 ' +
        (selected ? '-mx-1.5 bg-accent-soft' : 'hover:bg-surface-2')
      }
    >
      <Link href={href} className="contents">
      <span
        className={
          'font-mono text-[11px] ' +
          (selected
            ? 'font-semibold text-accent-ink'
            : future || quota === 0
              ? 'text-ink-3'
              : 'text-ink-2')
        }
      >
        {label(date)}
        {isToday && !selected && <span className="ml-0.5 text-accent">•</span>}
      </span>

      <DayBar
        pct={pct}
        tone={tone}
        dayOff={dayOff}
        split={split}
        title={
          dayOff
            ? `${DAY_OFF_LABEL[dayOff]} — phần gạch chéo là buổi không tính giờ`
            : undefined
        }
      />

      <span
        className={
          'text-right font-mono text-[11.5px] tabular ' +
          (seconds ? (short ? 'text-warn' : '') : 'text-ink-3')
        }
      >
        <LinkPending className="mr-1 align-[-1px]" />
        {seconds ? (seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1) : '—'}
      </span>
      </Link>

      <DayOffButton date={date} current={dayOff} label={label(date)} />
    </div>
  )
}
