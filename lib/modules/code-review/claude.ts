import 'server-only'

import { type ClaudeCheck, probeClaude, resolveClaudeBin } from '@/lib/ai/cli'

import { getReviewConfig } from './config'

/**
 * Whether this machine can run a review at all.
 *
 * The module has one engine — the Claude Code CLI the reviewer already uses by
 * hand — and no fallback, so nothing is queued before the CLI has been found
 * and found signed in. The looking and the asking live in `lib/ai/cli.ts`,
 * shared with "Task mới", which runs on the same binary; what is left here is
 * the module's own cache around it.
 */

export type { ClaudeCheck }
export { resolveClaudeBin }

const CACHE_MS = 60_000
const g = globalThis as unknown as { __codeReviewClaudeCheck?: ClaudeCheck }

export async function checkClaude(force = false): Promise<ClaudeCheck> {
  const cached = g.__codeReviewClaudeCheck
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached

  const result = await probeClaude(getReviewConfig().claudeBin)
  g.__codeReviewClaudeCheck = result
  return result
}
