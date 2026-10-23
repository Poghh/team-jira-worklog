'use client'

import { createContext, useContext, useEffect, useState, useTransition } from 'react'

import type { ConfluenceAccess } from '@/lib/modules/code-review/confluence'
import { type DocFile, type FindingView, confluencePages } from '@/lib/modules/code-review/model'

import { confluenceAccessAction, confluenceReplyAction, postAllConfluenceAction, postConfluenceAction } from '../actions'
import { BTN, BTN_PRI, INPUT } from '../ui'

/**
 * Doc findings back onto Confluence: per finding, all at once, and replies in
 * the thread a later round drafted. Same contract as github.tsx — nothing is
 * sent without an explicit click and a confirm, and the server re-checks that
 * the account may comment before every write.
 */

interface CfState {
  /** The item has Confluence pages at all. */
  enabled: boolean
  access: ConfluenceAccess
  recheck: () => Promise<void>
}

const NONE: ConfluenceAccess = { read: false, write: false, reason: '' }
const CfContext = createContext<CfState>({ enabled: false, access: NONE, recheck: async () => {} })
const useCf = () => useContext(CfContext)

export function CfProvider({
  itemId,
  enabled,
  initialAccess,
  children,
}: {
  itemId: number
  enabled: boolean
  initialAccess: ConfluenceAccess
  children: React.ReactNode
}) {
  const [access, setAccess] = useState(initialAccess)
  const recheck = async () => {
    if (enabled) setAccess(await confluenceAccessAction(itemId, true))
  }
  return <CfContext.Provider value={{ enabled, access, recheck }}>{children}</CfContext.Provider>
}

/** Why there are no send buttons, when the account cannot comment. */
export function CfAccessNote() {
  const cf = useCf()
  const [busy, start] = useTransition()
  if (!cf.enabled || cf.access.write) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-line-strong bg-surface px-3 py-2 text-[12px] text-ink-2">
      <span>🔒 {cf.access.reason || 'Tài khoản Atlassian chưa có quyền comment.'} Dùng nút Copy rồi tự dán comment trên Confluence.</span>
      <button type="button" className={BTN + ' ml-auto'} disabled={busy} onClick={() => start(() => cf.recheck())}>
        {busy ? 'Đang kiểm tra…' : 'Kiểm tra lại quyền'}
      </button>
    </div>
  )
}

function Confirm({ label, confirm, onConfirm, disabled, primary }: { label: string; confirm: string; onConfirm: () => void; disabled?: boolean; primary?: boolean }) {
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

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** "Gửi lên Confluence" for one finding, or — once sent — its link and the reply box. */
export function FindingConfluence({ f, body, docs, onPosted }: { f: FindingView; body: string; docs: DocFile[]; onPosted: () => void }) {
  const cf = useCf()
  const pages = confluencePages(docs)
  const [pageId, setPageId] = useState(f.docRef)
  const [busy, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => setPageId(f.docRef), [f.docRef])
  if (!cf.enabled || !pages.length) return null

  if (f.ghUrl) {
    return (
      <div className="w-full">
        <a href={f.ghUrl} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-good hover:underline">
          ✓ Đã gửi lên Confluence{f.commentKind === 'footer' ? ' (comment cuối trang)' : ''} ↗
        </a>
        {cf.access.write && f.commentKind && <CfFollowUp f={f} body={body} onSent={onPosted} />}
      </div>
    )
  }
  if (!cf.access.write || f.status === 'dismissed' || f.status === 'fixed') return null
  const page = pages.find((p) => p.source.pageId === pageId)
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {(!f.docRef || pages.length > 1) && (
        <select
          value={pageId}
          onChange={(e) => setPageId(e.target.value)}
          className="max-w-[220px] rounded-md border border-line bg-ground px-1.5 py-0.5 text-[12px]"
          title="Trang sẽ nhận comment"
        >
          {!f.docRef && <option value="">— Chọn trang —</option>}
          {pages.map((p) => (
            <option key={p.source.pageId} value={p.source.pageId}>
              🌐 {short(p.name, 40)}
            </option>
          ))}
        </select>
      )}
      <Confirm
        label="Gửi lên Confluence"
        confirm={page ? (f.quote ? `Comment vào "${short(f.quote, 30)}" trên ${short(page.name, 30)}?` : `Comment cuối trang ${short(page.name, 36)}?`) : 'Chọn trang trước'}
        disabled={busy || !page || !body.trim()}
        onConfirm={() =>
          start(async () => {
            const r = await postConfluenceAction(f.id, pageId)
            setMsg({ ok: r.ok, text: r.message })
            if (r.ok) onPosted()
          })
        }
      />
      {busy && <span className="text-[12px] text-ink-3">Đang gửi…</span>}
      {msg && <span className={'text-[12px] ' + (msg.ok ? 'text-good' : 'text-crit')}>{msg.text}</span>}
    </span>
  )
}

/** The next thing to say under a finding already on Confluence — Claude's draft, the comment as edited, or this round's note. */
function CfFollowUp({ f, body, onSent }: { f: FindingView; body: string; onSent: () => void }) {
  const sources = [
    f.followReply && { key: 'draft', label: 'Câu Claude soạn', text: f.followReply },
    { key: 'body', label: 'Nội dung comment', text: body },
    f.followNote && { key: 'note', label: 'Ghi chú vòng này', text: f.followNote },
  ].filter(Boolean) as Array<{ key: string; label: string; text: string }>
  const [open, setOpen] = useState(Boolean(f.followReply && !f.followSentUrl))
  const [source, setSource] = useState(sources[0].key)
  const [text, setText] = useState(sources[0].text)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  useEffect(() => {
    setSource(sources[0].key)
    setText(sources[0].text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.followReply, f.body])

  return (
    <div className="mt-2">
      {f.followSentUrl && (
        <a href={f.followSentUrl} target="_blank" rel="noreferrer" className="mr-2 text-[12px] text-good hover:underline">
          ✓ Đã trả lời tiếp ↗
        </a>
      )}
      {!open ? (
        <button type="button" className={BTN} onClick={() => setOpen(true)}>
          ↩ Trả lời tiếp trên Confluence{f.followReply && !f.followSentUrl ? ' (Claude đã soạn sẵn)' : ''}
        </button>
      ) : (
        <div className="rounded-md border border-line bg-surface-2 p-2">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
            <span>Trả lời trong thread của comment này · lấy nội dung từ:</span>
            {sources.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setSource(s.key)
                  setText(s.text)
                }}
                className={'rounded border px-1.5 py-px ' + (source === s.key ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface hover:bg-surface-2')}
              >
                {s.label}
              </button>
            ))}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(10, Math.max(3, text.split('\n').length + 1))} className={INPUT} />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Confirm
              label="Gửi trả lời"
              confirm="Gửi vào thread trên Confluence?"
              primary
              disabled={busy || !text.trim()}
              onConfirm={() =>
                start(async () => {
                  const r = await confluenceReplyAction(f.id, text)
                  setMsg({ ok: r.ok, text: r.message })
                  if (r.ok) {
                    setOpen(false)
                    onSent()
                  }
                })
              }
            />
            <button type="button" className={BTN} onClick={() => setOpen(false)}>
              Đóng
            </button>
            {busy && <span className="text-[12px] text-ink-3">Đang gửi…</span>}
          </div>
        </div>
      )}
      {msg && <span className={'text-[12px] ' + (msg.ok ? 'text-good' : 'text-crit')}>{msg.text}</span>}
    </div>
  )
}

/**
 * Every finding the reviewer kept — not dismissed, not fixed, not yet sent,
 * with a known page — each as its own comment on its page.
 */
export function SendAllConfluence({ roundId, findings, docs, onDone }: { roundId: number; findings: FindingView[]; docs: DocFile[]; onDone: () => void }) {
  const cf = useCf()
  const [busy, start] = useTransition()
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!cf.enabled || !cf.access.write || !confluencePages(docs).length) return null
  const ready = findings.filter((f) => !f.ghUrl && f.docRef && f.body.trim() && f.status !== 'dismissed' && f.status !== 'fixed')
  const noPage = findings.filter((f) => !f.ghUrl && !f.docRef && f.status !== 'dismissed' && f.status !== 'fixed').length
  if (!ready.length && !msg) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-ink-2">
      <span>
        🌐 {ready.length} mục còn mở chưa gửi — bấm <span className="font-medium">Bỏ qua</span> những mục không muốn gửi, rồi gửi phần còn lại lên đúng trang.
        {noPage > 0 && <span className="text-ink-3"> ({noPage} mục chưa rõ trang — gửi từng cái.)</span>}
      </span>
      <span className="ml-auto inline-flex items-center gap-2">
        <Confirm
          label={`Gửi ${ready.length} comment lên Confluence`}
          confirm={`Gửi ${ready.length} comment?`}
          primary
          disabled={busy || !ready.length}
          onConfirm={() =>
            start(async () => {
              const r = await postAllConfluenceAction(roundId, ready.map((f) => f.id))
              setMsg({ ok: r.ok, text: r.message })
              onDone()
            })
          }
        />
        {busy && <span className="text-ink-3">Đang gửi…</span>}
      </span>
      {msg && <div className={'w-full ' + (msg.ok ? 'text-good' : 'text-crit')}>{msg.text}</div>}
    </div>
  )
}
