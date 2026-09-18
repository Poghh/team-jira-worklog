import Link from 'next/link'

import { JiraError, jiraBlockedBy } from '@/lib/jira/client'

import { LinkPending } from './link-pending'

/**
 * Jira could not be reached, said in terms of what to do about it.
 *
 * Every screen here is a view of somebody else's Jira behind a VPN, so "the
 * tunnel is down" is not an exceptional state — it is the single most common
 * way this app fails, and it used to surface as an uncaught throw and a stack
 * trace pointing at `jiraFetch`. That page is accurate and useless: nothing on
 * it says the one thing the reader needs to do.
 *
 * Three cases, because they need three different actions:
 *
 *   - `allowlist` — the request arrived, and Atlassian turned it away for
 *     coming from the wrong address. The VPN is off, or it reconnected on a
 *     different exit.
 *   - `offline` — nothing arrived at all. The VPN is down, or the network is.
 *   - anything else — a real failure, shown as it is rather than dressed up as
 *     a VPN problem. Telling somebody to check their VPN when their token has
 *     expired costs them the afternoon.
 */
export function JiraDown({
  error,
  /** What the reader was trying to look at, for the retry link. */
  retryHref = '',
}: {
  error: unknown
  retryHref?: string
}) {
  const blocked = jiraBlockedBy(error)
  const message = error instanceof Error ? error.message : String(error)
  const status = error instanceof JiraError ? error.status : undefined

  if (!blocked) {
    return (
      <div className="rounded-[9px] border border-crit/40 bg-crit-soft p-[17px]">
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-crit">
          Không kết nối được Jira{status ? ` · HTTP ${status}` : ''}
        </div>
        <p className="text-[13px] text-ink">{message}</p>
        <Link
          href="/settings"
          className="mt-3 inline-block rounded-md border border-line-strong bg-surface px-[9px] py-1 text-[12.5px] hover:bg-surface-2"
        >
          <span className="inline-flex items-center gap-1.5">
            Kiểm tra Settings
            <LinkPending />
          </span>
        </Link>
      </div>
    )
  }

  return (
    <div className="rounded-[9px] border border-warn/50 bg-warn-soft p-[17px]">
      <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-warn">
        {blocked === 'allowlist' ? 'Jira chặn IP này' : 'Không tới được Jira'}
      </div>
      <h1 className="text-lg font-semibold tracking-tight">Bật VPN lên rồi tải lại</h1>
      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-ink-2">
        {blocked === 'allowlist' ? (
          <>
            Jira nhận được request nhưng từ chối vì IP hiện tại không nằm trong allowlist —
            VPN đang tắt, hoặc vừa nối lại và ra bằng một IP khác. Dữ liệu không mất gì cả;
            app chỉ không hỏi được.
          </>
        ) : (
          <>
            Request không tới được Jira. Thường là VPN rớt, đôi khi là mạng. Dữ liệu không
            mất gì cả; app chỉ không hỏi được.
          </>
        )}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* A plain link to the same URL, which is a fresh server render — the
            page is dynamic, so this really does re-ask Jira rather than
            replaying a cached answer. */}
        <Link
          href={retryHref || '/'}
          prefetch={false}
          className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent-2"
        >
          <span className="inline-flex items-center gap-1.5">
            Thử lại
            <LinkPending />
          </span>
        </Link>
        <Link
          href="/settings"
          className="rounded-md border border-line-strong bg-surface px-[9px] py-1 text-[12.5px] hover:bg-surface-2"
        >
          <span className="inline-flex items-center gap-1.5">
            Settings
            <LinkPending />
          </span>
        </Link>
      </div>

      {/* Kept, and kept small. It is the line that matters when the guess above
          is wrong, and the only way to tell this apart from a token that
          expired on the same afternoon. */}
      <p className="mt-3 border-t border-warn/25 pt-2 font-mono text-[11px] text-warn">
        {status ? `HTTP ${status} · ` : ''}
        {message}
      </p>
    </div>
  )
}
