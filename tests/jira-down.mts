/**
 * Telling "the tunnel is down" apart from "the request was wrong".
 *
 * Run: npx tsx --conditions=react-server tests/jira-down.mts
 *
 * The cost of getting this wrong runs both ways and neither is cheap: classify
 * an expired token as a VPN problem and somebody spends the afternoon
 * reconnecting a VPN that was never off; classify the allowlist refusal as a
 * real error and they get the stack trace this was built to replace.
 */
import { JiraError, jiraBlockedBy } from '@/lib/jira/client'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (a !== b) {
    bad++
    console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}

/* ── the IP allowlist, in Atlassian's own words ─────────────────────────── */
const ATLASSIAN =
  "You're unable to access content because your IP address is not listed in the IP allowlist. Contact your admin for help."

eq(jiraBlockedBy(new JiraError(ATLASSIAN, 403, '/rest/api/3/myself')), 'allowlist',
   'the sentence Atlassian actually sends')
// Classified on the sentence, not the status: our own describeError has already
// rewritten the message by the time some callers see it.
eq(jiraBlockedBy(new JiraError('Jira chặn IP này — bật VPN lên rồi thử lại', 403, '/x')), 'allowlist',
   'and our own rewrite of it, so a message classified twice stays classified')
// The refusal can arrive as an unparsed body rather than as the message.
eq(jiraBlockedBy(new JiraError('Jira trả về HTTP 403', 403, '/x', { message: ATLASSIAN })), 'allowlist',
   'or buried in the body')

/* ── never reached Jira at all ──────────────────────────────────────────── */
eq(jiraBlockedBy(new TypeError('fetch failed')), 'offline', 'a bare undici failure')
eq(jiraBlockedBy(new JiraError('Không nối được tới Jira (ECONNREFUSED)', 0, '/x')), 'offline',
   'the wrapper jiraFetch puts around one')
for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
  eq(jiraBlockedBy(new JiraError(`Không nối được tới Jira (${code})`, 0, '/x')), 'offline',
     `${code} is the tunnel, not the request`)
}

/* ── everything else must NOT be dressed up as a VPN problem ────────────── */
// 401 and 403 are the trap: the same statuses the allowlist uses, and the one
// place where "check your VPN" sends somebody the wrong way for an afternoon.
eq(jiraBlockedBy(new JiraError('Sai email hoặc API token', 401, '/x')), null,
   'an expired token is not a VPN problem')
eq(jiraBlockedBy(new JiraError('Token hợp lệ nhưng không đủ quyền', 403, '/x')), null,
   'and neither is a permissions problem, which shares the status')
eq(jiraBlockedBy(new JiraError('Không tìm thấy — kiểm tra lại key hoặc quyền truy cập', 404, '/x')), null,
   'nor a missing issue')
eq(jiraBlockedBy(new JiraError('Jira trả về HTTP 500', 500, '/x')), null,
   'nor Jira falling over, which is theirs to fix and ours to report honestly')
eq(jiraBlockedBy(new JiraError('Chưa cấu hình Jira — vào Settings điền URL, email và API token', 0, '/x')), null,
   'nor an unconfigured app, which shares status 0 with the offline wrapper')
eq(jiraBlockedBy(new Error('Cannot read properties of undefined')), null,
   'a real bug stays a real bug')
eq(jiraBlockedBy('fetch failed'), null, 'a non-Error is not classified at all')
eq(jiraBlockedBy(null), null, 'and neither is nothing')

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} ok`)
if (bad) process.exit(1)
