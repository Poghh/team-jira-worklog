/**
 * Where a worklog lands on the clock, on a day with half of it taken as leave.
 *
 * Run: npx tsx tests/schedule.mts
 *
 * These write real times into somebody else's Jira, so every case here is one
 * that used to come out wrong or is one step away from it: an afternoon worked
 * after a morning off, an entry that must no longer jump a break it is already
 * past, and the overtime that runs off the end of a half day.
 */
import { type DayOffKind, halfDayHours, quotaForDate, scheduleForDate } from '@/lib/quota'
import {
  DEFAULT_SCHEDULE,
  type WorkSchedule,
  formatClock,
  formatSlices,
  placeWorklog,
  sliceWorklog,
} from '@/lib/time'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}

const DAY = '2026-09-17'
/** A workplace with no break at all — 08:00–16:00 solid. */
const solidSchedule: WorkSchedule = {
  start: 8 * 60,
  end: 16 * 60,
  breakStart: null,
  breakEnd: null,
}
const off = (kind: DayOffKind | null): Record<string, DayOffKind> =>
  kind ? { [DAY]: kind } : {}
const sched = (kind: DayOffKind | null, base: WorkSchedule = DEFAULT_SCHEDULE) =>
  scheduleForDate(DAY, base, off(kind))
/** The span an entry reads back as, given nothing else logged that day. */
const span = (kind: DayOffKind | null, hours: number, already = 0) => {
  const s = placeWorklog(already * 60, hours * 60, sched(kind))
  return `${formatClock(s.start)}–${formatClock(s.end)}`
}

/* ── an ordinary day is untouched ───────────────────────────────────────── */
eq(sched(null), DEFAULT_SCHEDULE, 'no leave leaves the schedule exactly as it was')
eq(span(null, 4), '09:00–14:00', 'and 4h from 09:00 still steps over lunch to 14:00')

/* ── the bug: a morning off, and the afternoon still stamped 09:00 ──────── */
eq(sched('morning'), { start: 13 * 60, end: 18 * 60, breakStart: null, breakEnd: null },
   'a morning off starts the day after the break')
eq(span('morning', 4), '13:00–17:00', '4h after a morning off is 13:00–17:00, not 09:00–14:00')
// And it must not step over a break it is already past — that was the old
// behaviour reappearing one layer down.
eq(sliceWorklog(0, 4 * 60, sched('morning')).length, 1,
   'an afternoon-only entry is one Jira record, not two')
eq(formatSlices(sliceWorklog(0, 4 * 60, sched('morning'))), '13:00–17:00',
   'and Jira holds exactly the hours worked')

/* ── an afternoon off ───────────────────────────────────────────────────── */
eq(sched('afternoon'), { start: 9 * 60, end: 12 * 60, breakStart: null, breakEnd: null },
   'an afternoon off ends the day at the break')
eq(span('afternoon', 3), '09:00–12:00', 'a full morning is 09:00–12:00')
eq(formatSlices(sliceWorklog(0, 3 * 60, sched('afternoon'))), '09:00–12:00',
   'and stays one record — there is no break left inside it to cut at')
// The half is where the day *ends*, not a wall. Five hours on a morning-only
// day says somebody worked through lunch, and saying 09:00–12:00 would be a
// quieter lie than saying 09:00–14:00.
eq(span('afternoon', 5), '09:00–14:00', 'overtime past a half day runs on rather than clamping')

/* ── entries stack within the half ──────────────────────────────────────── */
eq(span('morning', 2, 2), '15:00–17:00', 'a second entry follows the first inside the afternoon')
eq(span('afternoon', 1, 2), '11:00–12:00', 'and inside the morning')

/* ── a whole day off is left alone on purpose ───────────────────────────── */
eq(sched('full'), DEFAULT_SCHEDULE,
   'a full day off has no half to move work into, so the ordinary day stands')
eq(span('full', 2), '09:00–11:00', 'work logged on one is placed as it always was')

/* ── the halves are not equal, and the quota must not pretend they are ──── */
// 09:00–18:00 around a 12:00–13:00 lunch: three hours of morning, five of
// afternoon. `dailyHours / 2` — what this used to be — is wrong for both.
eq(halfDayHours(DEFAULT_SCHEDULE), { morning: 3, afternoon: 5 },
   'the clock divides the day 3/5, not 4/4')
const rulesFor = (kind: DayOffKind | null) => ({
  dailyHours: 8,
  weekendCounts: false,
  daysOff: off(kind),
  schedule: DEFAULT_SCHEDULE,
})
eq(quotaForDate(DAY, rulesFor('morning')), 5,
   'a morning off still owes the full five-hour afternoon')
eq(quotaForDate(DAY, rulesFor('afternoon')), 3, 'and an afternoon off owes the three-hour morning')
eq(quotaForDate(DAY, rulesFor('full')), 0, 'a whole day off owes nothing')
eq(quotaForDate(DAY, rulesFor(null)), 8, 'and an ordinary day still takes the configured figure')
// The quota and the placement have to describe the same block of time, or the
// bar fills to 100% somewhere the entry could never have been written.
eq((sched('morning').end - sched('morning').start) / 60, quotaForDate(DAY, rulesFor('morning')),
   'quota and schedule agree on how long the afternoon is')
eq((sched('afternoon').end - sched('afternoon').start) / 60, quotaForDate(DAY, rulesFor('afternoon')),
   'and on the morning')
eq(span('morning', 5), '13:00–18:00', 'five hours after a morning off fills it exactly')
eq(span('afternoon', 3), '09:00–12:00', 'as three does the morning')

eq(halfDayHours(solidSchedule), { morning: 4, afternoon: 4 },
   'with no break there is no boundary, so the span is halved')

/* ── a workplace with no break configured ───────────────────────────────── */
// Nothing to be either side of, so the working day is halved instead. 08:00–16:00
// splits at noon.
eq(sched('morning', solidSchedule).start, 12 * 60, 'with no break, a morning off starts at the midpoint')
eq(sched('afternoon', solidSchedule).end, 12 * 60, 'and an afternoon off ends there')
eq(sched(null, solidSchedule), solidSchedule, 'an ordinary day on such a schedule is still untouched')

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} ok`)
if (bad) process.exit(1)
