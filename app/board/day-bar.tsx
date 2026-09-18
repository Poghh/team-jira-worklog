import type { DayOffKind } from '@/lib/quota'

/**
 * One day's hours as a bar, with any leave struck out of it.
 *
 * The strike is the point. Before it, a day off and a day nobody logged looked
 * identical — an empty track either way — and only one of those means work is
 * missing. Worse on a half day: the bar read full at four hours without ever
 * saying four was the whole of what the day asked for.
 *
 * So the hatched part is the half that was not worked, and the fill sits on the
 * half that was: a morning off pushes the fill to the right-hand side, which is
 * where those hours actually happened. That the fill *moves* is what makes the
 * bar readable at a glance rather than needing the number beside it.
 *
 * The two halves are not equal and the bar does not pretend they are. This
 * workplace runs 09:00–18:00 around lunch, so the morning is three hours
 * against the afternoon's five — `split` is where that boundary falls, and a
 * morning off leaves visibly more track than an afternoon off does.
 *
 * `pct` is already measured against that half's own quota — a half day full of
 * work is 100% — so the fill is scaled into its own share of the track.
 * Overtime past the half runs on and overlaps the hatching, which is exactly
 * what it means.
 *
 * The hatch is an inline gradient rather than a Tailwind arbitrary value: this
 * is the one place in the app that needs it, and a `repeating-linear-gradient`
 * spelled into a class name is a string that silently stops being emitted the
 * day somebody reformats it.
 */
const HATCH =
  'repeating-linear-gradient(135deg, var(--line-strong) 0 1.5px, transparent 1.5px 4px)'

export function DayBar({
  pct,
  tone,
  dayOff = null,
  split = 0.5,
  title,
}: {
  /** How much of the day's own quota was logged, 0–100. */
  pct: number
  /** Tailwind background class for the fill. */
  tone: string
  dayOff?: DayOffKind | null
  /** Where the morning ends, as a fraction of the working day. 3h of 8 = 0.375. */
  split?: number
  title?: string
}) {
  const morning = dayOff === 'afternoon'
  const afternoon = dayOff === 'morning'
  const half = morning || afternoon
  // The share of the track this day's work can occupy: its own half, or all of
  // it when no leave is marked.
  const share = morning ? split : afternoon ? 1 - split : 1
  const left = afternoon ? split * 100 : 0

  return (
    <span
      title={title}
      className="relative block h-[5px] overflow-hidden rounded-[3px] bg-surface-2"
    >
      {dayOff && (
        <span
          aria-hidden
          className="absolute inset-y-0"
          style={{
            backgroundImage: HATCH,
            // The hatch covers what was *not* worked, so it is the other half.
            left: morning ? `${split * 100}%` : 0,
            width: half ? `${(morning ? 1 - split : split) * 100}%` : '100%',
          }}
        />
      )}
      <span
        className={'absolute inset-y-0 rounded-[3px] ' + tone}
        style={{ left: `${left}%`, width: `${pct * share}%` }}
      />
    </span>
  )
}
