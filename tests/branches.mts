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
  branchesCleanedUp,
  branchesToDelete,
  ticketsDone,
  cardLadder,
  cleanupStep,
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
eq(S.length, 12, 'eleven pipeline columns plus the terminal one')
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
eq(ruleOf('đang code'), 'chưa mở PR — hoặc PR còn draft, hoặc đã đóng', 'cột không nhánh, chưa có PR')
eq(ruleOf('review'), 'PR đang mở', 'cột không nhánh, PR đang mở')
eq(ruleOf('develop'), 'có PR đang mở nhắm vào ctalk/develop', 'chờ merge = PR mở nhắm đúng nhánh này')
eq(ruleOf('đã merge develop'), 'code đã nằm trong ctalk/develop', 'đã merge hỏi repo, không hỏi PR')
eq(ruleOf('đã build develop'), 'đã có bản build của ctalk/develop mang code này', 'đã build hỏi bản build')
eq(ruleOf('done'), 'nhánh của card đã bị xoá khỏi mọi repo', 'cột cuối')
// Điều kiện PR chồng thêm thì câu phải nói ra cả hai vế.
eq(stageRule({ name: 'x', expects: '', branch: 'staging', phase: 'open', reach: 'merged' }),
   'code đã nằm trong staging, và PR đang mở', 'hai điều kiện thì nói cả hai')

/* ── which column a branch belongs in ───────────────────────────────────── */
const open = (base: string, num = 1) => ({ number: num, url: '', state: 'OPEN', isDraft: false, baseRefName: base })
const merged = { number: 2, url: '', state: 'MERGED', isDraft: false, baseRefName: 'ctalk/develop' }
const none = {} as Record<string, { ahead: number | null; landed?: boolean }>

eq(stageFor(none, null, S, []), 'đang code', 'no PR -> đang code')
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
eq(stageFor(none, draft, S, [draft]), 'đang code', 'a draft is not queued')
const closed = { number: 4, url: '', state: 'CLOSED', isDraft: false, baseRefName: 'develop' }
eq(stageFor(none, closed, S, [closed]), 'đang code', 'a closed PR is not queued')
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
eq(stageFor(inAll, closed, S, [closed]), 'đang code',
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

/* ── cột cuối: Jira đóng ticket là vào, rồi đòi xoá nhánh ───────────────── */
eq(ticketsDone(['Done']), true, 'a closed ticket is done')
eq(ticketsDone(['Done', 'Done']), true, 'both closed is done')
eq(ticketsDone(['Done', 'READY TO TEST ON STAGING']), false,
   'a card is only as finished as its least finished ticket')
eq(ticketsDone(['VERIFIED ON STAGING']), false,
   'verified is the tester speaking, not the ticket closing')
eq(ticketsDone([null]), false, 'a ticket Jira did not answer for is not done')
eq(ticketsDone([]), false, 'a card naming no ticket is not done either')

// Jira closing the ticket wins from anywhere — a won't-fix never reaches an
// environment and is still over.
eq(cardStage([sideAt('o/ios', [prAt(1, 'OPEN', 'ctalk/develop')])], [], S, true), 'done',
   'a closed ticket finishes the card from any column')
eq(cardStage([sideAt('o/ios', [prAt(1, 'OPEN', 'ctalk/develop')])], [], S, false), 'develop',
   'and an open one leaves it exactly where it was')
eq(cardStage([sideAt('o/ios', [prAt(1, 'OPEN', 'ctalk/develop')])], [], S, null), 'develop',
   'as does having nobody to ask')


const shipped = (repo: string, gone: boolean) => ({
  ...sideAt(repo, [prAt(1, 'MERGED', 'staging')]), branchGone: gone,
})
// The branch going is what puts a card in the last column — nothing else does.
eq(cardStage([shipped('o/ios', true)], [], S), 'done',
   'with no ticket to ask, a branch deleted after the work shipped -> done')
eq(cardStage([shipped('o/ios', true)], [], S, false), 'đã merge staging',
   'but a live ticket that is not done overrules the weaker witness')
eq(cardStage([shipped('o/ios', false)], [], S), 'đã merge staging',
   'the same card with its branch still up stays where it was')
// Both halves, ANDed. This is the one rule that is not "the furthest side wins":
// what is being asked is whether anything is left, not how far it got.
eq(cardStage([shipped('o/ios', true), shipped('o/sdk', false)], [], S), 'đã merge staging',
   'one repo cleaned up and the other not is not finished')
eq(cardStage([shipped('o/ios', true), shipped('o/sdk', true)], [], S), 'done',
   'both cleaned up is')
// Deleting a branch that never went anywhere is abandonment, not delivery.
eq(cardStage([{ ...sideAt('o/ios', [prAt(1, 'CLOSED', 'ctalk/develop')]), branchGone: true }], [], S),
   'đang code', 'a branch deleted before it reached any environment is not done')
eq(branchesCleanedUp([]), false, 'a card with no sides has not been cleaned up')

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

console.log(bad ? `\n${bad}/${n} FAILED` : `\nall ${n} ok`)
process.exit(bad ? 1 : 0)
