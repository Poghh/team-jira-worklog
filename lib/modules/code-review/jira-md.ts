/**
 * Jira's Atlassian Document Format → Markdown, for Claude to read a ticket.
 *
 * Unlike lib/jira/adf.ts (six node types, for the board's detail panel) this
 * keeps what a review needs from a requirement: tables, code, links, mentions,
 * nesting — and collects every link, so the Confluence pages a ticket points
 * at can be offered as more context. Unknown nodes fall back to their text.
 *
 * Pure — no server imports — so tests/code-review-jira.mts can run it.
 */

export interface AdfNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
  content?: AdfNode[]
}

interface Ctx {
  links: string[]
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
      const body = blocks(li.content, ctx).trim()
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
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 3)) + 1)} ${inline(n.content, ctx)}`
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
        .map((l) => `> ${l}`)
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
export function adfToMarkdown(doc: unknown): { markdown: string; links: string[] } {
  const ctx: Ctx = { links: [] }
  if (typeof doc === 'string') return { markdown: doc, links: [...doc.matchAll(/https?:\/\/[^\s)\]>"']+/g)].map((m) => m[0]) }
  const root = doc as AdfNode | null
  if (!root || typeof root !== 'object') return { markdown: '', links: [] }
  return { markdown: blocks(root.content, ctx).trim(), links: ctx.links }
}

/* ── a whole ticket ─────────────────────────────────────────────────────── */

interface Named {
  key?: string
  name?: string
  displayName?: string
  fields?: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } }
}

export interface TicketJson {
  key: string
  fields: Record<string, unknown> & {
    summary?: string
    updated?: string
    status?: { name?: string }
    issuetype?: { name?: string; subtask?: boolean }
    priority?: { name?: string }
    assignee?: Named | null
    reporter?: Named | null
    parent?: Named
    labels?: string[]
    fixVersions?: Array<{ name?: string }>
    subtasks?: Named[]
    issuelinks?: Array<{ type?: { inward?: string; outward?: string }; inwardIssue?: Named; outwardIssue?: Named }>
    attachment?: Array<{ filename?: string }>
    comment?: { comments?: Array<{ author?: Named; created?: string; body?: unknown }> }
  }
  /** `expand=names`: field id → its name, for custom fields. */
  names?: Record<string, string>
}

export interface RemoteLink {
  object?: { url?: string; title?: string }
  application?: { name?: string }
}

/** Fields shown in their own sections, or not worth showing. */
const SKIP_FIELDS = new Set(['description', 'comment', 'environment', 'worklog', 'timetracking'])

const isAdf = (v: unknown): boolean => Boolean(v && typeof v === 'object' && (v as AdfNode).type === 'doc')

function remoteSection(title: string, remote: RemoteLink[] | undefined, links: string[]): string[] {
  const rows = (remote ?? []).filter((r) => r.object?.url)
  if (!rows.length) return []
  const out = [title, '']
  for (const r of rows) {
    const u = r.object!.url!
    if (!links.includes(u)) links.push(u)
    out.push(`- ${r.object?.title || u}${r.application?.name ? ` (${r.application.name})` : ''}: ${u}`)
  }
  return [...out, '']
}

const issueLine = (i: Named | undefined) =>
  i?.key ? `${i.key} — ${i.fields?.summary ?? ''}${i.fields?.status?.name ? ` [${i.fields.status.name}]` : ''}` : ''

/**
 * A ticket as Claude reads it: what it is, its description, every other
 * rich-text field (acceptance criteria, DoD… whatever the project calls
 * them), subtasks, links, the latest comments — and, for a subtask, the
 * ticket above it, which is usually where the requirement is written.
 */
export function ticketToMarkdown(input: {
  issue: TicketJson
  url: string
  remote?: RemoteLink[]
  parent?: TicketJson | null
  parentRemote?: RemoteLink[]
  maxComments?: number
}): { markdown: string; links: string[] } {
  const { issue, url } = input
  const f = issue.fields
  const links: string[] = []
  const md = (doc: unknown) => {
    const r = adfToMarkdown(doc)
    for (const l of r.links) if (!links.includes(l)) links.push(l)
    return r.markdown
  }
  const meta = [
    f.issuetype?.name && `Loại: ${f.issuetype.name}`,
    f.status?.name && `Trạng thái: ${f.status.name}`,
    f.priority?.name && `Ưu tiên: ${f.priority.name}`,
    f.assignee?.displayName && `Người làm: ${f.assignee.displayName}`,
    f.reporter?.displayName && `Người tạo: ${f.reporter.displayName}`,
    f.labels?.length && `Label: ${f.labels.join(', ')}`,
    f.fixVersions?.length && `Fix version: ${f.fixVersions.map((v) => v.name).join(', ')}`,
    f.updated && `Cập nhật: ${f.updated.slice(0, 16).replace('T', ' ')}`,
  ].filter(Boolean)

  const out: string[] = [`# ${issue.key} · ${f.summary ?? ''}`, '', `> Ticket Jira · ${meta.join(' · ')}`, `> ${url}`, '']
  if (f.parent?.key) out.push(`Ticket cha: ${issueLine(f.parent)}`, '')
  out.push('## Mô tả', '', md(f.description) || '_(không có mô tả)_', '')

  // Custom rich-text fields: acceptance criteria and the like, by their own names.
  for (const [id, v] of Object.entries(f)) {
    if (SKIP_FIELDS.has(id) || !isAdf(v)) continue
    const body = md(v)
    if (body) out.push(`## ${issue.names?.[id] ?? id}`, '', body, '')
  }

  if (f.subtasks?.length) out.push('## Subtask', '', ...f.subtasks.map((s) => `- ${issueLine(s)}`), '')
  const rel = (f.issuelinks ?? [])
    .map((l) => (l.outwardIssue ? `- ${l.type?.outward ?? 'liên quan'}: ${issueLine(l.outwardIssue)}` : l.inwardIssue ? `- ${l.type?.inward ?? 'liên quan'}: ${issueLine(l.inwardIssue)}` : ''))
    .filter(Boolean)
  if (rel.length) out.push('## Ticket liên kết', '', ...rel, '')
  out.push(...remoteSection('## Link ngoài', input.remote, links))
  if (f.attachment?.length) out.push(`Đính kèm trên ticket (không tải về): ${f.attachment.map((a) => a.filename).join(', ')}`, '')

  const comments = (f.comment?.comments ?? []).slice(-(input.maxComments ?? 15))
  if (comments.length) {
    out.push('## Comment gần nhất', '')
    for (const c of comments) {
      out.push(`**${c.author?.displayName ?? '?'}** (${(c.created ?? '').slice(0, 10)}):`, '', md(c.body), '')
    }
  }

  if (input.parent) {
    // A subtask's requirement is usually written on its parent; for a bug or a
    // story the parent (an epic) is background — kept, but short.
    const p = input.parent
    const own = Boolean(f.issuetype?.subtask)
    const desc = md(p.fields.description)
    out.push(
      `## Ticket cha ${p.key} · ${p.fields.summary ?? ''}${own ? '' : ' (bối cảnh)'}`,
      '',
      (own || desc.length <= 3000 ? desc : `${desc.slice(0, 3000)}…`) || '_(không có mô tả)_',
      '',
    )
    if (own) {
      for (const [id, v] of Object.entries(p.fields)) {
        if (SKIP_FIELDS.has(id) || !isAdf(v)) continue
        const body = md(v)
        if (body) out.push(`### ${p.names?.[id] ?? id}`, '', body, '')
      }
    }
    out.push(...remoteSection('### Link ngoài của ticket cha', input.parentRemote, links))
  }
  return { markdown: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', links }
}
