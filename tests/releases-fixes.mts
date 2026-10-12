/**
 * Fix codes, "each code goes public once", and Lite ↔ MatrixRustSDK links.
 *
 * Run: npx tsx tests/releases-fixes.mts
 */
import {
  type TaskLike,
  fixProgress,
  linkedTasks,
  publishCandidates,
  publishedCodes,
  renderWhatToTest,
  republished,
  suggestedLinks,
} from '@/lib/modules/releases/model'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log('FAIL', m, '\n  got: ', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}

const ENVS = ['CTalk Dev', 'Integration', 'Staging', 'Released']
const t = (o: Partial<TaskLike> & { id: number }): TaskLike => ({
  taskId: '', description: '', product: 'Lite', team: 'CTalk', environment: 'Staging', buildStatus: 'đã build',
  refId: null, fixes: [], publishedBuild: '', ...o,
})

const tasks: TaskLike[] = [
  // Feature already public; two fixes later — one built, one still in PR, one public.
  t({ id: 1, taskId: 'VT-2511', buildStatus: 'đã public', publishedBuild: 'Lite 2.3.0 (512)',
      fixes: [{ code: 'VT-2601', status: 'đã public', build: 'Lite 2.3.0 (515)' }, { code: 'VT-2633', status: 'đã build' }, { code: 'VT-2640', status: 'đang PR' }] }),
  // Fresh feature, built.
  t({ id: 2, taskId: 'VT-2700', team: 'Hir' }),
  // Below the app's environment — not in a Staging build yet.
  t({ id: 3, taskId: 'VT-2800', environment: 'CTalk Dev' }),
  // Same code on the SDK board, not linked yet; and a linked pair.
  t({ id: 4, taskId: 'vt-2511 ', product: 'MatrixRustSDK', buildStatus: 'đã public' }),
  t({ id: 5, taskId: 'VT-2900', product: 'MatrixRustSDK', buildStatus: 'đã merge' }),
  t({ id: 6, taskId: 'VT-2900', refId: 5 }),
]

const cands = publishCandidates(tasks, 'Lite', 'Staging', ENVS)
eq(cands.map((c) => `${c.code}/${c.kind}`), ['VT-2633/fix', 'VT-2700/feature', 'VT-2900/feature'], 'only built, unpublished codes at Staging+ are offered')
eq(renderWhatToTest(cands), '- CTalk: VT-2633 (fix VT-2511), VT-2900\n- Hir: VT-2700', 'What to Test groups by team, fixes name their feature')

const pub = publishedCodes(tasks, 'Lite')
eq([...pub.entries()], [['VT-2511', 'Lite 2.3.0 (512)'], ['VT-2601', 'Lite 2.3.0 (515)']], 'published codes remember their build')
eq(republished('- CTalk: VT-2601, VT-2633', pub), [{ code: 'VT-2601', build: 'Lite 2.3.0 (515)' }], 'warns about a code already public')
eq(republished('- CTalk: VT-26011', pub), [], 'no false match on a longer code')

eq(linkedTasks(tasks[4], tasks).map((x) => x.id), [6], 'link is visible from the referenced side too')
eq(linkedTasks(tasks[5], tasks).map((x) => x.id), [5], 'and from the referencing side')
eq(suggestedLinks(tasks[0], tasks).map((x) => x.id), [4], 'same code in another product is suggested (case/space-insensitive)')
eq(suggestedLinks(tasks[5], tasks).map((x) => x.id), [], 'already-linked pair is not suggested again')
eq(fixProgress(tasks[0].fixes), '1/3 fix đã public', 'fix progress')

console.log(bad ? `${bad}/${n} failed` : `releases fixes: ${n} ok`)
process.exit(bad ? 1 : 0)
