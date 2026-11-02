/**
 * Which sprint a board day belongs to — including the days just after a
 * sprint ended (weekend overtime), which used to have no sprint at all.
 *
 * Run: npx tsx tests/sprint-day.mts
 */
import { sprintForDay } from '@/lib/sprint-name'

let n = 0
let bad = 0
const eq = (got: unknown, want: unknown, m: string) => {
  n++
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++
    console.log('FAIL', m, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want))
  }
}

const s72 = { id: 72, start: '2026-10-19', end: '2026-10-30' }
const s73 = { id: 73, start: '2026-11-02', end: '2026-11-13' }
const future = { id: 74, start: null, end: null }
const all = [future, s73, s72]
const pick = (day: string, list = all) => {
  const r = sprintForDay(list, day)
  return r && [r.sprint.id, r.overrun]
}

eq(pick('2026-10-30'), [72, false], 'last day is inside')
eq(pick('2026-10-31'), [72, true], 'saturday after the end counts for the sprint')
eq(pick('2026-11-01'), [72, true], 'sunday too')
eq(pick('2026-11-02'), [73, false], 'the next sprint takes over on its first day')
eq(pick('2026-11-06', [future, s72]), [72, true], 'a week later, next sprint not opened yet')
eq(pick('2026-11-07', [future, s72]), null, 'past the grace week: outside every sprint')
eq(pick('2026-10-10'), null, 'before any sprint')
eq(pick('2026-10-25', [{ id: 71, start: '2026-10-05', end: '2026-10-30' }, s72]), [72, false], 'overlap: the later start wins')

console.log(bad ? `${bad}/${n} failed` : `sprint day: ${n} ok`)
process.exit(bad ? 1 : 0)
