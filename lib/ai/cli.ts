import 'server-only'

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Finding and vetting the Claude Code CLI.
 *
 * Two features run on it — "Task mới" sinh nội dung và module Review code —
 * and both need the same three answers before they can do anything:
 *
 *   1. is there a `claude` binary we can find?
 *   2. does it run (`--version`)?
 *   3. is it signed in (`auth status` → `loggedIn`)?
 *
 * This file owns those answers so there is one copy of them. The binary is
 * looked up by hand rather than trusted to `PATH`: the Next server is often
 * started from an IDE or launchd with a `PATH` that has never seen
 * `~/.local/bin`, where the installer puts it.
 */

export interface ClaudeCheck {
  ok: boolean
  /** Resolved binary, when one was found. */
  bin: string
  version: string
  /** Account the CLI is signed in as — shown so the user knows whose quota this is. */
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

export async function probeClaude(configured: string): Promise<ClaudeCheck> {
  const base: ClaudeCheck = {
    ok: false,
    bin: '',
    version: '',
    account: '',
    authMethod: '',
    problem: '',
    checkedAt: Date.now(),
  }
  const bin = resolveClaudeBin(configured)
  if (!bin) {
    return {
      ...base,
      problem: configured
        ? `Không chạy được "${configured}" — kiểm tra lại đường dẫn trong Settings.`
        : 'Không tìm thấy Claude Code CLI trên máy. Cài bằng `curl -fsSL https://claude.ai/install.sh | bash` rồi kiểm tra lại, hoặc điền đường dẫn tới `claude` trong Settings.',
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
        problem: 'Claude Code CLI chưa đăng nhập. Chạy `claude auth login` trong Terminal rồi kiểm tra lại.',
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
        problem: 'Claude Code CLI chưa đăng nhập. Chạy `claude auth login` trong Terminal rồi kiểm tra lại.',
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
