/**
 * Jira tickets as PR review requirements: ADF → Markdown, a whole ticket, and
 * which keys a PR names on its own.
 *
 * Run: npx tsx tests/code-review-jira.mts
 */
import { adfToMarkdown, ticketToMarkdown } from '@/lib/modules/code-review/jira-md'
import { NO_JIRA, detectJiraKeys, parseJiraKeys, ticketPlan } from '@/lib/modules/code-review/model'

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

function t(text: string, marks?: unknown[]) {
  return marks ? { type: 'text', text, marks } : { type: 'text', text }
}
function p(...content: unknown[]) {
  return { type: 'paragraph', content }
}
function doc(...content: unknown[]) {
  return { type: 'doc', version: 1, content }
}

/* ── ADF ── */
{
  const r = adfToMarkdown(
    doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Luồng')] },
      p(t('Gọi '), t('login()', [{ type: 'code' }]), t(' rồi xem '), t('spec', [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/spaces/A/pages/123/Spec' } }])),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('một'))] }, { type: 'listItem', content: [p(t('hai')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('hai.một'))] }] }] }] },
      { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [p(t('ba'))] }] },
      { type: 'codeBlock', attrs: { language: 'swift' }, content: [t('let a = 1')] },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Mã'))] }, { type: 'tableHeader', content: [p(t('Ý nghĩa'))] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('401'))] }, { type: 'tableCell', content: [p(t('hết a|b'))] }] },
        ],
      },
      p({ type: 'inlineCard', attrs: { url: 'https://x.atlassian.net/browse/VTL-1' } }, t(' '), { type: 'mention', attrs: { text: '@An' } }),
      { type: 'panel', attrs: { panelType: 'warning' }, content: [p(t('Chú ý'))] },
    ),
  )
  has(r.markdown, '### Luồng', 'heading one level below the ticket title')
  has(r.markdown, 'Gọi `login()` rồi xem [spec](https://x.atlassian.net/wiki/spaces/A/pages/123/Spec)', 'marks and links')
  has(r.markdown, '- một\n- hai\n\n  - hai.một', 'nested list')
  has(r.markdown, '3. ba', 'ordered list start')
  has(r.markdown, '```swift\nlet a = 1\n```', 'code block')
  has(r.markdown, '| Mã | Ý nghĩa |\n| --- | --- |\n| 401 | hết a\\|b |', 'table, pipes escaped')
  has(r.markdown, 'https://x.atlassian.net/browse/VTL-1 @An', 'card and mention')
  has(r.markdown, '> **[warning]** Chú ý', 'panel')
  eq(r.links, ['https://x.atlassian.net/wiki/spaces/A/pages/123/Spec', 'https://x.atlassian.net/browse/VTL-1'], 'links collected')
  eq(adfToMarkdown(null).markdown, '', 'no description')
}

/* ── a ticket ── */
{
  const r = ticketToMarkdown({
    issue: {
      key: 'VTL-2',
      names: { customfield_1: 'Acceptance criteria' },
      fields: {
        summary: 'Đăng nhập iOS',
        updated: '2026-10-20T09:15:00.000+0700',
        status: { name: 'In Progress' },
        issuetype: { name: 'Sub-task', subtask: true },
        parent: { key: 'VTL-1', fields: { summary: 'Đăng nhập' } },
        description: doc(p(t('Làm màn login'))),
        customfield_1: doc(p(t('Sai mật khẩu 3 lần thì khoá'))),
        subtasks: [],
        comment: { comments: [{ author: { displayName: 'Bình' }, created: '2026-10-21T00:00:00', body: doc(p(t('Đổi: khoá sau 5 lần'))) }] },
      },
    },
    url: 'https://x.atlassian.net/browse/VTL-2',
    remote: [{ object: { url: 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=77', title: 'TDD iOS' }, application: { name: 'Confluence' } }],
    parent: { key: 'VTL-1', fields: { summary: 'Đăng nhập', description: doc(p(t('Yêu cầu chung'))) } },
  })
  has(r.markdown, '# VTL-2 · Đăng nhập iOS', 'title')
  has(r.markdown, 'Trạng thái: In Progress', 'status')
  has(r.markdown, '## Acceptance criteria\n\nSai mật khẩu 3 lần thì khoá', 'custom rich-text field by its name')
  has(r.markdown, '**Bình** (2026-10-21):\n\nĐổi: khoá sau 5 lần', 'comments')
  has(r.markdown, '## Ticket cha VTL-1 · Đăng nhập\n\nYêu cầu chung', 'parent requirement')
  has(r.markdown, '- TDD iOS (Confluence): https://x.atlassian.net/wiki/pages/viewpage.action?pageId=77', 'remote link')
  eq(r.links, ['https://x.atlassian.net/wiki/pages/viewpage.action?pageId=77'], 'remote link collected')
}

/* ── keys ── */
eq(parseJiraKeys('https://x.atlassian.net/browse/VTL-286\nCTALK-12, VTL-286 ?selectedIssue=KAN-9'), ['VTL-286', 'CTALK-12', 'KAN-9'], 'links and bare keys, deduped')
eq(parseJiraKeys('UTF-8 SHA-256 ISO-8601 step-2'), [], 'not tickets')
eq(detectJiraKeys({ branch: 'ctalk/bugfix/vtl-286_VTL-610', title: 'Fix VTL-700 login', body: 'Xem KAN-1' }), ['VTL-286', 'VTL-610', 'VTL-700', 'KAN-1'], 'branch, title, body')
eq(detectJiraKeys({ branch: 'release/2.1', title: 'Bump', body: '' }), [], 'nothing to detect')
eq(
  ticketPlan({ keys: ['VTL-1'], auto: true }, { branch: 'feature/VTL-1_VTL-2', title: '' }),
  [{ key: 'VTL-1', auto: false }, { key: 'VTL-2', auto: true }],
  'pasted first, detected after, once each',
)
eq(ticketPlan({ keys: [], auto: false }, { branch: 'feature/VTL-2', title: '' }), [], 'auto off')
eq(NO_JIRA.auto, true, 'auto on by default')

console.log(bad ? `${bad}/${n} failed` : `code-review jira: ${n} ok`)
process.exit(bad ? 1 : 0)
