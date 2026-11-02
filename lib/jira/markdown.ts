/**
 * Markdown ↔ Atlassian Document Format, both ways.
 *
 * `markdownToAdf` is how a task's description and Definition of Done reach
 * Jira: whatever the reviewer pastes or writes — headings, **bold**, `code`,
 * fenced blocks, nested / numbered lists, tables, quotes, links — lands as the
 * matching ADF node instead of a line of literal asterisks. A plain line stays
 * a paragraph and `- x` stays a bullet, so text written before this reads the
 * same. A single line break inside a paragraph is kept as a hard break: these
 * fields are typed line by line, not wrapped.
 *
 * `adfToMarkdown` is the way back — an issue's description into the editor,
 * or a ticket for Claude to read (code-review/jira-md.ts) — so an edit keeps
 * the formatting it found. Unknown nodes fall back to their text.
 *
 * Pure — no server imports — so the board renders and tests run it as is.
 */

export interface AdfNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
  content?: AdfNode[]
}

/* ── ADF → Markdown ─────────────────────────────────────────────────────── */

interface Ctx {
  links: string[]
  /** Added to every heading level — a ticket read under its own `#` title. */
  headingShift: number
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function addLink(ctx: Ctx, url: string) {
  if (/^https?:\/\//.test(url) && !ctx.links.includes(url)) ctx.links.push(url)
}

function inline(nodes: AdfNode[] | undefined, ctx: Ctx): string {
  return (nodes ?? []).map((n) => inlineNode(n, ctx)).join('')
}

function inlineNode(n: AdfNode, ctx: Ctx): string {
  switch (n.type) {
    case 'text': {
      let t = n.text ?? ''
      let href = ''
      for (const m of n.marks ?? []) {
        if (m.type === 'code') t = '`' + t + '`'
        else if (m.type === 'strong') t = `**${t}**`
        else if (m.type === 'em') t = `_${t}_`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'link') href = str(m.attrs?.href)
      }
      if (href) {
        addLink(ctx, href)
        return t === href ? href : `[${t}](${href})`
      }
      return t
    }
    case 'hardBreak':
      return '\n'
    case 'mention':
      return str(n.attrs?.text) || '@người dùng'
    case 'emoji':
      return str(n.attrs?.text) || str(n.attrs?.shortName)
    case 'date': {
      const ts = Number(n.attrs?.timestamp)
      return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : ''
    }
    case 'status':
      return `[${str(n.attrs?.text)}]`
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = str(n.attrs?.url)
      addLink(ctx, url)
      return url
    }
    case 'media':
    case 'mediaInline':
      return `[đính kèm${str(n.attrs?.alt) ? `: ${str(n.attrs?.alt)}` : ''}]`
    default:
      return n.text ?? inline(n.content, ctx)
  }
}

const indent = (s: string, pad: string) =>
  s
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n')

function list(n: AdfNode, ctx: Ctx, ordered: boolean): string {
  const start = Number(n.attrs?.order) || 1
  return (n.content ?? [])
    .map((li, i) => {
      const mark = ordered ? `${start + i}.` : '-'
      // Tight: a list item's paragraph and its sub-list on consecutive lines.
      const body = (li.content ?? [])
        .map((c) => block(c, ctx))
        .filter((s) => s.trim())
        .join('\n')
        .trim()
      return `${mark} ${indent(body, ' '.repeat(mark.length + 1))}`
    })
    .join('\n')
}

function cell(n: AdfNode, ctx: Ctx): string {
  return blocks(n.content, ctx).trim().replace(/\n+/g, ' <br> ').replace(/\|/g, '\\|')
}

function table(n: AdfNode, ctx: Ctx): string {
  const rows = (n.content ?? []).filter((r) => r.type === 'tableRow').map((r) => (r.content ?? []).map((c) => cell(c, ctx)))
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
}

function block(n: AdfNode, ctx: Ctx): string {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content, ctx)
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, (Number(n.attrs?.level) || 3) + ctx.headingShift)))} ${inline(n.content, ctx)}`
    case 'bulletList':
      return list(n, ctx, false)
    case 'orderedList':
      return list(n, ctx, true)
    case 'taskList':
      return (n.content ?? [])
        .map((t) => `- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(t.content, ctx)}`)
        .join('\n')
    case 'codeBlock':
      return '```' + str(n.attrs?.language) + '\n' + (n.content ?? []).map((t) => t.text ?? '').join('') + '\n```'
    case 'blockquote':
      return blocks(n.content, ctx)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n')
    case 'panel': {
      const kind = str(n.attrs?.panelType)
      return blocks(n.content, ctx)
        .split('\n')
        .map((l, i) => (i === 0 && kind ? `> **[${kind}]** ${l}` : `> ${l}`))
        .join('\n')
    }
    case 'expand':
    case 'nestedExpand':
      return `**${str(n.attrs?.title) || 'Mở rộng'}**\n\n${blocks(n.content, ctx)}`
    case 'rule':
      return '---'
    case 'table':
      return table(n, ctx)
    case 'mediaSingle':
    case 'mediaGroup':
      return inline(n.content, ctx)
    case 'blockCard':
    case 'embedCard':
      return inlineNode(n, ctx)
    default:
      return n.content ? blocks(n.content, ctx) : inlineNode(n, ctx)
  }
}

function blocks(nodes: AdfNode[] | undefined, ctx: Ctx): string {
  return (nodes ?? [])
    .map((n) => block(n, ctx))
    .filter((s) => s.trim())
    .join('\n\n')
}

/** A document (description, comment) as Markdown, plus every link in it. */
export function adfToMarkdown(doc: unknown, opts: { headingShift?: number } = {}): { markdown: string; links: string[] } {
  const ctx: Ctx = { links: [], headingShift: opts.headingShift ?? 0 }
  if (typeof doc === 'string') return { markdown: doc, links: [...doc.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0]) }
  const root = doc as AdfNode | null
  if (!root || typeof root !== 'object') return { markdown: '', links: [] }
  return { markdown: blocks(root.content, ctx).trim(), links: ctx.links }
}

/** ADF top-level nodes as Markdown — for slicing a document (the DoD split). */
export function nodesToMarkdown(nodes: AdfNode[]): string {
  return blocks(nodes, { links: [], headingShift: 0 }).trim()
}

/* ── Markdown → ADF ─────────────────────────────────────────────────────── */

type Mark = NonNullable<AdfNode['marks']>[number]

const textNode = (text: string, marks: Mark[]): AdfNode => (marks.length ? { type: 'text', text, marks: [...marks] } : { type: 'text', text })

/**
 * Inline Markdown → text nodes with marks. One regex, leftmost match wins and
 * the alternation order breaks ties: code first (nothing nests inside it),
 * then links, then the emphasis marks.
 */
const INLINE =
  /(`+)([\s\S]+?)\1|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|(?<!\\)\*\*(?=\S)([\s\S]+?)(?<!\\)\*\*|(?<![\w\\])__(?=\S)([\s\S]+?)__(?!\w)|(?<!\\)~~(?=\S)([\s\S]+?)~~|(?<![\w\\*])\*(?=[^\s*])([\s\S]+?)(?<![\s\\])\*(?![\w*])|(?<![\w\\])_(?=[^\s_])([\s\S]+?)_(?!\w)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/

function parseInline(src: string, marks: Mark[] = []): AdfNode[] {
  const out: AdfNode[] = []
  let rest = src
  const plain = (s: string) => {
    // Backslash escapes: \* → *, as Markdown renders them.
    const t = s.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
    if (t) out.push(textNode(t, marks))
  }
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      plain(rest)
      break
    }
    plain(rest.slice(0, m.index))
    const has = (type: string) => marks.some((x) => x.type === type)
    if (m[2] !== undefined) {
      const code = m[2].length > 2 && m[2].startsWith(' ') && m[2].endsWith(' ') ? m[2].slice(1, -1) : m[2]
      // ADF lets `code` share a node only with a link.
      out.push(textNode(code, [...marks.filter((x) => x.type === 'link'), { type: 'code' }]))
    } else if (m[3] !== undefined) {
      out.push(...parseInline(m[3], [...marks.filter((x) => x.type !== 'link'), { type: 'link', attrs: { href: m[4] } }]))
    } else if (m[5] !== undefined) {
      out.push(textNode(m[5], [...marks, { type: 'link', attrs: { href: m[5] } }]))
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(...parseInline(m[6] ?? m[7], has('strong') ? marks : [...marks, { type: 'strong' }]))
    } else if (m[8] !== undefined) {
      out.push(...parseInline(m[8], has('strike') ? marks : [...marks, { type: 'strike' }]))
    } else if (m[9] !== undefined || m[10] !== undefined) {
      out.push(...parseInline(m[9] ?? m[10], has('em') ? marks : [...marks, { type: 'em' }]))
    } else if (m[11] !== undefined) {
      out.push(textNode(m[11], has('link') ? marks : [...marks, { type: 'link', attrs: { href: m[11] } }]))
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

/** A paragraph's lines: one hard break between each, as typed. */
function inlineLines(lines: string[]): AdfNode[] {
  const out: AdfNode[] = []
  lines.forEach((l, i) => {
    if (i > 0) out.push({ type: 'hardBreak' })
    // Markdown's own hard break markers — two trailing spaces or a backslash.
    out.push(...parseInline(l.replace(/(\s{2,}|\\)$/, '').trim()))
  })
  return out
}

const para = (content: AdfNode[]): AdfNode => ({ type: 'paragraph', content })

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?/
const ITEM = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

const isTableRow = (l: string) => l.includes('|')
function cells(l: string): string[] {
  let s = l.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

const startsBlock = (line: string, next: string | undefined) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  ITEM.test(line) ||
  (isTableRow(line) && next !== undefined && TABLE_SEP.test(next) && next.includes('-'))

const width = (s: string) => s.replace(/\t/g, '    ').length

function parseBlocks(lines: string[]): AdfNode[] {
  const out: AdfNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i++
      const text = body.join('\n')
      out.push({ type: 'codeBlock', attrs: fence[2] ? { language: fence[2].toLowerCase() } : {}, content: text ? [{ type: 'text', text }] : [] })
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      out.push({ type: 'heading', attrs: { level: h[1].length }, content: parseInline(h[2] ?? '') })
      i++
      continue
    }

    if (RULE.test(line)) {
      out.push({ type: 'rule' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''))
      out.push({ type: 'blockquote', content: parseBlocks(body).map(quoteSafe) })
      continue
    }

    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      const n = Math.max(head.length, ...rows.map((r) => r.length))
      const row = (r: string[], type: 'tableHeader' | 'tableCell'): AdfNode => ({
        type: 'tableRow',
        content: Array.from({ length: n }, (_, k) => ({
          type,
          attrs: {},
          // A cell's "<br>" is how a table writes a line break in Markdown.
          content: [para(inlineLines((r[k] ?? '').split(/\s*<br\s*\/?>\s*/i)))],
        })),
      })
      out.push({
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [row(head, 'tableHeader'), ...rows.map((r) => row(r, 'tableCell'))],
      })
      continue
    }

    const item = ITEM.exec(line)
    if (item) {
      const r = parseList(lines, i)
      out.push(r.node)
      i = r.next
      continue
    }

    const body: string[] = []
    while (i < lines.length && lines[i].trim() && (body.length === 0 || !startsBlock(lines[i], lines[i + 1]))) body.push(lines[i++])
    out.push(para(inlineLines(body)))
  }
  return out
}

/** One list from line `start`: items at its indent, deeper lines go to the item above. */
function parseList(lines: string[], start: number): { node: AdfNode; next: number } {
  const first = ITEM.exec(lines[start])!
  const base = width(first[1])
  const ordered = /\d/.test(first[2])
  const items: AdfNode[] = []
  let i = start
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || width(m[1]) !== base || /\d/.test(m[2]) !== ordered) break
    const pad = width(m[1]) + m[2].length + 1
    const body = [m[3]]
    i++
    // The item runs on while lines are indented past its marker, or are a
    // lazy continuation of its first paragraph; one blank line is allowed
    // when what follows is still indented.
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        const after = lines[i + 1]
        if (after !== undefined && after.trim() && width(after.match(/^\s*/)![0]) > base) {
          body.push('')
          i++
          continue
        }
        break
      }
      const lead = width(l.match(/^\s*/)![0])
      if (lead > base) {
        body.push(l.replace(/^\s+/, (s) => ' '.repeat(Math.max(0, width(s) - pad))))
        i++
        continue
      }
      if (ITEM.test(l) || startsBlock(l, lines[i + 1])) break
      body.push(l)
      i++
    }
    items.push(listItem(body))
  }
  const node: AdfNode = ordered
    ? { type: 'orderedList', attrs: { order: Number(first[2].replace(/\D/g, '')) || 1 }, content: items }
    : { type: 'bulletList', content: items }
  return { node, next: i }
}

function listItem(body: string[]): AdfNode {
  // "- [ ] x" / "- [x] x": a checkbox in the text — Jira's taskList is not
  // accepted everywhere a description goes, a ballot box always is.
  body[0] = body[0].replace(/^\[([ xX])\]\s+/, (_, c) => (c === ' ' ? '☐ ' : '☑ '))
  const content = parseBlocks(body).map(itemSafe)
  if (!content.length || content[0].type !== 'paragraph' && content[0].type !== 'codeBlock') content.unshift(para([]))
  return { type: 'listItem', content }
}

/** What a list item may hold in ADF: paragraphs, lists, code. Anything else becomes a paragraph. */
function itemSafe(n: AdfNode): AdfNode {
  if (['paragraph', 'bulletList', 'orderedList', 'codeBlock'].includes(n.type ?? '')) return n
  return flatten(n)
}

/** What a quote may hold: no headings, tables or rules. */
function quoteSafe(n: AdfNode): AdfNode {
  if (['paragraph', 'bulletList', 'orderedList', 'codeBlock'].includes(n.type ?? '')) return n
  return flatten(n)
}

/** A block that cannot sit here, kept as a paragraph of its text — a heading stays bold. */
function flatten(n: AdfNode): AdfNode {
  if (n.type === 'heading') return para((n.content ?? []).map((t) => (t.type === 'text' ? { ...t, marks: [...(t.marks ?? []).filter((m) => m.type !== 'strong'), { type: 'strong' }] } : t)))
  if (n.type === 'rule') return para([{ type: 'text', text: '———' }])
  const md = nodesToMarkdown([n])
  return para(md ? inlineLines(md.split('\n')) : [])
}

/** Markdown → the top-level content of an ADF document. */
export function markdownToAdf(markdown: string): AdfNode[] {
  return parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'))
}

/* ── description + Definition of Done in one paste ──────────────────────── */

/**
 * A heading line that opens the Definition of Done: `## Definition of Done`,
 * `**DoD**`, `DoD:` on its own line. Shared by the split below and the board's
 * reading of saved descriptions, so both agree on where the DoD starts.
 */
const DOD_LINE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:definition of done|dod)\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i

export const isDodTitle = (text: string) => DOD_LINE.test(text.trim())

/**
 * A whole task in Markdown → the two boxes: everything before a DoD heading,
 * and everything after it. Null when there is no such heading — the caller
 * then keeps the text where it was pasted. Fenced code is skipped, so a
 * "DoD:" inside a code sample does not cut the task.
 */
export function splitMarkdownDod(markdown: string): { description: string; dod: string } | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let fence = ''
  for (const [i, l] of lines.entries()) {
    const f = FENCE.exec(l)
    if (f && (!fence || l.trim().startsWith(fence))) fence = fence ? '' : f[1]
    else if (!fence && DOD_LINE.test(l)) {
      return { description: lines.slice(0, i).join('\n').trim(), dod: lines.slice(i + 1).join('\n').trim() }
    }
  }
  return null
}
