import { checkClaude } from '@/lib/modules/code-review/claude'
import { getRepo, getTemplate } from '@/lib/modules/code-review/config'
import { ensureTicker, tick } from '@/lib/modules/code-review/runner'
import { resolveSources } from '@/lib/modules/code-review/confluence'
import type { ConfluenceRef, PrLink } from '@/lib/modules/code-review/model'
import { createItem, getItem, hasLiveRound, patchItem, queueRound, setItemSources } from '@/lib/modules/code-review/store'
import { checkPdfs, savePdfs } from '@/lib/modules/code-review/uploads'
import { isModuleEnabled } from '@/lib/modules/state'

export const runtime = 'nodejs'

/**
 * Queues a document review — a new one, or the next round of an existing one.
 *
 * A route handler rather than a server action because PDFs are routinely
 * bigger than the 1 MB a server action accepts by default, and raising that
 * limit app-wide for one form would be the wrong trade.
 *
 * Files land in `data/code-review/docs/<item>/<stamp>/` — see uploads.ts.
 * Confluence links (`sources`, JSON) are only checked here; each round fetches
 * the pages itself, at their latest version.
 */
const fail = (message: string, status = 400) => Response.json({ ok: false, message }, { status })

export async function POST(request: Request) {
  if (!isModuleEnabled('code-review')) return fail('Module Code review đang tắt.', 403)
  const claude = await checkClaude()
  if (!claude.ok) return fail(claude.problem, 412)

  const form = await request.formData()
  const itemIdRaw = Number(form.get('itemId') ?? 0)
  const title = String(form.get('title') ?? '').trim()
  const repoId = String(form.get('repoId') ?? '').trim()
  const ref = String(form.get('ref') ?? '').trim()
  const note = String(form.get('note') ?? '')
  const templateId = String(form.get('templateId') ?? '').trim()
  if (templateId && !getTemplate(templateId)) return fail('Mẫu tài liệu không còn trong Cấu hình.')
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
  const roles = form.getAll('roles').map(String)
  // One template per file (TDD iOS → mẫu iOS, TDD SDK → mẫu SDK); '' = none.
  const templateIds = form.getAll('templates').map(String)
  for (const t of templateIds) if (t && !getTemplate(t)) return fail('Mẫu tài liệu không còn trong Cấu hình.')

  let sources: ConfluenceRef[] | null = null
  if (form.has('sources')) {
    const resolved = await resolveSources(parseJson(form.get('sources')))
    if (typeof resolved === 'string') return fail(resolved)
    sources = resolved
    for (const s of sources) if (s.templateId && !getTemplate(s.templateId)) return fail('Mẫu tài liệu không còn trong Cấu hình.')
  }

  // Code to check against: the first repo is where Claude runs, the rest are read beside it.
  const repos = (parseJson(form.get('repos')) as Array<{ repoId?: string; ref?: string }> | null) ?? (repoId ? [{ repoId, ref }] : [])
  const picked: Array<{ repoId: string; ref: string }> = []
  for (const r of Array.isArray(repos) ? repos.slice(0, 6) : []) {
    const id = String(r?.repoId ?? '').trim()
    const branch = String(r?.ref ?? '').trim()
    if (!id) continue
    if (!getRepo(id)) return fail('Không thấy repo.')
    if (!branch) return fail(`Chọn nhánh code để đối chiếu cho ${getRepo(id)!.name}.`)
    if (!picked.some((p) => p.repoId === id && p.ref === branch)) picked.push({ repoId: id, ref: branch })
  }
  const links: PrLink[] = picked.slice(1).map((p) => ({ repoId: p.repoId, prNumber: null, baseRef: '', headRef: p.ref, title: p.ref, url: '' }))

  const existing = itemIdRaw ? getItem(itemIdRaw) : null
  if (!files.length && !sources?.length && !existing?.sources.length) return fail('Chọn ít nhất một file PDF hoặc dán link Confluence.')
  const bad = checkPdfs(files)
  if (bad) return fail(bad)

  let itemId = itemIdRaw
  if (itemId) {
    const item = getItem(itemId)
    if (!item || item.kind !== 'doc') return fail('Không thấy hồ sơ tài liệu.', 404)
    if (hasLiveRound(itemId)) return fail('Hồ sơ này đang có vòng review chưa xong.', 409)
    if (form.has('note')) patchItem(itemId, { note: note.trim() })
    if (sources) setItemSources(itemId, sources)
  } else {
    if (!title) return fail('Đặt tên cho hồ sơ tài liệu.')
    const primary = picked[0]
    itemId = createItem({
      kind: 'doc',
      repoId: primary?.repoId ?? '',
      title,
      prNumber: null,
      baseRef: '',
      headRef: primary?.ref ?? '',
      author: '',
      url: sources?.[0]?.url ?? '',
      note: note.trim(),
      templateId,
      links,
      sources: sources ?? [],
    })
  }

  const docs = files.length ? await savePdfs(String(itemId), files, roles, templateIds) : []

  queueRound(itemId, docs)
  ensureTicker()
  void tick()
  return Response.json({ ok: true, message: 'Đã xếp hàng review tài liệu.', itemId })
}

function parseJson(v: FormDataEntryValue | null): unknown {
  if (typeof v !== 'string' || !v) return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}
