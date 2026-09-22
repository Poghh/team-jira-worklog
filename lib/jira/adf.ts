/**
 * Atlassian Document Format → simple blocks for display.
 *
 * Handles only what this project actually uses. A survey of the descriptions in
 * VT found six node types — doc, paragraph, text, bulletList, listItem, heading
 * — and no marks at all, so a full ADF renderer would be dead weight. Anything
 * unrecognised falls back to its text content rather than disappearing.
 *
 * No server import: the detail panel renders these on the client.
 */

export type AdfBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }

interface AdfNode {
  type?: string
  text?: string
  attrs?: { level?: number }
  content?: AdfNode[]
}

/** Concatenates every text leaf under a node. */
function textOf(node: AdfNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textOf).join('')
}

export function adfToBlocks(doc: unknown): AdfBlock[] {
  const root = doc as AdfNode | null
  if (!root || typeof root !== 'object' || !Array.isArray(root.content)) return []

  const out: AdfBlock[] = []

  for (const node of root.content) {
    switch (node.type) {
      case 'heading': {
        const text = textOf(node).trim()
        if (text) out.push({ kind: 'heading', level: node.attrs?.level ?? 3, text })
        break
      }
      case 'bulletList':
      case 'orderedList': {
        const items = (node.content ?? [])
          .map((li) => textOf(li).trim())
          .filter(Boolean)
        if (items.length) out.push({ kind: 'bullets', items })
        break
      }
      default: {
        const text = textOf(node).trim()
        if (text) out.push({ kind: 'paragraph', text })
      }
    }
  }

  return out
}

/** Flattens back to plain text, for tooltips and copying. */
export function adfToText(doc: unknown): string {
  return adfToBlocks(doc)
    .map((b) =>
      b.kind === 'bullets' ? b.items.map((i) => `- ${i}`).join('\n') : b.text,
    )
    .join('\n\n')
}

/** Tiêu đề của khối Definition of Done, dùng chung cho cả ghi lẫn đọc ngược. */
export const DOD_HEADING = 'Definition of Done'

/**
 * Chữ dạng gạch đầu dòng → ADF. Chỉ bullet và đoạn văn, không hơn.
 *
 * Ở cạnh `adfToBlocks` vì hai hàm là một cặp: cái này ghi ra, cái kia đọc về,
 * và luật đặt khối Definition of Done phải giống nhau ở cả hai chiều — lệch
 * một chữ là sửa mô tả xong sẽ mất phần DoD.
 */
export function textToAdf(description: string, dod: string) {
  const content: unknown[] = []

  const pushBlock = (text: string) => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    let bullets: string[] = []

    const flush = () => {
      if (!bullets.length) return
      content.push({
        type: 'bulletList',
        content: bullets.map((b) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: b }] }],
        })),
      })
      bullets = []
    }

    for (const line of lines) {
      if (/^[-*•]\s+/.test(line)) bullets.push(line.replace(/^[-*•]\s+/, ''))
      else {
        flush()
        content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] })
      }
    }
    flush()
  }

  if (description.trim()) pushBlock(description)

  if (dod.trim()) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'Definition of Done' }],
    })
    pushBlock(dod)
  }

  if (!content.length) content.push({ type: 'paragraph', content: [] })

  return { type: 'doc', version: 1, content }
}

/**
 * Tách mô tả đã lưu thành hai ô như lúc soạn: phần thân và phần DoD.
 *
 * Cắt ở đúng heading mà {@link textToAdf} ghi ra. Không tìm thấy thì cả tài
 * liệu là phần thân — an toàn hơn đoán, vì đoán sai là người dùng bấm lưu rồi
 * mất nguyên khối DoD.
 */
export function splitDod(doc: unknown): { description: string; dod: string } {
  const blocks = adfToBlocks(doc)
  const at = blocks.findIndex(
    (b) => b.kind === 'heading' && b.text.trim().toLowerCase() === DOD_HEADING.toLowerCase(),
  )
  const asText = (list: AdfBlock[]) =>
    list
      .map((b) => (b.kind === 'bullets' ? b.items.map((i) => `- ${i}`).join('\n') : b.text))
      .join('\n\n')
      .trim()

  return at < 0
    ? { description: asText(blocks), dod: '' }
    : { description: asText(blocks.slice(0, at)), dod: asText(blocks.slice(at + 1)) }
}
