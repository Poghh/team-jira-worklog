/**
 * `git diff` output as files → hunks → lines, for the "Thay đổi code" tab —
 * pure, so the parser is tested without a repository.
 */

export interface DiffLine {
  /** ' ' context, '+' added, '-' removed. */
  t: ' ' | '+' | '-'
  /** Line number on the old side; null for an added line. */
  o: number | null
  /** Line number on the new side; null for a removed line. */
  n: number | null
  s: string
}

export interface DiffHunk {
  /** The text after the second `@@` — usually the enclosing function. */
  section: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export type DiffStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface DiffFile {
  /** New path ('' never: a deleted file keeps its old path here). */
  path: string
  /** Old path when renamed, else equal to `path`. */
  oldPath: string
  status: DiffStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

/** Git quotes paths with unusual bytes as C strings ("t\303\252n.swift"). */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p
  const bytes: number[] = []
  const body = p.slice(1, p.endsWith('"') ? -1 : undefined)
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = body[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' }
      bytes.push(...new TextEncoder().encode(map[next] ?? next))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** `a/x` / `b/x` / `/dev/null` from a ---/+++ line. */
function sidePath(raw: string): string {
  const p = unquote(raw.replace(/\t.*$/, '').trim())
  if (p === '/dev/null') return ''
  return p.replace(/^[ab]\//, '')
}

/** The two paths of a `diff --git a/x b/y` line, when neither is quoted and they are equal. */
function headerPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length)
  const m = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(rest)
  if (!m) return null
  return [unquote(rest.startsWith('"') ? `"${m[1]}"` : m[1]), unquote(rest.includes(' "b/') ? `"${m[2]}"` : m[2])]
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let o = 0
  let n = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = headerPaths(line)
      file = { path: paths?.[1] ?? '', oldPath: paths?.[0] ?? '', status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (hunk) {
      const c = line[0]
      if (c === ' ' || c === '+' || c === '-') {
        if (c === '+') {
          hunk.lines.push({ t: '+', o: null, n: n++, s: line.slice(1) })
          file.additions++
        } else if (c === '-') {
          hunk.lines.push({ t: '-', o: o++, n: null, s: line.slice(1) })
          file.deletions++
        } else hunk.lines.push({ t: ' ', o: o++, n: n++, s: line.slice(1) })
        continue
      }
      // "\ No newline at end of file" belongs to the line before it.
      if (c === '\\') continue
      if (line === '') continue
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      hunk = { section: h[3], oldStart: o, newStart: n, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.oldPath = unquote(line.slice(12))
      file.status = 'renamed'
    } else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
    else if (line.startsWith('--- ')) {
      const p = sidePath(line.slice(4))
      if (p) file.oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = sidePath(line.slice(4))
      if (p) file.path = p
    }
  }
  for (const f of files) {
    if (!f.path) f.path = f.oldPath
    if (!f.oldPath) f.oldPath = f.path
  }
  return files
}

/** Rows a file shows; past this many it starts collapsed, as GitHub does with large diffs. */
export const LARGE_FILE_ROWS = 600

export const rowCount = (f: DiffFile) => f.hunks.reduce((s, h) => s + h.lines.length, 0)

const LOCK_FILES = new Set([
  'Cargo.lock',
  'Package.resolved',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Podfile.lock',
  'Gemfile.lock',
  'go.sum',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'flake.lock',
])

/** A line near the top of a file that says a tool wrote it (Sourcery, SwiftGen, protoc, uniffi…). */
const GENERATED_MARK = /DO NOT EDIT|@generated|Generated using|auto-?generated|generated by|This file was generated/i

/**
 * Why a file is machine-written — lock files, Xcode project files, code a tool
 * generated — or '' for a file someone wrote. Such files start collapsed: they
 * are rarely what a review is about and can be thousands of lines.
 */
export function generatedReason(f: DiffFile): string {
  const name = f.path.split('/').at(-1) ?? ''
  if (LOCK_FILES.has(name) || name.endsWith('.lock')) return 'lock file'
  if (name.endsWith('.pbxproj')) return 'file project Xcode'
  if (/(^|\/)__snapshots__\//i.test(f.path) || name.endsWith('.snap')) return 'snapshot test'
  if (/\.(min\.(js|css)|map)$/.test(name)) return 'file build'
  if (
    /(^|\/)(generated|__generated__)\//i.test(f.path) ||
    /generated/i.test(name) ||
    /\.(pb\.(swift|go)|g\.dart|freezed\.dart)$|_pb2\.py$/.test(name)
  ) {
    return 'code sinh tự động'
  }
  for (const h of f.hunks) {
    for (const l of h.lines) {
      const at = l.n ?? l.o ?? 99
      if (at > 5) break
      if (GENERATED_MARK.test(l.s)) return 'code sinh tự động'
    }
  }
  return ''
}
