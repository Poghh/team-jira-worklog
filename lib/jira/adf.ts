/**
 * A task's description and Definition of Done ↔ the one ADF document Jira
 * keeps them in.
 *
 * Both boxes are Markdown (lib/jira/markdown.ts): written by hand, pasted from
 * elsewhere, or generated — plain lines and `- ` bullets, as before, are just
 * the simplest Markdown. The DoD goes under its own heading, and reading back
 * cuts at that heading, so an edit gets the same two boxes it was created from.
 *
 * No server import: the detail panel builds and renders these on the client.
 */

import { type AdfNode, isDodTitle, markdownToAdf, nodesToMarkdown } from './markdown'

/** Tiêu đề của khối Definition of Done, dùng chung cho cả ghi lẫn đọc ngược. */
export const DOD_HEADING = 'Definition of Done'

/**
 * Hai ô Markdown → một tài liệu ADF.
 *
 * Ở cạnh `splitDod` vì hai hàm là một cặp: cái này ghi ra, cái kia đọc về,
 * và luật đặt khối Definition of Done phải giống nhau ở cả hai chiều — lệch
 * một chữ là sửa mô tả xong sẽ mất phần DoD.
 */
export function textToAdf(description: string, dod: string) {
  const content: AdfNode[] = []

  if (description.trim()) content.push(...markdownToAdf(description))

  if (dod.trim()) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: DOD_HEADING }],
    })
    content.push(...markdownToAdf(dod))
  }

  if (!content.length) content.push({ type: 'paragraph', content: [] })

  return { type: 'doc', version: 1, content }
}

const textOf = (n: AdfNode): string => (n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(textOf).join(''))

/**
 * Tách mô tả đã lưu thành hai ô Markdown như lúc soạn: phần thân và phần DoD.
 *
 * Cắt ở heading Definition of Done (hoặc "DoD") ở cấp ngoài cùng — đúng chỗ
 * {@link textToAdf} ghi ra. Không tìm thấy thì cả tài liệu là phần thân — an
 * toàn hơn đoán, vì đoán sai là người dùng bấm lưu rồi mất nguyên khối DoD.
 */
export function splitDod(doc: unknown): { description: string; dod: string } {
  const root = doc as AdfNode | null
  const nodes = root && typeof root === 'object' && Array.isArray(root.content) ? root.content : []
  const at = nodes.findIndex((n) => n.type === 'heading' && isDodTitle(textOf(n)))
  return at < 0
    ? { description: nodesToMarkdown(nodes), dod: '' }
    : { description: nodesToMarkdown(nodes.slice(0, at)), dod: nodesToMarkdown(nodes.slice(at + 1)) }
}
