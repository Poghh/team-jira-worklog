import { DAY_OFF_LABEL, type QuotaRules, halfDayHours, quotaForDate } from '@/lib/quota'
import { formatDuration } from '@/lib/time'

import { DayBar } from './day-bar'

const VI_DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${VI_DAYS[dow]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`
}

export function WeekPanel({
  days,
  today,
  hoursByDate,
  rules,
}: {
  days: string[]
  today: string
  hoursByDate: Record<string, number>
  rules: QuotaRules
}) {
  const total = days.reduce((n, d) => n + (hoursByDate[d] ?? 0), 0)
  // Where lunch falls across the bar — the halves are 3h and 5h here, not 4/4.
  const halves = halfDayHours(rules.schedule)
  const span = halves.morning + halves.afternoon
  const split = span > 0 ? halves.morning / span : 0.5

  const shortDays = days.filter((d) => {
    const quota = quotaForDate(d, rules)
    return quota > 0 && (hoursByDate[d] ?? 0) < quota
  })

  return (
    <aside className="flex flex-col gap-3.5 lg:sticky lg:top-5">
      <section className="rounded-[9px] border border-line bg-surface p-[17px]">
        <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
          Tuần {dayLabel(days[0]).slice(3)} – {dayLabel(days[6]).slice(3)}
        </div>

        <div className="flex flex-col gap-px">
          {days.map((d) => {
            const hours = hoursByDate[d] ?? 0
            const quota = quotaForDate(d, rules)
            const pct = quota > 0 ? Math.min(100, (hours / quota) * 100) : hours > 0 ? 100 : 0
            const tone =
              quota === 0 ? 'bg-ot' : hours > quota ? 'bg-ot' : hours < quota ? 'bg-warn' : 'bg-accent'

            return (
              <div
                key={d}
                className={
                  'grid grid-cols-[62px_minmax(0,1fr)_38px] items-center gap-2 rounded py-1 ' +
                  (d === today ? '-mx-1.5 bg-accent-soft px-1.5' : '')
                }
              >
                <span
                  className={
                    'font-mono text-[11px] ' +
                    (d === today ? 'font-semibold text-accent-ink' : quota === 0 ? 'text-ink-3' : 'text-ink-2')
                  }
                >
                  {dayLabel(d)}
                </span>
                <DayBar
                  pct={pct}
                  tone={tone}
                  dayOff={rules.daysOff[d] ?? null}
                  split={split}
                  title={
                    rules.daysOff[d]
                      ? `${DAY_OFF_LABEL[rules.daysOff[d]]} — phần gạch chéo là buổi không tính giờ`
                      : undefined
                  }
                />
                <span
                  className={
                    'text-right font-mono text-[11.5px] tabular ' + (hours ? '' : 'text-ink-3')
                  }
                >
                  {hours ? hours.toFixed(hours % 1 === 0 ? 0 : 1) : '—'}
                </span>
              </div>
            )
          })}
        </div>

        <div className="mt-2.5 flex justify-between border-t border-line pt-2.5 font-mono text-xs">
          <span className="text-ink-3">Tổng</span>
          <b className="tabular">{formatDuration(total * 3600)}</b>
        </div>
      </section>

      {shortDays.length > 0 && (
        <section className="rounded-[9px] border border-line bg-surface p-[17px]">
          <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
            Ngày chưa đủ định mức
          </div>
          <div className="flex flex-col">
            {shortDays.map((d, i) => {
              const missing = quotaForDate(d, rules) - (hoursByDate[d] ?? 0)
              return (
                <div
                  key={d}
                  className={
                    'flex justify-between gap-2.5 py-[5px] text-[12.5px] ' +
                    (i ? 'border-t border-line' : '')
                  }
                >
                  <span className="font-mono">{dayLabel(d)}</span>
                  <b className="font-mono font-medium text-warn tabular">
                    thiếu {formatDuration(missing * 3600)}
                  </b>
                </div>
              )
            })}
          </div>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
            {rules.weekendCounts
              ? 'Cuối tuần đang được tính định mức như ngày thường.'
              : 'T7 và CN không tính định mức — giờ log vào vẫn cộng tổng.'}
          </p>
        </section>
      )}
    </aside>
  )
}
