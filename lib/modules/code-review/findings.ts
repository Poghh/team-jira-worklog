import 'server-only'

import type { reviewFindings } from '@/lib/db/schema'

import { snippetAt } from './git'
import { DOC_CATEGORIES, type DocFile, type ItemKind, type RepoPreset, SEVERITIES, type Severity, anchorInDiff } from './model'
import type { RoundRow } from './store'

/**
 * Turning what Claude said into finding rows — shared by a review round and by
 * a chat turn whose proposed additions the reviewer accepted, so both anchor,
 * snippet and classify a finding the same way.
 */

export interface RawFinding {
  file?: string
  line?: number
  end_line?: number
  location?: string
  severity?: string
  category?: string
  title?: string
  comment?: string
  /** Doc reviews: the document the finding is in, by path as Claude was given it. */
  doc?: string
  /** Doc reviews on Confluence: page text to hang an inline comment on. */
  quote?: string
}

/**
 * The Confluence page a doc finding is about: the path Claude named, else a
 * page whose title the location mentions (longest title wins), else the only
 * page there is. '' when it cannot be told — the reviewer picks when posting.
 */
export function pageOf(f: Pick<RawFinding, 'doc' | 'location'>, docs: DocFile[]): string {
  const pages = docs.filter((d) => d.source)
  if (!pages.length) return ''
  const doc = (f.doc ?? '').trim()
  if (doc) {
    const hit = pages.find((d) => d.path === doc) ?? pages.find((d) => d.path.endsWith(doc) || d.name === doc)
    if (hit) return hit.source!.pageId
    // Claude named a PDF or something else that is not a page.
    if (docs.some((d) => !d.source && (d.path === doc || d.name === doc))) return ''
  }
  const loc = (f.location ?? '').toLowerCase()
  const byTitle = pages.filter((d) => d.name && loc.includes(d.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0]
  if (byTitle) return byTitle.source!.pageId
  return pages.length === 1 ? pages[0].source!.pageId : ''
}

export const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 }

export const cleanSeverity = (s: string | undefined): Severity =>
  (SEVERITIES as string[]).includes(s ?? '') ? (s as Severity) : 'minor'

export async function buildFreshRows(
  r: Pick<RoundRow, 'id' | 'itemId' | 'headSha'>,
  kind: ItemKind,
  repo: RepoPreset | undefined,
  raw: RawFinding[],
  ranges: Map<string, Array<[number, number]>> | null,
  startPosition: number,
  /** Doc reviews: the round's documents, to tell which Confluence page a finding is on. */
  docs: DocFile[] = [],
): Promise<Array<typeof reviewFindings.$inferInsert>> {
  const fresh = raw
    .filter((f) => (f.title || f.comment)?.trim())
    .map((f) => ({ ...f, severity: cleanSeverity(f.severity) }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  const rows: Array<typeof reviewFindings.$inferInsert> = []
  let position = startPosition
  for (const f of fresh) {
    const file = (f.file ?? '').replace(/^\.?\//, '').trim()
    const line = Number.isInteger(f.line) && f.line! > 0 ? f.line! : null
    const endLine = Number.isInteger(f.end_line) && f.end_line! >= (line ?? 0) ? f.end_line! : null
    let snippet = { text: '', start: 0 }
    if (repo && file && line && r.headSha) snippet = await snippetAt(repo.localPath, r.headSha, file, line, endLine)
    const inDiff = Boolean(file && anchorInDiff(ranges?.get(file), line, endLine))
    rows.push({
      roundId: r.id,
      itemId: r.itemId,
      file,
      line,
      endLine,
      location: (f.location ?? '').trim(),
      severity: f.severity,
      category:
        kind === 'doc'
          ? (DOC_CATEGORIES as string[]).includes(f.category ?? '')
            ? f.category!
            : 'unreasonable'
          : (f.category ?? '').trim(),
      title: (f.title ?? '').trim(),
      body: (f.comment ?? '').trim(),
      snippet: snippet.text,
      snippetStart: snippet.start,
      inDiff,
      origin: 'new',
      status: 'open',
      docRef: kind === 'doc' ? pageOf(f, docs) : '',
      quote: kind === 'doc' ? (f.quote ?? '').trim().slice(0, 300) : '',
      position: position++,
    })
  }
  return rows
}
