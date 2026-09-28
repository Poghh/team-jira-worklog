import 'server-only'

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { getReviewConfig } from './config'

const run = promisify(execFile)

/**
 * Whether this machine can run a review at all.
 *
 * The module has one engine — the Claude Code CLI the reviewer already uses by
 * hand — and no fallback. So before anything is queued the app asks three
 * questions, in order, and stops at the first "no" with a sentence that says
 * what to do about it:
 *
 *   1. is there a `claude` binary we can find?
 *   2. does it run (`--version`)?
 *   3. is it signed in (`auth status` → `loggedIn`)?
 *
 * The binary is looked up by hand rather than trusted to `PATH`: the Next
 * server is often started from an IDE or launchd with a `PATH` that has never
 * seen `~/.local/bin`, where the installer puts it.
 */

export interface ClaudeCheck {
  ok: boolean
  /** Resolved binary, when one was found. */
  bin: string
  version: string
  /** Account the CLI is signed in as — shown so the reviewer knows whose quota this is. */
  account: string
  authMethod: string
  /** What is wrong and what to do, when `ok` is false. */
  problem: string
  checkedAt: number
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveClaudeBin(configured: string): string {
  if (configured) return executable(configured) ? configured : ''
  const home = os.homedir()
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...(process.env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
  ]
  return candidates.find(executable) ?? ''
}

const CACHE_MS = 60_000
const g = globalThis as unknown as { __codeReviewClaudeCheck?: ClaudeCheck }

export async function checkClaude(force = false): Promise<ClaudeCheck> {
  const cached = g.__codeReviewClaudeCheck
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached

  const result = await probe()
  g.__codeReviewClaudeCheck = result
  return result
}

async function probe(): Promise<ClaudeCheck> {
  const base: ClaudeCheck = {
    ok: false,
    bin: '',
    version: '',
    account: '',
    authMethod: '',
    problem: '',
    checkedAt: Date.now(),
  }
  const { claudeBin } = getReviewConfig()
  const bin = resolveClaudeBin(claudeBin)
  if (!bin) {
    return {
      ...base,
      problem: claudeBin
        ? `Không chạy được "${claudeBin}" — kiểm tra lại đường dẫn trong tab Cấu hình.`
        : 'Không tìm thấy Claude Code CLI trên máy. Cài bằng `curl -fsSL https://claude.ai/install.sh | bash` rồi bấm Kiểm tra lại, hoặc điền đường dẫn tới `claude` trong tab Cấu hình.',
    }
  }

  let version = ''
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 20_000 })
    version = stdout.trim()
  } catch (err) {
    return {
      ...base,
      bin,
      problem: `Tìm thấy ${bin} nhưng không chạy được: ${(err as Error).message.split('\n')[0]}`,
    }
  }

  try {
    const { stdout } = await run(bin, ['auth', 'status'], { timeout: 20_000 })
    const status = JSON.parse(stdout) as {
      loggedIn?: boolean
      email?: string
      authMethod?: string
      orgName?: string
    }
    if (!status.loggedIn) {
      return {
        ...base,
        bin,
        version,
        problem: 'Claude Code CLI chưa đăng nhập. Chạy `claude auth login` trong Terminal rồi bấm Kiểm tra lại.',
      }
    }
    return {
      ...base,
      ok: true,
      bin,
      version,
      account: status.email || status.orgName || '',
      authMethod: status.authMethod ?? '',
    }
  } catch (err) {
    // `auth status` exits non-zero when signed out on some versions; its
    // stdout may still carry the JSON.
    const out = (err as { stdout?: string }).stdout ?? ''
    if (/"loggedIn"\s*:\s*false/.test(out)) {
      return {
        ...base,
        bin,
        version,
        problem: 'Claude Code CLI chưa đăng nhập. Chạy `claude auth login` trong Terminal rồi bấm Kiểm tra lại.',
      }
    }
    return {
      ...base,
      bin,
      version,
      problem: `Không đọc được trạng thái đăng nhập (\`claude auth status\`): ${(err as Error).message.split('\n')[0]}`,
    }
  }
}
