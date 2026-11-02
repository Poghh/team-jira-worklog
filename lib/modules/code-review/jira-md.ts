/**
 * A Jira ticket as Markdown, for Claude to read.
 *
 * The ADF conversion itself lives in lib/jira/markdown.ts (shared with task
 * creation); this keeps what a review needs from a requirement — tables,
 * code, links, mentions, nesting — and collects every link, so the Confluence
 * pages a ticket points at can be offered as more context.
 *
 * Pure — no server imports — so tests/code-review-jira.mts can run it.
 */

import { type AdfNode, adfToMarkdown as toMarkdown } from '@/lib/jira/markdown'

export type { AdfNode }

/**
 * A document (description, comment) as Markdown, plus every link in it.
 * Headings drop one level: the ticket sits under its own `#` title.
 */
export const adfToMarkdown = (doc: unknown) => toMarkdown(doc, { headingShift: 1 })

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
