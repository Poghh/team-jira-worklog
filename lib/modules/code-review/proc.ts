import 'server-only'

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

/**
 * Watching a detached `claude -p` from the outside: is it alive, did the
 * machine reboot under it, and what did its stream-json log end with. Shared
 * by review rounds (runner.ts) and follow-up chat turns (chat.ts).
 */

const run = promisify(execFile)

export async function bootTime(): Promise<number> {
  try {
    const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 5_000 })
    const m = /sec\s*=\s*(\d+)/.exec(stdout)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}


export interface ResultEvent {
  type: 'result'
  subtype?: string
  is_error?: boolean
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  session_id?: string
  errors?: string[]
}

export async function readLog(logPath: string): Promise<string> {
  try {
    return await fs.readFile(logPath, 'utf8')
  } catch {
    return ''
  }
}

export function lastResult(log: string): ResultEvent | null {
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{')) continue
    try {
      const e = JSON.parse(l)
      if (e?.type === 'result') return e as ResultEvent
    } catch {}
  }
  return null
}

/** Lines of the log that are not stream-json — the CLI's own complaints. */
export function strayLines(log: string): string {
  return log
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('{'))
    .slice(-6)
    .join(' ')
    .slice(0, 600)
}


export interface LogLine {
  kind: 'tool' | 'text' | 'result' | 'error'
  text: string
}

function short(s: unknown, n = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => {
    const s = String(p ?? '')
    if (cwd && s.startsWith(cwd)) return s.slice(cwd.length + 1) || '.'
    // Outside the worktree is the uploaded PDFs: the name is what matters.
    return s.startsWith('/') ? path.basename(s) : s
  }
  switch (name) {
    case 'Read':
      return `📖 ${rel(input.file_path)}${input.offset ? ` @${input.offset}` : ''}${input.pages ? ` tr.${input.pages}` : ''}`
    case 'Grep':
      return `🔎 grep ${short(input.pattern, 80)}${input.path ? ` trong ${rel(input.path)}` : ''}`
    case 'Glob':
      return `🗂 ${short(input.pattern, 80)}`
    case 'Bash':
      return `$ ${short(input.command, 160)}`
    case 'StructuredOutput':
      return '📝 Ghi kết quả'
    default:
      return `🔧 ${name}`
  }
}

/** A stream-json log as a reviewer wants to watch it: what Claude is reading, and why. */
export function parseLog(raw: string, workdir: string, limit = 250): LogLine[] {
  const out: LogLine[] = []
  for (const l of raw.split('\n')) {
    const line = l.trim()
    if (!line) continue
    if (!line.startsWith('{')) {
      out.push({ kind: 'error', text: short(line, 400) })
      continue
    }
    let e: {
      type?: string
      message?: { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> }
      subtype?: string
      is_error?: boolean
      num_turns?: number
      total_cost_usd?: number
      duration_ms?: number
    }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') out.push({ kind: 'tool', text: describeTool(c.name ?? '', c.input ?? {}, workdir) })
        else if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: short(c.text, 600) })
      }
    } else if (e.type === 'result') {
      out.push({
        kind: e.is_error ? 'error' : 'result',
        text: `${e.is_error ? '✗ Lỗi' : '✓ Xong'} · ${e.num_turns ?? '?'} lượt · ${Math.round((e.duration_ms ?? 0) / 1000)}s${e.total_cost_usd ? ` · ~$${e.total_cost_usd.toFixed(2)}` : ''}`,
      })
    }
  }
  return out.slice(-limit)
}

