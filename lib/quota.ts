import { type WorkSchedule, isWeekend } from './time'

/**
 * How many hours a given day is expected to hold.
 *
 * Previously this line was copied into four components, so a change to the rule
 * meant finding all four — and any one that was missed would quietly disagree
 * with the others about whether a day was short.
 *
 * Pure and free of server imports so both the board and its panels can use it.
 */

export type DayOffKind = 'full' | 'morning' | 'afternoon'

export interface QuotaRules {
  /** Hours expected on a normal working day. */
  dailyHours: number
  /** Whether Saturday and Sunday carry the same expectation. */
  weekendCounts: boolean
  /** date (YYYY-MM-DD) → kind of leave taken. */
  daysOff: Record<string, DayOffKind>
  /**
   * The working day on the clock. Only a half day needs it, and needs it
   * badly — see {@link halfDayHours}.
   */
  schedule: WorkSchedule
}

/**
 * The two halves of the working day, in hours, as the clock actually divides
 * them.
 *
 * Not `dailyHours / 2`, which is what this was and which is wrong for any
 * workplace whose lunch does not sit in the middle of the day. Here the day
 * runs 09:00–18:00 around a 12:00–13:00 break, so the morning is three hours
 * and the afternoon is five. Calling both of them four asked somebody who had
 * taken the morning off for four hours and then marked their day complete
 * while an hour of it was still missing — and told somebody who had taken the
 * afternoon off that they were an hour short of a morning that had already
 * ended.
 *
 * With no break configured there is no boundary to measure from, so the span
 * is halved — the same fallback {@link scheduleForDate} makes, and for the
 * same reason.
 */
export function halfDayHours(schedule: WorkSchedule): {
  morning: number
  afternoon: number
} {
  const { start, end, breakStart, breakEnd } = schedule
  if (breakStart === null || breakEnd === null) {
    const half = (end - start) / 2 / 60
    return { morning: half, afternoon: half }
  }
  return {
    morning: Math.max(0, breakStart - start) / 60,
    afternoon: Math.max(0, end - breakEnd) / 60,
  }
}

export function quotaForDate(date: string, rules: QuotaRules): number {
  if (isWeekend(date) && !rules.weekendCounts) return 0

  const off = rules.daysOff[date]
  if (off === 'full') return 0
  if (off === 'morning' || off === 'afternoon') {
    // Read off the clock, not halved. The daily setting still governs a whole
    // day, because a workplace may well expect fewer hours than its own opening
    // times span; a *half* day has no setting of its own, and the only honest
    // answer left is how long that half actually is.
    const halves = halfDayHours(rules.schedule)
    return off === 'morning' ? halves.afternoon : halves.morning
  }

  return rules.dailyHours
}

/**
 * The working day as half a day of leave leaves it.
 *
 * Quota already halved on these days; where the remaining half sits on the
 * clock did not, so an afternoon of work logged after a morning off still came
 * out stamped 09:00 — the one time of day it certainly was not. Everything
 * that places an entry runs off {@link WorkSchedule}, so correcting the
 * schedule corrects the placement, the preview and the Jira record together
 * rather than in three places that can disagree.
 *
 * The break is the boundary: "sáng" and "chiều" are the two sides of lunch,
 * not of an arbitrary midpoint. With no break configured there is nothing to
 * be either side of, so the working day is halved instead — the only split
 * left that is defensible.
 *
 * Both halves come back without a break of their own, which is what makes the
 * placement right: a half day is worked straight through. Overtime past the
 * half still runs on rather than clamping, exactly as it does on a full day —
 * an afternoon off and five hours logged says somebody worked through lunch,
 * which is a thing that happens and not something to quietly round away.
 *
 * `full` is deliberately left alone. Hours logged on a day marked off entirely
 * are hours somebody worked anyway, and there is no half to move them into —
 * the ordinary day is the only honest frame left.
 */
export function scheduleForDate(
  date: string,
  base: WorkSchedule,
  daysOff: Record<string, DayOffKind>,
): WorkSchedule {
  const off = daysOff[date]
  if (off !== 'morning' && off !== 'afternoon') return base

  const morningEnds = base.breakStart ?? Math.round((base.start + base.end) / 2)
  const afternoonStarts = base.breakEnd ?? morningEnds

  return off === 'morning'
    ? { start: afternoonStarts, end: base.end, breakStart: null, breakEnd: null }
    : { start: base.start, end: morningEnds, breakStart: null, breakEnd: null }
}

export function isDayOff(date: string, rules: QuotaRules): boolean {
  return Boolean(rules.daysOff[date]) || (isWeekend(date) && !rules.weekendCounts)
}

export const DAY_OFF_LABEL: Record<DayOffKind, string> = {
  full: 'Nghỉ cả ngày',
  morning: 'Nghỉ sáng',
  afternoon: 'Nghỉ chiều',
}

export const DAY_OFF_SHORT: Record<DayOffKind, string> = {
  full: 'nghỉ',
  morning: 'nghỉ sáng',
  afternoon: 'nghỉ chiều',
}
