import 'server-only'

import type { reviewFindings } from '@/lib/db/schema'

import { snippetAt } from './git'
import { DOC_CATEGORIES, type ItemKind, type RepoPreset, SEVERITIES, type Severity, anchorInDiff } from './model'
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
      position: position++,
    })
  }
  return rows
}
