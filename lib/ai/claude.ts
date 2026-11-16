import 'server-only'

import { spawn } from 'node:child_process'
import os from 'node:os'
import * as z from 'zod/v4'

import { SETTING_KEYS, getSetting } from '../settings'
import { probeClaude } from './cli'
import { RetryableError, withRetry } from './retry'

export interface GeneratedTask {
  title: string
  description: string
  dod: string
  storyPoints?: number
}

/** Attempts per model before giving up. */
const MAX_ATTEMPTS = 4

/** One call is a few seconds; this is the ceiling before we give up on it. */
const TIMEOUT_MS = 120_000

/**
 * The shape the model must return.
 *
 * Passed to the CLI as `--json-schema`, so the constraint is on decoding
 * rather than on a line in the prompt asking nicely for JSON: the old "model
 * wrapped its answer in a fence" and "model wrote prose instead" failures
 * cannot happen. The same object then parses the reply, so the thing we asked
 * for and the thing we accept cannot drift apart.
 */
const TaskSchema = z.object({
  title: z.string(),
  description: z.string(),
  dod: z.string(),
  storyPoints: z.number().int(),
})

// `$schema` bị bỏ đi: zod gắn vào dòng `https://json-schema.org/draft/2020-12/
// schema`, còn CLI từ chối thẳng vì nó không tra được ref đó — "no schema with
// key or ref". Phần thân schema thì CLI đọc bình thường.
const { $schema: _draft, ...SCHEMA_BODY } = z.toJSONSchema(TaskSchema)
const JSON_SCHEMA = JSON.stringify(SCHEMA_BODY)

/**
 * Model đôi khi trả chuỗi có `\\n` dạng chữ (hai ký tự) thay vì xuống dòng
 * thật — chép theo ví dụ JSON. Đổi lại thành xuống dòng để Jira hiện đúng
 * danh sách gạch đầu dòng.
 */
export function unescapeLines(text: string) {
  return text.replace(/\\r\\n|\\n/g, '\n').trim()
}

/**
 * The model is told NOT to emit prefixes. The app composes `[spt 66][Mobile]`
 * itself from the sprint and the user's chips, because a model asked to follow
 * a bracket convention will eventually produce `[mobile]` or `[Mob]` and the
 * drift is invisible until someone greps the backlog.
 */
function buildSystem(pointRules: string) {
  return `Bạn là trợ lý viết task cho một team phát triển phần mềm người Việt.

Từ mô tả của lập trình viên, hãy viết:
1. title — một dòng, tiếng Việt, ngắn gọn, nêu rõ việc phải làm. KHÔNG thêm bất kỳ tiền tố nào trong ngoặc vuông.
2. description — 3 đến 5 gạch đầu dòng "- ", tiếng Việt, mỗi dòng một việc cần xử lý, tối đa khoảng 20 từ.
3. dod — Definition of Done, 2 đến 4 gạch đầu dòng "- ", mỗi dòng là một điều kiện kiểm chứng được, tối đa khoảng 20 từ.
4. storyPoints — số nguyên 1, 2 hoặc 3.

Viết NGẮN như một ticket Jira, không phải báo cáo:
- Mô tả của lập trình viên có thể dài hoặc dán kèm ghi chú, log, kết quả điều tra. Chỉ rút ra việc cần làm; KHÔNG chép lại số liệu, tên file, dòng code, bằng chứng hay kết luận đã có.
- Không tiêu đề phụ, không đoạn văn, không gạch đầu dòng lồng nhau, không dòng "Mục tiêu:" hay "Output:".
- Mỗi dòng bắt đầu bằng động từ.

Mỗi gạch đầu dòng nằm trên một dòng riêng (xuống dòng thật, không viết chữ "\\n").

Ví dụ:
title: Thêm nút xoá tin nhắn trong màn chat
description:
- Thêm action Xoá vào menu nhấn giữ tin nhắn
- Gọi API redact và cập nhật timeline
- Hiện xác nhận trước khi xoá
dod:
- Xoá được tin của chính mình, tin biến mất ở cả hai phía
- Không hiện Xoá với tin của người khác
storyPoints: 2

Quy tắc story point của team:
${pointRules}
Không có point lớn hơn 3. Việc lớn hơn phải tách thành nhiều task con.`
}

function buildUser(idea: string, parentSummary?: string) {
  return `${parentSummary ? `Task này là task con của: "${parentSummary}"\n\n` : ''}Mô tả của lập trình viên:
"""
${idea}
"""`
}

/**
 * What `--output-format json` hands back. Only the fields we act on.
 *
 * `structured_output` is the schema-shaped object; `result` is the same thing
 * as text on success, and the error sentence on failure.
 */
interface CliResult {
  is_error?: boolean
  result?: string
  structured_output?: unknown
  modelUsage?: Record<string, unknown>
}

/**
 * Failures that another attempt can plausibly clear.
 *
 * Deliberately narrow, and narrower than it first looked: "try again" was in
 * here until a 400 saying *"version 2.1.280 or newer is required … then try
 * again"* matched it. Permanent errors routinely end with advice that reads
 * like a retry hint, so match the failure, never the advice.
 */
const RETRYABLE = /overload|quá tải|rate.?limit|429|5[02]\d|temporar|timed? ?out/i

function runClaude(bin: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      // A neutral directory: run from the project and the CLI would pick up
      // its CLAUDE.md and `.claude/`, folding this repo's instructions into a
      // prompt about writing a Jira ticket.
      cwd: os.tmpdir(),
      // Closed, not inherited: the CLI waits three seconds for piped input
      // before giving up on it, and there is none coming.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new RetryableError(`Không chạy được ${bin}: ${e.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal === 'SIGKILL') {
        return reject(new RetryableError(`Claude CLI chạy quá ${TIMEOUT_MS / 1000}s, đã dừng`))
      }
      try {
        resolve(JSON.parse(out) as CliResult)
      } catch {
        // No JSON at all means the CLI fell over before it could answer —
        // its stderr is the only thing that says why.
        reject(
          new Error(
            `Claude CLI thoát với mã ${code}: ${(err || out).trim().split('\n')[0] || 'không có thông báo'}`,
          ),
        )
      }
    })
  })
}

/**
 * One call returning the schema-shaped object, unparsed. Throws
 * RetryableError for anything worth another go.
 */
async function callStructured(
  bin: string,
  model: string,
  system: string,
  user: string,
  schemaJson: string,
): Promise<unknown> {
  const res = await runClaude(bin, [
    '-p',
    user,
    '--output-format',
    'json',
    '--json-schema',
    schemaJson,
    // Replaces Claude Code's own system prompt instead of appending to it.
    // Appending left the whole coding-agent persona in front of a request to
    // write one Jira ticket — 42k tokens of context for a 500-token job.
    '--system-prompt',
    system,
    // Nothing from ~/.claude, nothing from any repo: no hooks, no skills, no
    // MCP server. This call writes text; it has no business reading anything.
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--allowedTools',
    '',
    // Never sit waiting for a permission answer nobody is there to give.
    '--permission-mode',
    'dontAsk',
    ...(model ? ['--model', model] : []),
  ])

  if (res.is_error) {
    const message = (res.result ?? '').trim() || 'Claude CLI báo lỗi'
    if (/not logged in|logged out|\/login/i.test(message)) {
      throw new Error('Claude Code CLI chưa đăng nhập. Chạy `claude auth login` trong Terminal.')
    }
    if (RETRYABLE.test(message)) throw new RetryableError(message)
    throw new Error(message)
  }
  return res.structured_output
}

/** One task-writing call. Throws RetryableError for anything worth another go. */
async function callOnce(
  bin: string,
  model: string,
  system: string,
  user: string,
): Promise<GeneratedTask> {
  const parsed = TaskSchema.safeParse(await callStructured(bin, model, system, user, JSON_SCHEMA))
  if (!parsed.success) {
    // With `--json-schema` in force this should not happen; when it does it is
    // a bad roll rather than a standing failure.
    throw new RetryableError('Claude không trả về nội dung đúng dạng')
  }
  if (!parsed.data.title.trim()) throw new RetryableError('Claude trả về thiếu title')

  return {
    title: parsed.data.title.trim(),
    description: unescapeLines(parsed.data.description),
    dod: unescapeLines(parsed.data.dod),
    // Clamp rather than trust: the team's scale stops at 3 and a stray 5 or 8
    // would sail straight into Jira.
    storyPoints: Math.min(3, Math.max(1, parsed.data.storyPoints)),
  }
}

export interface GenerateOutcome extends GeneratedTask {
  /** Attempts used, so the UI can mention when it had to fight for a result. */
  attempts: number
  /** Which model actually answered — may be a fallback. */
  model: string
}

/**
 * Runs the prompt through the Claude Code CLI, falling through to a spare
 * model when the primary is out of quota.
 *
 * Retrying alone cannot help there: a spent quota stays spent for the rest of
 * the window, so the only way through is a different model. Transient failures
 * are still handled by the retry inside each attempt.
 */
export async function generateTask(
  idea: string,
  context: { pointRules: string; parentSummary?: string },
): Promise<GenerateOutcome> {
  const system = buildSystem(context.pointRules)
  const user = buildUser(idea, context.parentSummary)
  return withModels((bin, model) => callOnce(bin, model, system, user))
}

/**
 * Chạy `call` qua model chính rồi các model dự phòng khi model trước hết quota;
 * lỗi tạm thời thì thử lại trong từng model.
 */
async function withModels<T extends object>(
  call: (bin: string, model: string) => Promise<T>,
): Promise<T & { attempts: number; model: string }> {
  const check = await probeClaude(getSetting(SETTING_KEYS.claudeBin) ?? '')
  if (!check.ok) throw new Error(check.problem)

  const primary = getSetting(SETTING_KEYS.claudeModel)?.trim() ?? ''
  const fallbacks = (getSetting(SETTING_KEYS.claudeFallbackModels) ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== primary)

  let totalAttempts = 0
  let last: Error | null = null

  for (const model of [primary, ...fallbacks]) {
    // Đếm tay vì `withRetry` nuốt mất số lần khi nó bỏ cuộc. Cộng đại
    // MAX_ATTEMPTS như bản trước là nói dối: một model hỏng ngay từ lần đầu
    // vẫn bị tính đủ bốn lần, và con số đó hiện lên cho người dùng xem.
    let used = 0
    try {
      const { value, attempts } = await withRetry(
        () => {
          used++
          return call(check.bin, model)
        },
        { maxAttempts: MAX_ATTEMPTS },
      )
      return { ...value, attempts: totalAttempts + attempts, model: model || check.version }
    } catch (error) {
      totalAttempts += used
      last = error instanceof Error ? error : new Error(String(error))
      // A signed-out CLI or a declined prompt fails the same on every model.
      if (!RETRYABLE.test(last.message) && !/quota|giới hạn|không trả về/i.test(last.message)) {
        throw last
      }
    }
  }

  throw last ?? new Error('Claude lỗi')
}

export function pointRulesText(): string {
  const rules = [
    ['1', getSetting(SETTING_KEYS.pointBudget1) ?? '1-2h'],
    ['2', getSetting(SETTING_KEYS.pointBudget2) ?? '4h'],
    ['3', getSetting(SETTING_KEYS.pointBudget3) ?? '1d-2d'],
  ]
  return rules.map(([p, spec]) => `- ${p} point = ${spec}`).join('\n')
}

const ChangesSchema = z.object({ changes: z.array(z.string()) })
const { $schema: _draft2, ...CHANGES_BODY } = z.toJSONSchema(ChangesSchema)
const CHANGES_SCHEMA = JSON.stringify(CHANGES_BODY)

const CHANGES_SYSTEM = `You write the change list of a pull request description for a mobile/chat app team.

Given the commit messages and the diff, return "changes": 3 to 8 short items.
- Each item is one user-visible or reviewer-relevant change, in English, imperative mood ("Limit title input…", "Show…", "Keep…").
- At most about 15 words each, no trailing period, no leading "- ".
- Describe behaviour, not files or line numbers. Group related edits into one item.
- Mention refactors, comment-only or test-only work in one short item only if it is a large part of the diff.
- Do not invent anything the diff does not show. Do not repeat Jira keys.`

/** Gợi ý danh sách thay đổi của một PR từ commit và diff. Chỉ đọc dữ liệu đưa vào. */
export async function summarizeChanges(input: {
  commits: string[]
  files: Array<{ path: string; additions: number; deletions: number; patch?: string }>
}): Promise<{ changes: string[]; model: string; attempts: number }> {
  const MAX_PATCH = 60_000
  let budget = MAX_PATCH
  const diff: string[] = []
  for (const f of input.files) {
    const head = `--- ${f.path} (+${f.additions} -${f.deletions})`
    const patch = f.patch && budget > 0 ? f.patch.slice(0, Math.min(budget, 6_000)) : ''
    budget -= patch.length
    diff.push(patch ? `${head}\n${patch}` : `${head} (patch omitted)`)
  }
  const user = `Commit messages:\n${input.commits.map((c) => `* ${c.trim()}`).join('\n') || '(none)'}\n\nDiff:\n${diff.join('\n\n')}`

  return withModels(async (bin, model) => {
    const parsed = ChangesSchema.safeParse(await callStructured(bin, model, CHANGES_SYSTEM, user, CHANGES_SCHEMA))
    if (!parsed.success) throw new RetryableError('Claude không trả về nội dung đúng dạng')
    const changes = parsed.data.changes
      .map((c) => unescapeLines(c).replace(/^[-*•]\s*/, '').replace(/\.$/, '').trim())
      .filter(Boolean)
    if (!changes.length) throw new RetryableError('Claude trả về danh sách rỗng')
    return { changes }
  })
}
