/**
 * Rules of the branches board that can be checked without a network.
 *
 * Run: npx tsx tests/branches.mts
 *
 * Kept in the repo rather than a scratch directory because every one of these
 * pins a decision that was got wrong at least once — which column an open pull
 * request belongs to, whether a build number is UTC, what happens to a card
 * whose key its branch does not name. Losing them means re-learning by hand.
 */
import { logDatePastDue, statusRank, statusTone } from '@/lib/jira/types'
import {
  DEFAULT_STAGES,
  envSteps,
  hostOf,
  jiraLinkFor,
  jiraLookups,
  jiraRefFromUrl,
  noteProgress,
  baseFreshness,
  branchesToDelete,
  cardLadder,
  cleanupStep,
  type StageConfig,
  branchSegments,
  envBranchNames,
  inboundPrs,
  ownersByBranch,
  kindMatches,
  stageRule,
  orderSides,
  parseIssueKeys,
  parseJiraUrls,
  parseNotes,
  serializeJiraUrls,
  serializeNotes,
  builtButNotTested,
  sortByStatus,
  stageDrift,
  suggestBranch,
  withLocalState,
} from '@/lib/modules/branches/model'
import {
  buildCarries,
  joinBuilds,
  newBuilds,
  parseBuildNumber,
  parseSeenBuilds,
  mergeCardBuild,
  newestCardBuild,
  parseCardBuilds,
  serializeCardBuilds,
  resolveStamp,
  serializeSeenBuilds,
} from '@/lib/modules/branches/build-model'
import {
  extractIssueKey,
  extractIssueKeys,
  isRevertBranch,
  mineBy,
  parseEnvState,
  parseGitHubLink,
  asPullRequest,
  cardStage,
  reachedTrunk,
  mergeCardPrs,
  parseCardSides,
  primarySide,
  serializeCardSides,
  parsePrRef,
  parseCardPrs,
  pickPr,
  prsForCard,
  serializeCardPrs,
  prStateTag,
  shortRepo,
  stageFor,
} from '@/lib/modules/branches/github-model'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}
const ts = (s: string) => Math.floor(new Date(s).getTime() / 1000)

/* ── pipeline shape ─────────────────────────────────────────────────────── */
const S = DEFAULT_STAGES
eq(S.length, 14, 'bốn cột đầu, chín cột môi trường, và cột cuối')
eq(S[S.length - 1].name, 'done', 'the terminal column is last')
eq(cleanupStep(S)?.name, 'done', 'the terminal column is found by reach, not by name')
eq(cleanupStep(S.slice(0, -1)), null, 'a pipeline without one has no terminal column')
eq(envSteps(S).map((s) => s.branch), ['ctalk/develop', 'develop', 'staging'], 'three environments')
eq(envSteps(S).map((s) => s.name), ['develop', 'integration', 'staging'],
   'ladder uses the environment name, not the "đã merge" column name')
eq(S.find((s) => s.name === 'đã merge develop')?.expects, 'prog',
   'merging into the team env does not demand a test status')
eq(S.filter((s) => s.reach === 'built').map((s) => s.branch),
   ['ctalk/develop', 'develop', 'staging'], 'one build column per environment')
eq(S.filter((s) => s.reach === 'built').every((s) => s.expects !== 'prog'), true,
   'a build column expects a testable status — that is what the column is for')

/* ── mỗi cột tự nói ra luật của nó ──────────────────────────────────────── */
const ruleOf = (n: string) => stageRule(S.find((s) => s.name === n)!)
eq(ruleOf('task'), 'nhánh task chưa mở PR — hoặc PR còn draft, hoặc đã đóng', 'cột không nhánh, chưa có PR')
eq(ruleOf('review'), 'PR đang mở', 'cột không nhánh, PR đang mở')
eq(ruleOf('develop'), 'có PR đang mở nhắm vào ctalk/develop', 'chờ merge = PR mở nhắm đúng nhánh này')
eq(ruleOf('đã merge develop'), 'code đã nằm trong ctalk/develop', 'đã merge hỏi repo, không hỏi PR')
eq(ruleOf('đã build develop'), 'đã có bản build của ctalk/develop mang code này', 'đã build hỏi bản build')
eq(ruleOf('done'), 'code của mọi nhánh đã có trong master', 'cột cuối')
// Điều kiện PR chồng thêm thì câu phải nói ra cả hai vế.
eq(stageRule({ name: 'x', expects: '', branch: 'staging', phase: 'open', reach: 'merged', kind: '' }),
   'code đã nằm trong staging, và PR đang mở', 'hai điều kiện thì nói cả hai')

/* ── cột điểm bắt đầu, tách theo loại nhánh ─────────────────────────────── */
//
// Đếm trên 220 nhánh thật của hai repo: 123 `feature`, 44 `bugfix`, 31 `task`,
// rồi `release`/`hotfix`/`chore` và 6 nhánh không có `/` nào.
eq(ruleOf('feature'), 'nhánh feature chưa mở PR — hoặc PR còn draft, hoặc đã đóng',
   'cột kén loại nói ra loại nó kén')
// Thứ tự cột là thứ tự tiến triển, nên nó là một khẳng định chứ không phải
// trang trí: `feature` đứng sau `review` là lựa chọn của người dùng.
eq(S.slice(0, 4).map((x) => x.name), ['task', 'bugfix', 'review', 'feature'],
   'bốn cột đầu, đúng thứ tự người dùng đặt')
eq(S.filter((x) => x.kind).map((x) => x.kind), ['task', 'bugfix', 'feature'],
   'ba cột kén loại')

eq(kindMatches('ctalk/feature/VT-2583_FR-4', 'feature'), true, 'đoạn giữa khớp')
eq(kindMatches('feature/VT-1', 'feature'), true, 'không có tiền tố team vẫn khớp')
eq(kindMatches('ctalk/FEATURE/VT-1', 'feature'), true, 'không phân biệt hoa thường')
// Khớp theo đoạn, không phải chuỗi con — đây là chỗ `includes` sẽ sai.
eq(kindMatches('ctalk/bugfix/resolve_feature_flag', 'feature'), false,
   '`feature` nằm trong tên file thì không phải nhánh feature')
eq(kindMatches('ctalk/bugfix/VT-451', 'feature'), false, 'bugfix không phải feature')
eq(kindMatches('ctalk/task/abc', ''), true, 'cột không kén nhận tất cả')
eq(branchSegments('ctalk/feature/VT-1'), ['ctalk', 'feature', 'vt-1'], 'tách đúng các đoạn')

/* ── which column a branch belongs in ───────────────────────────────────── */
const open = (base: string, num = 1) => ({ number: num, url: '', state: 'OPEN', isDraft: false, baseRefName: base })
const merged = { number: 2, url: '', state: 'MERGED', isDraft: false, baseRefName: 'ctalk/develop' }
const none = {} as Record<string, { ahead: number | null; landed?: boolean }>

eq(stageFor(none, null, S, []), 'task', 'no PR -> cột đầu')

// Chưa mở PR là lúc duy nhất cái tên quyết định chỗ đứng.
eq(stageFor(none, null, S, [], [], 'ctalk/feature/VT-2583'), 'feature', 'nhánh feature -> cột feature')
eq(stageFor(none, null, S, [], [], 'ctalk/bugfix/VT-451'), 'bugfix', 'nhánh bugfix -> cột bugfix')
eq(stageFor(none, null, S, [], [], 'ctalk/task/abc'), 'task', 'nhánh task -> cột task')
// Không còn cột không kén nào: `release`, `hotfix`, `chore` và nhánh không có
// `/` rơi về cột đầu tiên — `task`. 17/220 nhánh thật rơi vào diện này.
eq(stageFor(none, null, S, [], [], 'ctalk/release/2026.09'), 'task',
   'loại không có cột riêng rơi về cột đầu')
eq(stageFor(none, null, S, [], [], 'linh-tinh'), 'task', 'nhánh không theo quy ước cũng vậy')
eq(stageFor(none, null, S, []), 'task', 'không biết tên nhánh thì về cột đầu')
// Mở PR rồi thì PR quyết định, không phải cái tên — nếu không thì nhánh feature
// sẽ kẹt ở cột feature suốt đời.
eq(stageFor(none, open(''), S, [open('')], [], 'ctalk/feature/VT-2583'), 'review',
   'mở PR rồi thì cái tên hết quyền')
eq(stageFor(none, open('ctalk/develop'), S, [open('ctalk/develop')], [], 'ctalk/feature/VT-1'), 'develop',
   'PR nhắm môi trường thì vào môi trường')
// Bảng chưa khai loại nào phải chạy y như trước.
{
  const plain = S.map((x) => ({ ...x, kind: '' }))
  eq(stageFor(none, null, plain, [], [], 'ctalk/feature/VT-1'), 'task',
     'bỏ hết cột kén thì mọi nhánh về cột đầu, đúng hành vi cũ')
}

// Đã merge mà chưa thấy ở môi trường nào -> cột PR đang mở, không phải cột
// pre cuối cùng. Với thứ tự này cột pre cuối là `feature`, và một PR đã merge
// rơi vào cột của nhánh chưa mở PR thì đọc không ra gì.
eq(stageFor(none, merged, S, [merged]), 'đã merge develop',
   'merged vào môi trường thì vào môi trường')
{
  const nowhere = { number: 9, url: '', state: 'MERGED', isDraft: false, baseRefName: 'ctalk/feature/x' }
  eq(stageFor(none, nowhere, S, [nowhere]), 'review',
     'merged vào một nhánh không phải môi trường -> review, không phải feature')
}

eq(stageFor(none, open(''), S, [open('')]), 'review', 'PR with no base -> review')
// A bugfix is reviewed and merged straight into ctalk/develop, so a request
// aimed at an environment belongs to that environment, reviewed or not.
eq(stageFor(none, open('ctalk/develop'), S, [open('ctalk/develop')]), 'develop',
   'PR mở thẳng vào ctalk/develop -> develop')
// A task branch goes into a feature branch first; that is what review is for.
eq(stageFor(none, open('ctalk/feature/big'), S, [open('ctalk/feature/big')]), 'review',
   'PR mở vào nhánh feature -> review')
eq(stageFor({ 'ctalk/develop': { ahead: 0 } }, merged, S, [merged]), 'đã merge develop', 'contained -> đã merge develop')
eq(stageFor({ 'ctalk/develop': { ahead: 3, landed: true } }, merged, S, [merged]), 'đã merge develop',
   'landed by patch, not by SHA -> still đã merge develop')
eq(stageFor({ 'ctalk/develop': { ahead: 0 } }, open('develop'), S, [open('develop')]), 'integration',
   'queued for a later environment beats being merged into an earlier one')
eq(stageFor({ 'ctalk/develop': { ahead: 0 }, develop: { ahead: 0 }, staging: { ahead: 0 } }, merged, S, [merged]),
   'đã merge staging', 'in every environment -> the last one')
const draft = { number: 3, url: '', state: 'OPEN', isDraft: true, baseRefName: 'ctalk/develop' }
eq(stageFor(none, draft, S, [draft]), 'task', 'a draft is not queued')
const closed = { number: 4, url: '', state: 'CLOSED', isDraft: false, baseRefName: 'develop' }
eq(stageFor(none, closed, S, [closed]), 'task', 'a closed PR is not queued')
// A request merged into an environment is evidence the work is there, even
// when containment says otherwise — the branch grew two more commits after the
// merge, or the work went in through a resolve branch with rewritten SHAs.
const mergedInt = { number: 1470, url: '', state: 'MERGED', isDraft: false, baseRefName: 'develop' }
eq(stageFor({ develop: { ahead: 2 } }, mergedInt, S, [merged, mergedInt]), 'đã merge integration',
   'a merged request into develop reaches integration, ahead-count notwithstanding')
eq(stageFor(none, merged, S, [merged]), 'đã merge develop',
   'and into ctalk/develop reaches develop with nothing measured at all')
// An abandoned branch is zero commits ahead of everything for ever. That is
// not the work arriving — it is there being no work.
const inAll = { 'ctalk/develop': { ahead: 0 }, develop: { ahead: 0 }, staging: { ahead: 0 } }
eq(stageFor(inAll, closed, S, [closed]), 'task',
   'a closed request contained everywhere is an empty branch, not a shipped one')
eq(stageFor(inAll, merged, S, [merged]), 'đã merge staging',
   'the same containment does count once something of the branch merged')
eq(stageFor(inAll, open('ctalk/develop'), S, [open('ctalk/develop')]), 'develop',
   'a fresh branch with nothing merged yet is queued, not already in staging')

/* ── the build columns ──────────────────────────────────────────────────── */
const inDev = { 'ctalk/develop': { ahead: 0 } }
const inInt = { 'ctalk/develop': { ahead: 0 }, develop: { ahead: 0 } }
eq(stageFor(inDev, merged, S, [merged], ['ctalk/develop']), 'đã build develop',
   'a build naming this ticket moves it past the merge')
eq(stageFor(inDev, merged, S, [merged], []), 'đã merge develop',
   'no build -> the card stops at the merge, it is not pushed forward on a guess')
// The board only trusts a build for the exact branch it names. The code really
// is in both environments here, but only ctalk/develop has shipped a build.
eq(stageFor(inInt, merged, S, [merged], ['ctalk/develop']), 'đã merge integration',
   'a build of the team env says nothing about integration')
eq(stageFor(inInt, merged, S, [merged], ['develop']), 'đã build integration',
   'a build of integration puts it in integration\'s build column')

/* ── mỗi ô đã điền là một điều kiện ─────────────────────────────────────── */
// Ô "điều kiện PR" từng bị khoá trên mọi cột có nhánh, nên engine chưa bao giờ
// đọc tới. Mở ô thì nó phải có tác dụng thật, không phải ô câm.
const withPhase = (name: string, phase: '' | 'nopr' | 'open') =>
  S.map((s) => (s.name === name ? { ...s, phase } : s))

// `đã merge develop` cộng thêm điều kiện "PR đang mở" -> PR đã merge không khớp
// nên cột không nhận, và card rơi về đường PR như mọi card merged mà chưa thấy ở
// đâu: cột pre cuối cùng.
eq(stageFor({ 'ctalk/develop': { ahead: 0 } }, merged, withPhase('đã merge develop', 'open'), [merged]),
   'review', 'điều kiện PR không đạt thì cột có nhánh cũng không nhận')
// Cùng dữ liệu, điều kiện để trống -> vẫn như cũ.
eq(stageFor({ 'ctalk/develop': { ahead: 0 } }, merged, withPhase('đã merge develop', ''), [merged]),
   'đã merge develop', 'để trống thì không xét, giữ nguyên hành vi cũ')
// Và điều kiện khớp thì vào bình thường.
eq(stageFor({ 'ctalk/develop': { ahead: 0 } }, open('ctalk/develop'), withPhase('develop', 'open'), [open('ctalk/develop')]),
   'develop', 'điều kiện PR khớp thì cột có nhánh vẫn nhận')

// `đã xoá nhánh` trên cột có nhánh: trước đây rơi xuống nhánh else và hành xử
// như "chờ merge". Giờ nó là cột cuối, và không còn nhận card qua containment.
const goneOnEnv = S.map((s) => (s.name === 'staging' ? { ...s, reach: 'gone' as const } : s))
eq(cleanupStep(goneOnEnv)?.name, 'staging', '`gone` là cột cuối dù cột có điền nhánh')
eq(stageFor({ staging: { ahead: 0 } }, open('staging'), goneOnEnv, [open('staging')]) === 'staging', false,
   '`gone` không còn âm thầm hành xử như "chờ merge"')

/* ── picking which pull request to show ─────────────────────────────────── */
const prs = [
  { number: 341, url: '', state: 'CLOSED', isDraft: false },
  { number: 348, url: '', state: 'MERGED', isDraft: false },
  { number: 353, url: '', state: 'OPEN', isDraft: false },
]
eq(pickPr(prs)?.number, 353, 'open outranks merged and closed')
eq(pickPr(prs, 348)?.number, 348, 'a pinned number wins outright')
eq(pickPr([])?.number, undefined, 'no requests -> none')

/* ── một PR cho mỗi nhánh đích ──────────────────────────────────────────── */
const many = [
  { number: 340, url: 'u340', state: 'CLOSED', isDraft: false, baseRefName: 'ctalk/develop' },
  { number: 353, url: 'u353', state: 'MERGED', isDraft: false, baseRefName: 'ctalk/develop' },
  { number: 1400, url: 'u1400', state: 'MERGED', isDraft: false, baseRefName: 'develop' },
  { number: 1500, url: 'u1500', state: 'OPEN', isDraft: false, baseRefName: 'staging' },
  { number: 300, url: 'u300', state: 'MERGED', isDraft: false, baseRefName: 'ctalk/feature/big' },
]
eq(prsForCard(many).map((p) => [p.number, p.base]),
   [[300, 'ctalk/feature/big'], [353, 'ctalk/develop'], [1400, 'develop'], [1500, 'staging']],
   'one per base, best of each — #340 loses to #353 on the same branch')
eq(prsForCard(many).map((p) => p.state), ['MERGED', 'MERGED', 'MERGED', 'OPEN'], 'state travels with it')
// Stable output: the scan compares this against what the card stores, so the
// same set arriving in another order must serialize identically.
eq(serializeCardPrs(prsForCard([...many].reverse())), serializeCardPrs(prsForCard(many)),
   'the order GitHub replies in does not change what is stored')
eq(prsForCard([]), [], 'no requests -> nothing to show')

/* ── ghim pull request theo từng môi trường ─────────────────────────────── */
eq(parsePrRef('1322'), 1322, 'bare number')
eq(parsePrRef('#1322'), 1322, 'with a hash')
eq(parsePrRef('https://github.com/atthetalk/viptalk-ios-x/pull/1322'), 1322, 'a pasted URL')
eq(parsePrRef('  https://github.com/o/r/pull/7/files  '), 7, 'a URL deeper than the PR page')
eq(parsePrRef(''), 0, 'empty -> no pin')
eq(parsePrRef('không phải số'), 0, 'nonsense -> no pin, not NaN')
eq(parsePrRef('0'), 0, 'zero is not a pull request')

const scanned = prsForCard(many)
const pin = { number: 1322, url: '', state: 'MERGED', base: 'ctalk/develop', pinned: true as const }
eq(mergeCardPrs(scanned, []), scanned, 'nothing pinned -> the scan stands untouched')
eq(mergeCardPrs(scanned, [pin]).map((p) => [p.base, p.number]),
   [['ctalk/feature/big', 300], ['ctalk/develop', 1322], ['develop', 1400], ['staging', 1500]],
   'the pin replaces the scan at its own environment and nowhere else')
// The whole reason pins exist: the request that carried the work belongs to a
// resolve branch, so GitHub never lists it among this branch's requests.
eq(mergeCardPrs(scanned, [pin]).find((p) => p.base === 'ctalk/develop')?.pinned, true,
   'and stays pinned, so the next scan keeps it too')
eq(mergeCardPrs(scanned, [pin], new Map()).find((p) => p.base === 'ctalk/develop')?.state, 'MERGED',
   'GitHub saying nothing about the number leaves the stored state alone')
// Only the number is the user's; the state is still GitHub's to say.
const live = new Map([[1322, { number: 1322, url: 'u1322', state: 'OPEN', isDraft: false, baseRefName: 'x' }]])
eq(mergeCardPrs(scanned, [pin], live).find((p) => p.base === 'ctalk/develop'),
   { number: 1322, url: 'u1322', state: 'OPEN', base: 'ctalk/develop', pinned: true },
   'a fresh answer updates the state and url, never the number or the environment')

// A card written before the column existed still shows its one request.
eq(parseCardPrs('', { prNumber: 353, prUrl: 'u', prState: 'MERGED', prBase: 'ctalk/develop' }),
   [{ number: 353, url: 'u', state: 'MERGED', base: 'ctalk/develop' }],
   'no stored list -> fall back to the card\'s single PR')
eq(parseCardPrs('', { prNumber: null, prUrl: '', prState: '', prBase: '' }), [], 'no PR at all -> empty')
eq(parseCardPrs('rác', { prNumber: 353, prUrl: 'u', prState: 'MERGED', prBase: 'x' }).length, 1,
   'unreadable JSON falls back rather than throwing')
eq(asPullRequest({ number: 9, url: 'u', state: 'DRAFT', base: 'develop' }),
   { number: 9, url: 'u', state: 'OPEN', isDraft: true, baseRefName: 'develop' },
   'DRAFT unfolds back into GitHub\'s two fields')
eq(prStateTag(null), '', 'no PR -> no tag')

/* ── reading Jira keys out of a branch name ─────────────────────────────── */
const P = ['VT', 'VTL']
eq(extractIssueKey('ctalk/bugfix/VTL-560-pin', P), 'VTL-560', 'key from a branch name')
eq(extractIssueKeys('ctalk/bugfix/VTL-286_VTL-610', P), ['VTL-286', 'VTL-610'], 'two keys, in the order written')
eq(extractIssueKeys('resolve_VTL-286_VTL-286_develop', P), ['VTL-286'], 'a repeated key means it once')
eq(extractIssueKey('feature/release-2026-08-31', P), '', 'a date is not a key')
eq(isRevertBranch('revert-1234-fix'), true, 'revert branch')
eq(isRevertBranch('unreverted'), false, 'revert inside a word is not a revert')

/* ── build numbers, which are not always UTC ────────────────────────────── */
eq(parseBuildNumber('20260903100223'), ts('2026-09-03T10:02:23Z'), 'read as a naive wall clock')
eq(parseBuildNumber('1.0.2'), 0, 'a marketing version is not a stamp')
eq(resolveStamp('20260903100223', ts('2026-09-03T10:21:02Z')), ts('2026-09-03T10:02:23Z'), 'CI runner stamps UTC')
eq(resolveStamp('20260904113038', ts('2026-09-04T04:55:22Z')), ts('2026-09-04T04:30:38Z'), 'a local machine stamps +07')
eq(resolveStamp('20260904113038', ts('2026-09-06T00:00:00Z')), 0, 'no offset fits -> unresolved')

const runs = [
  { sha: 'f2606553', startedAt: ts('2026-09-03T10:01:02Z') },
  { sha: 'de4099b9', startedAt: ts('2026-09-03T07:49:32Z') },
]
const builds = [
  { version: '20260904113038', uploadedAt: ts('2026-09-04T04:55:22Z') }, // archived locally
  { version: '20260903100223', uploadedAt: ts('2026-09-03T10:21:02Z') },
  { version: '20260903075111', uploadedAt: ts('2026-09-03T08:06:14Z') },
]
const j = joinBuilds('ctalk/develop', runs, builds)
eq(j.length, 3, 'nothing is dropped — a build with no run is still installable')
eq([j[0].build, j[0].sha, j[0].at], ['20260904113038', '', ts('2026-09-04T04:30:38Z')],
   'the local build has no commit but a resolved time')
eq([j[1].sha, j[1].at], ['f2606553', ts('2026-09-03T10:01:02Z')], 'a CI build takes its run')
eq(joinBuilds('x', [], [{ version: '1.0.2', uploadedAt: ts('2026-09-04T04:55:22Z') }])[0].at,
   ts('2026-09-04T03:55:22Z'), 'unreadable stamp falls back an hour before upload')

/* ── which build carries which card ─────────────────────────────────────── */
const B = (notes: string, build = '20260904113038', at = 1) =>
  ({ branch: 'ctalk/develop', build, sha: '', at, notes, externalState: '' })
eq(buildCarries(B('- CTalk: VT-17252, VT-523, VT-525'), P),
   ['VT-17252', 'VT-523', 'VT-525'], 'one line, several keys')
eq(buildCarries(B('- Hir: VT-122\n- CTalk: VT-501, VT-504'), P),
   ['VT-122', 'VT-501', 'VT-504'], 'several lines, several teams')
eq(buildCarries(B('- Sync code master (hotfix)'), P), [], 'prose with no keys')
eq(buildCarries(B(''), P), [], 'no note at all')
eq(buildCarries(B('- CXP: CXPT-316'), P), [], 'a project key nobody configured is not invented')

/* ── một bản build cho mỗi môi trường ───────────────────────────────────── */
const dev = (n: string, at: number) => ({ branch: 'ctalk/develop', build: n, at })
const int = (n: string, at: number) => ({ branch: 'develop', build: n, at })

eq(mergeCardBuild([], dev('20260904113038', 500)),
   [{ branch: 'ctalk/develop', build: '20260904113038', at: 500 }], 'an empty card takes it')
eq(mergeCardBuild([dev('20260904113038', 500)], dev('20260904113038', 500)), null, 'same build -> no write')
eq(mergeCardBuild([dev('20260907030007', 900)], dev('20260904113038', 500)), null,
   'an older build never overwrites a newer one of the same environment')
eq(mergeCardBuild([dev('20260904113038', 500)], dev('20260907030007', 900)),
   [{ branch: 'ctalk/develop', build: '20260907030007', at: 900 }], 'a newer build replaces it')
// The whole point of the list: shipping to integration must not erase the
// develop build the work also went out in.
eq(mergeCardBuild([dev('20260904113038', 500)], int('20260903100223', 400))?.map((b) => b.branch),
   ['ctalk/develop', 'develop'], 'another environment is added, not swapped in')
eq(mergeCardBuild([dev('20260904113038', 500)], int('20260903100223', 400))?.map((b) => b.build),
   ['20260904113038', '20260903100223'], 'an older integration build still lands — different environment')
// A hand-typed entry has no measured date; anything the scan finds supersedes it.
eq(mergeCardBuild([{ branch: 'ctalk/develop', build: '20260901080729', at: 0 }], dev('20260904113038', 500))
     ?.map((b) => b.build), ['20260904113038'], 'a measured build supersedes a hand-typed one')

eq(serializeCardBuilds([int('b', 2), dev('a', 1)]), serializeCardBuilds([dev('a', 1), int('b', 2)]),
   'the order builds are found in does not change what is stored')
/* ── thang môi trường trên card ─────────────────────────────────────────── */
const L = cardLadder(prsForCard(many), [int('b', 2), dev('a', 1)], S)
eq(L.map((r) => r.name), ['ctalk/feature/big', 'develop', 'integration', 'staging'],
   'every environment, in pipeline order, the feature branch first')
eq(L.map((r) => r.pr?.number ?? 0), [300, 353, 1400, 1500], 'each row carries its own request')
eq(L.map((r) => r.build?.build ?? ''), ['', 'a', 'b', ''], 'and its own build, blank where there is none')
// A feature branch never gets a build, so its row must not be shown missing one.
eq(L.map((r) => r.isEnv), [false, true, true, true], 'the feature branch row is not an environment')
eq(cardLadder([], [], S).map((r) => [r.name, r.pr, r.build]),
   [['develop', null, null], ['integration', null, null], ['staging', null, null]],
   'an empty card still shows the whole ladder')
/* ── card nhiều repo ────────────────────────────────────────────────────── */
const flat = { prNumber: 353, prUrl: 'u', prState: 'MERGED', prBase: 'ctalk/develop',
  prs: '', envState: '{"ctalk/develop":{"ahead":0}}', landedVia: '', branchGone: false,
  localAhead: 0, localOnly: false, localPath: '', branchUpdatedAt: 7 }
// Every card written before this column existed has to keep working, unscanned.
eq(parseCardSides('', { ...flat, repo: 'o/ios', branch: 'b' }).map((x: { repo: string; branch: string; prs: unknown[] }) => [x.repo, x.branch, x.prs.length]),
   [['o/ios', 'b', 1]], 'no stored sides -> the flat columns are one side')
eq(parseCardSides('', { ...flat, repo: '', branch: '' }), [], 'a card with no branch has no sides')
eq(parseCardSides('rác', { ...flat, repo: 'o/ios', branch: 'b' }).length, 1,
   'unreadable JSON falls back rather than throwing')
const two = [
  { repo: 'o/ios', branch: 'b', prs: [{ number: 1, url: '', state: 'MERGED', base: 'ctalk/develop' }],
    envState: '', landedVia: '', branchGone: false, localAhead: 0, localOnly: false, localPath: '', branchUpdatedAt: null },
  { repo: 'o/sdk', branch: 'b', prs: [{ number: 2, url: '', state: 'MERGED', base: 'develop' }],
    envState: '', landedVia: '', branchGone: false, localAhead: 0, localOnly: false, localPath: '', branchUpdatedAt: null },
]
eq(parseCardSides(serializeCardSides(two), { ...flat, repo: 'o/ios', branch: 'b' }).map((x: { repo: string }) => x.repo),
   ['o/ios', 'o/sdk'], 'both sides survive a round trip, in order')
eq(primarySide(two)?.repo, 'o/ios', 'the first side is the one the flat columns describe')
eq(primarySide([]), null, 'no sides -> no primary')
// Stored order is slowest-first and flips card to card; read order must not.
const cfgRepos = ['o/ios', 'o/sdk']
eq(orderSides(two, cfgRepos).map((x) => x.repo), ['o/ios', 'o/sdk'], 'read in the configured order')
eq(orderSides([two[1], two[0]], cfgRepos).map((x) => x.repo), ['o/ios', 'o/sdk'],
   'and the same order whichever half is further along')
eq(orderSides([{ repo: 'o/gone' }, { repo: 'o/sdk' }], cfgRepos).map((x) => x.repo),
   ['o/sdk', 'o/gone'], 'a repository no longer configured sorts last, never vanishes')
eq(orderSides([], cfgRepos), [], 'no sides -> nothing to order')
// Each side draws its own ladder; builds belong to the card, not to a side.
eq(cardLadder(two[0].prs, [], S).map((r) => r.pr?.number ?? 0), [1, 0, 0],
   "a side's ladder shows only that side's requests")
eq(cardLadder(two[1].prs, [], S).map((r) => r.pr?.number ?? 0), [0, 2, 0],
   'and the other side its own')

eq(cardLadder([], [{ branch: 'nhánh-cũ', build: 'z', at: 1 }], S).map((r) => r.name),
   ['develop', 'integration', 'staging', 'nhánh-cũ'],
   'a build against a branch the pipeline dropped is appended, never vanishes')

eq(newestCardBuild([dev('20260904113038', 500), int('20260903100223', 400)]),
   { build: '20260904113038', buildBranch: 'ctalk/develop', buildAt: 500 },
   'the flat fields hold the newest of the list')
eq(newestCardBuild([]), { build: '', buildBranch: '', buildAt: 0 }, 'no builds -> flat fields empty')

eq(parseCardBuilds('', { build: '20260904113038', buildBranch: 'ctalk/develop', buildAt: 500 }),
   [{ branch: 'ctalk/develop', build: '20260904113038', at: 500 }],
   'no stored list -> fall back to the card\'s single build')
eq(parseCardBuilds('', { build: '', buildBranch: '', buildAt: 0 }), [], 'no build at all -> empty')
eq(parseCardBuilds('rác', { build: 'x', buildBranch: 'y', buildAt: 1 }).length, 1,
   'unreadable JSON falls back rather than throwing')

/* ── build news, per environment ────────────────────────────────────────── */
const cur = new Map([['ctalk/develop', j[0]], ['develop', j[1]]])
eq(newBuilds(cur, {}).map((b) => b.build), ['20260904113038', '20260903100223'], 'nothing seen -> all news, newest first')
eq(newBuilds(cur, { 'ctalk/develop': '20260904113038' }).map((b) => b.build), ['20260903100223'], 'one seen')
eq(newBuilds(cur, { 'ctalk/develop': '20260904113038', develop: '20260903100223' }), [], 'all seen -> quiet')
eq(parseSeenBuilds(serializeSeenBuilds({ a: '1', b: '2' })), { a: '1', b: '2' }, 'seen-builds round trip')
eq(parseSeenBuilds('rubbish'), {}, 'a bad blob means nothing seen')

/* ── drift: which ticket is behind, and is it named ─────────────────────── */
eq(statusTone('READY TO TEST ON DEVELOP'), 'test', 'READY *TO* TEST, not just READY FOR TEST')
eq(statusTone('COMMITED CODE FEATURE BRANCH'), 'prog', 'committed to a feature branch is still in progress')
eq(statusTone('VERIFIED ON DEVELOP'), 'ver', 'verified')
eq(statusTone('READY FOR RELEASE'), 'prog', 'READY without TEST is not a test state')
eq(stageDrift('đã merge develop', 'COMMITED CODE FEATURE BRANCH', 'prog', S, 'VT-365'), null,
   'đã merge develop expects only đang làm')
// Merging is not shipping in *any* environment, so no merge column warns —
// only the build columns, which is where testing actually becomes possible.
eq(stageDrift('đã merge integration', 'COMMITED CODE FEATURE BRANCH', 'prog', S, 'VT-467'), null,
   'merging into integration does not demand a test status either')
eq(stageDrift('đã build integration', 'COMMITED CODE FEATURE BRANCH', 'prog', S, 'VT-467')?.label,
   'VT-467 vẫn: COMMITED CODE FEATURE BRANCH', 'the warning names the ticket that is behind')
eq(stageDrift('đã build integration', 'X', 'prog', S)?.label, 'ticket vẫn: X', 'generic when no key is given')
eq(S.filter((s) => s.expects === 'test').map((s) => s.name),
   ['đã build develop', 'đã build integration'], 'only build columns ask for a test status')
// The environment, not just the colour. A ticket verified on develop is past
// testing *there* and nowhere else — its card has since reached the
// integration build, which is a different thing to be tested on.
eq(stageDrift('đã build integration', 'VERIFIED ON DEVELOP', 'ver', S, 'VT-848')?.label,
   'VT-848 vẫn: VERIFIED ON DEVELOP', 'verified on develop is behind an integration build')
eq(stageDrift('đã build develop', 'VERIFIED ON DEVELOP', 'ver', S, 'VT-848'), null,
   'and is exactly right for the develop build')
eq(stageDrift('đã build integration', 'READY TO TEST ON INTEGRATION', 'test', S), null,
   'ready to test on the right environment clears it')
eq(stageDrift('đã build integration', 'VERIFIED ON INTEGRATION', 'ver', S), null,
   'so does verified on it')
eq(stageDrift('đã build integration', 'DONE', 'done', S), null, 'Done is past everything')
eq(stageDrift('đã build integration', 'VERIFIED ON DEVELOP', 'ver', S)?.detail.includes('chờ test trên integration'),
   true, 'the warning names the environment the ticket has to move to')

/* ── cột tính từ chính card, không cần mạng ─────────────────────────────── */
const sideAt = (repo: string, prs: Array<{number:number;url:string;state:string;base:string}>, env = '') => ({
  repo, branch: 'b', prs, envState: env, landedVia: '', branchGone: false,
  localAhead: 0, localOnly: false, localPath: '', branchUpdatedAt: null,
})
const prAt = (n: number, state: string, base: string) => ({ number: n, url: '', state, base })
// The furthest half decides — the abandoned one must not hold the card back.
eq(cardStage([sideAt('o/ios', [prAt(1, 'CLOSED', 'ctalk/develop')]),
              sideAt('o/sdk', [prAt(2, 'MERGED', 'develop')])], [], S),
   'đã merge integration', 'the furthest side decides, not the abandoned one')
// A build typed in by hand moves the card with no scan and no network.
eq(cardStage([sideAt('o/ios', [prAt(1, 'MERGED', 'ctalk/develop')])],
             [{ branch: 'develop', build: '20260909042020', at: 1 }], S),
   'đã build integration', 'a hand-entered build moves the card on its own')
eq(cardStage([], [], S), '', 'a card with no sides has no column to compute')

/* ── cột cuối: code đã có trong trunk chưa ──────────────────────────────── */
//
// Đổi luật: không đọc trạng thái Jira nữa, cũng không nhận "nhánh đã bị xoá"
// làm bằng chứng. Chỉ một câu hỏi, đo trên đồ thị git — code của mọi nhánh đã
// nằm trong trunk chưa. Trên repo thật, `master` chính là trunk phát hành:
// tip của nó là `Merge pull request … from atthetalk/staging`, và
// `master...staging` trả về `status=behind` — staging nằm trọn trong master.
eq(cleanupStep(S)?.branch, 'master', 'cột cuối khai trunk của nó')
eq(stageRule(cleanupStep(S)!), 'code của mọi nhánh đã có trong master',
   'và nói ra luật của mình bằng chính ô đó')
eq(stageRule({ ...cleanupStep(S)!, branch: '' }),
   'chưa khai nhánh — cột này sẽ không nhận card nào',
   'ô trống thì nói thẳng là sẽ không nhận card')

const inTrunk = '{"ctalk/develop":{"ahead":0},"master":{"ahead":0}}'
const notTrunk = '{"ctalk/develop":{"ahead":0},"master":{"ahead":3}}'
const shipped = (repo: string, env: string) =>
  sideAt(repo, [prAt(1, "MERGED", "staging")], env)

eq(cardStage([shipped("o/ios", inTrunk)], [], S), 'done',
   'đã merge được gì đó + code nằm trong master -> done')
eq(cardStage([shipped("o/ios", notTrunk)], [], S), 'đã merge staging',
   'còn 3 commit master chưa có thì chưa xong')

// Cái bẫy, đo được trên bảng thật: `master...ctalk/feature/VT-2583_FR-4…` trả
// về `identical`. Nhánh vừa cắt ra, chưa có commit nào của chính nó, nên nó
// "không thêm gì master chưa có" — y hệt một nhánh đã phát hành. Thứ phân biệt
// hai cái là nhánh đó đã từng merge được gì chưa.
eq(cardStage([sideAt('o/ios', [], inTrunk)], [], S), 'task',
   'nhánh chưa có commit nào giống hệt master -> KHÔNG phải done')
eq(cardStage([sideAt('o/ios', [prAt(1, 'OPEN', 'ctalk/develop')], inTrunk)], [], S), 'develop',
   'PR còn mở cũng vậy — chưa merge thì chưa đóng góp gì')

// PR merge thẳng vào trunk được tính riêng: nhánh vẫn mọc tiếp sau khi PR của
// nó merge, nên tip của nó ahead trunk vĩnh viễn dù việc đã nằm trong đó.
eq(cardStage([sideAt('o/ios', [prAt(1, 'MERGED', 'master')], notTrunk)], [], S), 'done',
   'PR merge thẳng vào master -> done dù containment nói chưa')

// Cả hai nửa, ANDed — một fix hai repo chưa xong khi mới phát hành một nửa.
eq(cardStage([shipped("o/ios", inTrunk), shipped("o/sdk", notTrunk)], [], S), 'đã merge staging',
   'một repo vào master, repo kia chưa -> chưa xong')
eq(cardStage([shipped("o/ios", inTrunk), shipped("o/sdk", inTrunk)], [], S), 'done',
   'cả hai vào master thì xong')

// Nhánh bị xoá không còn là bằng chứng — hệ quả đã biết và đã chọn.
eq(cardStage([{ ...shipped("o/ios", notTrunk), branchGone: true }], [], S), 'đã merge staging',
   'nhánh đã xoá mà code chưa vào master -> KHÔNG tự về done nữa')
eq(cardStage([{ ...shipped("o/ios", inTrunk), branchGone: true }], [], S), 'done',
   'nhánh đã xoá nhưng lần đo cuối nói code đã vào master -> vẫn done')

eq(reachedTrunk([], 'master'), false, 'card chưa có nửa nào thì chưa phát hành')
eq(reachedTrunk([shipped("o/ios", inTrunk)], ''), false,
   'không khai trunk thì không kết luận gì')

// A squash merge lands on the last pre-merge step, which must not be the
// terminal one just because that also has no branch.
eq(stageFor(none, merged, S, [merged]), 'đã merge develop',
   'a merge the repo cannot confirm still stops short of the terminal column')

// The other half of the rule: dragged in by hand, the card asks for the branch.
const stillUp = sideAt('o/ios', [prAt(1, 'MERGED', 'staging')])
eq(branchesToDelete('done', [stillUp], S).map((x) => x.repo), ['o/ios'],
   'a card in the last column names every branch still up')
eq(branchesToDelete('done', [{ ...stillUp, branchGone: true }], S), [],
   'and asks for nothing once they are gone')
eq(branchesToDelete('đã build staging', [stillUp], S), [],
   'the demand belongs to the last column alone')
eq(branchesToDelete('done', [{ ...stillUp, branch: '' }], S), [],
   'a card with no branch has nothing to delete')
eq(branchesToDelete('done', [stillUp], S.slice(0, -1)), [],
   'a pipeline with no terminal column never asks')
// The point of the build column: a build exists, so there is something to
// test, so a ticket still reading as in-progress is the thing to fix.
eq(stageDrift('đã build develop', 'COMMITED CODE FEATURE BRANCH', 'prog', S, 'VT-466')?.label,
   'VT-466 vẫn: COMMITED CODE FEATURE BRANCH', 'a build shipped it but the ticket is still in progress')
eq(stageDrift('đã build develop', 'READY TO TEST ON DEVELOP', 'test', S, 'VT-466'), null,
   'ready to test in the build column is exactly right')


/* ── ordering by the real workflow, not the five colour buckets ─────────── */
// The environments the pipeline is configured with; the status names carry the
// same words, which is what makes the order derivable rather than hard-coded.
const ENVS = ['develop', 'integration', 'staging']
const ranked = [
  'To Do',
  'BLOCKED',
  'In Progress',
  'COMMITED CODE FEATURE BRANCH',
  'READY TO TEST ON DEVELOP',
  'VERIFIED ON DEVELOP',
  'READY TO TEST ON INTEGRATION',
  'VERIFIED ON INTEGRATION',
  'READY TO TEST ON STAGING',
  'VERIFIED ON STAGING',
  'Done',
].map((n) => [n, statusRank(n, ENVS)] as const)
/* ── Jira không gọi được, khác với Jira không có ticket ─────────────────── */
// `statusRank` is what the drift warning compares, so an unknown status must
// land in the in-progress band rather than at either extreme — a board that
// could not reach Jira must not read as "everything is To Do" or "all Done".
eq(statusRank('', ENVS), 1, 'no status at all is in-progress, not To Do')
eq(statusRank('BLOCKED', ENVS), 1, 'a status the rule cannot place lands in the same band')

/* ── log sau due date của task đã Done ──────────────────────────────────── */
eq(logDatePastDue('2026-09-10', '2026-09-11', 'Done'), true,
   'Done với due 10/09 mà log ngày 11/09 -> cảnh báo')
eq(logDatePastDue('2026-09-10', '2026-09-10', 'Done'), false,
   'log đúng ngày due thì không sao')
eq(logDatePastDue('2026-09-10', '2026-09-09', 'Done'), false,
   'log trước due thì càng không sao')
// Vượt due khi còn đang làm là chuyện thường ở đây; cảnh báo sẽ chôn mất ca
// thật sự mâu thuẫn.
eq(logDatePastDue('2026-09-10', '2026-09-11', 'In Progress'), false,
   'task chưa xong thì log trễ chỉ là trễ, không phải mâu thuẫn')
eq(logDatePastDue('2026-09-10', '2026-09-11', 'VERIFIED ON DEVELOP'), false,
   'verified on develop là giữa quy trình, chưa phải xong')
eq(logDatePastDue(null, '2026-09-11', 'Done'), false, 'không có due date thì không có gì để so')
eq(logDatePastDue('2026-09-10', '', 'Done'), false, 'không có ngày log thì không so được')
// So chuỗi YYYY-MM-DD chính là so ngày — kiểm qua mốc sang năm.
eq(logDatePastDue('2026-12-31', '2027-01-01', 'Done'), true, 'qua năm vẫn so đúng')

eq(ranked.map(([, r]) => r), [0, 1, 1, 1, 2, 3, 4, 5, 6, 7, 99],
   'toàn bộ workflow thật xếp đúng thứ tự')
// The point of the whole function: these four are one bucket to `statusTone`.
eq(new Set([
  statusTone('READY TO TEST ON DEVELOP'),
  statusTone('READY TO TEST ON INTEGRATION'),
  statusTone('READY TO TEST ON STAGING'),
]).size, 1, 'statusTone gộp cả ba READY TO TEST làm một')
eq([statusRank('READY TO TEST ON DEVELOP', ENVS),
    statusRank('READY TO TEST ON INTEGRATION', ENVS),
    statusRank('READY TO TEST ON STAGING', ENVS)], [2, 4, 6],
   'statusRank tách chúng theo môi trường')
eq(statusRank('READY TO TEST ON DEVELOP', ENVS) < statusRank('VERIFIED ON DEVELOP', ENVS), true,
   'chờ test đứng trước đã verify, cùng một môi trường')
eq(statusRank('VERIFIED ON DEVELOP', ENVS) < statusRank('READY TO TEST ON INTEGRATION', ENVS), true,
   'xong develop rồi mới tới integration')
// Renaming an environment must not break the order.
// Same status, two different pipelines: the rank follows the pipeline's own
// environment order, which is the whole point of not hard-coding names.
eq(statusRank('VERIFIED ON UAT', ['uat', 'develop']), 3, 'UAT là môi trường đầu -> xếp sớm')
eq(statusRank('VERIFIED ON UAT', ['develop', 'uat']), 5, 'cùng trạng thái, UAT là môi trường sau -> xếp muộn')
// Unknown statuses go in the middle, not at either end.
eq(statusRank('Chờ ai đó duyệt', ENVS), 1, 'trạng thái lạ nằm ở giữa')
eq(statusRank('VERIFIED ON SOMETHING-ELSE', ENVS), 2 + ENVS.length * 2 + 1,
   'môi trường không có trong pipeline vẫn xếp sau các môi trường đã biết')

/* ── board order: pinned status first, then the workflow ────────────────── */
const rank = (s: string | null) => (s ? statusRank(s, ENVS) : -1)
/** `statusName` is the card's laggard; `statuses` is every ticket it carries. */
const card = (key: string, ...names: string[]) => ({
  key,
  statusName: [...names].sort((a, b) => rank(a) - rank(b))[0] ?? null,
  statuses: names.map((n) => ({ name: n })),
})
const keys = (list: Array<{ key: string }>) => list.map((c) => c.key).join(' ')

const board = [
  card('A', 'VERIFIED ON DEVELOP'),
  card('B', 'COMMITED CODE FEATURE BRANCH'),
  card('C', 'READY TO TEST ON STAGING'),
  card('D', 'To Do'),
]
eq(keys(sortByStatus(board, '', rank)), 'D B A C', 'không ưu tiên: xếp theo thứ tự workflow')
eq(keys(sortByStatus(board, 'READY TO TEST ON STAGING', rank)), 'C D B A', 'trạng thái được chọn lên đầu')
eq(keys(sortByStatus(board, 'VERIFIED ON DEVELOP', rank)), 'A D B C', 'chọn cái khác thì cái đó lên đầu')
eq(sortByStatus(board, 'READY TO TEST ON STAGING', rank).length, board.length, 'không ẩn card nào')

// X carries a VERIFIED ticket but its laggard is COMMITED, so the board shows
// it as COMMITED. Both simpler rules were wrong on it, in opposite directions;
// it belongs between the cards that are verified and the ones that are not.
const mixed = [
  card('X', 'COMMITED CODE FEATURE BRANCH', 'VERIFIED ON DEVELOP'),
  card('Y', 'VERIFIED ON DEVELOP'),
  card('W', 'COMMITED CODE FEATURE BRANCH'),
  card('Z', 'To Do'),
]
eq(keys(sortByStatus(mixed, 'VERIFIED ON DEVELOP', rank)), 'Y X Z W',
   'Y thật sự verified lên đầu · X có một ticket verified nên đứng giữa · Z W không có gì verified')
eq(keys(sortByStatus(mixed, 'COMMITED CODE FEATURE BRANCH', rank)), 'X W Z Y',
   'chọn COMMITED thì hai card đang ở COMMITED lên đầu')
eq(keys(sortByStatus(mixed, 'To Do', rank)), 'Z X W Y', 'chọn To Do thì chỉ Z được nâng')
eq(keys(sortByStatus(mixed, 'READY TO TEST ON STAGING', rank)), 'Z X W Y',
   'chọn trạng thái không card nào có -> trở về thứ tự workflow')
eq(keys(sortByStatus(mixed, '', rank)), 'Z X W Y', 'không ưu tiên -> thuần thứ tự workflow')

// Ties keep the order they arrived in, so recency survives underneath.
const tied = [card('P', 'VERIFIED ON DEVELOP'), card('Q', 'VERIFIED ON DEVELOP')]
eq(keys(sortByStatus(tied, '', rank)), 'P Q', 'cùng trạng thái thì giữ nguyên thứ tự đến trước')

/* ── build đã ra mà ticket còn ở trạng thái đang làm ─────────────────────── */
eq(builtButNotTested('20260908090132', statusTone('COMMITED CODE FEATURE BRANCH')), true,
   'có build mà ticket còn COMMITED -> cảnh báo')
eq(builtButNotTested('20260908090132', statusTone('To Do')), true, 'To Do cũng cảnh báo')
eq(builtButNotTested('20260908090132', statusTone('READY TO TEST ON DEVELOP')), false,
   'đã chờ test rồi thì thôi')
eq(builtButNotTested('20260908090132', statusTone('VERIFIED ON DEVELOP')), false, 'đã verify thì thôi')
eq(builtButNotTested('20260908090132', statusTone('Done')), false, 'đã xong thì thôi')
eq(builtButNotTested('', statusTone('COMMITED CODE FEATURE BRANCH')), false,
   'chưa có build thì không cảnh báo — đây là điểm khác với cột "đã build" cũ')
eq(builtButNotTested('20260908090132', null), false, 'Jira không tra được thì im, không đoán')

/* ── Jira links, which may point at another site ────────────────────────── */
const BASE = 'https://ossworks.atlassian.net'
eq(jiraRefFromUrl('https://theboys2024.atlassian.net/browse/VTL-286'),
   { host: 'theboys2024.atlassian.net', key: 'VTL-286' }, 'a link to another site')
eq(jiraRefFromUrl('https://x.atlassian.net/jira/software/c/projects/VT/boards/1?selectedIssue=VT-9'),
   { host: 'x.atlassian.net', key: 'VT-9' }, 'a board link carrying the issue')
eq(jiraRefFromUrl('https://x.atlassian.net/secure/Dashboard.jspa'), null, 'a page naming no issue')
eq(hostOf(BASE), 'ossworks.atlassian.net', 'host of the base')
eq(jiraLookups(['VT-365'], { 'VT-365': 'https://ossworks.atlassian.net/browse/VT-17252' }, BASE),
   { 'VT-365': { host: 'ossworks.atlassian.net', key: 'VT-17252' } }, 'a pin renames the key asked for')
eq(jiraLookups(['VTL-286'], { 'VTL-286': 'https://theboys2024.atlassian.net/browse/VTL-286' }, BASE)['VTL-286'].host,
   'theboys2024.atlassian.net', 'a pin moves the lookup off site')
eq(jiraLinkFor('VT-2', { 'VT-1': 'https://a/1' }, BASE), BASE + '/browse/VT-2', 'other keys stay derived')
eq(parseJiraUrls('{"VT-1":""}', 'https://old/1', 'VT-1'), {}, 'an emptied entry clears the legacy value')
eq(serializeJiraUrls({ 'vt-1': ' https://a/1 ', 'VT-2': '  ' }), '{"VT-1":"https://a/1"}',
   'trims, uppercases, drops blanks')

/* ── notes, keys, misc ──────────────────────────────────────────────────── */
eq(parseNotes('- [x] a\n- b\nc'), [{ done: true, text: 'a' }, { done: false, text: 'b' }, { done: false, text: 'c' }],
   'tolerant on input')
eq(serializeNotes([{ done: false, text: ' keep ' }, { done: false, text: '' }]), '- [ ] keep',
   'blank rows are dropped on the way out')
eq(noteProgress(parseNotes('- [x] a\n- [ ] b')), { done: 1, total: 2 }, 'progress')
eq(parseIssueKeys('["VT-2"]', 'VT-1'), ['VT-1', 'VT-2'], 'the primary key comes first')
eq(suggestBranch('VT-412', '[CTALK] Sửa crash khi vào room'), 'VT-412-sua-crash-khi-vao-room', 'branch suggestion')
eq(shortRepo('atthetalk/viptalk-ios-x', ['atthetalk/viptalk-ios-x', 'atthetalk/viptalk-matrix-rust-sdk-ruma']),
   'ios-x', 'the common prefix is dropped')
eq(parseGitHubLink('https://github.com/o/r/pull/12'), { repo: 'o/r', prNumber: 12 }, 'a pull request URL')
eq(parseGitHubLink('o/r'), { repo: 'o/r' }, 'bare owner/name')
eq(parseEnvState('rubbish'), {}, 'a bad env blob is empty, not a crash')
eq(mineBy({ repo: 'o/r', name: 'x', committedAt: 0, login: 'me', email: '', prs: [], pr: null },
          { logins: ['ME'] }), 'login', 'identity by login, case-insensitive')
// Tên nhánh không còn là bằng chứng sở hữu: một tiền tố như `hir/` là thói quen
// đặt tên, và luật cũ nhận vơ mọi nhánh dưới tiền tố đó kể cả của người khác.
eq(mineBy({ repo: 'o/r', name: 'hir/task/x', committedAt: 0, login: 'ai-do', email: '', prs: [], pr: null },
          { logins: ['ME'] }), null, 'tiền tố nhánh không còn nhận vơ nhánh của người khác')

/* ── local state, which is about this machine and nothing else ──────────── */

{
  const side = (over: Record<string, unknown> = {}) => ({
    repo: 'atthetalk/viptalk-ios-x',
    branch: 'ctalk/bugfix/VT-526',
    localAhead: 0,
    localOnly: false,
    localPath: '',
    ...over,
  })
  const here = new Map([
    ['atthetalk/viptalk-ios-x#ctalk/bugfix/VT-526',
     { ahead: 0, onlyLocal: false, path: '/Repo/viptalk-ios-x' }],
  ])

  // The bug this exists for: a branch marked "chưa push" before it was pushed
  // kept the mark for ever, on a card that was showing its merged PR.
  eq(withLocalState([side({ localOnly: true })], here)[0].localOnly, false,
     'a pushed branch stops being reported as unpushed')
  eq(withLocalState([side({ localAhead: 7 })], here)[0].localAhead, 0,
     'and its ahead count comes back down')
  // Absent from every clone is "nothing to say", not "whatever it last was".
  eq(withLocalState([side({ localOnly: true, localPath: '/x' })], new Map())[0], side(),
     'a branch no clone has any more is reset, not left alone')
  eq(withLocalState([side({ localOnly: true })],
       new Map([['atthetalk/viptalk-ios-x#ctalk/bugfix/VT-526',
                 { ahead: 3, onlyLocal: true, path: '/Repo/viptalk-ios-x' }]]))[0].localAhead,
     3, 'a branch that really is unpushed keeps saying so')
  eq(withLocalState([side({ branch: '  ctalk/bugfix/VT-526  ', localOnly: true })], here)[0].localOnly,
     false, 'the branch name is trimmed before lookup')
  // Identity, so a caller can skip a pointless write.
  const settled = [side({ localPath: '/Repo/viptalk-ios-x' })]
  eq(withLocalState(settled, here) === settled, true, 'nothing changed, same array back')
  eq(withLocalState([side()], here) === undefined, false, 'a change gives a new array')
}

/* ── nhánh đã lấy bản mới của môi trường về chưa ────────────────────────── */
const NOW = ts('2026-09-23T08:00:00Z')
const fresh = (baseAt: number | null, behind: number | null, baseBranch = 'master') =>
  baseFreshness({ baseAt, behind, baseBranch }, NOW)

// Câu hỏi là nhị phân, và `behind === 0` trả lời nó mà không cần ngưỡng nào.
eq(fresh(ts('2026-09-23T07:00:00Z'), 0).upToDate, true, 'behind 0 -> đã up to date')
eq(fresh(ts('2026-09-23T07:00:00Z'), 0).text, 'đã có bản mới nhất của master',
   'và nói đúng tên nhánh gốc đã so')

// So với `master` thì số commit mới đọc được — đo thật: 0, 11, 62, 174. Cùng
// những nhánh ấy so với môi trường `ctalk/develop` ra 127, 137, 301, 501, và
// còn nói ngược: nhánh tách 1 ngày tụt 127, nhánh ngâm 145 ngày chỉ tụt 301.
eq(fresh(ts('2026-09-22T06:00:00Z'), 11).text, 'dựng trên master của hôm qua · tụt 11 commit',
   'tuổi đứng trước, số commit theo sau')
eq(fresh(ts('2026-05-01T12:00:00Z'), 174).days, 144, 'nhánh cổ thì tuổi nói ngay')
eq(fresh(ts('2026-09-23T01:00:00Z'), 5).text, 'dựng trên master của hôm nay · tụt 5 commit', 'cùng ngày')
eq(fresh(ts('2026-09-13T09:00:00Z'), 62).text, 'dựng trên master của 9 ngày trước · tụt 62 commit',
   'nhiều ngày thì đếm ngày')

// Repo không có `master` thì so với nhánh mặc định, và câu chữ phải nói đúng
// cái đã so chứ không mặc định ghi "master".
eq(fresh(ts('2026-09-22T06:00:00Z'), 3, 'main').text, 'dựng trên main của hôm qua · tụt 3 commit',
   'nói đúng nhánh gốc thật sự dùng')

// Chưa đo được khác hẳn với "đã up to date" — không được trả về true.
eq(fresh(null, null).upToDate, null, 'chưa đo -> null, không phải true')
eq(fresh(ts('2026-09-20T00:00:00Z'), null).text, '', 'thiếu behind thì không nói gì')
eq(fresh(null, 3).upToDate, null, 'thiếu baseAt cũng vậy')
eq(fresh(ts('2026-09-20T00:00:00Z'), 3, '').upToDate, null, 'không biết đã so với gì thì im')

// Ba trường này phải sống sót qua một vòng lưu–đọc. Bỏ sót `baseBranch` ở
// `parseCardSides` là đúng lỗi đã gặp: quét ghi đủ, DB có đủ, mà card im lặng.
const roundTrip = parseCardSides(
  serializeCardSides([{ ...sideAt('o/sdk', []), baseAt: 1790057579, behind: 0, baseBranch: 'master' }]),
  { repo: '', branch: '', prs: '', prNumber: null, prUrl: '', prState: '', prBase: '', envState: '', landedVia: '', branchGone: false, localAhead: 0, localOnly: false, localPath: '', branchUpdatedAt: null },
)[0]
eq([roundTrip.baseAt, roundTrip.behind, roundTrip.baseBranch], [1790057579, 0, 'master'],
   'baseAt/behind/baseBranch sống sót qua lưu–đọc')
eq(baseFreshness(roundTrip, NOW).upToDate, true, 'và đọc ra đúng kết luận')

// ── Nhánh môi trường không bao giờ là card ─────────────────────────────────
//
// Đúng cấu hình cột thật đang dùng: ba môi trường, mỗi cái ba cột. `ctalk/develop`
// từng lên board thành một card `no-ticket` vì feed sự kiện nhận nó là của người
// dùng — họ merge một PR vào nó qua giao diện GitHub, và GitHub ghi cú dời đầu
// nhánh thành PushEvent mang tên họ, dù commit đầu nhánh là của người khác.
{
  const st = (name: string, branch: string, reach: string) =>
    ({ name, branch, reach, expects: 'prog', phase: '' }) as unknown as StageConfig
  const stages: StageConfig[] = [
    st('đang code', '', 'queued'),
    st('review', '', 'queued'),
    st('develop', 'ctalk/develop', 'queued'),
    st('đã merge develop', 'ctalk/develop', 'merged'),
    st('đã build develop', 'ctalk/develop', 'built'),
    st('integration', 'develop', 'queued'),
    st('đã merge integration', 'develop', 'merged'),
    st('đã build integration', 'develop', 'built'),
    st('staging', 'staging', 'queued'),
    st('đã merge staging', 'staging', 'merged'),
    st('đã build staging', 'staging', 'built'),
    st('done', '', 'gone'),
  ]
  const envs = envBranchNames(stages)
  eq([...envs].sort(), ['ctalk/develop', 'develop', 'staging'], 'ba môi trường, mỗi cái một lần')
  eq(envs.has('ctalk/develop'), true, 'chính nhánh đã lọt lên board')
  // Cột `queued` và `built` cũng phải tính — `envSteps` chỉ lấy `merged`, mà
  // lọc theo mỗi `merged` thì vẫn đúng ở đây nhưng sai ngay khi ai đó bỏ cột
  // "đã merge" của một môi trường.
  eq(envBranchNames([st('develop', 'ctalk/develop', 'queued')]).has('ctalk/develop'), true,
     'một cột queued đơn độc vẫn khai được môi trường')
  // Nhánh việc thật thì không được đụng tới, kể cả khi tên chứa tên môi trường.
  for (const b of ['ctalk/bugfix/VT-451', 'ctalk/develop-fix', 'feature/develop'])
    eq(envs.has(b), false, `${b} vẫn là nhánh việc`)
  // Cột không khai nhánh (đang code / review / done) không được biến '' thành môi trường.
  eq(envs.has(''), false, 'cột không có nhánh không tạo ra môi trường rỗng')
}

/* ── task nhắm vào nhánh feature: liên kết hai chiều ────────────────────── */
//
// Có thật trên bảng: card task `implement_set_password_with_sso_account` mở PR
// #1635 nhắm vào `ctalk/feature/VT-2583_FR-4_…`, tức nhánh của card VT-2583.
// Quan hệ này đã nằm sẵn trong dữ liệu card, không phải hỏi GitHub thêm.
{
  const c = (id: number, key: string, repo: string, branch: string,
             prs: Array<{ base: string; state: string }> = []) =>
    ({ id, issueKey: key, title: `card ${id}`, sides: [{ repo, branch, prs }] })

  const feat = c(44, 'VT-2583', 'o/sdk', 'ctalk/feature/VT-2583_FR-4')
  const task = c(45, '', 'o/sdk', 'ctalk/task/impl',
                 [{ base: 'ctalk/feature/VT-2583_FR-4', state: 'OPEN' }])
  const all = [feat, task]

  const owners = ownersByBranch(all)
  eq(owners.get('o/sdk#ctalk/feature/VT-2583_FR-4')?.id, 44, 'nhánh feature trỏ về card giữ nó')
  eq(owners.get('o/sdk#ctalk/task/impl')?.id, 45, 'và nhánh task cũng vậy')
  // Khoá kèm repo: cùng tên nhánh ở hai repo là hai nhánh khác nhau.
  eq(owners.get('o/ios#ctalk/feature/VT-2583_FR-4'), undefined, 'không lẫn giữa hai repo')

  eq(inboundPrs(all, 'o/sdk', 'ctalk/feature/VT-2583_FR-4').map((x) => x.id), [45],
     'card feature thấy task đang nhắm vào mình')
  eq(inboundPrs(all, 'o/sdk', 'ctalk/task/impl').map((x) => x.id), [],
     'card task không có ai nhắm vào')
  eq(inboundPrs(all, 'o/ios', 'ctalk/feature/VT-2583_FR-4').map((x) => x.id), [],
     'khác repo thì không tính')

  // PR đã đóng hoặc đã merge không còn là việc đang chờ.
  for (const state of ['CLOSED', 'MERGED']) {
    const done = c(46, '', 'o/sdk', 'ctalk/task/x',
                   [{ base: 'ctalk/feature/VT-2583_FR-4', state }])
    eq(inboundPrs([feat, done], 'o/sdk', 'ctalk/feature/VT-2583_FR-4').map((x) => x.id), [],
       `PR ${state} không còn là "chờ vào"`)
  }
  // Card tự nhắm vào chính nhánh mình thì không tính là liên kết.
  const selfie = c(47, '', 'o/sdk', 'b', [{ base: 'b', state: 'OPEN' }])
  eq(inboundPrs([selfie], 'o/sdk', 'b').map((x) => x.id), [], 'không tự trỏ vào mình')
}

console.log(bad ? `\n${bad}/${n} FAILED` : `\nall ${n} ok`)
process.exit(bad ? 1 : 0)
