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
 * The model is told NOT to emit prefixes. The app composes `[spt 66][Mobile]`
 * itself from the sprint and the user's chips, because a model asked to follow
 * a bracket convention will eventually produce `[mobile]` or `[Mob]` and the
 * drift is invisible until someone greps the backlog.
 */
function buildSystem(pointRules: string) {
  return `Bạn là trợ lý viết task cho một team phát triển phần mềm người Việt.

Từ mô tả ngắn của lập trình viên, hãy viết:
1. title — một dòng, tiếng Việt, ngắn gọn, nêu rõ việc phải làm. KHÔNG thêm bất kỳ tiền tố nào trong ngoặc vuông.
2. description — các gạch đầu dòng mô tả công việc cần xử lý, tiếng Việt.
3. dod — Definition of Done, các gạch đầu dòng, mỗi dòng là một điều kiện kiểm chứng được.
4. storyPoints — số nguyên 1, 2 hoặc 3.

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

/** One call. Throws RetryableError for anything worth another go. */
async function callOnce(
  bin: string,
  model: string,
  system: string,
  user: string,
): Promise<GeneratedTask> {
  const res = await runClaude(bin, [
    '-p',
    user,
    '--output-format',
    'json',
    '--json-schema',
    JSON_SCHEMA,
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

  const parsed = TaskSchema.safeParse(res.structured_output)
  if (!parsed.success) {
    // With `--json-schema` in force this should not happen; when it does it is
    // a bad roll rather than a standing failure.
    throw new RetryableError('Claude không trả về nội dung đúng dạng')
  }
  if (!parsed.data.title.trim()) throw new RetryableError('Claude trả về thiếu title')

  return {
    title: parsed.data.title.trim(),
    description: parsed.data.description.trim(),
    dod: parsed.data.dod.trim(),
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
  const check = await probeClaude(getSetting(SETTING_KEYS.claudeBin) ?? '')
  if (!check.ok) throw new Error(check.problem)

  const primary = getSetting(SETTING_KEYS.claudeModel)?.trim() ?? ''
  const fallbacks = (getSetting(SETTING_KEYS.claudeFallbackModels) ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== primary)

  const system = buildSystem(context.pointRules)
  const user = buildUser(idea, context.parentSummary)

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
          return callOnce(check.bin, model, system, user)
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
