/**
 * Naming rules for an iOS SDK release.
 *
 * Run: npx tsx tests/sdk-release.mts
 *
 * Every case here is harvested from the wrapper repository's real history — 496
 * tags and the commit subjects beside them — rather than invented. The version
 * string is handed to a tool that checks nothing and then builds for forty
 * minutes, so a rule that is wrong is only discovered at the far end.
 */
import {
  DEFAULT_BRANCH_SUFFIXES,
  terminalText,
  deriveSuffix,
  nextOrdinal,
  nextVersion,
  parseBumpMessage,
  parseNameStatus,
  parseNumstat,
  parseAnsi,
  stripAnsi,
  rankBranch,
  searchBranches,
  parseUnifiedDiff,
  recoveryPlan,
  parseReleaseTag,
  releasesForBranch,
  phaseOf,
  tailLines,
  versionString,
} from '@/lib/modules/sdk-release/model'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}

const KEYS = ['VT', 'VTL']
const S = DEFAULT_BRANCH_SUFFIXES
const sfx = (branch: string) => deriveSuffix(branch, S, KEYS)

/* ── parsing tags ───────────────────────────────────────────────────────── */
eq(parseReleaseTag('2026.09.15-cxpdev.3'),
   { pre: false, date: '2026.09.15', suffix: 'cxpdev', ordinal: 3 }, 'an ordinary tag')
eq(parseReleaseTag('pre-2026.08.20-cxpdev.2'),
   { pre: true, date: '2026.08.20', suffix: 'cxpdev', ordinal: 2 }, 'a pre- tag')
// A master release is a bare date. 39 of them, none ever carrying a number.
eq(parseReleaseTag('2026.09.12'),
   { pre: false, date: '2026.09.12', suffix: '', ordinal: 1 }, 'master is a bare date')

// Three older shapes still in the repository. Each must be ignored rather than
// misread — letting `1.0` parse as a date would poison the ordinal arithmetic.
eq(parseReleaseTag('v1.0.30'), null, 'the pre-date scheme is not a release tag')
eq(parseReleaseTag('25.03.06'), null, 'nor a two-digit year')
eq(parseReleaseTag('2025.12.19.password.1'), null, 'nor dots where the dash belongs')

eq(versionString({ date: '2026.09.18', suffix: 'ctalkdev', ordinal: 2 }),
   '2026.09.18-ctalkdev.2', 'round trip')
eq(versionString({ date: '2026.09.12', suffix: '', ordinal: 1 }), '2026.09.12',
   'a master release prints no ordinal')

/* ── which suffix a branch releases under ───────────────────────────────── */
eq(sfx('ctalk/develop').suffix, 'ctalkdev', 'the configured map wins')
eq(sfx('ctalk/develop').confidence, 'exact', 'and says so')
eq(sfx('develop').suffix, 'dev', 'plain develop')
eq(sfx('staging').suffix, 'stag', 'staging is abbreviated')
eq(sfx('master').suffix, '', 'master has no suffix at all')
// Not in the seeded map — the team prefix is read off the branch rather than
// looked up, so a team nobody declared still resolves.
eq(sfx('cxp/develop').suffix, 'cxpdev', 'an undeclared team still works')
eq(sfx('hir/develop').suffix, 'hirdev', 'and so does one the guide never mentions')

// Feature branches, each checked against the tag it actually shipped as.
eq(sfx('ctalk/bugfix/VT-526').suffix, 'ctalkvt526', 'VT-526 → ctalkvt526')
eq(sfx('ctalk/task/VT_706_permalink_base_urls').suffix, 'ctalkvt706',
   'the trailing words are dropped, the key is not')
eq(sfx('ctalk/feature/VT_4_open_app_via_native_camera').suffix, 'ctalkvt4',
   'a single-digit key')
eq(sfx('hir/feature/vtl-679-ice-configuration').suffix, 'hirvtl679', 'lower-case key')
// A ticket number is a guess, not a rule, and the repository says so: over all
// 429 release commits the Jira-key reading fired 49 times and was right 31 —
// 63%. `ctalk/feature/VT_23228_sqa_security_20260412` shipped as `ctalksqa`,
// `ctalk/task/VT_23248_improve_message_otp_err` as `ctalkotperr`. The guide
// never mentions Jira at all; it says `<team><tên_feature>`.
eq(sfx('ctalk/bugfix/VT-526').confidence, 'guess', 'a ticket number is only a guess')

// What the same branch used last time is the rule worth having: applicable 360
// times across the history, right 344 — 96%.
const hist = [
  { version: '2026.09.16-ctalkvt526.1', branch: 'ctalk/bugfix/VT-526', sha: 'a'.repeat(40), at: 200 },
  { version: '2026.07.11-bug26586.1', branch: 'ctalk/bugfix/VT-26586', sha: 'b'.repeat(40), at: 100 },
]
eq(deriveSuffix('ctalk/bugfix/VT-526', S, KEYS, hist),
   { suffix: 'ctalkvt526', confidence: 'derived', why: 'nhánh này lần trước release là 2026.09.16-ctalkvt526.1' },
   'history beats the ticket number — same answer here, but for the right reason')
eq(deriveSuffix('ctalk/bugfix/VT-26586', S, KEYS, hist).suffix, 'bug26586',
   'and a different answer where the team chose one: bug26586, not ctalkvt26586')
eq(deriveSuffix('ctalk/develop', S, KEYS,
     [{ version: '2026.07.17-ctackdev.1', branch: 'ctalk/develop', sha: 'c'.repeat(40), at: 300 }]).suffix,
   'ctalkdev',
   'but the guide table still wins: one past typo does not become the rule')
eq(deriveSuffix('ctalk/bugfix/VT-526', S, KEYS, hist.slice(1)).confidence, 'guess',
   'a branch with no history falls back to guessing')

// The runners-up are offered rather than hidden, each with its own ordinal —
// and only where they differ, since history and ticket agree on VT-526.
eq(nextVersion({ branch: 'ctalk/bugfix/VT-526', date: '2026.09.18', tags: [],
                 suffixes: S, projectKeys: KEYS, history: hist }).alternatives,
   [],
   'nothing to offer when every rule lands on the same suffix')
eq(nextVersion({ branch: 'ctalk/bugfix/VT-26586', date: '2026.09.18',
                 tags: ['2026.09.18-ctalkvt26586.1'],
                 suffixes: S, projectKeys: KEYS, history: hist })
     .alternatives.map((a) => a.version),
   ['2026.09.18-ctalkvt26586.2'],
   'the ticket form stays one click away, and carries its own ordinal')
// Two keys drop the project prefix entirely. Odd, but it is what shipped, and a
// tag has to look like the ones beside it.
eq(sfx('ctalk/bugfix/VTL-286_VTL-610').suffix, 'ctalk286610', 'two keys → digits only')

// No key to read. The guide says the feature name is the person's to choose and
// the history agrees, so assert the flag rather than the string.
eq(sfx('ctalk/feature/upgrade_26.09.09_phase1').confidence, 'guess',
   'a branch naming no ticket can only be guessed at')
eq(sfx('ctalk/feature/scanner_suggestion').confidence, 'guess', 'likewise')
// The kind segment is noise in a version: nothing ever shipped as `ctalktask…`.
eq(sfx('ctalk/task/scanner').suffix, 'ctalkscanner', 'the kind segment is dropped')
eq(sfx('origin/ctalk/develop').suffix, 'ctalkdev', 'a remote-style name is the same branch')

// The first segment is a team only when it is not a kind word. `feature` is
// not a team, and `featurelinkmanagement` is a shape nothing ever shipped as.
eq(sfx('feature/link-management').suffix, 'linkmanagement', 'a kind word is not a team')
eq(sfx('cxp/features/update_framework/preview_2').suffix, 'cxpupdateframework',
   'plural "features" is a kind word too')
// Whole words up to the cap, never a cut through the middle of one: this used
// to end `…resetse`.
eq(sfx('ctalk/feature/fighting_identity_reset_security_issue_20260426').suffix,
   'ctalkfightingidentity', 'the cap lands on a word boundary')
// A team nobody configured still works, because the prefix is read off the
// branch rather than matched against a list.
eq(sfx('newteam/feature/some_brand_new_thing').suffix, 'newteamsomebrandnewthing',
   'a brand-new team needs no configuration')
eq(sfx('cxp/develop').suffix, 'cxpdev', "the guide's table now seeds cxp as well")
eq(sfx('hir/develop').suffix, 'hirdev', 'and an unlisted team still resolves by rule')

/* ── the ordinal, which is where the real bug lives ─────────────────────── */
eq(nextOrdinal([], '2026.09.18', 'ctalkdev'), 1, 'first of the day')
eq(nextOrdinal(['2026.09.18-ctalkdev.1'], '2026.09.18', 'ctalkdev'), 2, 'then the second')

// max + 1, not count + 1. Real: 2026.09.15-cxpdev has .1 and .3 and no .2.
eq(nextOrdinal(['2026.09.15-cxpdev.1', '2026.09.15-cxpdev.3'], '2026.09.15', 'cxpdev'), 4,
   'a gap in the numbers must not be handed out again')

// Tag `pre-` KHÔNG đốt số.
//
// Trước đây nó có, dựa trên một quan sát đúng mà giải thích sai: lịch sử có
// `.1`, `pre-.2`, `.3`, nên tưởng lần chạy hỏng giữ mất số. Log thật của
// `swift run release` cho thấy tag pre- là sổ sách của chính lệnh — cắm lúc
// "Making release", rồi "Delete tag pre-…" ở bước cuối. Còn sót một cái nghĩa
// là lần chạy ấy chết, chứ không nghĩa là tên đã được phát hành.
//
// Đếm nó vào thì app nhảy số vì rác mà chính lệnh sẽ dọn, và người dùng thấy
// `.2` cho một cái tên chưa ai dùng. Chỉ tag thật mới tính.
eq(nextOrdinal(
     ['2026.08.20-cxpdev.1', 'pre-2026.08.20-cxpdev.2', '2026.08.20-cxpdev.3'],
     '2026.08.20', 'cxpdev'), 4,
   'tag thật cao nhất vẫn quyết định, tag pre- xen giữa không đổi gì')
eq(nextOrdinal(['2026.09.17-ctalkdev.1', 'pre-2026.09.17-ctalkdev.2'], '2026.09.17', 'ctalkdev'),
   2, 'tag pre- cao nhất bị bỏ qua — .2 vẫn là số tiếp theo')
eq(nextOrdinal(['pre-2026.09.17-ctalkdev.1'], '2026.09.17', 'ctalkdev'), 1,
   'chỉ có tag pre- thì coi như chưa ai dùng')

eq(nextOrdinal(['2026.08.20-cxpdev.3'], '2026.08.21', 'cxpdev'), 1, 'a new day starts over')
eq(nextOrdinal(['v1.0.83', '2026.09.17-cxpdev.1'], '2026.09.17', 'ctalkdev'), 1,
   'other suffixes and legacy tags do not count toward this one')


/* ── the whole proposal ─────────────────────────────────────────────────── */
const p = nextVersion({
  branch: 'ctalk/develop',
  date: '2026.09.18',
  tags: ['2026.09.18-ctalkdev.1', '2026.09.18-dev.1'],
  suffixes: S,
  projectKeys: KEYS,
})
eq(p.version, '2026.09.18-ctalkdev.2', 'today already has one, so this is the second')
eq(p.warnings, [], 'and nothing to warn about')

// Master twice in a day has no precedent in 496 tags and no format to express
// it. Say so rather than invent `.2`.
const m = nextVersion({
  branch: 'master', date: '2026.09.12', tags: ['2026.09.12'], suffixes: S, projectKeys: KEYS,
})
eq(m.version, '2026.09.12', 'still the bare date')
eq(m.warnings.length, 1, 'but flagged, because that tag already exists')

const stranded = nextVersion({
  branch: 'ctalk/develop',
  date: '2026.09.17',
  tags: ['2026.09.17-ctalkdev.1', 'pre-2026.09.17-ctalkdev.2'],
  suffixes: S,
  projectKeys: KEYS,
})
eq(stranded.version, '2026.09.17-ctalkdev.2', 'không nhảy số vì tag pre-')
// Vẫn nhảy qua số đó — một tag pre- còn sót nghĩa là lần chạy ấy chết giữa
// chừng và để lại một trang release gắn vào tag đó, nên tên ấy chưa rảnh.
// Nhưng KHÔNG cảnh báo: tag pre- là sổ sách của lệnh, lệnh tự dọn, và app nói
// vào đó chỉ làm người dùng đi xoá thứ không phải việc của mình.
eq(stranded.warnings.length, 0, 'nhưng không cảnh báo gì về tag pre-')

/* ── reading the build log ──────────────────────────────────────────────── */
// cargo writes progress with \r. Left alone, forty minutes of build fills the
// console with thousands of lines that only ever meant to be one.
eq(terminalText('a\rb\rCompiling matrix-sdk\nplain'), 'Compiling matrix-sdk\nplain',
   'only what a terminal would still be showing')
eq(terminalText('no carriage returns'), 'no carriage returns', 'untouched otherwise')
eq(tailLines('1\n2\n3\n4', 2), '3\n4', 'the last lines only')
eq(tailLines('1\n2', 5), '1\n2', 'short input is returned whole')

// Phases come from the tool's own Log.info strings, and the button that reads
// them changes meaning: cancelling before `Copying sources` costs nothing,
// cancelling after `Pushing changes` cannot take the push back.
eq(phaseOf('Building ctalk/develop at a31a460'), 'build', 'the build')
eq(phaseOf('🚀 Zipping framework'), 'zip', 'zipping')
eq(phaseOf('🚀 Making release'), 'release', 'making the release')
eq(phaseOf('🚀 Copying sources'), 'sources', 'copying sources')
eq(phaseOf('🚀 Pushing changes'), 'push', 'pushing')
eq(phaseOf('🚀 Update release'), 'finish', 'finishing')
eq(phaseOf('Building …\n🚀 Zipping framework\n🚀 Pushing changes'), 'push',
   'a full log reports the furthest phase reached, not the first')
eq(phaseOf(''), 'build', 'nothing yet reads as the build')

/* ── reading a release back out of the tool's own commit ─────────────────── */

// All four subjects below are verbatim from `git log origin/main` in the
// wrapper repository.
eq(
  parseBumpMessage(
    'Bump to version 2026.09.18-ctalkdev.1 (viptalk-matrix-rust-sdk-ruma/ctalk/develop 5fca2f33e7de75725536f7c8542b264336619526)',
    1789704139,
  ),
  {
    version: '2026.09.18-ctalkdev.1',
    branch: 'ctalk/develop',
    sha: '5fca2f33e7de75725536f7c8542b264336619526',
    at: 1789704139,
  },
  'a bump commit names the branch in full',
)
eq(
  parseBumpMessage(
    'Bump to version 2026.09.16-ctalk260909phase1.1 (viptalk-matrix-rust-sdk-ruma/ctalk/task/upgrade_26.09.09_phase1 ab8311d063fa08617473a88fe094b660ec20b838)',
  )?.branch,
  'ctalk/task/upgrade_26.09.09_phase1',
  'a branch with three slashes and dots survives — the sha is what ends it',
)
eq(
  parseBumpMessage(
    'Bump to version 2026.09.15-stag.1 (viptalk-matrix-rust-sdk-ruma/staging 7f9668a89becd42f6d39ce2a8d50c27586e7be88)',
  )?.branch,
  'staging',
  'a branch with no slash at all',
)
eq(
  parseBumpMessage('Merge pull request #378 from atthetalk/ctalk/bugfix/VT-526'),
  null,
  'an ordinary commit is not a release',
)

// The slug cannot answer this question and the commit can: `ctalkdev` is shared
// by `ctalk/develop` alone here, but the history also holds `hirvt111` and
// `hirvtl111` for one branch, and `ctackdev` for another.
const bumps = [
  parseBumpMessage(
    'Bump to version 2026.09.18-ctalkdev.1 (viptalk-matrix-rust-sdk-ruma/ctalk/develop 5fca2f33e7de75725536f7c8542b264336619526)',
    300,
  )!,
  parseBumpMessage(
    'Bump to version 2026.09.17-ctalkdev.1 (viptalk-matrix-rust-sdk-ruma/ctalk/develop 946af64fbaafb92bdeeebec2bf48ca842f645b24)',
    100,
  )!,
  parseBumpMessage(
    'Bump to version 2026.09.15-ctalkdev.1 (viptalk-matrix-rust-sdk-ruma/ctalk/develop 9b5d8a6eefef37bdcf17f0e4e26ec86005388c6c)',
    200,
  )!,
  parseBumpMessage(
    'Bump to version 2026.09.18-dev.1 (viptalk-matrix-rust-sdk-ruma/develop 58cc0e0c65fb5664b21cc07ae69e864231a9d6a3)',
    400,
  )!,
]
eq(
  releasesForBranch(bumps, 'ctalk/develop').map((r) => r.version),
  ['2026.09.18-ctalkdev.1', '2026.09.15-ctalkdev.1', '2026.09.17-ctalkdev.1'],
  'newest first by commit time, and `develop` is not `ctalk/develop`',
)
eq(releasesForBranch(bumps, 'ctalk/develop', 2).length, 2, 'capped at n')
eq(releasesForBranch(bumps, ''), [], 'a detached HEAD has no branch history')
eq(releasesForBranch(bumps, 'ctalk/bugfix/VT-526'), [], 'a branch that never released')

/* ── what to do after a run that did not finish ──────────────────────────── */

const after = (over: Partial<Parameters<typeof recoveryPlan>[0]> = {}) =>
  recoveryPlan(
    { version: '2026.09.19-ctalkdev.2', slug: 'atthetalk/viptalk-matrix-rust-components-swift',
      tagged: false, preTagged: false, unpushed: 0, remoteMoved: false, ...over },
    '', '/Repo/swift',
  )

// The four states are told apart by refs and commits, never by the exit code:
// `makeRelease` dying on a taken tag and `git push` being rejected both exit
// non-zero and leave completely different messes.
eq(after().state, 'clean', 'no tag, no stray commit — nothing reached GitHub')
eq(after({ preTagged: true, unpushed: 1 }).state, 'push-rejected', 'release made, commit stuck')
eq(after({ preTagged: true }).state, 'stranded', 'a pre- tag with nothing local behind it')
eq(after({ tagged: true, preTagged: true, unpushed: 1 }).state, 'done',
   'a real tag outranks everything — it shipped, whatever else is lying around')

// The order is the whole point: rebase before deleting leaves a release pointing
// at a commit that no longer exists, and re-running before deleting dies on the
// tag that is already taken.
const steps = after({ preTagged: true, unpushed: 1, remoteMoved: true }).steps
eq(steps.map((s) => (s.command ?? s.url ?? '').split(' ').slice(0, 4).join(' ')),
   ['git -C /Repo/swift fetch',
    'git -C /Repo/swift rebase',
    'https://github.com/atthetalk/viptalk-matrix-rust-components-swift/releases/tag/pre-2026.09.19-ctalkdev.2',
    ''],
   'fetch, rebase, xoá trang release, rồi chạy lại')

// Tag pre- là sổ sách của `swift run release`: log thật cho thấy nó cắm lúc
// "Making release" rồi tự "Delete tag pre-…" ở bước cuối. App từng bày cách xoá
// tag — vừa thừa vừa sai, vì lệnh mới là chỗ quản nó. Chỉ trang release là việc
// của người dùng.
for (const [name, a] of [
  ['còn bản dở dang', { preTagged: true }],
  ['push bị từ chối', { preTagged: true, unpushed: 1 }],
] as const) {
  const cmds = after(a).steps.map((s) => s.command ?? '')
  eq(cmds.some((c) => /refs\/tags\/pre-|tag -d pre-/.test(c)), false,
     `${name}: KHÔNG bày cách xoá tag pre-`)
  eq(after(a).steps.some((st) => (st.url ?? '').includes('/releases/tag/pre-')), true,
     `${name}: có bước xoá trang release`)
}
// Bản đã release thật thì không được bày cách xoá gì cả.
eq(after({ tagged: true }).steps.some((s) => (s.command ?? '').includes('push origin :refs')), false,
   'bản đã lên thật thì không gợi ý xoá tag')
eq(/có người push lên main trước bạn/.test(after({ preTagged: true, unpushed: 1, remoteMoved: true }).detail),
   true, 'and it says why, when it knows why')
eq(/origin\/main đã đổi/.test(after({ remoteMoved: true }).detail), true,
   'a clean stop still warns that the remote moved under it')

/* ── file thay đổi của commit sắp build ─────────────────────────────────── */
// Dòng đổi tên có ba cột, mọi dòng khác hai — và đó là dòng không dựng lại
// được bằng tay trong một clone thật, nên nó phải nằm ở đây.
eq(parseNameStatus('M\tsrc/client.rs'), [{ status: 'M', path: 'src/client.rs' }],
   'dòng thường: hai cột')
eq(parseNameStatus('R100\tsrc/old.rs\tsrc/new.rs'),
   [{ status: 'R', path: 'src/new.rs', from: 'src/old.rs' }],
   'đổi tên: giữ cả đường dẫn cũ, và status rút về một chữ')
eq(parseNameStatus('C75\ta.rs\tb.rs')[0]?.from, 'a.rs', 'copy cũng ba cột')
eq(parseNameStatus('A\ta.rs\nD\tb.rs\n\nM\tc.rs').map((f) => f.status).join(''),
   'ADM', 'bỏ qua dòng trống, giữ nguyên thứ tự')
eq(parseNameStatus(''), [], 'không có gì thì trả mảng rỗng, không phải một phần tử rác')
// Đường dẫn có khoảng trắng: git không quote khi dùng \t làm phân cách.
eq(parseNameStatus('M\tsrc/my file.rs')[0]?.path, 'src/my file.rs',
   'đường dẫn có khoảng trắng vẫn nguyên vẹn')

/* ── đếm dòng thêm/bớt ──────────────────────────────────────────────────── */
const ns = parseNumstat('3\t0\tsrc/client.rs\n24\t1\tsrc/ctk.rs')
eq(ns.get('src/client.rs'), { added: 3, removed: 0, binary: false }, 'numstat thường')
eq(ns.get('src/ctk.rs')?.removed, 1, 'đếm cả dòng bớt')
// File nhị phân git ghi `-`, không phải 0 — hai thứ khác nhau.
eq(parseNumstat('-\t-\tlogo.png').get('logo.png'), { added: 0, removed: 0, binary: true },
   'file nhị phân đánh dấu riêng, không đọc thành "đổi 0 dòng"')
// Đổi tên có hai dạng, và cả hai phải ra *tên mới* để khớp với --name-status.
eq([...parseNumstat('1\t1\told.rs => new.rs').keys()], ['new.rs'], 'đổi tên dạng phẳng')
eq([...parseNumstat('1\t1\tsrc/{old => new}/a.rs').keys()], ['src/new/a.rs'], 'đổi tên dạng gộp')

/* ── đọc unified diff thành dòng có số ──────────────────────────────────── */
const D = parseUnifiedDiff(
  'diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n' +
    '@@ -10,3 +10,4 @@ fn main() {\n a\n+b\n c\n' +
    '@@ -80,2 +81,1 @@\n-d\n e\n\\ No newline at end of file\n',
)
eq(D.filter((l) => l.kind === 'hunk').length, 2, 'hai hunk')
// Phần đầu (diff --git, index, ---, +++) không phải nội dung file.
eq(D.some((l) => l.text.startsWith('diff --git') || l.text.startsWith('index ')), false,
   'bỏ phần đầu của diff')
eq(D.filter((l) => l.kind !== 'hunk').map((l) => [l.old, l.new, l.text]), [
  [10, 10, 'a'],
  [null, 11, 'b'],
  [11, 12, 'c'],
  [80, null, 'd'],
  [81, 81, 'e'],
], 'số dòng bám theo đầu hunk, và nhảy cóc giữa hai hunk là bình thường')
// Dòng này nói về dòng ngay trên nó, không phải một dòng của file: đếm nó vào
// là lệch số dòng của tất cả phần còn lại.
eq(D.some((l) => l.text.startsWith('\\')), false, '"No newline at end of file" không phải một dòng')
eq(parseUnifiedDiff(''), [], 'diff rỗng -> không có dòng nào')
eq(parseUnifiedDiff('diff --git a/b b/b\nBinary files a/b and b/b differ\n'), [],
   'diff nhị phân không có hunk nên không ra dòng rác')

/* ── tìm nhánh: khớp sát nhất phải lên đầu ──────────────────────────────── */
// Lấy nguyên từ clone SDK, gồm đúng những cái từng đẩy câu trả lời xuống dưới.
const B = [
  'ctalk/develop',
  'ctalk/feature/resolve_ctalkdevelop_upgrade_26.09.09_phase1',
  'ctalk/task/VT_706_permalink_base_urls',
  'cxp/develop',
  'cxp/feature/backup-develop',
  'cxp/feature/update_framework/feature_upgrade_framework_sync_latest_master',
  'delete_soon_develop',
  'develop',
  'hir/bugfix/vt-111-show-avatar-when-remote-camera-off-develop-resolve',
  'master',
].map((name) => ({ name }))

const first = (q: string) => searchBranches(B, q)[0]?.name
// Đây là lỗi người dùng báo: gõ đúng tên một nhánh mà nó không lên đầu.
eq(first('develop'), 'develop', 'gõ đúng tên nhánh thì nhánh đó lên đầu')
eq(first('master'), 'master', 'kể cả khi có nhánh dài hơn cũng chứa chuỗi đó')
// Danh sách chỉ hiện 10 dòng, nên "có trong kết quả" là chưa đủ.
eq(searchBranches(B, 'develop').findIndex((b) => b.name === 'develop'), 0,
   'khớp cả tên đứng thứ nhất, không phải chỉ "có mặt đâu đó"')

eq(rankBranch('develop', 'develop') < rankBranch('ctalk/develop', 'develop'), true,
   'khớp cả tên hơn khớp đoạn cuối')
eq(rankBranch('ctalk/develop', 'develop') < rankBranch('delete_soon_develop', 'develop'), true,
   'nhánh MANG tên đó hơn nhánh chỉ nhắc tới nó')
eq(rankBranch('ctalk/bugfix/VT-526', 'vt') < rankBranch('ctalk/task/merge_VT_4', 'vt'), true,
   'đầu đoạn hơn giữa đoạn')
// Gõ số hiệu ticket là cách tìm nhanh nhất, và nó nằm giữa tên.
eq(rankBranch('ctalk/task/VT_706_permalink_base_urls', '706') < 6, true,
   'đầu một từ bên trong đoạn vẫn hơn khớp chuỗi bất kỳ')
// Cùng bậc thì từ khớp sớm hơn thắng, không phải tên ngắn hơn thắng: gõ số
// hiệu ticket thì nhánh CỦA ticket đó phải lên trước nhánh chỉ nhắc tới nó.
eq(searchBranches(
  [{ name: 'ctalk/task/merge_VT_4_and_VT_706' }, { name: 'ctalk/task/VT_706_permalink_base_urls' }],
  '706',
)[0]?.name, 'ctalk/task/VT_706_permalink_base_urls', 'từ khớp sớm hơn thắng tên ngắn hơn')
eq(rankBranch('ctalk/feature/resolve_ctalkdevelop_x', 'develop'), 6,
   'dính giữa một từ là bậc cuối')

eq(searchBranches(B, '').length, B.length, 'không gõ gì thì giữ nguyên cả danh sách')
eq(searchBranches(B, 'khongcogi'), [], 'không khớp thì rỗng')
// Cùng bậc thì tên ngắn lên trước, và thứ tự phải ổn định chứ không đổi giữa
// hai lần gõ cùng một chữ.
eq(searchBranches(B, 'develop').slice(0, 3).map((b) => b.name),
   ['develop', 'cxp/develop', 'ctalk/develop'], 'cùng bậc: ngắn trước, rồi theo bảng chữ cái')

/* ── log phải hiện đúng như terminal ────────────────────────────────────── */
// PTY đổi mọi \n thành \r\n. Không tách CRLF ra trước thì `\r` cuối dòng bị đọc
// là "viết đè", và mọi dòng thành rỗng — log trắng bóc.
eq(terminalText('a\r\nb\r\n'), 'a\nb\n', 'CRLF là xuống dòng, không phải viết đè')
eq(terminalText('  Building [1]\r  Building [2]\r  Building [3]\r\n'),
   '  Building [3]\n', 'thanh tiến trình: chỉ còn trạng thái cuối, như terminal')
// `script` vọng lại ^D ở đầu vì stdin đóng ngay; `\r` ngay sau đó xoá nó, đúng
// như terminal thật.
eq(terminalText('^D\b\b\r  Building [3] 3/3\r\n'), '  Building [3] 3/3\n',
   'rác đầu dòng của script bị chính \\r xoá đi')

eq(stripAnsi('\x1b[0;32m   Finished\x1b[0m release'), '   Finished release', 'gỡ sạch mã màu')
eq(stripAnsi('\x1b]0;tiêu đề\x07xong'), 'xong', 'gỡ cả chuỗi OSC đặt tiêu đề cửa sổ')

// Tô theo mã tool phát ra, không đoán bằng regex.
eq(parseAnsi('\x1b[0;32m   Finished\x1b[0m release').map((s) => [s.text, s.color]),
   [['   Finished', '#3fb950'], [' release', '']], 'màu bật rồi tắt')
eq(parseAnsi('\x1b[1;31merror:\x1b[0m hỏng')[0], { text: 'error:', color: '#ff7b72', bold: true },
   'đậm và màu cùng lúc')
eq(parseAnsi('không màu'), [{ text: 'không màu', color: '', bold: false }], 'dòng trơn: một đoạn')
eq(parseAnsi('\x1b[38;5;208mcam\x1b[m')[0]?.color, '#ff8700', '256-màu')
eq(parseAnsi('\x1b[38;2;10;20;30mrgb\x1b[m')[0]?.color, 'rgb(10 20 30)', 'truecolor')
// Mã không hiểu được phải bị nuốt, không in ra — in ra là người đọc thấy rác.
eq(parseAnsi('\x1b[2Kxoá dòng').map((s) => s.text).join(''), 'xoá dòng',
   'mã không phải SGR bị nuốt chứ không vẽ')
eq(parseAnsi(''), [], 'dòng rỗng')

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} ok`)
if (bad) process.exit(1)
