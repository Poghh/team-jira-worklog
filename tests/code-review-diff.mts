/**
 * The "Thay đổi code" tab's diff parser: line numbers on both sides, new /
 * deleted / renamed / binary files, quoted paths.
 *
 * Run: npx tsx tests/code-review-diff.mts
 */
import { parseDiff } from '@/lib/modules/code-review/diff'

let n = 0
let bad = 0
const eq = (got: unknown, want: unknown, m: string) => {
  n++
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++
    console.log('FAIL', m, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want))
  }
}

const text = [
  'diff --git a/Sources/Login.swift b/Sources/Login.swift',
  'index 1111111..2222222 100644',
  '--- a/Sources/Login.swift',
  '+++ b/Sources/Login.swift',
  '@@ -10,4 +10,5 @@ final class Login {',
  '     let a = 1',
  '-    let b = 2',
  '+    let b = 3',
  '+    let c = 4',
  '     }',
  ' ',
  '@@ -40 +41 @@ func x() {',
  '-old',
  '+new',
  '\\ No newline at end of file',
  'diff --git a/New.swift b/New.swift',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/New.swift',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  'diff --git a/Gone.swift b/Gone.swift',
  'deleted file mode 100644',
  '--- a/Gone.swift',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/Old Name.swift b/New Name.swift',
  'similarity index 90%',
  'rename from Old Name.swift',
  'rename to New Name.swift',
  'diff --git a/logo.png b/logo.png',
  'index 4444444..5555555 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git "a/T\\303\\252n.swift" "b/T\\303\\252n.swift"',
  '--- "a/T\\303\\252n.swift"',
  '+++ "b/T\\303\\252n.swift"',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n')

const files = parseDiff(text)
eq(files.map((f) => [f.path, f.status]), [
  ['Sources/Login.swift', 'modified'],
  ['New.swift', 'added'],
  ['Gone.swift', 'deleted'],
  ['New Name.swift', 'renamed'],
  ['logo.png', 'modified'],
  ['Tên.swift', 'modified'],
], 'files and statuses')

const login = files[0]
eq([login.additions, login.deletions], [3, 2], 'counts')
eq(login.hunks.map((h) => h.section), ['final class Login {', 'func x() {'], 'hunk sections')
eq(
  login.hunks[0].lines.map((l) => [l.t, l.o, l.n]),
  [[' ', 10, 10], ['-', 11, null], ['+', null, 11], ['+', null, 12], [' ', 12, 13], [' ', 13, 14]],
  'line numbers on both sides (blank context line kept)',
)
eq(login.hunks[1].lines.map((l) => [l.t, l.o, l.n, l.s]), [['-', 40, null, 'old'], ['+', null, 41, 'new']], 'no-newline marker skipped')
eq(files[1].hunks[0].lines.map((l) => l.n), [1, 2], 'new file from line 1')
eq([files[2].path, files[2].hunks[0].lines[0].o], ['Gone.swift', 1], 'deleted file keeps its path')
eq([files[3].oldPath, files[3].hunks.length], ['Old Name.swift', 0], 'pure rename')
eq(files[4].binary, true, 'binary')

console.log(bad ? `${bad}/${n} failed` : `code-review diff: ${n} ok`)
process.exit(bad ? 1 : 0)
