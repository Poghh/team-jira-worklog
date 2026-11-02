'use client'

import { Fragment, type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'

import { type DiffFile, type DiffLine, LARGE_FILE_ROWS, generatedReason, rowCount } from '@/lib/modules/code-review/diff'
import { highlightDiff } from '@/lib/modules/code-review/highlight'
import { type Addressee, type FindingView, type ItemView, type RoundView, SEVERITIES, SEVERITY_LABEL, type Severity, shortSha } from '@/lib/modules/code-review/model'

import { type RoundDiff, addOwnFindingAction, postFindingAction, roundDiffAction } from '../actions'
import { BTN, BTN_PRI, CARD, INPUT } from '../ui'
import { type ChatHandle, ChatPanel } from './chat'
import { ConfirmButton, useGh } from './github'

/**
 * "Thay đổi code": the round's diff laid out like GitHub's Files changed — a
 * file tree on the left that follows the scroll, the diffs on the right with
 * Claude's findings under the lines they are about, and on any line the
 * reviewer's own comment or a question to Claude about it. Nothing here posts
 * anything: a saved comment is a finding like the others, sent by its own
 * "Gửi lên PR".
 *
 * Big PRs (tens of files, ten thousand lines) stay smooth because a file's
 * lines are only in the DOM while it is near the screen; elsewhere it is a
 * box of the same height. Files are memoised, so picking a line or ticking
 * "Đã xem" re-renders one file, not all of them.
 */

type Scope = 'all' | 'since'

interface Selection {
  file: string
  /** Indexes into the file's lines, in click order. */
  a: number
  b: number
}

const STATUS_BADGE: Record<DiffFile['status'], string> = { added: 'mới', deleted: 'xoá', modified: '', renamed: 'đổi tên' }
const STATUS_DOT: Record<DiffFile['status'], string> = { added: 'text-good', deleted: 'text-crit', modified: 'text-warn', renamed: 'text-blue-ink' }

const live = (f: FindingView) => f.status !== 'fixed' && f.status !== 'dismissed'
const anchorId = (path: string) => `diff-${encodeURIComponent(path)}`
/** Where a file counts as "the one being read": its header has passed this line. */
const READ_LINE = 120

function readViewed(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function CodeTab({
  item,
  round,
  findings,
  githubRepo,
  canRun,
  addressee,
  renderFinding,
  onChanged,
}: {
  item: ItemView
  round: RoundView
  findings: FindingView[]
  githubRepo: string
  canRun: boolean
  addressee: Addressee | null
  /** A finding card as the review tab shows it; `onAsk` opens the chat beside the diff. */
  renderFinding: (f: FindingView, onAsk: () => void) => ReactNode
  onChanged: () => void
}) {
  const later = round.round > 1 && Boolean(round.prevHeadSha)
  // The whole PR by default, as GitHub shows it; a later round marks what moved since the last one.
  const [scope, setScope] = useState<Scope>('all')
  const [sinceCount, setSinceCount] = useState<number | null>(null)
  const [diff, setDiff] = useState<RoundDiff | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const viewedKey = `code-review:viewed:${round.id}`
  const [viewed, setViewed] = useState<Set<string>>(new Set())
  const [showClosed, setShowClosed] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)
  const [active, setActive] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const chat = useRef<ChatHandle>(null)
  const done = round.state === 'done'

  useEffect(() => setViewed(new Set(readViewed(viewedKey))), [viewedKey])

  useEffect(() => {
    let stale = false
    setDiff(null)
    setSel(null)
    void roundDiffAction(round.id, scope).then((d) => {
      if (stale) return
      setDiff(d)
      if (d.ok && later) setSinceCount(d.since.length)
      const seen = new Set(readViewed(viewedKey))
      // Deleted, huge, machine-written (lock files, generated code) or already
      // viewed: start closed, one click away.
      setCollapsed(
        new Set(d.files.filter((f) => f.status === 'deleted' || rowCount(f) > LARGE_FILE_ROWS || generatedReason(f) || seen.has(f.path)).map((f) => f.path)),
      )
    })
    return () => {
      stale = true
    }
  }, [round.id, scope, viewedKey, later])

  // One order for both columns: the tree's (folders first, by name), not git's
  // byte order, which puts "Cargo.lock" before "bindings/".
  const tree = useMemo(() => buildTree(diff?.files ?? []), [diff])
  const files = useMemo(() => treeOrder(tree), [tree])
  useEffect(() => setActive(files[0]?.path ?? ''), [files])
  const generated = useMemo(() => new Map(files.map((f) => [f.path, generatedReason(f)] as const).filter(([, r]) => r)), [files])
  // Marked only in the full view — in "since" every file is new by definition.
  const fresh = useMemo(() => new Set(scope === 'all' ? (diff?.since ?? []) : []), [diff, scope])

  // Scroll spy: the active file is the last one whose header has scrolled past
  // the reading line. One rect per file per frame — cheap even for 100 files.
  useEffect(() => {
    if (!files.length) return
    let frame = 0
    const spy = () => {
      frame = 0
      let current = files[0].path
      for (const f of files) {
        const el = document.getElementById(anchorId(f.path))
        if (!el) continue
        if (el.getBoundingClientRect().top <= READ_LINE) current = f.path
        else break
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(spy)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [files])

  const jump = useCallback((path: string) => {
    setActive(path)
    setCollapsed((c) => {
      if (!c.has(path)) return c
      const n = new Set(c)
      n.delete(path)
      return n
    })
    const go = () => {
      const el = document.getElementById(anchorId(path))
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 8 })
    }
    // Files around the target mount on arrival and may change height a
    // little; land again once they have.
    requestAnimationFrame(go)
    setTimeout(go, 150)
  }, [])

  const toggle = useCallback(
    (path: string) =>
      setCollapsed((c) => {
        const n = new Set(c)
        if (n.has(path)) n.delete(path)
        else n.add(path)
        return n
      }),
    [],
  )

  const toggleViewed = useCallback(
    (path: string) => {
      setViewed((prev) => {
        const next = new Set(prev)
        const on = !next.has(path)
        if (on) next.add(path)
        else next.delete(path)
        setCollapsed((c) => {
          const n = new Set(c)
          if (on) n.add(path)
          else n.delete(path)
          return n
        })
        try {
          localStorage.setItem(viewedKey, JSON.stringify([...next]))
        } catch {}
        return next
      })
    },
    [viewedKey],
  )

  const select = useCallback(
    (path: string, i: number, extend: boolean) =>
      setSel((s) => (extend && s?.file === path ? { ...s, b: i } : s?.file === path && s.a === i && s.b === i ? null : { file: path, a: i, b: i })),
    [],
  )

  const range = useCallback((path: string, a: number, b: number) => setSel({ file: path, a, b }), [])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(t)
  }, [notice])

  const byFile = useMemo(() => {
    const m = new Map<string, FindingView[]>()
    for (const f of findings) if (f.file && (showClosed || live(f))) m.set(f.file, [...(m.get(f.file) ?? []), f])
    return m
  }, [findings, showClosed])

  const elsewhere = useMemo(() => [...byFile.values()].flat().filter((f) => !files.some((d) => d.path === f.file)), [byFile, files])
  const totals = useMemo(() => files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }), [files])

  // Stable callbacks for the memoised files; the latest props are read at call time.
  const latest = useRef({ renderFinding, onChanged })
  latest.current = { renderFinding, onChanged }
  const askFinding = useCallback((f: FindingView) => {
    setChatOpen(true)
    setTimeout(() => chat.current?.ask(f), 50)
  }, [])
  const showFinding = useCallback((f: FindingView) => latest.current.renderFinding(f, () => askFinding(f)), [askFinding])
  const cancel = useCallback(() => setSel(null), [])
  const saved = useCallback((message?: string) => {
    setSel(null)
    if (message) setNotice(message)
    latest.current.onChanged()
  }, [])
  const ask = useCallback((text: string) => {
    setSel(null)
    setChatOpen(true)
    chat.current?.send(text)
  }, [])

  return (
    <>
      {/* Lets the app's main column use the full screen width, like GitHub's diff (globals.css). */}
      <span className="wide-page" hidden />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        {later && (
          <div className="flex overflow-hidden rounded-md border border-line-strong">
            {(
              [
                ['all', 'Toàn bộ PR'],
                ['since', `Chỉ phần đổi từ vòng trước${sinceCount != null ? ` (${sinceCount} file)` : ''} · ${shortSha(round.prevHeadSha)}…${shortSha(round.headSha)}`],
              ] as const
            ).map(([s, label]) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={'border-l border-line px-3 py-[4px] first:border-l-0 ' + (scope === s ? 'bg-accent-soft font-semibold text-accent-ink' : 'bg-surface text-ink-2 hover:bg-surface-2')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {diff?.ok && (
          <span className="text-ink-2">
            {files.length} file · <span className="text-good">+{totals.add}</span> <span className="text-crit">−{totals.del}</span>
            {viewed.size > 0 && <span className="text-ink-3"> · đã xem {files.filter((f) => viewed.has(f.path)).length}/{files.length}</span>}
          </span>
        )}
        <label className="flex items-center gap-1 text-ink-2">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Hiện cả finding đã sửa / bỏ qua
        </label>
        <div className="ml-auto flex gap-1.5">
          {files.length > 1 && (
            <button type="button" className={BTN} onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(files.map((f) => f.path)))}>
              {collapsed.size ? 'Mở hết' : 'Thu gọn hết'}
            </button>
          )}
          <button type="button" className={BTN} onClick={() => setChatOpen((v) => !v)}>
            💬 {chatOpen ? 'Ẩn' : 'Mở'} chat với Claude
          </button>
        </div>
      </div>

      <p className="mb-3 text-[11.5px] text-ink-3">
        Bấm vào một dòng, hoặc kéo chuột quét cả đoạn code (Shift + bấm để nới rộng) → gửi comment thẳng lên PR, lưu lại để xem sau, hoặc hỏi Claude về đoạn
        đó. Không có gì lên PR nếu bạn chưa bấm xác nhận gửi.
      </p>

      {!diff ? (
        <div className={CARD + ' text-[12.5px] text-ink-3'}>Đang đọc diff từ clone…</div>
      ) : !diff.ok ? (
        <div className={CARD + ' text-[12.5px] text-crit'}>{diff.message}</div>
      ) : (
        <div className="flex items-start gap-3">
          {files.length > 0 && <FileTree files={files} tree={tree} active={active} viewed={viewed} fresh={fresh} generated={generated} byFile={byFile} onPick={jump} />}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {diff.truncated && <div className={CARD + ' !py-2 text-[12px] text-warn'}>Diff quá lớn — chỉ hiện {files.length} file đầu.</div>}
            {files.length === 0 && <div className={CARD + ' text-[12.5px] text-ink-2'}>Không có thay đổi nào.</div>}
            {files.map((f) => (
              <FileDiff
                key={f.path}
                file={f}
                findings={byFile.get(f.path)}
                open={!collapsed.has(f.path)}
                viewed={viewed.has(f.path)}
                fresh={fresh.has(f.path)}
                generated={generated.get(f.path) ?? ''}
                blob={githubRepo && f.status !== 'deleted' ? `https://github.com/${githubRepo}/blob/${round.headSha}/${f.path}` : ''}
                sel={sel?.file === f.path ? sel : null}
                roundId={round.id}
                canComment={done}
                canAsk={done && canRun}
                onToggle={toggle}
                onViewed={toggleViewed}
                onSelect={select}
                onRange={range}
                onCancel={cancel}
                onSaved={saved}
                onAsk={ask}
                renderFinding={showFinding}
              />
            ))}
            {elsewhere.length > 0 && (
              <section className={CARD}>
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">
                  Finding ở file không có trong phần diff đang xem{scope === 'since' ? ' (thử “Toàn bộ PR”)' : ''}
                </div>
                <div className="flex flex-col gap-2">
                  {elsewhere.map((x) => (
                    <Fragment key={x.id}>{showFinding(x)}</Fragment>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/* Kept mounted while hidden: the conversation and its polling survive closing it. */}
      <aside
        className={
          'fixed right-0 top-0 z-40 h-screen w-[460px] max-w-full overflow-y-auto border-l border-line-strong bg-ground p-3 shadow-xl ' +
          (chatOpen ? '' : 'hidden')
        }
      >
        <div className="mb-2 flex items-center">
          <span className="text-[12.5px] font-medium text-ink-2">
            Vòng {round.round} · {item.title}
          </span>
          <button type="button" className={BTN + ' ml-auto'} onClick={() => setChatOpen(false)}>
            Đóng
          </button>
        </div>
        {done ? (
          <ChatPanel ref={chat} roundId={round.id} findings={findings} canRun={canRun} addressee={addressee} onApplied={onChanged} />
        ) : (
          <div className={CARD + ' text-[12.5px] text-ink-2'}>Vòng này chưa xong — chat được khi review xong.</div>
        )}
      </aside>
      {notice && (
        <div className="fixed bottom-5 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-md border border-line-strong bg-surface px-3 py-2 text-[12.5px] shadow-lg">
          {notice}
        </div>
      )}
      {!chatOpen && done && (
        <button type="button" onClick={() => setChatOpen(true)} className={BTN_PRI + ' fixed bottom-5 right-5 z-30 shadow-lg'}>
          💬 Chat với Claude
        </button>
      )}
    </>
  )
}

/* ── left: the file tree ────────────────────────────────────────────────── */

interface Dir {
  name: string
  key: string
  dirs: Dir[]
  files: DiffFile[]
}

/** Files as a folder tree, single-child folders merged ("Sources/Feature/Login"), as GitHub does. */
function buildTree(files: DiffFile[]): Dir {
  const root: Dir = { name: '', key: '', dirs: [], files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let d = root
    for (const part of parts.slice(0, -1)) {
      let next = d.dirs.find((x) => x.name === part)
      if (!next) {
        next = { name: part, key: d.key ? `${d.key}/${part}` : part, dirs: [], files: [] }
        d.dirs.push(next)
      }
      d = next
    }
    d.files.push(f)
  }
  const squash = (d: Dir): Dir => {
    d.dirs = d.dirs.map(squash)
    if (d.name && d.files.length === 0 && d.dirs.length === 1) {
      const only = d.dirs[0]
      return { ...only, name: `${d.name}/${only.name}` }
    }
    return d
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  const sort = (d: Dir) => {
    d.dirs.sort((a, b) => byName(a.name, b.name))
    d.files.sort((a, b) => byName(a.path.split('/').at(-1)!, b.path.split('/').at(-1)!))
    d.dirs.forEach(sort)
  }
  sort(root)
  return squash(root)
}

/** The files in the order the tree lists them. */
function treeOrder(d: Dir): DiffFile[] {
  return [...d.dirs.flatMap(treeOrder), ...d.files]
}

const FileTree = memo(function FileTree({
  files,
  tree,
  active,
  viewed,
  fresh,
  generated,
  byFile,
  onPick,
}: {
  files: DiffFile[]
  tree: Dir
  active: string
  viewed: Set<string>
  fresh: Set<string>
  generated: Map<string, string>
  byFile: Map<string, FindingView[]>
  onPick: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const box = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => (q ? files.filter((f) => f.path.toLowerCase().includes(q)) : []), [files, q])

  // Keep the active file visible in the tree as the diff scrolls.
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(active)}"]`)
    const b = box.current
    if (!el || !b) return
    // The box is `relative`, so offsetTop is already measured from its top.
    const top = el.offsetTop
    if (top < b.scrollTop + 40 || top > b.scrollTop + b.clientHeight - 40) b.scrollTop = top - b.clientHeight / 2
  }, [active])

  const fileRow = (f: DiffFile, depth: number, full = false) => {
    const n = byFile.get(f.path)?.length ?? 0
    const on = f.path === active
    return (
      <button
        key={f.path}
        type="button"
        data-path={f.path}
        onClick={() => onPick(f.path)}
        title={f.path}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={
          'flex w-full items-center gap-1.5 rounded py-[3px] pr-2 text-left ' +
          (on ? 'bg-accent-soft font-semibold text-accent-ink' : viewed.has(f.path) || generated.has(f.path) ? 'text-ink-3 hover:bg-surface-2' : 'text-ink-2 hover:bg-surface-2')
        }
      >
        <span className={'shrink-0 text-[9px] ' + STATUS_DOT[f.status]}>●</span>
        <span className={'min-w-0 flex-1 truncate ' + (f.status === 'deleted' ? 'line-through' : '')}>{full ? f.path : f.path.split('/').at(-1)}</span>
        {generated.has(f.path) && (
          <span className="shrink-0 font-sans text-[10px] text-ink-3" title={`Tự sinh: ${generated.get(f.path)}`}>
            tự sinh
          </span>
        )}
        {fresh.has(f.path) && <span className="shrink-0 rounded bg-blue-soft px-1 font-sans text-[10px] text-blue-ink" title="Member đã sửa file này sau vòng trước">mới đổi</span>}
        {n > 0 && <span className="shrink-0 rounded bg-warn-soft px-1 text-[10px] text-warn">{n}</span>}
        {viewed.has(f.path) && <span className="shrink-0 text-good">✓</span>}
      </button>
    )
  }

  const dirRows = (d: Dir, depth: number): ReactNode[] => {
    const out: ReactNode[] = []
    for (const sub of d.dirs) {
      const isClosed = closed.has(sub.key)
      out.push(
        <button
          key={`d:${sub.key}`}
          type="button"
          style={{ paddingLeft: 8 + depth * 12 }}
          className="flex w-full items-center gap-1 rounded py-[3px] pr-2 text-left text-ink-3 hover:bg-surface-2"
          onClick={() =>
            setClosed((c) => {
              const n = new Set(c)
              if (n.has(sub.key)) n.delete(sub.key)
              else n.add(sub.key)
              return n
            })
          }
          title={sub.key}
        >
          <span className="w-3 shrink-0">{isClosed ? '▸' : '▾'}</span>
          <span className="min-w-0 truncate">{sub.name}</span>
        </button>,
      )
      if (!isClosed) out.push(...dirRows(sub, depth + 1))
    }
    for (const f of d.files) out.push(fileRow(f, depth))
    return out
  }

  return (
    <nav className="sticky top-2 hidden w-[270px] shrink-0 2xl:w-[320px] flex-col rounded-[9px] border border-line bg-surface lg:flex" style={{ maxHeight: 'calc(100vh - 16px)' }}>
      <div className="border-b border-line p-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Lọc ${files.length} file…`} className={INPUT + ' !py-1 text-[12px]'} />
      </div>
      <div ref={box} className="relative min-h-0 flex-1 overflow-y-auto p-1 font-mono text-[11.5px]">
        {q ? (matches.length ? matches.map((f) => fileRow(f, 0, true)) : <div className="p-2 text-ink-3">Không có file nào khớp.</div>) : dirRows(tree, 0)}
      </div>
    </nav>
  )
})

/* ── right: one file ────────────────────────────────────────────────────── */

type Row = { kind: 'hunk'; text: string } | { kind: 'line'; line: DiffLine; i: number }

const NO_FINDINGS: FindingView[] = []
/** Rough height of a file's lines before they are drawn, so the scrollbar is about right. */
const estimate = (f: DiffFile) => Math.round(rowCount(f) * 19.5 + f.hunks.length * 22)

const FileDiff = memo(function FileDiff({
  file,
  findings = NO_FINDINGS,
  open,
  viewed,
  fresh,
  generated,
  blob,
  sel,
  roundId,
  canComment,
  canAsk,
  onToggle,
  onViewed,
  onSelect,
  onRange,
  onCancel,
  onSaved,
  onAsk,
  renderFinding,
}: {
  file: DiffFile
  findings?: FindingView[]
  open: boolean
  viewed: boolean
  fresh: boolean
  /** Why the file is machine-written ('' = it is not). */
  generated: string
  blob: string
  sel: Selection | null
  roundId: number
  canComment: boolean
  canAsk: boolean
  onToggle: (path: string) => void
  onViewed: (path: string) => void
  onSelect: (path: string, i: number, extend: boolean) => void
  onRange: (path: string, a: number, b: number) => void
  onCancel: () => void
  onSaved: (message?: string) => void
  onAsk: (text: string) => void
  renderFinding: (f: FindingView) => ReactNode
}) {
  const section = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const height = useRef<number | null>(null)
  const [near, setNear] = useState(false)

  // Lines are in the DOM only while the file is within a couple of screens.
  useEffect(() => {
    const el = section.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting && body.current) height.current = body.current.offsetHeight
        setNear(e.isIntersecting)
      },
      { rootMargin: '1500px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <section id={anchorId(file.path)} ref={section} className="rounded-[9px] border border-line bg-surface">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-[9px] border-b border-line bg-surface px-3 py-2">
        <button type="button" className="w-4 text-ink-3 hover:text-ink" onClick={() => onToggle(file.path)} title={open ? 'Thu gọn' : 'Mở'}>
          {open ? '▾' : '▸'}
        </button>
        {STATUS_BADGE[file.status] && <span className="rounded bg-surface-2 px-1.5 py-[1px] text-[10.5px] font-medium text-ink-2">{STATUS_BADGE[file.status]}</span>}
        <span className="min-w-0 break-all font-mono text-[12px] font-medium">
          {file.status === 'renamed' && file.oldPath !== file.path ? (
            <>
              <span className="text-ink-3">{file.oldPath} → </span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <CopyPath path={file.path} />
        <span className="font-mono text-[11.5px]">
          <span className="text-good">+{file.additions}</span> <span className="text-crit">−{file.deletions}</span>
        </span>
        {generated && (
          <span className="rounded bg-surface-2 px-1.5 py-[1px] text-[11px] text-ink-3" title="File máy sinh ra — thu gọn sẵn, bấm ▸ để xem">
            tự sinh · {generated}
          </span>
        )}
        {fresh && <span className="rounded bg-blue-soft px-1.5 py-[1px] text-[11px] text-blue-ink" title="Member đã sửa file này sau vòng trước">mới đổi từ vòng trước</span>}
        {findings.length > 0 && <span className="rounded bg-warn-soft px-1.5 py-[1px] text-[11px] text-warn">{findings.length} finding</span>}
        <span className="ml-auto flex items-center gap-3 text-[12px] text-ink-2">
          {blob && (
            <a href={blob} target="_blank" rel="noreferrer" className="hover:text-accent-ink">
              Xem file ↗
            </a>
          )}
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={viewed} onChange={() => onViewed(file.path)} />
            Đã xem
          </label>
        </span>
      </div>

      {open &&
        (near || sel ? (
          <div ref={body}>
            <FileBody file={file} findings={findings} sel={sel} roundId={roundId} canComment={canComment} canAsk={canAsk} onSelect={onSelect} onRange={onRange} onCancel={onCancel} onSaved={onSaved} onAsk={onAsk} renderFinding={renderFinding} />
          </div>
        ) : (
          <div style={{ height: height.current ?? estimate(file) }} />
        ))}
    </section>
  )
})

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title={done ? 'Đã copy' : 'Copy đường dẫn file'}
      className={'shrink-0 rounded px-1 text-[12px] hover:bg-surface-2 ' + (done ? 'text-good' : 'text-ink-3 hover:text-ink')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(path)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {}
      }}
    >
      {done ? '✓' : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
          <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
        </svg>
      )}
    </button>
  )
}

function FileBody({
  file,
  findings,
  sel,
  roundId,
  canComment,
  canAsk,
  onSelect,
  onRange,
  onCancel,
  onSaved,
  onAsk,
  renderFinding,
}: {
  file: DiffFile
  findings: FindingView[]
  sel: Selection | null
  roundId: number
  canComment: boolean
  canAsk: boolean
  onSelect: (path: string, i: number, extend: boolean) => void
  onRange: (path: string, a: number, b: number) => void
  onCancel: () => void
  onSaved: (message?: string) => void
  onAsk: (text: string) => void
  renderFinding: (f: FindingView) => ReactNode
}) {
  const { rows, lines } = useMemo(() => {
    const rows: Row[] = []
    const lines: DiffLine[] = []
    for (const h of file.hunks) {
      rows.push({ kind: 'hunk', text: `@@ -${h.oldStart} +${h.newStart} @@ ${h.section}` })
      for (const l of h.lines) {
        rows.push({ kind: 'line', line: l, i: lines.length })
        lines.push(l)
      }
    }
    return { rows, lines }
  }, [file])
  // Coloured once per file while it is mounted; null = plain text.
  const html = useMemo(() => highlightDiff(file), [file])

  // Each finding goes under the last line it covers, or its first when that is shown.
  const { at, outside } = useMemo(() => {
    const shownNew = new Map<number, number>()
    lines.forEach((l, i) => l.n != null && shownNew.set(l.n, i))
    const at = new Map<number, FindingView[]>()
    const outside: FindingView[] = []
    for (const f of findings) {
      const end = f.endLine && f.line && f.endLine > f.line ? f.endLine : f.line
      const i = end != null ? (shownNew.get(end) ?? (f.line != null ? shownNew.get(f.line) : undefined)) : undefined
      if (i === undefined) outside.push(f)
      else at.set(i, [...(at.get(i) ?? []), f])
    }
    return { at, outside }
  }, [lines, findings])

  const lo = sel ? Math.min(sel.a, sel.b) : -1
  const hi = sel ? Math.max(sel.a, sel.b) : -1
  const table = useRef<HTMLTableElement>(null)

  // A drag over the code picks the lines it covers; a plain click picks one
  // line (Shift widens). Clicks on the comment box or finding cards are theirs.
  const pick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('button, a, textarea, input, select, label')) return
    const rowOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>('tr[data-i]') ?? null
    const s = window.getSelection()
    if (s && !s.isCollapsed && s.toString().trim()) {
      const a = rowOf(s.anchorNode)
      const b = rowOf(s.focusNode)
      if (a && b && table.current?.contains(a) && table.current.contains(b)) onRange(file.path, Number(a.dataset.i), Number(b.dataset.i))
      return
    }
    const r = rowOf(t)
    if (r) onSelect(file.path, Number(r.dataset.i), e.shiftKey)
  }

  return (
    <>
      {outside.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-line bg-surface-2 p-3">
          <div className="text-[11.5px] text-ink-3">Finding ở dòng không có trong phần diff này</div>
          {outside.map((f) => (
            <Fragment key={f.id}>{renderFinding(f)}</Fragment>
          ))}
        </div>
      )}
      {file.binary ? (
        <div className="p-3 text-[12px] text-ink-3">File nhị phân — không hiện nội dung.</div>
      ) : rows.length === 0 ? (
        <div className="p-3 text-[12px] text-ink-3">{file.status === 'renamed' ? 'Chỉ đổi tên, nội dung giữ nguyên.' : 'Không có dòng thay đổi.'}</div>
      ) : (
        <table ref={table} onMouseUp={pick} className="code-hl w-full border-collapse font-mono text-[12px] leading-[1.6]">
          <tbody>
            {rows.map((r, k) => {
              if (r.kind === 'hunk') {
                return (
                  <tr key={`h${k}`} className="bg-blue-soft text-blue-ink">
                    <td colSpan={3} className="px-3 py-0.5 text-[11.5px]">
                      {r.text}
                    </td>
                  </tr>
                )
              }
              const l = r.line
              const picked = r.i >= lo && r.i <= hi
              const tone = picked ? 'bg-accent-soft' : l.t === '+' ? 'bg-good-soft' : l.t === '-' ? 'bg-crit-soft' : ''
              return (
                <Fragment key={r.i}>
                  <tr data-i={r.i} className={tone + ' cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-accent/40'}>
                    <td className="w-[1%] select-none whitespace-nowrap px-0 text-right align-top text-ink-3">
                      <span className="block px-2">{l.o ?? ''}</span>
                    </td>
                    <td className="w-[1%] select-none whitespace-nowrap border-r border-line px-0 text-right align-top text-ink-3">
                      <span className="block px-2">{l.n ?? ''}</span>
                    </td>
                    <td className="whitespace-pre-wrap break-all px-2 align-top [tab-size:4]">
                      <span className="select-none text-ink-3">{l.t === ' ' ? ' ' : l.t}</span>
                      {html ? <span dangerouslySetInnerHTML={{ __html: html[r.i] }} /> : l.s}
                    </td>
                  </tr>
                  {r.i === hi && (
                    <tr>
                      <td colSpan={3} className="border-y border-line bg-surface p-3 font-sans">
                        <Composer file={file.path} lines={lines.slice(lo, hi + 1)} roundId={roundId} canComment={canComment} canAsk={canAsk} onCancel={onCancel} onSaved={onSaved} onAsk={onAsk} />
                      </td>
                    </tr>
                  )}
                  {at.get(r.i)?.map((f) => (
                    <tr key={`f${f.id}`}>
                      <td colSpan={3} className="border-y border-line bg-surface-2 p-2.5 font-sans">
                        {renderFinding(f)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}

/** The picked lines as Claude and a reader see them: a fenced diff with the range named. */
function quoteLines(file: string, lines: DiffLine[]): { range: string; block: string } {
  const news = lines.map((l) => l.n).filter((n): n is number => n != null)
  const olds = lines.map((l) => l.o).filter((n): n is number => n != null)
  const span = (ns: number[]) => (ns.length ? (ns[0] === ns.at(-1) ? `${ns[0]}` : `${ns[0]}–${ns.at(-1)}`) : '')
  const range = news.length ? `\`${file}\` dòng ${span(news)} (bản mới)` : `\`${file}\` dòng ${span(olds)} của bản cũ (đã xoá trong PR)`
  const body = lines.map((l) => `${l.t}${l.s}`).join('\n')
  return { range, block: '```diff\n' + body.slice(0, 12_000) + '\n```' }
}

function Composer({
  file,
  lines,
  roundId,
  canComment,
  canAsk,
  onCancel,
  onSaved,
  onAsk,
}: {
  file: string
  lines: DiffLine[]
  roundId: number
  canComment: boolean
  canAsk: boolean
  onCancel: () => void
  onSaved: (message?: string) => void
  onAsk: (text: string) => void
}) {
  const gh = useGh()
  const [text, setText] = useState('')
  const [severity, setSeverity] = useState<Severity>('minor')
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const news = lines.map((l) => l.n).filter((n): n is number => n != null)
  const { range, block } = quoteLines(file, lines)

  const save = (thenAsk: boolean) =>
    start(async () => {
      const r = await addOwnFindingAction({ roundId, file, line: news[0], endLine: news.at(-1), severity, body: text })
      setMsg(r.message)
      if (!r.ok) return
      if (thenAsk && r.id) {
        onAsk(
          `Mình vừa viết comment (finding #${r.id}) cho ${range}:\n${block}\n\nNội dung comment:\n"""\n${text.trim()}\n"""\n\nKiểm tra giúp nhận định này có đúng không — mở code xung quanh và nơi gọi tới nếu cần. Đúng thì góp ý viết lại cho rõ, đúng giọng văn comment (đề xuất update finding #${r.id}, kể cả severity nếu thấy chưa hợp). Sai hoặc không đáng comment thì nói rõ vì sao và đề xuất dismiss.`,
        )
      }
      onSaved()
    })

  // Straight to the PR: kept as the reviewer's finding (so the next round
  // checks it), then posted — after the button's own confirm click.
  const post = () =>
    start(async () => {
      const r = await addOwnFindingAction({ roundId, file, line: news[0], endLine: news.at(-1), severity, body: text })
      if (!r.ok || !r.id) {
        setMsg(r.message)
        return
      }
      const p = await postFindingAction(r.id)
      void gh.reload()
      onSaved(p.ok ? p.message : `Đã lưu comment nhưng chưa gửi được: ${p.message} — gửi lại từ comment dưới dòng code.`)
    })

  const ask = () =>
    onAsk(
      `Mình đang xem diff, đoạn ${range}:\n${block}\n\n${text.trim()}\n\nMở code xung quanh (và nơi gọi tới nếu cần) để trả lời cho chắc, đừng đoán. Nếu đây là vấn đề đáng comment lên PR, đề xuất thêm finding trong changes.add gắn đúng file / dòng; nếu không đáng thì nói rõ vì sao.`,
    )

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] text-ink-2">
        {news.length ? (
          <>
            Dòng {news[0]}
            {news.length > 1 && news.at(-1) !== news[0] ? `–${news.at(-1)}` : ''} · <span className="font-mono">{file}</span>
          </>
        ) : (
          <>Dòng đã xoá — chỉ hỏi Claude được (GitHub chỉ cho comment vào bản mới ở đây).</>
        )}
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        rows={4}
        className={INPUT + ' leading-relaxed'}
        placeholder="Comment của bạn (viết như sẽ đăng lên PR), hoặc câu hỏi cho Claude về đoạn này…"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {news.length > 0 && (
          <>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={INPUT + ' !w-auto !py-1 text-[12.5px]'}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
            {gh.canWrite && (
              <ConfirmButton primary label="Gửi lên PR" confirm="Bấm lần nữa để gửi lên GitHub" disabled={busy || !canComment || !text.trim()} onConfirm={post} />
            )}
            <button type="button" className={gh.canWrite ? BTN : BTN_PRI} disabled={busy || !canComment || !text.trim()} title="Lưu lại, chưa gửi — gửi sau bằng nút Gửi lên PR trên comment" onClick={() => save(false)}>
              Lưu, chưa gửi
            </button>
            <button
              type="button"
              className={BTN}
              disabled={busy || !canComment || !canAsk || !text.trim()}
              title="Lưu comment rồi nhờ Claude kiểm tra nhận định và góp ý câu chữ"
              onClick={() => save(true)}
            >
              Lưu + nhờ Claude kiểm tra
            </button>
          </>
        )}
        <button type="button" className={BTN} disabled={busy || !canAsk || !text.trim()} title="Hỏi Claude về đoạn code này — trả lời ở khung chat" onClick={ask}>
          🤖 Hỏi Claude
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Huỷ
        </button>
        {!canComment && <span className="text-[11.5px] text-ink-3">Vòng này chưa xong.</span>}
        {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
      </div>
    </div>
  )
}
