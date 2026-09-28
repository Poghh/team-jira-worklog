'use client'

import { createContext, useCallback, useContext, useEffect, useState, useTransition } from 'react'

import type { Discussion, GhComment, GhThread, GithubAccess } from '@/lib/modules/code-review/github'
import { type FindingView, type RoundView, where } from '@/lib/modules/code-review/model'

import {
  commentAction,
  discussionAction,
  githubAccessAction,
  postFindingAction,
  replyAction,
  resolveThreadAction,
  submitReviewAction,
} from '../actions'
import { BTN, BTN_PRI, CARD, CTITLE, INPUT, SeverityPill, timeAgo } from '../ui'

/**
 * Talking to the PR from inside the module: post findings, submit a review,
 * read the threads and answer them.
 *
 * Every write here is one explicit click, most of them two (arm, then
 * confirm), and the server side only ever reaches the comment / review
 * endpoints — see lib/modules/code-review/guard.ts. Nothing here can merge,
 * close, approve or touch a branch.
 */

interface GhState {
  /** The item is a GitHub PR and the token can read it: discussion is shown. */
  enabled: boolean
  /** The token can comment: send / reply / resolve are shown. Otherwise Copy only. */
  canWrite: boolean
  access: GithubAccess
  recheck: () => Promise<void>
  itemId: number
  discussion: Discussion | null
  error: string
  loading: boolean
  reload: () => Promise<void>
}

const NO_ACCESS: GithubAccess = { read: false, write: false, reason: '' }

const GhContext = createContext<GhState>({
  enabled: false,
  canWrite: false,
  access: NO_ACCESS,
  recheck: async () => {},
  itemId: 0,
  discussion: null,
  error: '',
  loading: false,
  reload: async () => {},
})

export const useGh = () => useContext(GhContext)

export function GhProvider({
  itemId,
  onGithub,
  initialAccess,
  children,
}: {
  itemId: number
  /** The item is tied to a PR on github.com at all. */
  onGithub: boolean
  initialAccess: GithubAccess
  children: React.ReactNode
}) {
  const [access, setAccess] = useState(initialAccess)
  const enabled = onGithub && access.read
  const [discussion, setDiscussion] = useState<Discussion | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    const r = await discussionAction(itemId)
    setLoading(false)
    if (r.ok && r.discussion) {
      setDiscussion(r.discussion)
      setError('')
    } else setError(r.message)
  }, [enabled, itemId])

  useEffect(() => {
    void reload()
  }, [reload])

  const recheck = useCallback(async () => {
    if (onGithub) setAccess(await githubAccessAction(itemId, true))
  }, [itemId, onGithub])

  return (
    <GhContext.Provider value={{ enabled, canWrite: enabled && access.write, access, recheck, itemId, discussion, error, loading, reload }}>
      {children}
    </GhContext.Provider>
  )
}

/**
 * Shown where send buttons would be, when the token cannot comment: why, and
 * that Copy still works. Nothing to show when it can, or when the item is not
 * on GitHub at all (Copy is simply the only way there).
 */
export function AccessNote({ onGithub }: { onGithub: boolean }) {
  const gh = useGh()
  const [busy, start] = useTransition()
  if (!onGithub || gh.canWrite) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-line-strong bg-surface px-3 py-2 text-[12px] text-ink-2">
      <span>🔒 {gh.access.reason || 'Token GitHub chưa có quyền ghi.'} Dùng nút Copy rồi tự dán comment trên GitHub.</span>
      <button type="button" className={BTN + ' ml-auto'} disabled={busy} onClick={() => start(() => gh.recheck())}>
        {busy ? 'Đang kiểm tra…' : 'Kiểm tra lại quyền'}
      </button>
    </div>
  )
}

/** A button that asks once more before doing anything visible to other people. */
function ConfirmButton({
  label,
  confirm,
  onConfirm,
  disabled,
  primary,
}: {
  label: string
  confirm: string
  onConfirm: () => void
  disabled?: boolean
  primary?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])
  return armed ? (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setArmed(false)
        onConfirm()
      }}
      className="rounded-md bg-warn px-2.5 py-1 text-[12.5px] font-medium text-white disabled:opacity-50"
    >
      {confirm}
    </button>
  ) : (
    <button type="button" disabled={disabled} onClick={() => setArmed(true)} className={primary ? BTN_PRI : BTN}>
      {label}
    </button>
  )
}

/* ── per finding ────────────────────────────────────────────────────────── */

/** "Gửi lên PR", or — once sent — the link and the thread that grew from it. */
export function FindingGithub({ f, onPosted }: { f: FindingView; onPosted: () => void }) {
  const gh = useGh()
  const [busy, start] = useTransition()
  const [msg, setMsg] = useState('')
  if (!gh.enabled) return null

  if (!f.ghUrl) {
    if (!gh.canWrite) return null
    return (
      <span className="inline-flex items-center gap-2">
        <ConfirmButton
          label="Gửi lên PR"
          confirm={f.inDiff ? `Gửi comment vào ${where(f)}?` : 'Gửi thành comment chung?'}
          disabled={busy}
          onConfirm={() =>
            start(async () => {
              const r = await postFindingAction(f.id)
              setMsg(r.ok ? '' : r.message)
              if (r.ok) {
                onPosted()
                void gh.reload()
              }
            })
          }
        />
        {busy && <span className="text-[12px] text-ink-3">Đang gửi…</span>}
        {msg && <span className="text-[12px] text-crit">{msg}</span>}
      </span>
    )
  }

  const thread = f.ghCommentId
    ? gh.discussion?.threads.find((t) => t.comments.some((c) => c.id === f.ghCommentId))
    : undefined
  return (
    <div className="w-full">
      <a href={f.ghUrl} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-good hover:underline">
        ✓ Đã gửi lên PR ↗
      </a>
      {thread && <ThreadView thread={thread} skipFirst compact />}
    </div>
  )
}

/* ── threads ────────────────────────────────────────────────────────────── */

function CommentView({ c, viewer }: { c: GhComment; viewer: string }) {
  const mine = c.author === viewer
  return (
    <div className={'rounded-md px-2.5 py-2 ' + (mine ? 'bg-accent-soft/50' : 'bg-surface-2')}>
      <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px]">
        {c.avatar && <img src={c.avatar} alt="" className="size-4 rounded-full" />}
        <span className="font-semibold">{c.author}</span>
        {mine && <span className="text-ink-3">(bạn)</span>}
        <a href={c.url} target="_blank" rel="noreferrer" className="text-ink-3 hover:underline">
          {timeAgo(Math.floor(Date.parse(c.createdAt) / 1000))}
        </a>
      </div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{c.body}</div>
    </div>
  )
}

function ReplyBox({ onSend, placeholder }: { onSend: (body: string) => Promise<{ ok: boolean; message: string }>; placeholder: string }) {
  const [body, setBody] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  return (
    <div className="mt-1.5">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} className={INPUT} placeholder={placeholder} />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className={BTN_PRI}
          disabled={busy || !body.trim()}
          onClick={() =>
            start(async () => {
              const r = await onSend(body)
              setMsg(r.ok ? '' : r.message)
              if (r.ok) setBody('')
            })
          }
        >
          {busy ? 'Đang gửi…' : 'Gửi'}
        </button>
        {msg && <span className="text-[12px] text-crit">{msg}</span>}
      </div>
    </div>
  )
}

export function ThreadView({ thread, skipFirst, compact }: { thread: GhThread; skipFirst?: boolean; compact?: boolean }) {
  const gh = useGh()
  const [busy, start] = useTransition()
  const [open, setOpen] = useState(!thread.isResolved)
  const viewer = gh.discussion?.viewer ?? ''
  const shown = skipFirst ? thread.comments.slice(1) : thread.comments
  const last = thread.comments.at(-1)
  const pending = last && last.author !== viewer

  const toggleResolve = () =>
    start(async () => {
      await resolveThreadAction(gh.itemId, thread.id, !thread.isResolved)
      await gh.reload()
    })

  return (
    <div className={compact ? 'mt-2 border-l-2 border-line pl-2.5' : ''}>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        {compact ? (
          <span className="text-ink-3">{shown.length ? `${shown.length} phản hồi` : 'Chưa có phản hồi'}</span>
        ) : (
          <span className="font-mono text-ink-2">
            {thread.path}
            {thread.line ? `:${thread.line}` : ''}
          </span>
        )}
        {thread.isResolved && <span className="rounded bg-good-soft px-1.5 text-good">Resolved</span>}
        {thread.isOutdated && <span className="rounded bg-surface-2 px-1.5 text-ink-3">Outdated</span>}
        {pending && !thread.isResolved && <span className="rounded bg-blue-soft px-1.5 text-blue-ink">Chờ bạn trả lời</span>}
        <button type="button" className="ml-auto text-ink-3 hover:text-ink" onClick={() => setOpen((v) => !v)}>
          {open ? 'Thu gọn' : 'Mở'}
        </button>
        {gh.canWrite && (
          <button type="button" className="text-ink-3 hover:text-ink disabled:opacity-50" disabled={busy} onClick={toggleResolve}>
            {thread.isResolved ? 'Mở lại' : 'Resolve'}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {shown.map((c) => (
            <CommentView key={c.id} c={c} viewer={viewer} />
          ))}
          {gh.canWrite && (
            <ReplyBox
              placeholder="Trả lời trong thread này…"
              onSend={async (body) => {
                const r = await replyAction(gh.itemId, thread.comments[0].id, body)
                if (r.ok) await gh.reload()
                return r
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* ── the whole discussion ───────────────────────────────────────────────── */

const REVIEW_STATE: Record<string, string> = {
  APPROVED: '✅ Approved',
  CHANGES_REQUESTED: '✋ Request changes',
  COMMENTED: '💬 Comment',
  DISMISSED: 'Dismissed',
}

export function DiscussionPanel() {
  const gh = useGh()
  const [showResolved, setShowResolved] = useState(false)
  const d = gh.discussion

  if (!d) {
    return (
      <div className={CARD + ' text-[12.5px] ' + (gh.error ? 'text-crit' : 'text-ink-3')}>
        {gh.error || 'Đang tải thảo luận từ GitHub…'}
      </div>
    )
  }

  const threads = d.threads.filter((t) => showResolved || !t.isResolved)
  const resolved = d.threads.filter((t) => t.isResolved).length
  const timeline = [
    ...d.comments.map((c) => ({ at: c.createdAt, c, r: null })),
    ...d.reviews.map((r) => ({ at: r.submittedAt, c: null, r })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  return (
    <div className="flex flex-col gap-4">
      <AccessNote onGithub />
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className={CTITLE}>
            Thread trên code · {d.threads.length - resolved} đang mở{resolved ? ` · ${resolved} resolved` : ''}
          </div>
          <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Hiện resolved
          </label>
          <button type="button" className={BTN} disabled={gh.loading} onClick={() => void gh.reload()}>
            {gh.loading ? 'Đang tải…' : 'Tải lại'}
          </button>
        </div>
        {threads.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">Không có thread nào{resolved && !showResolved ? ' đang mở' : ''}.</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {threads.map((t) => (
              <div key={t.id} className="py-3 first:pt-0 last:pb-0">
                <ThreadView thread={t} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={CARD}>
        <div className={CTITLE + ' mb-2'}>Conversation</div>
        <div className="flex flex-col gap-1.5">
          {timeline.length === 0 && <p className="text-[12.5px] text-ink-3">Chưa có comment chung nào.</p>}
          {timeline.map((e, i) =>
            e.c ? (
              <CommentView key={`c${i}`} c={e.c} viewer={d.viewer} />
            ) : (
              <div key={`r${i}`} className="rounded-md border border-line px-2.5 py-2">
                <div className="text-[11.5px]">
                  <span className="font-semibold">{e.r!.author}</span> · {REVIEW_STATE[e.r!.state] ?? e.r!.state} ·{' '}
                  <a href={e.r!.url} target="_blank" rel="noreferrer" className="text-ink-3 hover:underline">
                    {timeAgo(Math.floor(Date.parse(e.r!.submittedAt) / 1000))}
                  </a>
                </div>
                {e.r!.body && <div className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed">{e.r!.body}</div>}
              </div>
            ),
          )}
        </div>
        {gh.canWrite && (
          <ReplyBox
            placeholder="Comment chung trên PR…"
            onSend={async (body) => {
              const r = await commentAction(gh.itemId, body)
              if (r.ok) await gh.reload()
              return r
            }}
          />
        )}
      </div>
    </div>
  )
}

/* ── submitting a whole review ──────────────────────────────────────────── */

export function SubmitReview({
  round,
  findings,
  summary,
  onDone,
}: {
  round: RoundView
  findings: FindingView[]
  summary: string
  onDone: () => void
}) {
  const gh = useGh()
  const candidates = findings.filter((f) => !f.ghUrl && f.status !== 'fixed' && f.status !== 'dismissed')
  const [picked, setPicked] = useState<Set<number>>(() => new Set(candidates.map((f) => f.id)))
  const [event, setEvent] = useState<'COMMENT' | 'REQUEST_CHANGES'>(round.verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT')
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null)
  const [busy, start] = useTransition()
  if (!gh.canWrite) return null

  const chosen = candidates.filter((f) => picked.has(f.id))
  const inline = chosen.filter((f) => f.inDiff && f.line).length

  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <div className={CTITLE}>Gửi review lên GitHub</div>
        <span className="text-[12px] text-ink-2">
          {candidates.length ? `${candidates.length} điểm chưa gửi` : 'Đã gửi hết các điểm còn mở'}
        </span>
        {msg && (
          <span className={'text-[12px] ' + (msg.ok ? 'text-good' : 'text-crit')}>
            {msg.text}{' '}
            {msg.url && (
              <a href={msg.url} target="_blank" rel="noreferrer" className="underline">
                Xem ↗
              </a>
            )}
          </span>
        )}
        <button type="button" className={BTN + ' ml-auto'} onClick={() => setOpen((v) => !v)}>
          {open ? 'Đóng' : 'Soạn review'}
        </button>
      </div>
      {open && (
        <div className="mt-3">
          <p className="mb-2 text-[12px] text-ink-3">
            Gửi một lần: comment chung ở trên làm nội dung review, các điểm đã chọn thành comment inline (điểm ngoài diff được liệt kê trong nội dung). Tác giả nhận một thông báo.
          </p>
          <ul className="mb-2 max-h-[260px] overflow-y-auto rounded-md border border-line">
            {candidates.map((f) => (
              <li key={f.id} className="border-b border-line last:border-0">
                <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12.5px] hover:bg-surface-2/60">
                  <input
                    type="checkbox"
                    checked={picked.has(f.id)}
                    onChange={() =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (n.has(f.id)) n.delete(f.id)
                        else n.add(f.id)
                        return n
                      })
                    }
                  />
                  <SeverityPill s={f.severity} />
                  <span className="truncate">{f.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">
                    {where(f)} {f.inDiff ? '· inline' : '· trong nội dung'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <select value={event} onChange={(e) => setEvent(e.target.value as typeof event)} className={INPUT + ' w-auto'}>
              <option value="COMMENT">💬 Comment</option>
              <option value="REQUEST_CHANGES">✋ Request changes</option>
            </select>
            <ConfirmButton
              primary
              label={`Gửi review (${inline} inline${chosen.length - inline ? ` + ${chosen.length - inline} trong nội dung` : ''})`}
              confirm={event === 'REQUEST_CHANGES' ? 'Xác nhận gửi Request changes?' : 'Xác nhận gửi review?'}
              disabled={busy || (!chosen.length && !summary.trim())}
              onConfirm={() =>
                start(async () => {
                  const r = await submitReviewAction({ roundId: round.id, findingIds: [...picked], body: summary, event })
                  setMsg({ ok: r.ok, text: r.message, url: r.url })
                  if (r.ok) {
                    setOpen(false)
                    onDone()
                    void gh.reload()
                  }
                })
              }
            />
            {busy && <span className="text-[12px] text-ink-3">Đang gửi…</span>}
          </div>
          <p className="mt-2 text-[11.5px] text-ink-3">
            Không có Approve ở đây: approve có thể kích hoạt auto-merge, nên module chỉ Comment hoặc Request changes — approve thì bấm trên GitHub.
          </p>
        </div>
      )}
    </div>
  )
}
