'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'

import type { ClaudeCheck } from '@/lib/modules/code-review/claude'
import {
  DOC_ROLE_LABEL,
  type DocFile,
  type DocRole,
  type DocTemplate,
  type ItemSummary,
  guessTemplate,
  LIVE_STATES,
  type PrLink,
  linkLabel,
  type RepoPreset,
  shortSha,
} from '@/lib/modules/code-review/model'

import {
  type PullRow,
  type Updates,
  archiveItemAction,
  cancelRoundAction,
  checkUpdatesAction,
  dashboardAction,
  deleteItemAction,
  listBranchesAction,
  listPullsAction,
  queueBranchesAction,
  queuePullsAction,
  reReviewAction,
  saveReposAction,
  saveRunnerAction,
  saveTemplatesAction,
} from './actions'
import { BTN, BTN_PRI, CARD, CTITLE, ClaudeBanner, INPUT, RoundPill, TabBtn, Ago } from './ui'

type Tab = 'items' | 'pr' | 'doc' | 'config'

export interface RunnerView {
  concurrency: number
  claudeBin: string
  model: string
  globalRules: string
}

export function CodeReview({
  claude: initialClaude,
  repos,
  runner,
  items: initialItems,
  templates,
}: {
  claude: ClaudeCheck
  repos: RepoPreset[]
  runner: RunnerView
  items: ItemSummary[]
  templates: DocTemplate[]
}) {
  const [tab, setTab] = useState<Tab>(repos.length ? 'items' : 'config')
  const [claude, setClaude] = useState(initialClaude)

  return (
    <>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className={CTITLE}>Module · review PR & tài liệu bằng Claude Code</div>
          <h1 className="text-xl font-semibold tracking-tight">Code review</h1>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line-strong text-[12.5px]">
          <TabBtn on={tab === 'items'} onClick={() => setTab('items')}>
            Hồ sơ
          </TabBtn>
          <TabBtn on={tab === 'pr'} onClick={() => setTab('pr')}>
            + Review PR
          </TabBtn>
          <TabBtn on={tab === 'doc'} onClick={() => setTab('doc')}>
            + Review tài liệu
          </TabBtn>
          <TabBtn on={tab === 'config'} onClick={() => setTab('config')}>
            Cấu hình{repos.length === 0 && <span className="ml-1 text-warn">•</span>}
          </TabBtn>
        </div>
      </header>

      <ClaudeBanner check={claude} onChange={setClaude} />

      {tab === 'items' && <Dashboard initial={initialItems} repos={repos} canRun={claude.ok} onNew={() => setTab('pr')} />}
      {tab === 'pr' && <NewPr repos={repos} canRun={claude.ok} onDone={() => setTab('items')} onConfig={() => setTab('config')} />}
      {tab === 'doc' && <NewDoc repos={repos} templates={templates} canRun={claude.ok} />}
      {tab === 'config' && (
        <>
          <Config repos={repos} runner={runner} onClaude={setClaude} />
          <div className="mt-4">
            <TemplatesManager templates={templates} repos={repos} />
          </div>
        </>
      )}
    </>
  )
}

/* ── dashboard ──────────────────────────────────────────────────────────── */

function Dashboard({
  initial,
  repos,
  canRun,
  onNew,
}: {
  initial: ItemSummary[]
  repos: RepoPreset[]
  canRun: boolean
  onNew: () => void
}) {
  const [items, setItems] = useState(initial)
  const [archived, setArchived] = useState(false)
  const [updates, setUpdates] = useState<Updates>({ commits: {}, replies: {} })
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? '—'

  const refresh = useCallback(async () => setItems(await dashboardAction(archived)), [archived])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll only while something is in flight; a finished queue costs nothing.
  const live = items.some((i) => i.latest && LIVE_STATES.includes(i.latest.state))
  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => void refresh(), 3000)
    return () => clearTimeout(t)
  }, [live, items, refresh])

  useEffect(() => {
    void checkUpdatesAction().then(setUpdates)
  }, [])

  const act = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn()
      setMsg(r.message)
      await refresh()
    })

  const counts = useMemo(() => {
    const c = { running: 0, queued: 0 }
    for (const i of items) {
      if (i.latest?.state === 'running' || i.latest?.state === 'preparing') c.running++
      if (i.latest?.state === 'queued') c.queued++
    }
    return c
  }, [items])

  return (
    <div className={CARD}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className={CTITLE}>
          {archived ? 'Đã lưu trữ' : 'Đang theo dõi'} · {items.length}
          {counts.running > 0 && ` · ${counts.running} đang chạy`}
          {counts.queued > 0 && ` · ${counts.queued} chờ`}
        </div>
        {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Xem lưu trữ
        </label>
      </div>

      {items.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">
          Chưa có gì.{' '}
          <button type="button" onClick={onNew} className="text-accent-ink underline underline-offset-2">
            Chọn PR để review
          </button>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] text-ink-3">
                <th className="py-1.5 pr-2 font-medium">PR / Tài liệu</th>
                <th className="px-2 font-medium">Repo</th>
                <th className="px-2 font-medium">Vòng</th>
                <th className="px-2 font-medium">Trạng thái</th>
                <th className="px-2 font-medium">Còn mở</th>
                <th className="px-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const st = i.latest?.state
                const isLive = st ? LIVE_STATES.includes(st) : false
                const newSha = updates.commits[i.id]
                const replies = updates.replies[i.id]
                return (
                  <tr key={i.id} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <td className="py-2 pr-2">
                      <Link href={`/m/code-review/${i.id}`} className="font-medium hover:text-accent-ink">
                        {i.kind === 'doc' ? '📄 ' : i.prNumber ? `#${i.prNumber} ` : '⎇ '}
                        {i.title}
                      </Link>
                      <div className="mt-0.5 font-mono text-[11px] text-ink-3">
                        {i.kind === 'pr'
                          ? `${i.headRef} → ${i.baseRef}${i.author ? ` · ${i.author}` : ''}${i.latest?.docs.length ? ` · 📎 ${i.latest.docs.length} tài liệu` : ''}${i.links.length ? ` · 🔗 ${i.links.length} PR liên kết` : ''}`
                          : `${i.latest?.docs.length ?? 0} file${i.headRef ? ` · đối chiếu ${i.headRef}` : ''}`}
                      </div>
                    </td>
                    <td className="px-2 text-ink-2">{i.repoId ? repoName(i.repoId) : '—'}</td>
                    <td className="px-2 font-mono">{i.rounds}</td>
                    <td className="px-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {st && <RoundPill s={st} />}
                        {newSha && !isLive && (
                          <span className="rounded bg-warn-soft px-1.5 py-[1px] text-[11px] font-medium text-warn" title={newSha}>
                            🔔 Có commit mới
                          </span>
                        )}
                        {replies > 0 && (
                          <Link
                            href={`/m/code-review/${i.id}?tab=discussion`}
                            className="rounded bg-blue-soft px-1.5 py-[1px] text-[11px] font-medium text-blue-ink"
                          >
                            💬 {replies} phản hồi mới
                          </Link>
                        )}
                        <span className="text-[11px] text-ink-3">
                          <Ago epoch={i.latest?.endedAt ?? i.latest?.createdAt} />
                        </span>
                      </div>
                      {st === 'failed' && i.latest?.message && (
                        <div className="mt-0.5 max-w-[360px] truncate text-[11px] text-crit" title={i.latest.message}>
                          {i.latest.message}
                        </div>
                      )}
                    </td>
                    <td className="px-2 font-mono">{st === 'done' ? i.openFindings : '—'}</td>
                    <td className="px-2 py-2">
                      <div className="flex justify-end gap-1.5">
                        {isLive ? (
                          <button type="button" className={BTN} disabled={busy} onClick={() => act(() => cancelRoundAction(i.latest!.id))}>
                            Huỷ
                          </button>
                        ) : i.kind === 'pr' ? (
                          <button
                            type="button"
                            className={newSha ? BTN_PRI : BTN}
                            disabled={busy || !canRun}
                            onClick={() => act(() => reReviewAction(i.id))}
                          >
                            {i.rounds ? 'Review tiếp' : 'Review'}
                          </button>
                        ) : (
                          <Link href={`/m/code-review/${i.id}`} className={BTN}>
                            Mở
                          </Link>
                        )}
                        {!isLive && (
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy}
                            title={archived ? 'Mở lại' : 'Lưu trữ (PR đã merge / xong việc)'}
                            onClick={() => act(() => archiveItemAction(i.id, !archived))}
                          >
                            {archived ? '↩' : '✓'}
                          </button>
                        )}
                        {archived && (
                          <button type="button" className={BTN} disabled={busy} onClick={() => act(() => deleteItemAction(i.id))}>
                            Xoá
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ── new PR review ──────────────────────────────────────────────────────── */

function NewPr({
  repos,
  canRun,
  onDone,
  onConfig,
}: {
  repos: RepoPreset[]
  canRun: boolean
  onDone: () => void
  onConfig: () => void
}) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const repo = repos.find((r) => r.id === repoId)
  const [pulls, setPulls] = useState<PullRow[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, start] = useTransition()

  const load = useCallback(async () => {
    if (!repo?.githubRepo) {
      setPulls([])
      return
    }
    setLoading(true)
    const r = await listPullsAction(repo.id)
    setLoading(false)
    setPulls(r.pulls)
    setMsg(r.ok ? '' : r.message)
    setPicked(new Set())
  }, [repo?.id, repo?.githubRepo])

  useEffect(() => {
    void load()
  }, [load])

  if (!repos.length) {
    return (
      <div className={CARD + ' text-[12.5px] text-ink-2'}>
        Chưa có repo nào.{' '}
        <button type="button" onClick={onConfig} className="text-accent-ink underline underline-offset-2">
          Thêm repo trong Cấu hình
        </button>
      </div>
    )
  }

  const toggle = (n: number) =>
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  const attach = useAttachments()
  const [links, setLinks] = useState<PrLink[]>([])

  const submit = () =>
    start(async () => {
      const docs = await attach.upload()
      if (!docs) return
      const chosen = pulls.filter((p) => picked.has(p.number))
      const r = await queuePullsAction({ repoId, pulls: chosen, note, docs, links })
      setMsg(r.message)
      if (r.ok) {
        attach.clear()
        onDone()
      }
    })

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className={INPUT + ' w-auto'}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {repo?.githubRepo && (
            <>
              <span className="font-mono text-[11.5px] text-ink-3">{repo.githubRepo}</span>
              <button type="button" className={BTN} onClick={() => void load()} disabled={loading}>
                {loading ? 'Đang tải…' : 'Tải lại'}
              </button>
            </>
          )}
          {msg && <span className="text-[12px] text-crit">{msg}</span>}
        </div>

        {repo?.githubRepo ? (
          <>
            <div className={CTITLE + ' mb-1.5'}>PR đang mở · chọn nhiều cái để review song song</div>
            {pulls.length === 0 && !loading ? (
              <p className="text-[12.5px] text-ink-2">Không có PR nào đang mở.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {pulls.map((p) => {
                  const state = p.live
                    ? { t: 'Đang review', c: 'text-blue-ink' }
                    : !p.reviewedSha
                      ? { t: 'Chưa review', c: 'text-ink-3' }
                      : p.reviewedSha === p.headSha
                        ? { t: `Đã review @${shortSha(p.reviewedSha)}`, c: 'text-good' }
                        : { t: '🔔 Có commit mới', c: 'text-warn font-medium' }
                  return (
                    <li key={p.number}>
                      <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-surface-2/60">
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={p.live}
                          checked={picked.has(p.number)}
                          onChange={() => toggle(p.number)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px]">
                            <span className="font-mono text-ink-3">#{p.number}</span> {p.title}
                            {p.draft && <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10.5px] text-ink-3">draft</span>}
                          </div>
                          <div className="font-mono text-[11px] text-ink-3">
                            {p.headRef} → {p.baseRef} · {p.author}
                          </div>
                        </div>
                        <span className={`shrink-0 text-[11.5px] ${state.c}`}>{state.t}</span>
                        <a href={p.url} target="_blank" rel="noreferrer" className="shrink-0 text-[11.5px] text-ink-3 hover:text-accent-ink" onClick={(e) => e.stopPropagation()}>
                          ↗
                        </a>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Ghi chú cho Claude (không bắt buộc) — vd: tập trung phần xử lý token, PR này fix bug KAN-123…"
              className={INPUT + ' mt-3'}
            />
            {attach.section(
              'Mô tả chức năng, TDD… Claude sẽ kiểm tra PR có làm đúng và đủ theo tài liệu không. Áp dụng cho mọi PR đang chọn; các vòng Review tiếp tự dùng lại.',
            )}
            <details className="mt-2 rounded-md border border-line px-3 py-2" open={links.length > 0}>
              <summary className="cursor-pointer text-[12.5px] text-ink-2">
                🔗 Liên kết PR ở repo khác{links.length ? ` · ${links.length}` : ' (không bắt buộc)'}
              </summary>
              <p className="mb-2 mt-1 text-[11.5px] text-ink-3">
                Vd PR SDK mà PR iOS này dựa vào (hoặc ngược lại). Claude đọc thêm diff và code của PR kia để soi chỗ nối giữa hai bên. Áp dụng cho mọi PR đang chọn.
              </p>
              <LinkPicker repos={repos} value={links} onChange={setLinks} preferNot={repoId} />
            </details>
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className={BTN_PRI} disabled={busy || !canRun || picked.size === 0} onClick={submit}>
                {busy && attach.count ? 'Đang tải tài liệu…' : `Review ${picked.size || ''} PR`}
              </button>
              {!canRun && <span className="text-[12px] text-crit">Claude CLI chưa sẵn sàng.</span>}
            </div>
          </>
        ) : (
          <p className="text-[12.5px] text-ink-2">Repo này chưa gắn GitHub — review theo nhánh ở dưới.</p>
        )}
      </div>

      {repo && <BranchForm repo={repo} repos={repos} canRun={canRun} onDone={onDone} />}
    </div>
  )
}

function BranchForm({ repo, repos, canRun, onDone }: { repo: RepoPreset; repos: RepoPreset[]; canRun: boolean; onDone: () => void }) {
  const [links, setLinks] = useState<PrLink[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [head, setHead] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const attach = useAttachments()

  const load = (refresh: boolean) =>
    start(async () => {
      const r = await listBranchesAction(repo.id, refresh)
      setBranches(r.branches)
      setMsg(r.ok ? '' : r.message)
    })

  useEffect(() => {
    load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.id])

  return (
    <div className={CARD}>
      <div className="mb-2 flex items-center gap-2">
        <div className={CTITLE}>Hoặc review theo nhánh</div>
        <button type="button" className={BTN + ' ml-auto'} disabled={busy} onClick={() => load(true)}>
          {busy ? 'Đang fetch…' : 'git fetch'}
        </button>
      </div>
      <datalist id={`br-${repo.id}`}>
        {branches.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[12px] text-ink-2">
          Nhánh nguồn (head)
          <input list={`br-${repo.id}`} value={head} onChange={(e) => setHead(e.target.value)} className={INPUT} placeholder="feature/…" />
        </label>
        <label className="text-[12px] text-ink-2">
          Merge vào (base)
          <input list={`br-${repo.id}`} value={base} onChange={(e) => setBase(e.target.value)} className={INPUT} placeholder="develop" />
        </label>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT + ' mt-2'} placeholder="Tên hồ sơ (không bắt buộc)" />
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={INPUT + ' mt-2'} placeholder="Ghi chú cho Claude (không bắt buộc)" />
      {attach.section('Mô tả chức năng, TDD… Claude sẽ kiểm tra code trên nhánh có làm đúng và đủ theo tài liệu không.')}
      <details className="mt-2 rounded-md border border-line px-3 py-2" open={links.length > 0}>
        <summary className="cursor-pointer text-[12.5px] text-ink-2">
          🔗 Liên kết PR ở repo khác{links.length ? ` · ${links.length}` : ' (không bắt buộc)'}
        </summary>
        <div className="mt-2">
          <LinkPicker repos={repos} value={links} onChange={setLinks} preferNot={repo.id} />
        </div>
      </details>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className={BTN_PRI}
          disabled={busy || !canRun || !head || !base}
          onClick={() =>
            start(async () => {
              const docs = await attach.upload()
              if (!docs) return
              const r = await queueBranchesAction({ repoId: repo.id, baseRef: base, headRef: head, title, note, docs, links })
              setMsg(r.message)
              if (r.ok) {
                attach.clear()
                onDone()
              }
            })
          }
        >
          Review
        </button>
        {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
      </div>
    </div>
  )
}

/* ── new document review ────────────────────────────────────────────────── */

interface PickedDoc {
  file: File
  role: DocRole
  /** Doc reviews: the template this file follows; '' = none. */
  templateId?: string
  /** Chosen by hand — a later default must not overwrite it. */
  touched?: boolean
}

/**
 * PDF picker with a role per file — and, for doc reviews, the template each
 * file is held to (TDD iOS → mẫu iOS, TDD SDK → mẫu SDK). The files stay in
 * the browser until uploaded.
 */
function DocPicker({
  docs,
  setDocs,
  templates,
  guess,
}: {
  docs: PickedDoc[]
  setDocs: React.Dispatch<React.SetStateAction<PickedDoc[]>>
  /** Given for doc reviews only; PR attachments have no template. */
  templates?: DocTemplate[]
  guess?: (f: { name: string; role: DocRole }) => string
}) {
  return (
    <div>
      <input
        type="file"
        accept="application/pdf,.pdf"
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          setDocs((d) => [
            ...d,
            ...files.map((file) => {
              const role = (/tdd|design|thiet.?ke|thiết.?kế/i.test(file.name) ? 'tdd' : 'spec') as DocRole
              return { file, role, templateId: guess?.({ name: file.name, role }) ?? '' }
            }),
          ])
          e.target.value = ''
        }}
        className="text-[12.5px] file:mr-2 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-2.5 file:py-1 file:text-[12.5px]"
      />
      {docs.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {docs.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-[12.5px]">
              <select
                value={d.role}
                onChange={(e) =>
                  setDocs((all) =>
                    all.map((x, j) => {
                      if (j !== i) return x
                      const role = e.target.value as DocRole
                      return { ...x, role, templateId: x.touched ? x.templateId : guess?.({ name: x.file.name, role }) ?? '' }
                    }),
                  )
                }
                className="rounded-md border border-line bg-ground px-1.5 py-0.5 text-[12px]"
              >
                {(Object.keys(DOC_ROLE_LABEL) as DocRole[]).map((r) => (
                  <option key={r} value={r}>
                    {DOC_ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              {templates && (
                <select
                  value={d.templateId ?? ''}
                  onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, templateId: e.target.value, touched: true } : x)))}
                  className="max-w-[180px] rounded-md border border-line bg-ground px-1.5 py-0.5 text-[12px]"
                  title="Mẫu tài liệu file này phải theo"
                >
                  <option value="">📐 Không mẫu</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      📐 {t.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="truncate">{d.file.name}</span>
              <span className="text-[11px] text-ink-3">{(d.file.size / 1024 / 1024).toFixed(1)} MB</span>
              <button type="button" className="text-ink-3 hover:text-crit" onClick={() => setDocs((all) => all.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Spec / TDD PDFs attached to a PR review. Uploaded first (route handler —
 * too big for an action), then the returned list travels with the action.
 */
export function useAttachments() {
  const [docs, setDocs] = useState<PickedDoc[]>([])
  const [msg, setMsg] = useState('')

  /** Uploads the picked files; `[]` when none, `null` when the upload failed. */
  const upload = async (): Promise<DocFile[] | null> => {
    if (!docs.length) return []
    setMsg('')
    try {
      const form = new FormData()
      for (const d of docs) {
        form.append('files', d.file)
        form.append('roles', d.role)
      }
      const res = await fetch('/api/code-review/upload', { method: 'POST', body: form })
      const body = (await res.json()) as { ok: boolean; message: string; docs?: DocFile[] }
      if (!body.ok || !body.docs) {
        setMsg(body.message || 'Tải tài liệu lên thất bại.')
        return null
      }
      return body.docs
    } catch (err) {
      setMsg((err as Error).message)
      return null
    }
  }

  return {
    count: docs.length,
    clear: () => setDocs([]),
    upload,
    msg,
    section: (hint: string) => (
      <details className="mt-3 rounded-md border border-line px-3 py-2" open={docs.length > 0}>
        <summary className="cursor-pointer text-[12.5px] text-ink-2">
          📎 Đính kèm tài liệu để đối chiếu với code{docs.length ? ` · ${docs.length} file` : ' (không bắt buộc)'}
        </summary>
        <p className="mb-2 mt-1 text-[11.5px] text-ink-3">{hint}</p>
        <DocPicker docs={docs} setDocs={setDocs} />
        {msg && <p className="mt-1 text-[12px] text-crit">{msg}</p>}
      </details>
    ),
  }
}

/**
 * Picker + upload state for PDFs, shared by the new-review form and the
 * detail page's "Review tiếp" (which needs the updated documents).
 */
export function useDocUpload(opts: {
  itemId?: number
  canRun: boolean
  onQueued: (itemId: number) => void
  templates: DocTemplate[]
  /** Template for a TDD whose name says nothing (the repo's / item's default). */
  fallbackTemplate: string
  /** The last round's files: a new version of one keeps its template. */
  previous?: DocFile[]
}) {
  const [docs, setDocs] = useState<PickedDoc[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const guess = (f: { name: string; role: DocRole }) => {
    const byName = guessTemplate(f, opts.templates, '')
    if (byName) return byName
    // Same kind of document as last round, one template among them: keep it.
    const prior = new Set((opts.previous ?? []).filter((p) => p.role === f.role).map((p) => p.templateId ?? ''))
    if (prior.size === 1) return [...prior][0]
    return f.role === 'tdd' ? opts.fallbackTemplate : ''
  }

  // The repo (hence its default template) changed: re-guess what was not chosen by hand.
  useEffect(() => {
    setDocs((all) => all.map((d) => (d.touched ? d : { ...d, templateId: guess({ name: d.file.name, role: d.role }) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.fallbackTemplate])

  const picker = <DocPicker docs={docs} setDocs={setDocs} templates={opts.templates} guess={guess} />

  const submit = async (extra: Record<string, string>) => {
    setBusy(true)
    setMsg('')
    try {
      const form = new FormData()
      if (opts.itemId) form.set('itemId', String(opts.itemId))
      for (const [k, v] of Object.entries(extra)) form.set(k, v)
      for (const d of docs) {
        form.append('files', d.file)
        form.append('roles', d.role)
        form.append('templates', d.templateId ?? '')
      }
      const res = await fetch('/api/code-review/docs', { method: 'POST', body: form })
      const body = (await res.json()) as { ok: boolean; message: string; itemId?: number }
      setMsg(body.message)
      if (body.ok && body.itemId) {
        setDocs([])
        opts.onQueued(body.itemId)
      }
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return { picker, submit, busy, msg, ready: !busy && opts.canRun && docs.length > 0 }
}

function NewDoc({ repos, templates, canRun }: { repos: RepoPreset[]; templates: DocTemplate[]; canRun: boolean }) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const defaultTemplate = (rid: string) => templates.find((t) => t.repoIds.includes(rid))?.id ?? ''
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const up = useDocUpload({
    canRun,
    onQueued: (id) => router.push(`/m/code-review/${id}`),
    templates,
    fallbackTemplate: defaultTemplate(repoId),
  })

  useEffect(() => {
    if (!repoId) return setBranches([])
    void listBranchesAction(repoId).then((r) => setBranches(r.branches))
  }, [repoId])

  return (
    <div className={CARD}>
      <div className={CTITLE + ' mb-2'}>Review tài liệu PDF (mô tả chức năng + TDD iOS / SDK)</div>
      <div className="flex flex-col gap-2.5">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} placeholder="Tên hồ sơ — vd: TDD Payment v2" />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[12px] text-ink-2">
            Đối chiếu với code của repo
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              className={INPUT}
            >
              <option value="">— Không đối chiếu code —</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {repoId && (
            <label className="text-[12px] text-ink-2">
              Ở nhánh
              <input list="doc-branches" value={ref} onChange={(e) => setRef(e.target.value)} className={INPUT} placeholder="develop / feature/…" />
              <datalist id="doc-branches">
                {branches.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </label>
          )}
        </div>
        <div className="text-[12px] text-ink-2">
          Tài liệu — mỗi file chọn loại và <span className="font-medium">📐 mẫu</span> nó phải theo (vd Mô tả chức năng: không mẫu · TDD iOS: mẫu iOS · TDD SDK: mẫu SDK). Mẫu được đoán sẵn theo tên file.
          {templates.length === 0 && <span className="text-ink-3"> Chưa có mẫu nào — thêm ở tab Cấu hình → Mẫu tài liệu.</span>}
        </div>
        {up.picker}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={INPUT} placeholder="Ghi chú cho Claude (không bắt buộc) — vd: chú ý phần migration dữ liệu" />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={BTN_PRI}
            disabled={!up.ready || !title.trim() || (Boolean(repoId) && !ref.trim())}
            onClick={() => void up.submit({ title, repoId, ref, note, templateId: defaultTemplate(repoId) })}
          >
            {up.busy ? 'Đang tải lên…' : 'Review tài liệu'}
          </button>
          {up.msg && <span className="text-[12px] text-ink-2">{up.msg}</span>}
          {!canRun && <span className="text-[12px] text-crit">Claude CLI chưa sẵn sàng.</span>}
        </div>
      </div>
    </div>
  )
}

/* ── config ─────────────────────────────────────────────────────────────── */

const blankRepo = (): RepoPreset => ({ id: '', name: '', localPath: '', githubRepo: '', rules: '' })

function Config({ repos, runner, onClaude }: { repos: RepoPreset[]; runner: RunnerView; onClaude: (c: ClaudeCheck) => void }) {
  const router = useRouter()
  const [list, setList] = useState<RepoPreset[]>(repos.length ? repos : [blankRepo()])
  const [r, setR] = useState(runner)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const patch = (i: number, p: Partial<RepoPreset>) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className={CTITLE + ' mb-1'}>Repo review</div>
        <p className="mb-3 text-[12px] text-ink-2">
          Mỗi repo trỏ tới một bản clone chỉ dùng để review. App sẽ <code>git fetch</code> vào đó và tạo worktree tạm cho từng vòng review — không checkout gì trong clone.
        </p>
        <div className="flex flex-col gap-3">
          {list.map((repo, i) => (
            <div key={i} className="rounded-md border border-line p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <input value={repo.name} onChange={(e) => patch(i, { name: e.target.value })} className={INPUT} placeholder="Tên — vd: iOS app" />
                <input value={repo.localPath} onChange={(e) => patch(i, { localPath: e.target.value })} className={INPUT + ' font-mono'} placeholder="/Users/…/review/ios-app" />
                <input value={repo.githubRepo} onChange={(e) => patch(i, { githubRepo: e.target.value })} className={INPUT + ' font-mono'} placeholder="owner/repo trên github.com" />
              </div>
              <textarea
                value={repo.rules}
                onChange={(e) => patch(i, { rules: e.target.value })}
                rows={4}
                className={INPUT + ' mt-2'}
                placeholder={'Checklist riêng của repo này — vd:\n- UI chỉ cập nhật trên main thread\n- closure giữ self phải [weak self]\n- public API của SDK đổi thì phải ghi CHANGELOG'}
              />
              <button type="button" className="mt-1.5 text-[12px] text-ink-3 hover:text-crit" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
                Xoá repo này
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className={BTN} onClick={() => setList((l) => [...l, blankRepo()])}>
            + Thêm repo
          </button>
          <button
            type="button"
            className={BTN_PRI}
            disabled={busy}
            onClick={() =>
              start(async () => {
                const res = await saveReposAction(list)
                setMsg(res.message)
                if (res.ok) router.refresh()
              })
            }
          >
            Lưu repo
          </button>
          {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-3">
          GitHub token dùng chung với Settings → GitHub token (cần quyền đọc repo private).
        </p>
      </div>

      <div className={CARD}>
        <div className={CTITLE + ' mb-2'}>Claude Code CLI</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-[12px] text-ink-2">
            Số review chạy song song
            <input type="number" min={1} max={6} value={r.concurrency} onChange={(e) => setR({ ...r, concurrency: Number(e.target.value) })} className={INPUT} />
          </label>
          <label className="text-[12px] text-ink-2">
            Model (trống = mặc định của CLI)
            <input value={r.model} onChange={(e) => setR({ ...r, model: e.target.value })} className={INPUT + ' font-mono'} placeholder="opus / sonnet / …" />
          </label>
          <label className="text-[12px] text-ink-2">
            Đường dẫn claude (trống = tự tìm)
            <input value={r.claudeBin} onChange={(e) => setR({ ...r, claudeBin: e.target.value })} className={INPUT + ' font-mono'} placeholder="~/.local/bin/claude" />
          </label>
        </div>
        <label className="mt-2 block text-[12px] text-ink-2">
          Quy tắc chung cho mọi review
          <textarea value={r.globalRules} onChange={(e) => setR({ ...r, globalRules: e.target.value })} rows={3} className={INPUT} placeholder="Áp cho mọi repo, trước quy tắc riêng của từng repo." />
        </label>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className={BTN_PRI}
            disabled={busy}
            onClick={() =>
              start(async () => {
                const res = await saveRunnerAction(r)
                setMsg(res.message)
                if (res.claude) onClaude(res.claude)
              })
            }
          >
            Lưu & kiểm tra CLI
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── linked PRs (SDK ↔ iOS) ─────────────────────────────────────────────── */

/**
 * Picks PRs in other repos to review alongside — e.g. the SDK PR an iOS PR
 * builds on. Claude reads their diff and code; findings stay on this PR.
 */
export function LinkPicker({
  repos,
  value,
  onChange,
  preferNot,
}: {
  repos: RepoPreset[]
  value: PrLink[]
  onChange: (links: PrLink[]) => void
  /** The repo being reviewed — offered last, since the pair is usually cross-repo. */
  preferNot?: string
}) {
  const ordered = [...repos].sort((a, b) => Number(a.id === preferNot) - Number(b.id === preferNot))
  const [repoId, setRepoId] = useState(ordered[0]?.id ?? '')
  const repo = repos.find((r) => r.id === repoId)
  const [pulls, setPulls] = useState<PullRow[]>([])
  const [pick, setPick] = useState('')
  const [head, setHead] = useState('')
  const [base, setBase] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setPulls([])
    setPick('')
    if (!repo?.githubRepo) return
    void listPullsAction(repo.id).then((r) => {
      setPulls(r.pulls)
      setMsg(r.ok ? '' : r.message)
    })
  }, [repo?.id, repo?.githubRepo])

  const name = (id: string) => repos.find((r) => r.id === id)?.name ?? '?'
  const add = (l: PrLink) => {
    if (value.some((v) => v.repoId === l.repoId && (l.prNumber ? v.prNumber === l.prNumber : v.headRef === l.headRef))) return
    onChange([...value, l])
    setPick('')
    setHead('')
    setBase('')
  }

  return (
    <div>
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {value.map((l, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[12px]">
              🔗 <span className="font-medium">{linkLabel(l, name(l.repoId))}</span>
              <span className="max-w-[260px] truncate text-ink-3">{l.title}</span>
              <button type="button" className="text-ink-3 hover:text-crit" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className={INPUT + ' w-auto'}>
          {ordered.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.id === preferNot ? ' (cùng repo)' : ''}
            </option>
          ))}
        </select>
        {repo?.githubRepo ? (
          <>
            <select value={pick} onChange={(e) => setPick(e.target.value)} className={INPUT + ' w-auto max-w-[420px]'}>
              <option value="">— Chọn PR đang mở —</option>
              {pulls.map((p) => (
                <option key={p.number} value={p.number}>
                  #{p.number} {p.title.slice(0, 70)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={BTN}
              disabled={!pick}
              onClick={() => {
                const p = pulls.find((x) => String(x.number) === pick)
                if (p) add({ repoId, prNumber: p.number, headRef: p.headRef, baseRef: p.baseRef, title: p.title, url: p.url })
              }}
            >
              + Liên kết
            </button>
          </>
        ) : (
          <>
            <input value={head} onChange={(e) => setHead(e.target.value)} className={INPUT + ' w-40'} placeholder="nhánh nguồn" />
            <input value={base} onChange={(e) => setBase(e.target.value)} className={INPUT + ' w-32'} placeholder="nhánh đích" />
            <button
              type="button"
              className={BTN}
              disabled={!head.trim() || !base.trim()}
              onClick={() => add({ repoId, prNumber: null, headRef: head.trim(), baseRef: base.trim(), title: `${head.trim()} → ${base.trim()}`, url: '' })}
            >
              + Liên kết
            </button>
          </>
        )}
        {msg && <span className="text-[12px] text-crit">{msg}</span>}
      </div>
    </div>
  )
}

/* ── document templates ─────────────────────────────────────────────────── */

const blankTemplate = (): DocTemplate => ({ id: '', name: '', note: '', files: [], repoIds: [] })

/**
 * What a TDD iOS / TDD SDK is supposed to look like. A doc review held to one
 * checks the document against its files and checklist.
 */
function TemplatesManager({ templates, repos }: { templates: DocTemplate[]; repos: RepoPreset[] }) {
  const router = useRouter()
  const [list, setList] = useState<DocTemplate[]>(templates.length ? templates : [blankTemplate()])
  const [msg, setMsg] = useState('')
  const [uploading, setUploading] = useState<number | null>(null)
  const [busy, start] = useTransition()
  const patch = (i: number, p: Partial<DocTemplate>) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)))

  const upload = async (i: number, files: File[]) => {
    if (!files.length) return
    setUploading(i)
    setMsg('')
    try {
      const form = new FormData()
      form.set('kind', 'template')
      for (const f of files) {
        form.append('files', f)
        form.append('roles', 'other')
      }
      const res = await fetch('/api/code-review/upload', { method: 'POST', body: form })
      const body = (await res.json()) as { ok: boolean; message: string; docs?: DocFile[] }
      if (body.ok && body.docs) setList((l) => l.map((x, j) => (j === i ? { ...x, files: [...x.files, ...body.docs!] } : x)))
      else setMsg(body.message)
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setUploading(null)
    }
  }

  return (
    <div className={CARD}>
      <div className={CTITLE + ' mb-1'}>📐 Mẫu tài liệu</div>
      <p className="mb-3 text-[12px] text-ink-2">
        Mẫu TDD iOS / TDD SDK… mà tài liệu phải theo. Khi review tài liệu và chọn mẫu, Claude đọc mẫu trước rồi kiểm tra tài liệu có đủ mục, đúng cấu trúc, mục nào để trống hay chung chung. Nhận PDF, Markdown (.md) hoặc .txt.
      </p>
      <div className="flex flex-col gap-3">
        {list.map((t, i) => (
          <div key={i} className="rounded-md border border-line p-3">
            <input value={t.name} onChange={(e) => patch(i, { name: e.target.value })} className={INPUT} placeholder="Tên mẫu — vd: TDD iOS" />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
              <span>Mặc định cho repo:</span>
              {repos.map((r) => (
                <label key={r.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={t.repoIds.includes(r.id)}
                    onChange={(e) =>
                      patch(i, { repoIds: e.target.checked ? [...t.repoIds, r.id] : t.repoIds.filter((x) => x !== r.id) })
                    }
                  />
                  {r.name}
                </label>
              ))}
            </div>
            <div className="mt-2">
              {t.files.length > 0 && (
                <ul className="mb-1.5 flex flex-col gap-1">
                  {t.files.map((f, k) => (
                    <li key={k} className="flex items-center gap-2 text-[12.5px]">
                      📄 <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        className="text-ink-3 hover:text-crit"
                        onClick={() => patch(i, { files: t.files.filter((_, x) => x !== k) })}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                type="file"
                accept="application/pdf,.pdf,.md,.markdown,.txt,text/markdown,text/plain"
                multiple
                disabled={uploading !== null}
                onChange={(e) => {
                  void upload(i, [...(e.target.files ?? [])])
                  e.target.value = ''
                }}
                className="text-[12.5px] file:mr-2 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-2.5 file:py-1 file:text-[12.5px]"
              />
              {uploading === i && <span className="ml-2 text-[12px] text-ink-3">Đang tải lên…</span>}
            </div>
            <textarea
              value={t.note}
              onChange={(e) => patch(i, { note: e.target.value })}
              rows={4}
              className={INPUT + ' mt-2'}
              placeholder={'Checklist bắt buộc (không bắt buộc nếu file mẫu đã đủ) — vd:\n- Phải có sequence diagram cho luồng chính\n- Bảng API: endpoint, request, response, mã lỗi\n- Mục Error handling & Test plan không được để trống'}
            />
            <button type="button" className="mt-1.5 text-[12px] text-ink-3 hover:text-crit" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
              Xoá mẫu này
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className={BTN} onClick={() => setList((l) => [...l, blankTemplate()])}>
          + Thêm mẫu
        </button>
        <button
          type="button"
          className={BTN_PRI}
          disabled={busy || uploading !== null}
          onClick={() =>
            start(async () => {
              const r = await saveTemplatesAction(list)
              setMsg(r.message)
              if (r.ok) router.refresh()
            })
          }
        >
          Lưu mẫu
        </button>
        {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
      </div>
    </div>
  )
}
