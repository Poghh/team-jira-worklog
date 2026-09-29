'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useTransition } from 'react'

import type { ChatChanges, ChatMessage } from '@/lib/modules/code-review/chat'
import { type Addressee, type FindingView, SEVERITY_LABEL, type Severity, addressOf, where } from '@/lib/modules/code-review/model'

import { applyChatAction, cancelChatAction, chatAction, sendChatAction } from '../actions'
import { BTN, BTN_PRI, CARD, CTITLE, INPUT } from '../ui'

export interface ChatHandle {
  /** Starts a question about one finding and brings the chat into view. */
  ask: (f: FindingView) => void
}

/**
 * The reviewer ↔ Claude conversation about one round. Claude resumes the
 * session that did the review; anything it wants to change in the review
 * arrives as a proposal with an "Áp dụng" button — nothing changes on its own.
 */
export const ChatPanel = forwardRef<
  ChatHandle,
  { roundId: number; findings: FindingView[]; canRun: boolean; addressee: Addressee | null; onApplied: () => void }
>(
  function ChatPanel({ roundId, findings, canRun, addressee, onApplied }, ref) {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [text, setText] = useState('')
    const [msg, setMsg] = useState('')
    const [busy, start] = useTransition()
    const box = useRef<HTMLDivElement>(null)
    const input = useRef<HTMLTextAreaElement>(null)
    const running = messages.some((m) => m.state === 'running')

    const load = useCallback(async () => setMessages(await chatAction(roundId)), [roundId])

    useEffect(() => {
      void load()
    }, [load])

    useEffect(() => {
      if (!running) return
      const t = setTimeout(() => void load(), 2500)
      return () => clearTimeout(t)
    }, [running, messages, load])

    // A turn just finished: its proposal may be applied, so the list above is
    // worth a refresh only after the reviewer acts — but the end of the turn
    // should be visible.
    useEffect(() => {
      const el = box.current
      if (el) el.scrollTop = el.scrollHeight
    }, [messages.length, running])

    useImperativeHandle(ref, () => ({
      ask: (f) => {
        setText((t) => `${t ? `${t}\n` : ''}Về finding #${f.id} "${f.title}" (${where(f)}): `)
        box.current?.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        setTimeout(() => input.current?.focus(), 300)
      },
    }))

    const send = (override?: string) =>
      start(async () => {
        const r = await sendChatAction(roundId, override ?? text)
        setMsg(r.ok ? '' : r.message)
        if (r.ok && !override) setText('')
        await load()
      })

    // Results written before the addressee was set still say "tác giả" / "bạn".
    const rewriteAddress = () =>
      addressee &&
      send(
        `Viết lại nội dung các finding còn mở (và nhận xét chung nếu có) để xưng hô với tác giả đúng quy định: gọi là "${addressOf(addressee)}", thay mọi chỗ "tác giả", "bạn", "author". Chỉ đổi xưng hô và câu chữ đi kèm cho tự nhiên, KHÔNG đổi nội dung kỹ thuật. Đề xuất trong changes (update từng finding cần đổi), không cần đọc lại code.`,
      )

    const byId = new Map(findings.map((f) => [f.id, f]))

    return (
      <div className={CARD} id="chat">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className={CTITLE}>💬 Trao đổi với Claude về vòng review này</div>
          <span className="text-[11.5px] text-ink-3">
            Claude nối lại đúng phiên đã review — hỏi lại, phản biện, nhờ sửa comment. Thay đổi chỉ áp dụng khi bạn bấm.
          </span>
        </div>

        <div ref={box} className="flex max-h-[520px] flex-col gap-2 overflow-y-auto">
          {messages.length === 0 && (
            <p className="text-[12.5px] text-ink-3">
              Ví dụ: “Finding #3 có chắc không? Chỗ đó đã check nil ở caller rồi.” · “Viết lại comment chung ngắn hơn.” ·
              “Bỏ các nit, gộp 2 finding về threading.” · “Xem kỹ thêm file X.”
            </p>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-ink">
                {m.body}
              </div>
            ) : (
              <div key={m.id} className="max-w-[92%] rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                {m.state === 'running' ? (
                  <div className="text-ink-2">
                    <span className="animate-pulse">Claude đang xem lại…</span>
                    {m.activity.map((a, i) => (
                      <div key={i} className="truncate font-mono text-[11px] text-ink-3">
                        {a.text}
                      </div>
                    ))}
                    <button type="button" className="mt-1 text-[11.5px] text-ink-3 hover:text-crit" onClick={() => void cancelChatAction(m.id).then(load)}>
                      Huỷ
                    </button>
                  </div>
                ) : m.state === 'done' ? (
                  <>
                    <div className="whitespace-pre-wrap leading-relaxed">{m.body}</div>
                    {m.changes && (
                      <Proposal
                        changes={m.changes}
                        applied={m.applied}
                        byId={byId}
                        onApply={async () => {
                          const r = await applyChatAction(m.id)
                          setMsg(r.message)
                          await load()
                          if (r.ok) onApplied()
                        }}
                      />
                    )}
                  </>
                ) : (
                  <div className="text-crit">{m.message || 'Không có câu trả lời.'}</div>
                )}
              </div>
            ),
          )}
        </div>

        <textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !running) {
              e.preventDefault()
              send()
            }
          }}
          rows={3}
          className={INPUT + ' mt-3'}
          placeholder="Nhắn cho Claude… (⌘ + Enter để gửi)"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button type="button" className={BTN_PRI} disabled={busy || running || !canRun || !text.trim()} onClick={() => send()}>
            {running ? 'Claude đang trả lời…' : 'Gửi'}
          </button>
          {addressee && (
            <button
              type="button"
              className={BTN}
              disabled={busy || running || !canRun}
              title="Nhờ Claude đề xuất viết lại comment theo xưng hô đang chọn — bạn bấm Áp dụng mới đổi"
              onClick={rewriteAddress}
            >
              🗣 Cập nhật xưng hô “{addressOf(addressee)}” vào bản review
            </button>
          )}
          {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
        </div>
      </div>
    )
  },
)

function Proposal({
  changes,
  applied,
  byId,
  onApply,
}: {
  changes: ChatChanges
  applied: boolean
  byId: Map<number, FindingView>
  onApply: () => Promise<void>
}) {
  const [busy, start] = useTransition()
  const [open, setOpen] = useState(true)
  const updates = changes.update ?? []
  const adds = changes.add ?? []
  return (
    <div className="mt-2 rounded-md border border-line bg-surface px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold">Đề xuất sửa bản review</span>
        <span className="text-ink-3">
          {[
            updates.filter((u) => !u.dismiss).length && `sửa ${updates.filter((u) => !u.dismiss).length}`,
            updates.filter((u) => u.dismiss).length && `bỏ ${updates.filter((u) => u.dismiss).length}`,
            adds.length && `thêm ${adds.length}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <button type="button" className="text-ink-3 hover:text-ink" onClick={() => setOpen((v) => !v)}>
          {open ? 'Thu gọn' : 'Xem'}
        </button>
        <span className="ml-auto">
          {applied ? (
            <span className="font-medium text-good">✓ Đã áp dụng</span>
          ) : (
            <button type="button" className={BTN_PRI} disabled={busy} onClick={() => start(onApply)}>
              {busy ? 'Đang áp dụng…' : 'Áp dụng'}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2 text-[12.5px]">
          {updates.map((u, i) => {
            const f = byId.get(u.id)
            return (
              <div key={`u${i}`} className="border-l-2 border-line pl-2">
                <div className="font-medium">
                  {u.dismiss ? '🗑 Bỏ' : '✏️ Sửa'} #{u.id} {f ? `“${f.title}”` : '(không thuộc vòng này — sẽ bỏ qua)'}
                  {u.severity && f && u.severity !== f.severity && (
                    <span className="ml-1 text-ink-3">
                      {SEVERITY_LABEL[f.severity]} → {SEVERITY_LABEL[u.severity as Severity] ?? u.severity}
                    </span>
                  )}
                </div>
                {u.reason && <div className="text-ink-3">{u.reason}</div>}
                {u.title && u.title !== f?.title && <div className="text-ink-2">Tiêu đề: {u.title}</div>}
                {u.comment && <div className="mt-0.5 whitespace-pre-wrap text-ink-2">{u.comment}</div>}
              </div>
            )
          })}
          {adds.map((a, i) => (
            <div key={`a${i}`} className="border-l-2 border-accent pl-2">
              <div className="font-medium">
                ➕ [{a.severity}] {a.title}{' '}
                <span className="font-mono text-[11px] text-ink-3">
                  {a.location || (a.file ? `${a.file}${a.line ? `:${a.line}` : ''}` : '')}
                </span>
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-ink-2">{a.comment}</div>
            </div>
          ))}

        </div>
      )}
    </div>
  )
}

export function ChatShortcut() {
  return (
    <a href="#chat" className={BTN}>
      💬 Hỏi Claude
    </a>
  )
}
