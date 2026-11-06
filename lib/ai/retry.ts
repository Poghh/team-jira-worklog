/**
 * Retry policy, kept free of any server import so it can be exercised directly.
 *
 * The Claude API fails in two ways that clear on their own: 429 when the rate
 * limit window is full, and 529 when the model is overloaded. Both are worth
 * another attempt; a bad API key or a declined prompt is not.
 */

/** Marks a failure worth retrying, as opposed to one that will always fail. */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'RetryableError'
  }
}

export const MAX_BACKOFF_MS = 8000

/**
 * Exponential backoff with jitter. The jitter matters little for a single user
 * but costs nothing, and keeps repeated failures from settling into a rhythm.
 */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 700 * 2 ** attempt)
  return Math.round(base * (0.7 + random() * 0.6))
}

/** Reads `Retry-After`, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000))
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.min(MAX_BACKOFF_MS, Math.max(0, at - now))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RetryResult<T> {
  value: T
  /** Attempts used, so callers can tell the user it had to fight for a result. */
  attempts: number
}

export async function withRetry<T>(
  run: () => Promise<T>,
  opts: { maxAttempts?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<RetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 4
  const wait = opts.wait ?? sleep
  let last: Error | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return { value: await run(), attempts: attempt + 1 }
    } catch (error) {
      // Anything not explicitly marked retryable will fail the same way again,
      // so surface it immediately rather than burning the remaining attempts.
      if (!(error instanceof RetryableError)) throw error
      last = error
      if (attempt === maxAttempts - 1) break
      await wait(error.retryAfterMs ?? backoffMs(attempt))
    }
  }

  throw new Error(
    `${last?.message ?? 'Thất bại'} — đã thử ${maxAttempts} lần. ` +
      'Chờ một lát rồi thử lại, hoặc đổi model trong Settings.',
  )
}
