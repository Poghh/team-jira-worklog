/**
 * Confluence storage ⇄ Markdown, inline-comment anchoring, and pasted links.
 *
 * Run: npx tsx tests/code-review-confluence.mts
 */
import {
  locateQuote,
  markdownToStorage,
  parsePageUrl,
  storageToMarkdown,
  storageToText,
} from '@/lib/modules/code-review/confluence-md'

let n = 0
let bad = 0
const eq = (got: unknown, want: unknown, m: string) => {
  n++
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++
    console.log('FAIL', m, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want))
  }
}
const has = (got: string, part: string, m: string) => {
  n++
  if (!got.includes(part)) {
    bad++
    console.log('FAIL', m, '\n  missing', JSON.stringify(part), '\n  in', JSON.stringify(got))
  }
}

const H = 'ossworks.atlassian.net'
eq(parsePageUrl('https://ossworks.atlassian.net/wiki/spaces/VT/pages/334397471/Mobile+Technical', H), '334397471', 'page link')
eq(parsePageUrl('https://ossworks.atlassian.net/wiki/spaces/VT/pages/edit-v2/334397471', H), '334397471', 'edit link')
eq(parsePageUrl('https://ossworks.atlassian.net/wiki/pages/viewpage.action?pageId=42', H), '42', 'viewpage link')
eq(parsePageUrl('https://ossworks.atlassian.net/wiki/x/kgKvEw', H), '330236562', 'tiny link')
eq(parsePageUrl('https://evil.example.com/wiki/spaces/VT/pages/1/x', H), null, 'other host refused')
eq(parsePageUrl('not a url', H), null, 'garbage')

const page = `<h2>Luồng &ldquo;đăng nhập&rdquo;</h2><p>Gọi <code>login()</code> rồi <strong>lưu token</strong> v&agrave;o Keychain.</p>
<ul><li>Bước 1<ul><li>con</li></ul></li><li>Bước 2</li></ul>
<table><tbody><tr><th>Mức</th><th>Ý nghĩa</th></tr><tr><td><p>FULL</p></td><td>fsync | mỗi commit</td></tr></tbody></table>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">swift</ac:parameter><ac:plain-text-body><![CDATA[let a = 1 < 2]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Lưu ý</p></ac:rich-text-body></ac:structured-macro>
<p><ac:image><ri:attachment ri:filename="flow.png" /></ac:image> và <ac:link><ri:page ri:content-title="TDD SDK" /></ac:link></p>
<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>xong</ac:task-body></ac:task></ac:task-list>`
const md = storageToMarkdown(page, { image: (f) => (f === 'flow.png' ? '/abs/flow.png' : '') })
has(md.markdown, '## Luồng “đăng nhập”', 'heading + entities')
has(md.markdown, 'Gọi `login()` rồi **lưu token** vào Keychain.', 'inline marks + accented entity')
has(md.markdown, '- Bước 1\n  - con\n- Bước 2', 'nested list')
has(md.markdown, '| Mức | Ý nghĩa |\n| --- | --- |\n| FULL | fsync \\| mỗi commit |', 'table')
has(md.markdown, '```swift\nlet a = 1 < 2\n```', 'code macro')
has(md.markdown, '> **Info**\n> Lưu ý', 'info panel')
has(md.markdown, '![flow.png](/abs/flow.png)', 'saved image')
has(md.markdown, '[TDD SDK]', 'page link')
has(md.markdown, '- [x] xong', 'task')
eq(md.images, ['flow.png'], 'images listed')

const text = storageToText(page)
eq(locateQuote(text, 'lưu token vào Keychain'), { selection: 'lưu token vào Keychain', count: 1, index: 0 }, 'quote found')
eq(locateQuote(text, '**lưu token**  vào'), { selection: 'lưu token vào', count: 1, index: 0 }, 'markdown + spaces ignored')
eq(locateQuote(text, 'không có trong trang'), null, 'quote missing')
eq(locateQuote(text, 'Bước')?.count, 2, 'match count')

const st = markdownToStorage('Nên **đổi** `a<b`:\n\n```swift\nlet x = 1\n```\n- một\n- hai\n\n> trích')
has(st, '<p>Nên <strong>đổi</strong> <code>a&lt;b</code>:</p>', 'comment paragraph')
has(st, '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">swift</ac:parameter><ac:plain-text-body><![CDATA[let x = 1]]>', 'comment code block')
has(st, '<ul><li>một</li><li>hai</li></ul>', 'comment list')
has(st, '<blockquote><p>trích</p></blockquote>', 'comment quote')

console.log(bad ? `${bad}/${n} failed` : `code-review confluence: ${n} ok`)
process.exit(bad ? 1 : 0)
