import { type PointsSummary, type StatusTone } from '@/lib/jira/types'
import { formatDuration } from '@/lib/time'

/**
 * Bar fill and row dot per tone.
 *
 * Solid fills, not the soft ones the status pills use: a 4px bar painted in a
 * tint meant to sit behind text is invisible. `blue-ink` rather than `blue` for
 * the same reason it exists — light blue on a light background is not a bar.
 */
const FILL: Record<StatusTone, string> = {
  todo: 'bg-line-strong',
  prog: 'bg-accent',
  test: 'bg-warn',
  ver: 'bg-blue-ink',
  done: 'bg-good',
}

const LABEL: Record<StatusTone, string> = {
  todo: 'Chưa làm',
  prog: 'Đang làm',
  test: 'Chờ test',
  ver: 'Đã verify',
  done: 'Done',
}

/**
 * The sprint's story points, and how much of them has landed.
 *
 * Sits under the day-by-day panel because it answers the other half of the same
 * question. That one says whether the hours were written down; this says
 * whether they bought anything — a fortnight of full timesheets with two points
 * closed is a real thing to notice, and neither number shows it alone.
 *
 * Verified is drawn as its own band rather than counted as done. On this
 * workflow a verified ticket can still come back, and a completion figure that
 * walks backwards teaches people to stop reading it.
 */
export function PointsPanel({
  sprintName,
  summary,
}: {
  sprintName: string
  summary: PointsSummary
}) {
  const { points, tasks, seconds, unpointed, buckets, donePoints } = summary

  // No subtasks at all in this sprint — nothing to summarise, and the board
  // beside it already says so at length. A sprint that *has* tasks but no
  // estimates still renders: "0 point, 4 task chưa có point" is the whole
  // reason the panel is worth having.
  if (!tasks) return null

  const pct = points > 0 ? Math.round((donePoints / points) * 100) : 0
  /**
   * Hours per point, over the estimated work only.
   *
   * Dividing the sprint's whole timesheet by its points would charge the
   * unpointed tasks' hours to the tasks that do carry an estimate, and on a
   * sprint where half the rows have no points that is not a small error. So the
   * ratio is built from the pointed rows alone and the rest is reported
   * separately, below.
   */
  const pointedSeconds = seconds - summary.unpointedSeconds
  const perPoint = points > 0 ? pointedSeconds / points : 0

  return (
    <section className="rounded-[9px] border border-line bg-surface p-[17px]">
      <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
        Point · {sprintName}
      </div>

      <div className="mb-3 flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-medium tracking-[-0.03em] tabular">
          {fmt(donePoints)}
        </span>
        <span className="font-mono text-[13px] text-ink-3">/ {fmt(points)} point xong</span>
        {points > 0 && (
          <span
            className={
              'ml-auto rounded-full px-2 py-[2.5px] text-[11.5px] font-medium ' +
              (pct >= 100 ? 'bg-good-soft text-good' : 'bg-surface-2 text-ink-2')
            }
          >
            {pct}%
          </span>
        )}
      </div>

      {points > 0 && (
        <div
          // `gap-px` rather than trusting the hues: `accent` and `good` are
          // ΔE 22.5 apart, and they end up adjacent whenever nothing is in
          // test or verify — which is most of a sprint's last week. A hairline
          // of the track showing through separates any two neighbours, and
          // keeps working for a reader who cannot tell green from teal at all.
          className="mb-3 flex h-[5px] w-full gap-px overflow-hidden rounded-full bg-surface-2"
          // One label for the whole bar: five adjacent tooltips on a 5px strip
          // are five things nobody can hit.
          title={buckets
            .filter((b) => b.points > 0)
            .map((b) => `${LABEL[b.tone]}: ${fmt(b.points)} point`)
            .join(' · ')}
        >
          {buckets
            .filter((b) => b.points > 0)
            .map((b) => (
              <span
                key={b.tone}
                className={FILL[b.tone]}
                style={{ width: `${(b.points / points) * 100}%` }}
              />
            ))}
        </div>
      )}

      <div className="flex flex-col gap-px">
        {buckets.map((b) => (
          <div
            key={b.tone}
            className="flex items-center gap-2 rounded px-1 py-[3px] text-[12.5px]"
          >
            <i className={'size-[6px] shrink-0 rounded-full ' + FILL[b.tone]} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{LABEL[b.tone]}</span>
            <span className="font-mono text-[11px] text-ink-3">{b.tasks} task</span>
            <b className="w-[52px] shrink-0 text-right font-mono text-[12px] tabular">
              {fmt(b.points)} pt
            </b>
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex justify-between border-t border-line pt-2.5 font-mono text-xs">
        <span className="text-ink-3">Đã log</span>
        <b className="tabular">
          {formatDuration(seconds)}
          {points > 0 && (
            <span
              className="font-normal text-ink-3"
              title={
                'Giờ đã log chia cho point, tính trên các task có point.\n' +
                'Đây là "timespent" của Jira — tổng của mọi người trên task đó, ' +
                'không riêng giờ bạn log.'
              }
            >
              {' '}
              · {hours(perPoint)}/point
            </span>
          )}
        </b>
      </div>

      {unpointed > 0 && (
        <div
          className="mt-2 rounded-[5px] border border-warn/40 bg-warn-soft px-2 py-1.5 text-[11.5px] leading-relaxed text-warn"
          title="Task không có point vẫn tính giờ nhưng không tính point — nên tỉ lệ giờ/point ở trên chỉ dựa trên các task đã ước lượng."
        >
          <b className="font-mono font-semibold">{unpointed}</b> task chưa có point
          {summary.unpointedSeconds > 0 && (
            <> · đã log {formatDuration(summary.unpointedSeconds)}</>
          )}
        </div>
      )}
    </section>
  )
}

/** `2` not `2.0`, `2.5` not `2.50` — points are halves at worst. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function hours(seconds: number): string {
  const h = seconds / 3600
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`
}
