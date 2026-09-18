/**
 * The Jira client's retry rule, checked against a real HTTP server.
 *
 * Run: npx tsx --conditions=react-server tests/jira-retry.mts
 *
 * The `react-server` condition is what makes `server-only` resolve to its
 * empty stub instead of the module that throws — the same thing Next does.
 *
 * The write case is the one to keep: this app logs hours into a Jira other
 * people read, and a retried POST would log them twice.
 */
import http from 'node:http'
import { jiraFetch } from '@/lib/jira/client'

const creds = { baseUrl: 'http://127.0.0.1:8791', email: 'a@b.c', apiToken: 'x' }
const hits: string[] = []
let plan: number[] = []

const srv = http.createServer((req, res) => {
  hits.push(req.method + ' ' + req.url)
  const code = plan.shift() ?? 200
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(code === 200 ? JSON.stringify({ ok: true, n: hits.length }) : '')
})
await new Promise<void>((r) => srv.listen(8791, '127.0.0.1', r))

let n = 0, bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b)) }
}

// A 500 that clears on the second attempt — the case seen against Atlassian.
plan = [500]; hits.length = 0
eq(await jiraFetch('/a', { creds, fresh: true }), { ok: true, n: 2 }, 'read: 500 rồi 200 -> trả kết quả')
eq(hits.length, 2, 'read: gọi lại đúng 1 lần')

// Still failing after every attempt: the error reaches the caller as before.
plan = [500, 500, 500]; hits.length = 0
eq(await jiraFetch('/b', { creds, fresh: true }).then(() => 'ok', (e) => e.status), 500, 'read: hỏng mãi -> vẫn ném lỗi')
eq(hits.length, 3, 'read: đúng 3 lần rồi thôi')

// A 4xx is the request's own fault; retrying it only wastes the user's time.
plan = [404]; hits.length = 0
eq(await jiraFetch('/c', { creds, fresh: true }).then(() => 'ok', (e) => e.status), 404, 'read: 404 -> ném ngay')
eq(hits.length, 1, 'read: 404 không gọi lại')

// The one that matters: a retried write would log the same hours twice.
plan = [500]; hits.length = 0
eq(await jiraFetch('/d', { creds, body: { t: 1 }, method: 'POST' }).then(() => 'ok', (e) => e.status), 500, 'write: 500 -> ném ngay')
eq(hits.length, 1, 'write KHÔNG gọi lại — retry sẽ ghi trùng worklog')

srv.close()
console.log(bad ? `\n${bad}/${n} FAILED` : `\nall ${n} ok`)
process.exit(bad ? 1 : 0)
