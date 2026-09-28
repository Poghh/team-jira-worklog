import { checkPdfs, savePdfs } from '@/lib/modules/code-review/uploads'
import { isModuleEnabled } from '@/lib/modules/state'

export const runtime = 'nodejs'

/**
 * Stores PDFs to attach to a PR review and hands back where they went.
 *
 * Only the storing happens here; the review itself is queued by a server
 * action that receives the returned list — the files are too big for the
 * action, the list is not. The action re-checks every path (`validDocs`).
 */
export async function POST(request: Request) {
  if (!isModuleEnabled('code-review')) {
    return Response.json({ ok: false, message: 'Module Code review đang tắt.' }, { status: 403 })
  }
  const form = await request.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
  const roles = form.getAll('roles').map(String)
  if (!files.length) return Response.json({ ok: false, message: 'Chưa chọn file nào.' }, { status: 400 })
  const bad = checkPdfs(files)
  if (bad) return Response.json({ ok: false, message: bad }, { status: 400 })
  const docs = await savePdfs('attachments', files, roles)
  return Response.json({ ok: true, message: '', docs })
}
