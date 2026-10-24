import 'server-only'

import fs from 'node:fs/promises'
import path from 'node:path'

import { JiraError, jiraFetch, readCreds } from '@/lib/jira/client'

import { parsePageUrl } from './confluence-md'
import { assertJiraRequest } from './guard'
import { type RemoteLink, type TicketJson, ticketToMarkdown } from './jira-md'
import type { DocFile } from './model'
import { DOCS_DIR } from './uploads'

/**
 * Jira tickets as requirements for a PR review — read only.
 *
 * Same Atlassian account as everywhere else in the app, but every request goes
 * through `assertJiraRequest` (guard.ts): GET one issue, GET its remote links.
 * A review never edits, moves, comments on or logs work against a ticket.
 *
 * Each round fetches the tickets afresh and saves them as Markdown under
 * data/code-review/docs/<item>/<stamp>-jira/, next to the round's other docs.
 */

async function get<T>(pathname: string): Promise<T> {
  const c = readCreds()
  if (!c) throw new JiraError('Chưa cấu hình Jira (Cài đặt → Jira: URL, email, API token).', 0, pathname)
  const url = new URL(pathname, c.baseUrl)
  // Checked after URL normalisation, so "../" cannot walk out of the allowlist.
  if (url.origin !== new URL(c.baseUrl).origin) throw new JiraError('Chặn: không phải site Jira đã cấu hình.', 0, pathname)
  assertJiraRequest('GET', url.pathname)
  return jiraFetch<T>(url.pathname + url.search, { fresh: true })
}

const browseUrl = (key: string) => `${readCreds()?.baseUrl ?? ''}/browse/${key}`

async function readTicket(key: string): Promise<TicketJson> {
  return get<TicketJson>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all&expand=names`)
}

export interface LinkedPage {
  url: string
  /** As the ticket's link names it; '' when only the URL is known. */
  title: string
}

/** The Confluence pages among a ticket's links, on this Atlassian site — one per page. */
function confluenceLinks(links: string[], remote: RemoteLink[]): LinkedPage[] {
  const c = readCreds()
  if (!c) return []
  const host = new URL(c.baseUrl).host
  const out: LinkedPage[] = []
  const ids = new Set<string>()
  for (const l of links) {
    const id = parsePageUrl(l, host)
    if (id && !ids.has(id)) {
      ids.add(id)
      const title = remote.find((r) => r.object?.url === l)?.object?.title ?? ''
      out.push({ url: l, title: title === 'Wiki Page' ? '' : title })
    }
  }
  return out
}

const remoteLinks = (key: string) => get<RemoteLink[]>(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`).catch(() => [] as RemoteLink[])

interface Rendered {
  key: string
  summary: string
  status: string
  type: string
  url: string
  updated: string
  markdown: string
  pages: LinkedPage[]
}

async function render(key: string): Promise<Rendered> {
  const issue = await readTicket(key)
  const remote = await remoteLinks(issue.key)
  // A subtask's requirement usually lives on the story above it; a bug's
  // epic is where the TDD pages tend to be linked.
  const parentKey = issue.fields.parent?.key
  const parent = parentKey ? await readTicket(parentKey).catch(() => null) : null
  const parentRemote = parent ? await remoteLinks(parent.key) : []
  const url = browseUrl(issue.key)
  const { markdown, links } = ticketToMarkdown({ issue, url, remote, parent, parentRemote })
  return {
    key: issue.key,
    summary: issue.fields.summary ?? '',
    status: issue.fields.status?.name ?? '',
    type: issue.fields.issuetype?.name ?? '',
    url,
    updated: issue.fields.updated ?? '',
    markdown,
    pages: confluenceLinks(links, [...remote, ...parentRemote]),
  }
}

export interface TicketFetch {
  docs: DocFile[]
  /** Pasted tickets that could not be read — said in the prompt, not fatal. */
  problems: string[]
  /** Confluence pages the tickets link to (not read unless also pasted). */
  pages: string[]
}

/**
 * The round's tickets, saved as Markdown. A pasted ticket that cannot be read
 * is reported; one only guessed from the branch / title is dropped quietly —
 * "FOO-1" in a branch name is often not a ticket at all.
 */
export async function fetchTickets(itemId: number, plan: Array<{ key: string; auto: boolean }>): Promise<TicketFetch> {
  const out: TicketFetch = { docs: [], problems: [], pages: [] }
  if (!plan.length) return out
  if (!readCreds()) {
    if (plan.some((p) => !p.auto)) out.problems.push('Chưa cấu hình Jira nên không đọc được ticket nào.')
    return out
  }
  const dir = path.join(DOCS_DIR, String(itemId), `${Date.now()}-jira`)
  for (const p of plan) {
    let t: Rendered
    try {
      t = await render(p.key)
    } catch (err) {
      if (!p.auto) out.problems.push(`${p.key}: ${(err as Error).message}`)
      continue
    }
    if (out.docs.some((d) => d.ticket?.key === t.key)) continue
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${t.key}.md`)
    await fs.writeFile(file, t.markdown)
    out.docs.push({
      name: `${t.key} · ${t.summary}`,
      role: 'spec',
      path: file,
      ticket: { key: t.key, url: t.url, updated: t.updated, ...(p.auto ? { auto: true } : {}) },
    })
    for (const pg of t.pages) if (!out.pages.includes(pg.url)) out.pages.push(pg.url)
  }
  return out
}

export interface TicketPreview {
  key: string
  ok: boolean
  error?: string
  summary?: string
  status?: string
  type?: string
  url?: string
  /** Confluence pages linked from the ticket (or its parent) — offered to add as context. */
  pages?: LinkedPage[]
}

/** Pasted keys, read now: proof each one exists, and the Confluence pages it links to. */
export async function previewTickets(keys: string[]): Promise<TicketPreview[]> {
  const out: TicketPreview[] = []
  for (const key of keys.slice(0, 10)) {
    try {
      const t = await render(key)
      out.push({ key: t.key, ok: true, summary: t.summary, status: t.status, type: t.type, url: t.url, pages: t.pages })
    } catch (err) {
      out.push({ key, ok: false, error: (err as Error).message })
    }
  }
  return out
}
