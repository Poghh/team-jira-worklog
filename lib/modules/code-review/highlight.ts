/**
 * Syntax colours for the "Thay đổi code" tab. highlight.js core with only the
 * languages these repos use, so the page does not carry a hundred grammars.
 *
 * A diff is highlighted side by side, hunk by hunk: the old side (context +
 * removed lines) and the new side (context + added lines) are each coloured
 * as one block, then cut back into lines — so a block comment or a multi-line
 * string keeps its colour across the lines it spans. A hunk that starts inside
 * such a construct can still be off; GitHub has the same limit.
 */

import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import dart from 'highlight.js/lib/languages/dart'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import objectivec from 'highlight.js/lib/languages/objectivec'
import protobuf from 'highlight.js/lib/languages/protobuf'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

import type { DiffFile } from './diff'

const LANGS = { bash, cpp, css, dart, go, ini, java, javascript, json, kotlin, markdown, objectivec, protobuf, python, ruby, rust, sql, swift, typescript, xml, yaml }
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang)

const BY_EXT: Record<string, keyof typeof LANGS> = {
  swift: 'swift',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  m: 'objectivec',
  mm: 'objectivec',
  h: 'objectivec',
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  resolved: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  lock: 'ini',
  ini: 'ini',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  rb: 'ruby',
  py: 'python',
  go: 'go',
  java: 'java',
  dart: 'dart',
  proto: 'protobuf',
  sql: 'sql',
  xml: 'xml',
  plist: 'xml',
  storyboard: 'xml',
  xib: 'xml',
  html: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'css',
}

const BY_NAME: Record<string, keyof typeof LANGS> = {
  Podfile: 'ruby',
  Gemfile: 'ruby',
  Fastfile: 'ruby',
  Appfile: 'ruby',
  Matchfile: 'ruby',
  Dangerfile: 'ruby',
  Brewfile: 'ruby',
}

/** The grammar for a path, or '' to leave it plain. */
export function languageOf(path: string): string {
  const name = path.split('/').at(-1) ?? ''
  if (BY_NAME[name]) return BY_NAME[name]
  const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
  return BY_EXT[ext] ?? ''
}

/**
 * Cuts highlight.js HTML into lines. A span left open at a line break is
 * closed there and reopened on the next line, so every line is valid HTML.
 * highlight.js escapes the code, so the only tags are its own spans.
 */
export function splitLines(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let cur = ''
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g)) {
    if (m[1]) {
      open.push(m[1])
      cur += m[1]
    } else if (m[2]) {
      open.pop()
      cur += m[2]
    } else if (m[3]) {
      out.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
    } else cur += m[4]
  }
  out.push(cur)
  return out
}

/** Past these, a file stays plain: highlighting it would cost more than it helps. */
const MAX_ROWS = 5000
const MAX_LINE = 1000

/**
 * HTML for every line of a file's diff, in the order of its hunks' lines, or
 * null when the file is left plain (unknown language, huge, minified).
 */
export function highlightDiff(file: DiffFile): string[] | null {
  const language = languageOf(file.path)
  if (!language || file.binary) return null
  const rows = file.hunks.reduce((s, h) => s + h.lines.length, 0)
  if (!rows || rows > MAX_ROWS || file.hunks.some((h) => h.lines.some((l) => l.s.length > MAX_LINE))) return null
  const paint = (lines: string[]) => {
    try {
      return splitLines(hljs.highlight(lines.join('\n'), { language, ignoreIllegals: true }).value)
    } catch {
      return null
    }
  }
  const out: string[] = []
  for (const h of file.hunks) {
    const oldSide = paint(h.lines.filter((l) => l.t !== '+').map((l) => l.s))
    const newSide = paint(h.lines.filter((l) => l.t !== '-').map((l) => l.s))
    if (!oldSide || !newSide) return null
    let o = 0
    let n = 0
    for (const l of h.lines) {
      if (l.t === '-') out.push(oldSide[o++])
      else if (l.t === '+') out.push(newSide[n++])
      else {
        out.push(newSide[n++])
        o++
      }
    }
  }
  return out
}
