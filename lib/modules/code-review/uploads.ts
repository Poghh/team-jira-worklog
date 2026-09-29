import 'server-only'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { DocFile, DocRole } from './model'

/**
 * PDFs handed to a review — the documents of a doc review, or the spec / TDD
 * attached to a PR review for Claude to compare the implementation against.
 *
 * Each upload gets its own folder, so a later round can still hand Claude the
 * previous version to compare with. Uploads go through route handlers, never
 * server actions: PDFs are routinely bigger than the 1 MB an action accepts.
 */
export const DOCS_DIR = path.join(process.cwd(), 'data', 'code-review', 'docs')
export const MAX_DOC_BYTES = 40 * 1024 * 1024
const ROLES: DocRole[] = ['spec', 'tdd', 'other']

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim()
  return base || 'document.pdf'
}

/** Why these files cannot be accepted, or '' when they can. Templates may also be Markdown / text. */
export function checkPdfs(files: File[], allowText = false): string {
  for (const f of files) {
    const ok = /\.pdf$/i.test(f.name) || f.type === 'application/pdf' || (allowText && /\.(md|markdown|txt)$/i.test(f.name))
    if (!ok) return allowText ? `${f.name}: chỉ nhận PDF, Markdown (.md) hoặc .txt.` : `${f.name} không phải PDF.`
    if (f.size > MAX_DOC_BYTES) return `${f.name} lớn hơn 40 MB.`
  }
  return ''
}

export async function savePdfs(folder: string, files: File[], roles: string[], templateIds: string[] = []): Promise<DocFile[]> {
  const dir = path.join(DOCS_DIR, folder, String(Date.now()))
  await fs.mkdir(dir, { recursive: true })
  const docs: DocFile[] = []
  const used = new Set<string>()
  for (const [i, f] of files.entries()) {
    let name = safeName(f.name)
    while (used.has(name)) name = `${i}-${name}`
    used.add(name)
    const target = path.join(dir, name)
    await fs.writeFile(target, Buffer.from(await f.arrayBuffer()))
    const role = ROLES.includes(roles[i] as DocRole) ? (roles[i] as DocRole) : 'other'
    docs.push({ name: f.name, role, path: target, ...(templateIds[i] ? { templateId: templateIds[i] } : {}) })
  }
  return docs
}

/**
 * Docs coming back from the browser, trusted only if they point at a file this
 * module stored. The paths are handed to Claude with `--add-dir`, so a forged
 * one would open an arbitrary directory to the review.
 */
export async function validDocs(input: unknown): Promise<DocFile[] | null> {
  if (!Array.isArray(input)) return null
  const out: DocFile[] = []
  for (const d of input) {
    const p = typeof d?.path === 'string' ? path.resolve(d.path) : ''
    if (!p.startsWith(DOCS_DIR + path.sep)) return null
    try {
      await fs.access(p)
    } catch {
      return null
    }
    out.push({
      name: String(d.name ?? path.basename(p)),
      role: ROLES.includes(d.role) ? d.role : 'other',
      path: p,
      ...(typeof d.templateId === 'string' && d.templateId ? { templateId: d.templateId } : {}),
    })
  }
  return out
}
