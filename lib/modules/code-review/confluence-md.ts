/**
 * Confluence's storage format (XHTML with `ac:` / `ri:` macros) to Markdown
 * Claude can read, and back the other way for the comments the module posts.
 *
 * Pure and free of server imports so tests/code-review-confluence.mts can run
 * it. Tolerant rather than strict: a page with markup this does not know still
 * comes out as its text.
 */

interface El {
  name: string
  attrs: Record<string, string>
  kids: Node[]
}
type Node = El | string

const VOID = new Set(['br', 'hr', 'img', 'col', 'ri:attachment', 'ri:page', 'ri:user', 'ri:url', 'ri:space', 'ac:parameter-void'])

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', rarr: '→', larr: '←', copy: '©', reg: '®', trade: '™',
}

const ACCENTS: Record<string, string> = {
  acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', ring: '\u030A', cedil: '\u0327',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    if (ENTITIES[e]) return ENTITIES[e]
    // Latin letters with a diacritic — &aacute; &ecirc; &Ocirc; — which
    // Confluence uses all over Vietnamese text.
    const acc = e.match(/^([a-zA-Z])(acute|grave|circ|tilde|uml|ring|cedil)$/)
    if (acc) return (acc[1] + ACCENTS[acc[2]]).normalize('NFC')
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

function parse(xml: string): El {
  const root: El = { name: '#root', attrs: {}, kids: [] }
  const stack: El[] = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+|<)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.kids.push({ name: '#cdata', attrs: {}, kids: [m[1]] })
    else if (m[2]) {
      const name = m[2].toLowerCase()
      const at = stack.map((e) => e.name).lastIndexOf(name)
      if (at > 0) stack.length = at
    } else if (m[3]) {
      const name = m[3].toLowerCase()
      const attrs: Record<string, string> = {}
      for (const a of m[4].matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? '')
      const el: El = { name, attrs, kids: [] }
      top.kids.push(el)
      if (!m[5] && !VOID.has(name)) stack.push(el)
    } else if (m[6]) top.kids.push(decodeEntities(m[6]))
  }
  return root
}

const isEl = (n: Node): n is El => typeof n !== 'string'
const child = (e: El, name: string) => e.kids.find((k): k is El => isEl(k) && k.name === name)
const param = (e: El, name: string) => {
  const p = e.kids.find((k): k is El => isEl(k) && k.name === 'ac:parameter' && k.attrs['ac:name'] === name)
  return p ? textOf(p).trim() : ''
}

function textOf(n: Node): string {
  if (!isEl(n)) return n
  return n.kids.map(textOf).join('')
}

export interface MdOptions {
  /** Where an attached image is saved next to the Markdown, or '' when it was not saved. */
  image?: (filename: string) => string
}

interface Ctx {
  opts: MdOptions
  images: Set<string>
  /** List nesting: '-' or a number per level. */
  list: Array<{ ordered: boolean; n: number }>
}

const collapse = (s: string) => s.replace(/[ \t\r\n]+/g, ' ')

/** Inline content of an element, on one line. */
function inline(e: El, c: Ctx): string {
  return e.kids
    .map((k) => {
      if (!isEl(k)) return collapse(k)
      return render(k, c, true)
    })
    .join('')
}

/** Block content: paragraphs separated by blank lines. */
function blocks(e: El, c: Ctx): string {
  const out: string[] = []
  let line = ''
  const flush = () => {
    if (line.trim()) out.push(line.trim())
    line = ''
  }
  for (const k of e.kids) {
    if (!isEl(k)) {
      line += collapse(k)
      continue
    }
    if (BLOCK.has(k.name) || (k.name === 'ac:structured-macro' && !INLINE_MACROS.has(k.attrs['ac:name'] ?? ''))) {
      flush()
      const b = render(k, c, false)
      if (b.trim()) out.push(b.replace(/^\n+|\s+$/g, ''))
    } else line += render(k, c, true)
  }
  flush()
  return out.join('\n\n')
}

const BLOCK = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'pre', 'blockquote', 'hr',
  'ac:task-list', 'ac:layout', 'ac:layout-section', 'ac:layout-cell', 'ac:adf-extension', 'ac:rich-text-body', 'section',
])
const INLINE_MACROS = new Set(['status', 'jira', 'anchor', 'children-display-inline'])

function table(e: El, c: Ctx): string {
  const rows: El[] = []
  const walk = (n: El) => {
    for (const k of n.kids) {
      if (!isEl(k)) continue
      if (k.name === 'tr') rows.push(k)
      else if (k.name !== 'table') walk(k)
    }
  }
  walk(e)
  if (!rows.length) return ''
  const cells = rows.map((r) =>
    r.kids
      .filter((k): k is El => isEl(k) && (k.name === 'td' || k.name === 'th'))
      .map((td) => blocks(td, c).replace(/\n+/g, ' <br> ').replace(/\|/g, '\\|').trim()),
  )
  const width = Math.max(...cells.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
  const [head, ...body] = cells
  return [`| ${pad(head).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n')
}

function list(e: El, c: Ctx): string {
  const ordered = e.name === 'ol'
  c.list.push({ ordered, n: 0 })
  const depth = c.list.length - 1
  const lines: string[] = []
  for (const li of e.kids) {
    if (!isEl(li) || li.name !== 'li') continue
    const lvl = c.list[depth]
    lvl.n++
    const bullet = ordered ? `${lvl.n}.` : '-'
    const body = blocks(li, c)
    const [first, ...rest] = body.split('\n')
    const ind = '  '.repeat(depth)
    lines.push(`${ind}${bullet} ${first ?? ''}`)
    for (const r of rest) if (r.trim()) lines.push(r.startsWith('  ') || /^\s*([-*]|\d+\.) /.test(r) ? r : `${ind}  ${r}`)
  }
  c.list.pop()
  return lines.join('\n')
}

function imageOf(e: El, c: Ctx): string {
  const att = child(e, 'ri:attachment')
  const url = child(e, 'ri:url')
  const alt = e.attrs['ac:alt'] || e.attrs['ac:title'] || ''
  if (att) {
    const file = att.attrs['ri:filename'] ?? ''
    c.images.add(file)
    const saved = c.opts.image?.(file) ?? ''
    return saved ? `![${alt || file}](${saved})` : `[Hình: ${file}]`
  }
  if (url) return `![${alt}](${url.attrs['ri:value'] ?? ''})`
  return '[Hình]'
}

function macro(e: El, c: Ctx, asInline: boolean): string {
  const name = e.attrs['ac:name'] ?? ''
  const body = child(e, 'ac:rich-text-body')
  const plain = child(e, 'ac:plain-text-body')
  switch (name) {
    case 'code':
    case 'noformat': {
      const lang = param(e, 'language')
      const title = param(e, 'title')
      return `${title ? `**${title}**\n` : ''}\`\`\`${lang}\n${plain ? textOf(plain).replace(/\n+$/, '') : ''}\n\`\`\``
    }
    case 'info':
    case 'note':
    case 'warning':
    case 'tip':
    case 'panel': {
      const title = param(e, 'title')
      const inner = body ? blocks(body, c) : ''
      const label = { info: 'Info', note: 'Note', warning: 'Warning', tip: 'Tip', panel: 'Panel' }[name]
      return `> **${label}${title ? `: ${title}` : ''}**\n${inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')}`
    }
    case 'expand': {
      const title = param(e, 'title')
      return `**${title || 'Mở rộng'}**\n\n${body ? blocks(body, c) : ''}`
    }
    case 'status':
      return `[${param(e, 'title') || 'STATUS'}]`
    case 'jira':
      return `[Jira ${param(e, 'key') || param(e, 'jqlQuery') || ''}]`.replace(' ]', ']')
    case 'drawio':
    case 'inc-drawio':
    case 'gliffy': {
      const diagram = param(e, 'diagramName') || param(e, 'name')
      const png = diagram ? c.opts.image?.(`${diagram}.png`) ?? '' : ''
      if (png) {
        c.images.add(`${diagram}.png`)
        return `![Sơ đồ ${diagram}](${png})`
      }
      return `[Sơ đồ ${name}${diagram ? ` "${diagram}"` : ''} — không đọc được nội dung, hỏi tác giả nếu cần]`
    }
    case 'toc':
    case 'children':
    case 'pagetree':
    case 'recently-updated':
    case 'contentbylabel':
      return ''
    case 'anchor':
      return ''
    default: {
      if (body) return asInline ? inline(body, c) : blocks(body, c)
      if (plain) return '```\n' + textOf(plain) + '\n```'
      return `[macro ${name}]`
    }
  }
}

function render(e: El, c: Ctx, asInline: boolean): string {
  const n = e.name
  if (n === '#cdata') return textOf(e)
  if (/^h[1-6]$/.test(n)) return `${'#'.repeat(Number(n[1]))} ${inline(e, c).trim()}`
  switch (n) {
    case 'p':
    case 'div':
    case 'section':
    case 'ac:layout':
    case 'ac:layout-section':
    case 'ac:layout-cell':
    case 'ac:rich-text-body':
    case 'td':
    case 'th':
    case 'li':
      return asInline ? inline(e, c) : blocks(e, c)
    case 'br':
      return '\n'
    case 'hr':
      return '---'
    case 'strong':
    case 'b': {
      const t = inline(e, c)
      return t.trim() ? `**${t.trim()}**` : t
    }
    case 'em':
    case 'i': {
      const t = inline(e, c)
      return t.trim() ? `*${t.trim()}*` : t
    }
    case 's':
    case 'del':
      return `~~${inline(e, c)}~~`
    case 'u':
    case 'span':
    case 'sup':
    case 'sub':
    case 'small':
    case 'font':
      return inline(e, c)
    case 'code':
      return '`' + textOf(e) + '`'
    case 'pre':
      return '```\n' + textOf(e).replace(/\n+$/, '') + '\n```'
    case 'blockquote':
      return blocks(e, c)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'a': {
      const t = inline(e, c).trim()
      const href = e.attrs.href ?? ''
      return href && href !== t ? `[${t || href}](${href})` : t
    }
    case 'ul':
    case 'ol':
      return list(e, c)
    case 'table':
      return table(e, c)
    case 'ac:image':
      return imageOf(e, c)
    case 'ac:link': {
      const body = child(e, 'ac:link-body') ?? child(e, 'ac:plain-text-link-body')
      const page = child(e, 'ri:page')
      const user = child(e, 'ri:user')
      const att = child(e, 'ri:attachment')
      const label = body ? textOf(body).trim() : ''
      if (user) return label || '@user'
      if (page) return `[${label || page.attrs['ri:content-title'] || 'trang'}]`
      if (att) return `[${label || att.attrs['ri:filename']}]`
      return label
    }
    case 'ac:emoticon':
      return e.attrs['ac:emoji-fallback'] ?? ''
    case 'ac:task-list':
      return e.kids
        .filter((k): k is El => isEl(k) && k.name === 'ac:task')
        .map((t) => {
          const done = textOf(child(t, 'ac:task-status') ?? { name: '', attrs: {}, kids: [] }).trim() === 'complete'
          const body = child(t, 'ac:task-body')
          return `- [${done ? 'x' : ' '}] ${body ? inline(body, c).trim() : ''}`
        })
        .join('\n')
    case 'ac:structured-macro':
      return macro(e, c, asInline)
    case 'ac:adf-extension':
    case 'ac:placeholder':
    case 'ac:parameter':
    case 'time':
      return n === 'time' ? e.attrs.datetime ?? '' : ''
    default:
      return asInline ? inline(e, c) : blocks(e, c)
  }
}

/** The page as Markdown, plus the attachment names its images refer to. */
export function storageToMarkdown(xhtml: string, opts: MdOptions = {}): { markdown: string; images: string[] } {
  const c: Ctx = { opts, images: new Set(), list: [] }
  const md = blocks(parse(xhtml), c)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { markdown: md, images: [...c.images].filter(Boolean) }
}

/** Attachment file names the page's images point at — before anything is downloaded. */
export function referencedImages(xhtml: string): string[] {
  return storageToMarkdown(xhtml).images
}

/* ── inline comment anchoring ───────────────────────────────────────────── */

/**
 * The page's visible text, the way Confluence counts matches for an inline
 * comment's `textSelection`: text nodes only, macros' code included.
 */
export function storageToText(xhtml: string): string {
  const out: string[] = []
  const walk = (n: Node) => {
    if (!isEl(n)) return void out.push(n)
    if (n.name === 'ac:parameter' || n.name === 'ac:adf-attribute') return
    for (const k of n.kids) walk(k)
  }
  walk(parse(xhtml))
  return out.join('')
}

/**
 * Where a quote sits in the page text: the exact substring to select and how
 * many times it occurs (Confluence wants both), or null if it is not there.
 * Markdown punctuation Claude may have kept from the .md copy is ignored, and
 * so are differences in whitespace.
 */
export function locateQuote(pageText: string, quote: string): { selection: string; count: number; index: number } | null {
  const clean = quote.replace(/[*_`]+/g, '').replace(/^[#>\-\s]+/, '').trim()
  if (clean.length < 2) return null
  const esc = clean
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  const re = new RegExp(esc, 'g')
  const hits = [...pageText.matchAll(re)]
  if (!hits.length) return null
  const selection = hits[0][0]
  // Confluence counts occurrences of the selected text itself.
  let count = 0
  for (let i = pageText.indexOf(selection); i >= 0; i = pageText.indexOf(selection, i + 1)) count++
  return { selection, count: Math.max(count, 1), index: 0 }
}

/* ── comments: Markdown → storage ───────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inlineMd(s: string): string {
  // Code spans first, so nothing inside them is touched.
  const parts = s.split(/(`[^`]+`)/g)
  return parts
    .map((p) => {
      if (/^`[^`]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`
      return esc(p)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    })
    .join('')
}

/** A finding's comment — paragraphs, lists, quotes, code blocks — as storage XHTML. */
export function markdownToStorage(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    const fence = l.match(/^```\s*([\w+-]*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      const lang = fence[1] ? `<ac:parameter ac:name="language">${esc(fence[1])}</ac:parameter>` : ''
      out.push(`<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${body.join('\n').replace(/]]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`)
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote><p>${q.map(inlineMd).join('<br />')}</p></blockquote>`)
      continue
    }
    if (!l.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^>\s?/.test(lines[i])) {
      para.push(lines[i++].replace(/^#+\s+/, ''))
    }
    out.push(`<p>${para.map(inlineMd).join('<br />')}</p>`)
  }
  return out.join('')
}

/* ── links ──────────────────────────────────────────────────────────────── */

/**
 * The page id a pasted link points at, or null. Only links on `host` (the
 * Atlassian site the token belongs to) count — the token is never sent
 * anywhere else. Short links (`/wiki/x/…`) carry the id base64-encoded.
 */
export function parsePageUrl(raw: string, host: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.host.toLowerCase() !== host.toLowerCase()) return null
  const p = u.pathname
  const byPath = p.match(/\/pages\/(?:edit-v2\/|edit\/)?(\d+)(?:\/|$)/)
  if (byPath) return byPath[1]
  const byQuery = u.searchParams.get('pageId')
  if (byQuery && /^\d+$/.test(byQuery)) return byQuery
  const tiny = p.match(/\/wiki\/x\/([\w-]+)/)
  if (tiny) {
    const b64 = tiny[1].replace(/-/g, '/').replace(/_/g, '+')
    const bytes = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64')
    // Little-endian; page ids fit well inside a double's 53 bits.
    let id = 0
    for (let i = bytes.length - 1; i >= 0; i--) id = id * 256 + bytes[i]
    return id > 0 && Number.isSafeInteger(id) ? String(id) : null
  }
  return null
}
