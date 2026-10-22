import 'server-only'

import fs from 'node:fs/promises'
import path from 'node:path'

import { readCreds } from '@/lib/jira/client'

import { locateQuote, markdownToStorage, parsePageUrl, referencedImages, storageToMarkdown, storageToText } from './confluence-md'
import { assertConfluenceRequest } from './guard'
import { getTemplates } from './config'
import { type ConfluenceRef, type DocFile, type SubpageChoice, type SubpageInfo, guessRole, guessTemplate } from './model'
import { DOCS_DIR } from './uploads'

/**
 * Confluence pages as review documents, and comments back onto them.
 *
 * Uses the Atlassian account already set up for Jira (Cài đặt → Jira): on
 * Atlassian Cloud the same email + API token reads Confluence on the same
 * site. Every request goes through `assertConfluenceRequest` (guard.ts): reads,
 * plus POST to the two comment endpoints — never an edit of the page.
 *
 * Each round fetches the pages afresh and saves them as Markdown under
 * data/code-review/docs/<item>/<stamp>-confluence/, images beside them, so the
 * next round can compare the new version with this one.
 */

export class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ConfluenceError'
  }
}

/** Pages read per round at most, subpages included — a guard against pasting a whole space. */
export const MAX_PAGES = 60
const MAX_IMAGES_PER_PAGE = 30
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

interface Site {
  origin: string
  host: string
  auth: string
}

function site(): Site {
  const c = readCreds()
  if (!c) throw new ConfluenceError('Chưa cấu hình tài khoản Atlassian (Cài đặt → Jira: URL, email, API token).', 0)
  const u = new URL(c.baseUrl)
  return { origin: u.origin, host: u.host, auth: 'Basic ' + Buffer.from(`${c.email}:${c.apiToken}`).toString('base64') }
}

/** The Atlassian site links must be on, e.g. "ossworks.atlassian.net"; '' when not set up. */
export function confluenceHost(): string {
  try {
    return site().host
  } catch {
    return ''
  }
}

function describe(status: number, body: string): string {
  if (status === 401) return 'Token Atlassian bị từ chối (401) — kiểm tra email / API token ở Cài đặt.'
  if (status === 403) return 'Tài khoản không có quyền với trang này (403).'
  if (status === 404) return 'Không thấy trang, hoặc tài khoản không có quyền xem (404).'
  let msg = ''
  try {
    const j = JSON.parse(body)
    msg = j?.errors?.[0]?.title ?? j?.message ?? ''
  } catch {}
  return `Confluence trả lỗi ${status}${msg ? `: ${String(msg).slice(0, 300)}` : ''}.`
}

async function request(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<Response> {
  const s = site()
  const url = new URL(pathname, s.origin)
  // Checked after URL normalisation, so "../" cannot walk out of the allowlist.
  if (url.origin !== s.origin) throw new ConfluenceError('Chặn: link không thuộc site Atlassian đã cấu hình.', 0)
  assertConfluenceRequest(method, url.pathname)
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: s.auth,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    cache: 'no-store',
  })
  if (!res.ok) throw new ConfluenceError(describe(res.status, await res.text().catch(() => '')), res.status)
  return res
}

/**
 * An attachment's bytes. Confluence answers with a redirect to Atlassian's
 * media service carrying a short-lived signed URL; that hop is followed
 * WITHOUT the account's credentials, and only to an atlassian.com host.
 */
async function download(pathname: string): Promise<Buffer> {
  const s = site()
  const url = new URL(pathname, s.origin)
  if (url.origin !== s.origin) throw new ConfluenceError('Chặn: link không thuộc site Atlassian đã cấu hình.', 0)
  assertConfluenceRequest('GET', url.pathname)
  let res = await fetch(url, { headers: { Authorization: s.auth }, redirect: 'manual', cache: 'no-store' })
  if (res.status >= 300 && res.status < 400) {
    const to = new URL(res.headers.get('location') ?? '', url)
    if (to.protocol !== 'https:' || !/(^|\.)atlassian\.(com|net)$/.test(to.hostname)) throw new ConfluenceError('Chặn: ảnh chuyển hướng ra ngoài Atlassian.', 0)
    res = await fetch(to, { redirect: 'error', cache: 'no-store' })
  }
  if (!res.ok) throw new ConfluenceError(describe(res.status, ''), res.status)
  return Buffer.from(await res.arrayBuffer())
}

const getJson = async <T>(pathname: string): Promise<T> => (await request('GET', pathname)).json() as Promise<T>

/* ── pages ──────────────────────────────────────────────────────────────── */

interface PageJson {
  id: string
  title: string
  parentId?: string
  version?: { number: number }
  body?: { storage?: { value: string } }
  _links?: { webui?: string; base?: string }
}

export interface PageInfo {
  pageId: string
  title: string
  url: string
}

const webUrl = (s: Site, webui?: string) => (webui ? `${s.origin}/wiki${webui}` : '')

/** Reads the page a pasted link points at — the title, and proof the token can see it. */
export async function resolvePageLink(raw: string): Promise<PageInfo> {
  const s = site()
  const pageId = parsePageUrl(raw, s.host)
  if (!pageId) throw new ConfluenceError(`Link không phải trang Confluence trên ${s.host}: ${raw.slice(0, 120)}`, 0)
  const p = await getJson<PageJson>(`/wiki/api/v2/pages/${pageId}`)
  return { pageId, title: p.title, url: webUrl(s, p._links?.webui) || raw.trim() }
}

interface Descendant {
  id: string
  title: string
  type: string
  parentId?: string
  depth?: number
}

/** Every page under `pageId` (folders are walked through, not read), top-down. */
async function descendants(pageId: string, limit: number): Promise<Descendant[]> {
  const out: Descendant[] = []
  let next: string | undefined = `/wiki/api/v2/pages/${pageId}/descendants?limit=250&depth=5`
  while (next && out.length < limit * 3) {
    const page: { results: Descendant[]; _links?: { next?: string } } = await getJson(next)
    out.push(...page.results)
    next = page._links?.next ? (page._links.next.startsWith('/wiki') ? page._links.next : `/wiki${page._links.next}`) : undefined
  }
  return out.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))
}

/** The pages under `pageId` with the folders / pages between — what the reviewer classifies. */
export async function subpages(pageId: string): Promise<SubpageInfo[]> {
  const tree = await descendants(pageId, MAX_PAGES)
  const byId = new Map(tree.map((d) => [d.id, d]))
  const trailOf = (d: Descendant): string[] => {
    const t: string[] = []
    for (let p = d.parentId ? byId.get(d.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) t.unshift(p.title)
    return t
  }
  return tree.filter((d) => d.type === 'page' && d.id !== pageId).map((d) => ({ pageId: d.id, title: d.title, trail: trailOf(d) }))
}

const safe = (s: string) => s.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim().slice(0, 80) || 'page'

interface AttachmentJson {
  title: string
  mediaType?: string
  fileSize?: number
  downloadLink?: string
}

/** The images a page shows, saved next to its Markdown so Claude can look at diagrams and mockups. */
async function saveImages(pageId: string, xhtml: string, dir: string): Promise<Map<string, string>> {
  const saved = new Map<string, string>()
  const wanted = new Set(referencedImages(xhtml))
  // draw.io keeps a PNG preview as an attachment named after the diagram.
  for (const m of xhtml.matchAll(/<ac:parameter ac:name="diagramName">([^<]+)<\/ac:parameter>/g)) wanted.add(`${m[1].trim()}.png`)
  if (!wanted.size) return saved
  let atts: AttachmentJson[] = []
  try {
    atts = (await getJson<{ results: AttachmentJson[] }>(`/wiki/api/v2/pages/${pageId}/attachments?limit=250`)).results
  } catch {
    return saved
  }
  const filesDir = path.join(dir, `${pageId}-files`)
  for (const a of atts) {
    if (saved.size >= MAX_IMAGES_PER_PAGE) break
    if (!wanted.has(a.title) || !a.downloadLink || !/^image\//.test(a.mediaType ?? '') || (a.fileSize ?? 0) > MAX_IMAGE_BYTES) continue
    try {
      const link = a.downloadLink.startsWith('/wiki') ? a.downloadLink : `/wiki${a.downloadLink}`
      const buf = await download(link)
      if (buf.length > MAX_IMAGE_BYTES) continue
      await fs.mkdir(filesDir, { recursive: true })
      const target = path.join(filesDir, safe(a.title))
      await fs.writeFile(target, buf)
      saved.set(a.title, target)
    } catch {}
  }
  return saved
}

/**
 * Fetches the pasted pages — and the subpages of those that ask for it — at
 * their current version, writes each as Markdown, and returns them as the
 * round's documents. Each subpage has the role / template the reviewer chose
 * for it (ConfluenceRef.pages), or one guessed from its title.
 */
export async function fetchPages(itemId: number, refs: ConfluenceRef[]): Promise<DocFile[]> {
  const s = site()
  const dir = path.join(DOCS_DIR, String(itemId), `${Date.now()}-confluence`)
  await fs.mkdir(dir, { recursive: true })

  // Which pages to read, root first, then its tree — each page once.
  const templates = getTemplates()
  const plan: Array<{ pageId: string; ref: ConfluenceRef; trail: string[]; role: ConfluenceRef['role']; templateId: string }> = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (!seen.has(ref.pageId)) {
      seen.add(ref.pageId)
      plan.push({ pageId: ref.pageId, ref, trail: [], role: ref.role, templateId: ref.templateId })
    }
    if (!ref.children) continue
    for (const d of await subpages(ref.pageId)) {
      if (seen.has(d.pageId)) continue
      // Chosen when the link was added; a page added since is guessed from its title.
      const choice: SubpageChoice | undefined = ref.pages?.[d.pageId]
      if (choice?.skip) continue
      seen.add(d.pageId)
      const role = choice?.role ?? guessRole(d.title)
      plan.push({
        pageId: d.pageId,
        ref,
        trail: [ref.title, ...d.trail],
        role,
        templateId: choice ? choice.templateId : guessTemplate({ name: d.title, role }, templates, ''),
      })
    }
  }
  if (plan.length > MAX_PAGES) {
    throw new ConfluenceError(`Có ${plan.length} trang (tính cả subpage) — quá ${MAX_PAGES} trang một vòng. Dán link trang nhỏ hơn hoặc tắt "đọc cả subpage".`, 0)
  }

  const docs: DocFile[] = []
  for (const [i, p] of plan.entries()) {
    const page = await getJson<PageJson>(`/wiki/api/v2/pages/${p.pageId}?body-format=storage`)
    const xhtml = page.body?.storage?.value ?? ''
    const images = await saveImages(p.pageId, xhtml, dir)
    const { markdown } = storageToMarkdown(xhtml, { image: (f) => images.get(f) ?? '' })
    const url = webUrl(s, page._links?.webui) || p.ref.url
    const version = page.version?.number ?? 0
    const head = [
      `# ${page.title}`,
      '',
      `> Trang Confluence · phiên bản ${version}${p.trail.length ? ` · nằm dưới: ${p.trail.join(' › ')}` : ''}`,
      `> ${url}`,
      '',
    ].join('\n')
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${p.pageId}-${safe(page.title)}.md`)
    await fs.writeFile(file, `${head}\n${markdown || '_(trang trống)_'}\n`)
    docs.push({
      name: page.title,
      role: p.role,
      path: file,
      ...(p.templateId ? { templateId: p.templateId } : {}),
      source: { pageId: p.pageId, url, version, rootId: p.ref.pageId, trail: p.trail },
    })
  }
  return docs
}

/* ── access ─────────────────────────────────────────────────────────────── */

export interface ConfluenceAccess {
  read: boolean
  write: boolean
  reason: string
}

const accessCache = new Map<string, { at: number; v: ConfluenceAccess }>()

/** Whether the token may read the page and add comments to it — asked, not guessed. */
export async function checkConfluenceAccess(pageId: string, force = false): Promise<ConfluenceAccess> {
  const hit = accessCache.get(pageId)
  if (!force && hit && Date.now() - hit.at < 10 * 60_000) return hit.v
  let v: ConfluenceAccess
  try {
    const ops = await getJson<{ operations: Array<{ operation: string; targetType: string }> }>(`/wiki/api/v2/pages/${pageId}/operations`)
    const write = ops.operations.some((o) => o.operation === 'create' && o.targetType === 'comment')
    v = { read: true, write, reason: write ? '' : 'Tài khoản Atlassian không có quyền comment trên trang này.' }
  } catch (err) {
    v = { read: false, write: false, reason: (err as Error).message }
  }
  accessCache.set(pageId, { at: Date.now(), v })
  return v
}

/* ── comments ───────────────────────────────────────────────────────────── */

export type CommentKind = 'inline' | 'footer'

interface CommentJson {
  id: string
  _links?: { webui?: string; base?: string }
}

export interface PostedComment {
  id: number
  url: string
  kind: CommentKind
}

function posted(s: Site, c: CommentJson, kind: CommentKind, pageUrl: string): PostedComment {
  const base = c._links?.base ?? `${s.origin}/wiki`
  const url = c._links?.webui ? `${base}${c._links.webui}` : `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}focusedCommentId=${c.id}`
  return { id: Number(c.id), url, kind }
}

/**
 * A finding as a comment on its page: inline — highlighted on the quoted text —
 * when that text is still on the current version of the page, otherwise a
 * page comment that quotes it.
 */
export async function postPageComment(input: { pageId: string; pageUrl: string; body: string; quote: string }): Promise<PostedComment & { anchored: boolean }> {
  const s = site()
  const quote = input.quote.trim()
  if (quote) {
    const page = await getJson<PageJson>(`/wiki/api/v2/pages/${input.pageId}?body-format=storage`)
    const hit = locateQuote(storageToText(page.body?.storage?.value ?? ''), quote)
    if (hit) {
      try {
        const res = await request('POST', '/wiki/api/v2/inline-comments', {
          pageId: input.pageId,
          body: { representation: 'storage', value: markdownToStorage(input.body) },
          inlineCommentProperties: {
            textSelection: hit.selection,
            textSelectionMatchCount: hit.count,
            textSelectionMatchIndex: hit.index,
          },
        })
        return { ...posted(s, (await res.json()) as CommentJson, 'inline', input.pageUrl), anchored: true }
      } catch (err) {
        // Confluence could not place the highlight (text split by formatting…): fall back below.
        if (!(err instanceof ConfluenceError) || err.status < 400 || err.status >= 500 || err.status === 401 || err.status === 403) throw err
      }
    }
  }
  const body = quote ? `> ${quote.replace(/\n+/g, ' ')}\n\n${input.body}` : input.body
  const res = await request('POST', '/wiki/api/v2/footer-comments', {
    pageId: input.pageId,
    body: { representation: 'storage', value: markdownToStorage(body) },
  })
  return { ...posted(s, (await res.json()) as CommentJson, 'footer', input.pageUrl), anchored: false }
}

/** A reply under a comment the module posted, in the same thread. */
export async function replyToPageComment(input: { kind: CommentKind; parentId: number; body: string; pageUrl: string }): Promise<PostedComment> {
  const s = site()
  const res = await request('POST', `/wiki/api/v2/${input.kind}-comments`, {
    parentCommentId: String(input.parentId),
    body: { representation: 'storage', value: markdownToStorage(input.body) },
  })
  return posted(s, (await res.json()) as CommentJson, input.kind, input.pageUrl)
}

const names = new Map<string, string>()

async function displayName(accountId: string): Promise<string> {
  if (!accountId) return '?'
  const hit = names.get(accountId)
  if (hit) return hit
  try {
    const u = await getJson<{ displayName?: string; publicName?: string }>(`/wiki/rest/api/user?accountId=${encodeURIComponent(accountId)}`)
    const n = u.displayName || u.publicName || accountId
    names.set(accountId, n)
    return n
  } catch {
    return accountId
  }
}

/** What people answered under a posted comment — read-only, for the next round's follow-up. */
export async function pageCommentReplies(kind: CommentKind, id: number): Promise<Array<{ author: string; body: string }>> {
  const r = await getJson<{ results: Array<{ version?: { authorId?: string }; body?: { storage?: { value: string } } }> }>(
    `/wiki/api/v2/${kind}-comments/${id}/children?body-format=storage&limit=50`,
  )
  const out: Array<{ author: string; body: string }> = []
  for (const c of r.results) {
    out.push({ author: await displayName(c.version?.authorId ?? ''), body: storageToMarkdown(c.body?.storage?.value ?? '').markdown })
  }
  return out
}

/* ── what the reviewer pasted ───────────────────────────────────────────── */

const ROLES = ['spec', 'tdd', 'other'] as const

/**
 * Pasted links → page refs, each checked readable now so a typo fails at
 * "Review" rather than minutes later in the queue. Duplicates are dropped.
 */
export async function resolveSources(input: unknown): Promise<ConfluenceRef[] | string> {
  if (!Array.isArray(input)) return 'Danh sách link Confluence không hợp lệ.'
  const out: ConfluenceRef[] = []
  for (const raw of input.slice(0, 20)) {
    const url = String(raw?.url ?? '').trim()
    if (!url) continue
    try {
      const info = await resolvePageLink(url)
      if (out.some((o) => o.pageId === info.pageId)) continue
      out.push({
        url: info.url,
        pageId: info.pageId,
        title: info.title,
        children: raw?.children !== false,
        role: (ROLES as readonly string[]).includes(raw?.role) ? raw.role : guessRole(info.title),
        templateId: typeof raw?.templateId === 'string' ? raw.templateId : '',
        pages: cleanChoices(raw?.pages),
      })
    } catch (err) {
      return (err as Error).message
    }
  }
  return out
}

function cleanChoices(input: unknown): Record<string, SubpageChoice> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const out: Record<string, SubpageChoice> = {}
  for (const [id, c] of Object.entries(input as Record<string, Partial<SubpageChoice>>).slice(0, 200)) {
    if (!/^\d+$/.test(id) || !c) continue
    out[id] = {
      role: (ROLES as readonly string[]).includes(c.role ?? '') ? c.role! : 'other',
      templateId: typeof c.templateId === 'string' ? c.templateId : '',
      ...(c.skip ? { skip: true } : {}),
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** A pasted link, read now: its title and — for the reviewer to classify — every subpage. */
export async function previewLink(url: string): Promise<{ pageId: string; title: string; url: string; subpages: SubpageInfo[] }> {
  const info = await resolvePageLink(url)
  return { ...info, subpages: await subpages(info.pageId) }
}
