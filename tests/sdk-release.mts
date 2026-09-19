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
  collapseCr,
  deriveSuffix,
  nextOrdinal,
  nextVersion,
  parseBumpMessage,
  recoveryPlan,
  parseReleaseTag,
  releasesForBranch,
  phaseOf,
  strandedTags,
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

// And the mechanism behind that gap: a failed run still holds its number on
// GitHub. Counting only real tags would propose .2, and `makeRelease` would
// fail creating a tag that already exists — after a forty-minute build.
eq(nextOrdinal(
     ['2026.08.20-cxpdev.1', 'pre-2026.08.20-cxpdev.2', '2026.08.20-cxpdev.3'],
     '2026.08.20', 'cxpdev'), 4,
   'a pre- tag burns its ordinal')
eq(nextOrdinal(['2026.09.17-ctalkdev.1', 'pre-2026.09.17-ctalkdev.2'], '2026.09.17', 'ctalkdev'),
   3, 'even when the failed run is the highest number')

eq(nextOrdinal(['2026.08.20-cxpdev.3'], '2026.08.21', 'cxpdev'), 1, 'a new day starts over')
eq(nextOrdinal(['v1.0.83', '2026.09.17-cxpdev.1'], '2026.09.17', 'ctalkdev'), 1,
   'other suffixes and legacy tags do not count toward this one')

eq(strandedTags(['2026.09.17-ctalkdev.1', 'pre-2026.09.17-ctalkdev.2'], '2026.09.17', 'ctalkdev'),
   ['pre-2026.09.17-ctalkdev.2'], 'stranded runs are found by date and suffix')

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
eq(stranded.version, '2026.09.17-ctalkdev.3', 'skips the burnt number')
eq(stranded.warnings.length, 1, 'and mentions the run that burnt it')

/* ── reading the build log ──────────────────────────────────────────────── */
// cargo writes progress with \r. Left alone, forty minutes of build fills the
// console with thousands of lines that only ever meant to be one.
eq(collapseCr('a\rb\rCompiling matrix-sdk\nplain'), 'Compiling matrix-sdk\nplain',
   'only what a terminal would still be showing')
eq(collapseCr('no carriage returns'), 'no carriage returns', 'untouched otherwise')
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
    'git -C /Repo/swift tag',
    ''],
   'fetch, rebase, delete the release, delete the local tag, then run again')
eq(/có người push lên main trước bạn/.test(after({ preTagged: true, unpushed: 1, remoteMoved: true }).detail),
   true, 'and it says why, when it knows why')
eq(/origin\/main đã đổi/.test(after({ remoteMoved: true }).detail), true,
   'a clean stop still warns that the remote moved under it')

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} ok`)
if (bad) process.exit(1)
