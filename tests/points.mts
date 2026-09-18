/**
 * The sprint point rollup.
 *
 * Run: npx tsx tests/points.mts
 *
 * Every assertion here pins a decision that is easy to get quietly wrong in a
 * number nobody can check by eye: what counts as landed, what an unestimated
 * task does to the hours-per-point figure, and whether a total drops when the
 * board's status filter changes.
 */
import { summarisePoints, type PointRow } from '@/lib/jira/types'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}

const h = (n: number) => n * 3600
const row = (
  key: string,
  statusName: string,
  storyPoints: number | null,
  hours = 0,
): PointRow => ({ key, statusName, storyPoints, timeSpentSeconds: h(hours) })

/* ── totals ─────────────────────────────────────────────────────────────── */
const sprint = [
  row('A-1', 'Done', 3, 8),
  row('A-2', 'Done', 2, 5),
  row('A-3', 'VERIFIED ON STAGING', 3, 6),
  row('A-4', 'READY TO TEST ON DEVELOP', 2, 4),
  row('A-5', 'In Progress', 1, 3),
  row('A-6', 'To Do', 2, 0),
  row('A-7', 'In Progress', null, 7),
]

const s = summarisePoints(sprint)
eq(s.points, 13, 'points are summed over every row that has one')
eq(s.tasks, 7, 'task count includes the unestimated one')
eq(s.seconds, h(33), 'hours are summed over every row, estimated or not')

/* ── what counts as landed ──────────────────────────────────────────────── */
eq(s.donePoints, 5, 'only Jira DONE counts as landed')
// Verified is its own band. A ticket verified on staging can still come back
// here, and a completion figure that walks backwards is one nobody rereads.
eq(s.buckets.find((b) => b.tone === 'ver')?.points, 3, 'verified is tracked apart from done')
eq(s.buckets.find((b) => b.tone === 'test')?.points, 2, 'ready-to-test is its own band')

/* ── ordering: earliest work first, empty bands dropped ─────────────────── */
eq(s.buckets.map((b) => b.tone), ['todo', 'prog', 'test', 'ver', 'done'],
   'bands run in workflow order')
eq(summarisePoints([row('A-1', 'Done', 3)]).buckets.map((b) => b.tone), ['done'],
   'a band nobody is in is not drawn')

/* ── the unestimated tasks ──────────────────────────────────────────────── */
eq(s.unpointed, 1, 'a task with no estimate is counted, not ignored')
eq(s.unpointedSeconds, h(7), 'and so are its hours, separately')
// The whole reason `unpointedSeconds` exists: 33h over 13 points reads as
// 2.5h/point, when the estimated work actually took 26h — 2.0h/point. Charging
// an unestimated task's hours to the tasks that did carry an estimate is how a
// velocity figure quietly inflates.
eq((s.seconds - s.unpointedSeconds) / 3600 / s.points, 2,
   'hours per point is measured over the estimated work alone')
eq(summarisePoints([row('A-1', 'In Progress', null, 4)]).points, 0,
   'no estimates means no points, not a crash')

/* ── a task worth zero is not a task with no estimate ───────────────────── */
const zero = summarisePoints([row('A-1', 'Done', 0, 2)])
eq(zero.unpointed, 0, 'an explicit 0 is an estimate, not a missing one')
eq(zero.unpointedSeconds, 0, 'so its hours belong to the estimated pool')

/* ── empty ──────────────────────────────────────────────────────────────── */
const none = summarisePoints([])
eq([none.points, none.tasks, none.seconds, none.unpointed, none.donePoints], [0, 0, 0, 0, 0],
   'an empty sprint is all zeroes')
eq(none.buckets, [], 'and draws no bands')

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} ok`)
if (bad) process.exit(1)
