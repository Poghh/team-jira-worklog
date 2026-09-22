'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { type AdfBlock, adfToBlocks, splitDod, textToAdf } from '@/lib/jira/adf'
import { statusTone } from '@/lib/jira/types'
import { formatDuration } from '@/lib/time'

import { regenerateDescriptionAction, updateDescriptionAction, updateSummaryAction } from '../actions'
import { Spinner } from '../spinner'
import { StatusPill } from './status-pill'
import { TypeIcon } from './type-icon'

const TONE: Record<string, string> = {
  todo: 'bg-surface-2 text-ink-2',
  prog: 'bg-accent-soft text-accent-ink',
  test: 'bg-warn-soft text-warn',
  ver: 'bg-blue-soft text-blue',
  done: 'bg-good-soft text-good',
}

interface Detail {
  key: string
  summary: string
  statusName: string
  issueTypeName: string
  storyPoints: number | null
  timeSpentSeconds: number
  parentKey: string | null
  parentSummary: string | null
  sprintName: string | null
  assigneeName: string | null
  startDate: string | null
  dueDate: string | null
  labels: string[]
  description: unknown
  url: string
}

/**
 * Full text of one issue, opened from its key.
 *
 * The compact row shows a truncated summary, which is enough to pick a task but
 * not to read one. This panel carries the parts that were cut — the whole title,
 * the description and the Definition of Done — without giving up the density
 * that made the board scannable.
 */
export function IssueDetail({ issueKey, onClose }: { issueKey: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Ô sửa tiêu đề đang mở hay không — modal phải biết để Esc không đóng nó.
   *
   * `stopPropagation` trong ô sửa không đủ: App Router hydrate cả `document`,
   * nên listener của React và listener dưới đây nằm **cùng một node**, mà
   * `stopPropagation` chỉ chặn node sau chứ không chặn listener cùng node.
   */
  const [titleEditing, setTitleEditing] = useState(false)
  const [descEditing, setDescEditing] = useState(false)
  /**
   * Tiêu đề đang có sửa chưa lưu.
   *
   * Gemini viết theo tiêu đề **đã lưu** — nó chỉ đọc được `detail.summary`, mà
   * ô sửa chưa lưu thì giá trị ấy vẫn là tiêu đề cũ. Không chặn thì người dùng
   * đổi tiêu đề, bấm viết lại, và nhận về mô tả của tiêu đề cũ mà không có gì
   * trên màn hình nói ra điều đó.
   */
  const [titleDirty, setTitleDirty] = useState(false)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)

    fetch(`/api/jira/issue?key=${encodeURIComponent(issueKey)}`)
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body?.error ?? 'Không lấy được chi tiết')
        return body as Detail
      })
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))

    return () => {
      alive = false
    }
  }, [issueKey])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc đầu tiên đóng ô sửa, Esc sau mới đóng modal — nếu không thì một cú
      // Esc để bỏ sửa sẽ nuốt luôn cả màn hình đang đọc dở.
      if (e.key === 'Escape' && !titleEditing && !descEditing) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, titleEditing, descEditing])


  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-auto bg-black/45 p-6 sm:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Chi tiết ${issueKey}`}
        className="w-full max-w-[620px] rounded-xl border border-line-strong bg-surface shadow-2xl"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <TypeIcon name={detail?.issueTypeName || 'Subtask'} className="size-3.5" />
          <a
            href={detail?.url ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[12px] font-semibold text-accent-ink underline-offset-2 hover:underline"
            title="Mở trên Jira"
          >
            {issueKey}
          </a>
          {detail && (
            <StatusPill issueKey={detail.key} statusName={detail.statusName} />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="ml-auto grid size-7 place-items-center rounded-md text-[18px] leading-none text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </header>

        <div className="max-h-[70vh] overflow-auto px-4 py-4">
          {error && <p className="text-[13px] text-crit">{error}</p>}

          {!detail && !error && (
            <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
              <Spinner /> Đang tải chi tiết…
            </p>
          )}

          {detail && (
            <>
              <EditableTitle
                issueKey={issueKey}
                summary={detail.summary}
                onSaved={(text) => setDetail((d) => (d ? { ...d, summary: text } : d))}
                onEditingChange={setTitleEditing}
                onDirtyChange={setTitleDirty}
              />

              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
                {detail.parentKey && (
                  <Row label="Task cha">
                    <span className="font-mono text-ink-2">{detail.parentKey}</span>
                    {detail.parentSummary && (
                      <span className="text-ink-3"> · {detail.parentSummary}</span>
                    )}
                  </Row>
                )}
                {detail.sprintName && <Row label="Sprint">{detail.sprintName}</Row>}
                {detail.assigneeName && <Row label="Giao cho">{detail.assigneeName}</Row>}
                <Row label="Story point">
                  {detail.storyPoints ?? <span className="text-ink-3">chưa đặt</span>}
                </Row>
                <Row label="Ngày">
                  {detail.startDate || detail.dueDate ? (
                    <span className="font-mono">
                      {detail.startDate ?? '—'} → {detail.dueDate ?? '—'}
                    </span>
                  ) : (
                    <span className="text-warn">chưa đặt start/due</span>
                  )}
                </Row>
                <Row label="Label">
                  {detail.labels.length ? (
                    <span className="font-mono text-ink-2">{detail.labels.join(', ')}</span>
                  ) : (
                    <span className="text-warn">chưa có label</span>
                  )}
                </Row>
                <Row label="Đã log">
                  {detail.timeSpentSeconds ? (
                    formatDuration(detail.timeSpentSeconds)
                  ) : (
                    <span className="text-ink-3">chưa log</span>
                  )}
                </Row>
              </dl>

              <EditableDescription
                issueKey={issueKey}
                doc={detail.description}
                title={detail.summary}
                parentSummary={detail.parentSummary ?? undefined}
                onSaved={(doc) => setDetail((d) => (d ? { ...d, description: doc } : d))}
                onEditingChange={setDescEditing}
                titleDirty={titleDirty}
              />
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line bg-surface-2 px-4 py-2.5">
          <span className="font-mono text-[11px] text-ink-3">
            Esc để đóng · bấm mã task để mở trên Jira
          </span>
          <a
            href={detail?.url ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="ml-auto rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12px] hover:bg-surface"
          >
            Mở trên Jira ↗
          </a>
        </footer>
      </div>
    </div>
  )
}

/**
 * Tiêu đề issue, sửa được tại chỗ.
 *
 * Không phải một ô nhập luôn mở: 99% lần mở modal là để *đọc*, và một ô viền
 * sẵn ở dòng to nhất làm cả hộp đọc như một cái form. Bấm vào tiêu đề mới thành
 * ô sửa — cùng lối với ô point trên board.
 *
 * Ghi thẳng lên Jira, nên nó chỉ chạy khi người dùng bấm Lưu; Esc là huỷ và
 * không gửi gì.
 */
function EditableTitle({
  issueKey,
  summary,
  onSaved,
  onEditingChange,
  onDirtyChange,
}: {
  issueKey: string
  summary: string
  onSaved: (text: string) => void
  onEditingChange: (on: boolean) => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(summary)
  const [err, setErr] = useState('')
  const [saving, startSaving] = useTransition()
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    onEditingChange(editing)
  }, [editing, onEditingChange])

  useEffect(() => {
    onDirtyChange(editing && text.trim() !== summary.trim())
  }, [editing, text, summary, onDirtyChange])

  // Mở ra là con trỏ nằm sẵn ở cuối chữ, không phải đầu: sửa tiêu đề thường là
  // thêm vào đuôi hoặc sửa mấy chữ cuối.
  useEffect(() => {
    if (!editing) return
    const el = box.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  function save() {
    const next = text.trim()
    if (!next) {
      setErr('Tiêu đề không được để trống')
      return
    }
    if (next === summary.trim()) {
      setEditing(false)
      return
    }
    startSaving(async () => {
      const res = await updateSummaryAction(issueKey, next)
      if (!res.ok) {
        setErr(res.message)
        return
      }
      onSaved(next)
      setEditing(false)
      setErr('')
    })
  }

  if (!editing)
    return (
      <h2
        className="group cursor-text text-[15px] font-semibold leading-snug"
        onClick={() => {
          setText(summary)
          setErr('')
          setEditing(true)
        }}
        title="Bấm để sửa tiêu đề"
      >
        {summary}
        <span className="ml-1.5 align-middle text-[11px] font-normal text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
          ✎ sửa
        </span>
      </h2>
    )

  return (
    <div>
      <textarea
        ref={box}
        value={text}
        rows={2}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter lưu, Shift+Enter xuống dòng — tiêu đề Jira là một dòng, nên
          // Enter ở đây có nghĩa là "xong" chứ không phải "xuống dòng".
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
          // Esc chỉ đóng ô sửa, không được để nó đóng luôn cả modal.
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setEditing(false)
            setErr('')
          }
        }}
        className="w-full resize-y rounded-md border border-line bg-ground px-2.5 py-1.5 text-[15px] font-semibold leading-snug disabled:opacity-60"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:bg-accent-2 disabled:opacity-60"
        >
          {saving ? 'Đang lưu…' : 'Lưu'}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false)
            setErr('')
          }}
          disabled={saving}
          className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-2"
        >
          Huỷ
        </button>
        <span className="text-[11px] text-ink-3">Enter để lưu · Esc để huỷ</span>
      </div>
      {err && <p className="mt-1 text-[12px] text-crit">{err}</p>}
    </div>
  )
}

/**
 * Mô tả issue, sửa được tại chỗ, có nút nhờ Gemini viết lại.
 *
 * Hai ô chứ không một: Jira cất mô tả và Definition of Done chung một tài liệu
 * ADF, nhưng người soạn nghĩ về chúng riêng — và màn Task mới cũng hỏi riêng.
 * {@link splitDod} tách về đúng hai ô ấy, {@link textToAdf} ghép lại.
 *
 * Nút Gemini **không** tự ghi: nó điền chữ vào ô để người dùng đọc và sửa, rồi
 * mới bấm Lưu. Đổi tiêu đề xong mà mô tả tự nhảy theo là thứ không ai muốn.
 */
function EditableDescription({
  issueKey,
  doc,
  title,
  parentSummary,
  onSaved,
  onEditingChange,
  titleDirty,
}: {
  issueKey: string
  doc: unknown
  title: string
  parentSummary?: string
  onSaved: (doc: unknown) => void
  onEditingChange: (on: boolean) => void
  /** Tiêu đề đang sửa chưa lưu — Gemini phải đợi, xem ghi chú ở `IssueDetail`. */
  titleDirty: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [desc, setDesc] = useState('')
  const [dod, setDod] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, startSaving] = useTransition()
  const [asking, startAsking] = useTransition()

  useEffect(() => {
    onEditingChange(editing)
  }, [editing, onEditingChange])

  const blocks: AdfBlock[] = adfToBlocks(doc)

  function open() {
    const parts = splitDod(doc)
    setDesc(parts.description)
    setDod(parts.dod)
    setNote(null)
    setEditing(true)
  }

  function save() {
    startSaving(async () => {
      const res = await updateDescriptionAction(issueKey, desc, dod)
      if (!res.ok) {
        setNote({ ok: false, text: res.message })
        return
      }
      // Dựng lại tài liệu ngay tại client thay vì tải lại: đúng hàm server vừa
      // ghi, nên cái đang xem khớp cái vừa lưu mà không tốn một vòng mạng.
      onSaved(textToAdf(desc, dod))
      setEditing(false)
    })
  }

  function regenerate() {
    startAsking(async () => {
      const res = await regenerateDescriptionAction(title, parentSummary)
      setNote({ ok: res.ok, text: res.message })
      if (!res.ok) return
      setDesc(res.description ?? '')
      setDod(res.dod ?? '')
    })
  }

  if (!editing)
    return (
      <div className="mt-4 border-t border-line pt-3.5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Mô tả
          </span>
          <button
            type="button"
            onClick={open}
            className="text-[11.5px] text-accent-ink underline underline-offset-2"
          >
            ✎ sửa
          </button>
        </div>
        {blocks.length > 0 ? (
          blocks.map((b, i) => <Block key={i} block={b} />)
        ) : (
          <p className="text-[12.5px] text-ink-3">Task này chưa có mô tả.</p>
        )}
      </div>
    )

  const busy = saving || asking
  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Mô tả
        </span>
        <button
          type="button"
          onClick={regenerate}
          disabled={busy || titleDirty}
          title={
            titleDirty
              ? 'Tiêu đề đang sửa chưa lưu — Gemini viết theo tiêu đề đã lưu, nên hãy bấm Lưu ở tiêu đề trước.'
              : `Nhờ Gemini viết lại theo tiêu đề đã lưu:\n${title}\nChỉ điền vào ô — chưa ghi lên Jira.`
          }
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-40"
        >
          {asking ? <Spinner /> : '✨'} {asking ? 'Đang viết…' : 'Gemini viết lại'}
        </button>
      </div>

      {/* Nút xám mà không nói lý do thì người dùng chỉ thấy nó hỏng. */}
      {titleDirty && (
        <p className="mb-2 text-[11.5px] text-warn">
          Tiêu đề đang sửa chưa lưu — Gemini viết theo tiêu đề <b>đã lưu</b>.
          Bấm <b>Lưu</b> ở tiêu đề trước rồi hãy viết lại.
        </p>
      )}

      <label className="block">
        <span className="text-[11px] text-ink-3">Nội dung — mỗi dòng bắt đầu bằng “- ” là một gạch đầu dòng</span>
        <textarea
          value={desc}
          rows={6}
          disabled={busy}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={onEscape}
          className="mt-1 w-full resize-y rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12.5px] leading-relaxed disabled:opacity-60"
        />
      </label>

      <label className="mt-2 block">
        <span className="text-[11px] text-ink-3">Definition of Done</span>
        <textarea
          value={dod}
          rows={4}
          disabled={busy}
          onChange={(e) => setDod(e.target.value)}
          onKeyDown={onEscape}
          className="mt-1 w-full resize-y rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12.5px] leading-relaxed disabled:opacity-60"
        />
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:bg-accent-2 disabled:opacity-60"
        >
          {saving ? 'Đang lưu…' : 'Lưu mô tả'}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false)
            setNote(null)
          }}
          disabled={busy}
          className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-2"
        >
          Huỷ
        </button>
        <span className="text-[11px] text-ink-3">Esc để huỷ</span>
      </div>

      {note && (
        <p className={`mt-1.5 text-[12px] ${note.ok ? 'text-ink-3' : 'text-crit'}`}>
          {note.text}
        </p>
      )}
    </div>
  )

  // Esc chỉ đóng ô sửa; modal đã được dặn bỏ qua Esc khi ô này đang mở.
  function onEscape(e: React.KeyboardEvent) {
    if (e.key !== 'Escape' || busy) return
    e.preventDefault()
    e.stopPropagation()
    setEditing(false)
    setNote(null)
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap text-ink-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function Block({ block }: { block: AdfBlock }) {
  if (block.kind === 'heading') {
    return (
      <h3 className="mb-1.5 mt-3 text-[13px] font-semibold first:mt-0">{block.text}</h3>
    )
  }
  if (block.kind === 'bullets') {
    return (
      <ul className="mb-2.5 flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-relaxed">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    )
  }
  return <p className="mb-2.5 text-[12.5px] leading-relaxed">{block.text}</p>
}

/** Status colour for a pill rendered outside this file. */
export function toneClass(status: string) {
  return TONE[statusTone(status)]
}
