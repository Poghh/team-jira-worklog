/**
 * Markdown → ADF for a task's description / Definition of Done, the way back
 * for editing, and the split of a whole pasted task into the two boxes.
 *
 * Run: npx tsx tests/jira-markdown.mts
 */
import { splitDod, textToAdf } from '@/lib/jira/adf'
import { type AdfNode, adfToMarkdown, markdownToAdf, splitMarkdownDod } from '@/lib/jira/markdown'

let n = 0
let bad = 0
const eq = (got: unknown, want: unknown, m: string) => {
  n++
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++
    console.log('FAIL', m, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want))
  }
}

const t = (text: string, ...marks: string[]): AdfNode => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text })
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content })
const li = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content })

/* ── what plain text did before still reads the same ── */
eq(
  markdownToAdf('Làm màn hình quên mật khẩu\n- Gửi OTP\n- Hết hạn 5 phút'),
  [p(t('Làm màn hình quên mật khẩu')), { type: 'bulletList', content: [li(p(t('Gửi OTP'))), li(p(t('Hết hạn 5 phút')))] }],
  'paragraph then bullets',
)
eq(markdownToAdf('dòng một\ndòng hai'), [p(t('dòng một'), { type: 'hardBreak' }, t('dòng hai'))], 'line break kept inside a paragraph')
eq(markdownToAdf('• chấm tròn'), [{ type: 'bulletList', content: [li(p(t('chấm tròn')))] }], '• is a bullet')

/* ── inline marks ── */
eq(
  markdownToAdf('Gọi **API** `login()` _ngay_ ~~cũ~~'),
  [p(t('Gọi '), t('API', 'strong'), t(' '), t('login()', 'code'), t(' '), t('ngay', 'em'), t(' '), t('cũ', 'strike'))],
  'strong / code / em / strike',
)
eq(
  markdownToAdf('**đậm _nghiêng_**'),
  [p(t('đậm ', 'strong'), t('nghiêng', 'strong', 'em'))],
  'nested marks',
)
eq(
  markdownToAdf('[spec](https://x.atlassian.net/wiki/1) và https://jira.x/browse/VT-1.'),
  [
    p(
      { type: 'text', text: 'spec', marks: [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/1' } }] },
      t(' và '),
      { type: 'text', text: 'https://jira.x/browse/VT-1', marks: [{ type: 'link', attrs: { href: 'https://jira.x/browse/VT-1' } }] },
      t('.'),
    ),
  ],
  'link and bare url (trailing dot left out)',
)
eq(markdownToAdf('snake_case_name và 2*3*4'), [p(t('snake_case_name và 2*3*4'))], 'underscores inside words and lone stars stay text')
eq(markdownToAdf('\\*không đậm\\*'), [p(t('*không đậm*'))], 'escaped stars')
eq(markdownToAdf('`**không đậm**`'), [p(t('**không đậm**', 'code'))], 'nothing parsed inside code')

/* ── blocks ── */
eq(markdownToAdf('## Bối cảnh'), [{ type: 'heading', attrs: { level: 2 }, content: [t('Bối cảnh')] }], 'heading')
eq(
  markdownToAdf('```swift\nlet a = 1\n\nlet b = 2\n```'),
  [{ type: 'codeBlock', attrs: { language: 'swift' }, content: [t('let a = 1\n\nlet b = 2')] }],
  'fenced code keeps blank lines',
)
eq(markdownToAdf('```\n```'), [{ type: 'codeBlock', attrs: {}, content: [] }], 'empty code block has no empty text node')
eq(markdownToAdf('---'), [{ type: 'rule' }], 'rule')
eq(
  markdownToAdf('1. một\n2. hai\n   - hai.a\n   - hai.b\n3. ba'),
  [
    {
      type: 'orderedList',
      attrs: { order: 1 },
      content: [
        li(p(t('một'))),
        li(p(t('hai')), { type: 'bulletList', content: [li(p(t('hai.a'))), li(p(t('hai.b')))] }),
        li(p(t('ba'))),
      ],
    },
  ],
  'numbered list with a nested bullet list',
)
eq(markdownToAdf('5. năm\n6. sáu')[0].attrs, { order: 5 }, 'ordered list keeps its start')
eq(
  markdownToAdf('- [ ] chưa\n- [x] xong'),
  [{ type: 'bulletList', content: [li(p(t('☐ chưa'))), li(p(t('☑ xong')))] }],
  'task checkboxes',
)
eq(
  markdownToAdf('- a\n  ```\n  code\n  ```'),
  [{ type: 'bulletList', content: [li(p(t('a')), { type: 'codeBlock', attrs: {}, content: [t('code')] })] }],
  'code inside a list item',
)
eq(
  markdownToAdf('> chú ý\n> **quan trọng**'),
  [{ type: 'blockquote', content: [p(t('chú ý'), { type: 'hardBreak' }, t('quan trọng', 'strong'))] }],
  'quote',
)
{
  const [table] = markdownToAdf('| Mã | Ý nghĩa |\n|---|:---|\n| 401 | hết `token` |\n| 403 | a\\|b |')
  eq(table.type, 'table', 'table')
  eq(table.content!.map((r) => r.content!.map((c) => c.type)), [['tableHeader', 'tableHeader'], ['tableCell', 'tableCell'], ['tableCell', 'tableCell']], 'table rows / header')
  eq(table.content![1].content![1].content, [p(t('hết '), t('token', 'code'))], 'marks inside a cell')
  eq(table.content![2].content![1].content, [p(t('a|b'))], 'escaped pipe in a cell')
}
eq(markdownToAdf('a | b không phải bảng'), [p(t('a | b không phải bảng'))], 'a pipe without a separator row is text')
eq(
  markdownToAdf('đoạn\n# heading\n- item'),
  [p(t('đoạn')), { type: 'heading', attrs: { level: 1 }, content: [t('heading')] }, { type: 'bulletList', content: [li(p(t('item')))] }],
  'blocks interrupt a paragraph',
)

/* ── the way back: a round trip keeps the Markdown ── */
const md = [
  '## Bối cảnh',
  '',
  'Gọi **API** `login()` xem [spec](https://x.y/z)',
  '',
  '1. một',
  '2. hai',
  '   - hai.a',
  '',
  '```swift',
  'let a = 1',
  '```',
  '',
  '| Mã | Ý nghĩa |',
  '| --- | --- |',
  '| 401 | hết hạn |',
  '',
  '> chú ý',
].join('\n')
eq(adfToMarkdown({ type: 'doc', content: markdownToAdf(md) }).markdown, md, 'markdown → adf → markdown')

/* ── description + DoD ── */
{
  const doc = textToAdf('**Mục tiêu**: gửi OTP\n- qua SMS', '- [ ] test xanh\n- review xong')
  eq(doc.content.map((c) => c.type), ['paragraph', 'bulletList', 'heading', 'bulletList'], 'textToAdf layout')
  eq(splitDod(doc), { description: '**Mục tiêu**: gửi OTP\n\n- qua SMS', dod: '- ☐ test xanh\n- review xong' }, 'splitDod gives the Markdown back')
}
eq(
  splitDod({
    type: 'doc',
    content: [p(t('cũ')), { type: 'heading', attrs: { level: 3 }, content: [t('Definition of Done')] }, { type: 'bulletList', content: [li(p(t('xong')))] }],
  }),
  { description: 'cũ', dod: '- xong' },
  'descriptions written before still split',
)
eq(splitDod({ type: 'doc', content: [p(t('chỉ có mô tả'))] }), { description: 'chỉ có mô tả', dod: '' }, 'no DoD heading')
eq(textToAdf('', '').content, [{ type: 'paragraph', content: [] }], 'empty task')

eq(
  splitMarkdownDod('# Mô tả\nlàm A\n\n## Definition of Done\n- xong A'),
  { description: '# Mô tả\nlàm A', dod: '- xong A' },
  'paste split at ## Definition of Done',
)
eq(splitMarkdownDod('làm B\n**DoD:**\n- xong B'), { description: 'làm B', dod: '- xong B' }, 'paste split at **DoD:**')
eq(splitMarkdownDod('làm C\nDoD\n- xong C'), { description: 'làm C', dod: '- xong C' }, 'paste split at a bare DoD line')
eq(splitMarkdownDod('```\nDoD:\n```\nkhông tách'), null, 'DoD inside code does not split')
eq(splitMarkdownDod('DoD là viết tắt của Definition of Done'), null, 'a sentence mentioning DoD does not split')

console.log(bad ? `${bad}/${n} failed` : `jira markdown: ${n} ok`)
process.exit(bad ? 1 : 0)
