'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'

import {
  BUILD_STATUS,
  type FixCode,
  type ProductConfig,
  REPORTED_STATUS,
  type ReportExclude,
  type ReportProduct,
  fixProgress,
  linkedTasks,
  renderReleaseReport,
  sameCode,
  suggestedLinks,
} from '@/lib/modules/releases/model'

import {
  deleteReleaseTaskAction,
  patchReleaseTaskAction,
  saveProductsAction,
  saveReleaseTaskAction,
  saveReportExcludesAction,
  saveTeamsAction,
} from './actions'

interface Task {
  id: number
  taskId: string
  description: string
  branchName: string
  subTasks: string[]
  product: string
  team: string
  environment: string
  buildStatus: string
  noBranch: boolean
  refId: number | null
  fixes: FixCode[]
  publishedBuild: string
}

type Draft = Omit<Task, 'id'> & { id?: number }
type Note = { ok: boolean; message: string } | null

const CARD = 'rounded-[9px] border border-line bg-surface p-[17px]'
const CTITLE = 'font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3'
const BTN = 'rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-2'
const BTN_PRI = 'rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:bg-accent-2 disabled:opacity-50'

/** Included products with their tasks, for the report. Products sharing an
 *  environment are merged under it inside renderReleaseReport. */
function buildReportProducts(products: ProductConfig[], tasks: Task[]): ReportProduct[] {
  return products
    .filter((p) => p.inReport)
    .map((p) => ({
      name: p.name,
      environments: p.environments,
      tasks: tasks
        .filter((t) => t.product === p.name)
        .map((t) => ({
          taskId: t.taskId,
          description: t.description,
          team: t.team,
          environment: t.environment,
          buildStatus: t.buildStatus,
        })),
    }))
}

/** Cluster a column's tasks by team: configured teams first (in their order),
 *  then any other named team, then the "no team" bucket last. */
function groupByTeam(tasks: Task[], teams: string[]): Array<{ team: string; items: Task[] }> {
  const groups = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = t.team || ''
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(t)
  }
  const ordered: Array<{ team: string; items: Task[] }> = []
  for (const team of teams) {
    const items = groups.get(team)
    if (items) {
      ordered.push({ team, items })
      groups.delete(team)
    }
  }
  for (const team of [...groups.keys()].filter(Boolean).sort()) {
    ordered.push({ team, items: groups.get(team)! })
    groups.delete(team)
  }
  const none = groups.get('')
  if (none) ordered.push({ team: '', items: none })
  return ordered
}

const teamText = (team: string) =>
  team === 'CTalk'
    ? 'text-accent-ink'
    : team === 'Hir'
      ? 'text-blue'
      : team === 'CXP'
        ? 'text-epic-ink'
        : 'text-ink'

const teamChip = (team: string) =>
  team === 'CTalk'
    ? 'bg-accent-soft text-accent-ink'
    : team === 'Hir'
      ? 'bg-blue-soft text-blue'
      : team === 'CXP'
        ? 'bg-epic-soft text-epic-ink'
        : 'bg-surface-2 text-ink-3'

export function ReleaseBoard({
  initial,
  products,
  teams,
  reportExcludes,
}: {
  initial: Task[]
  products: ProductConfig[]
  teams: string[]
  reportExcludes: ReportExclude[]
}) {
  const [tab, setTab] = useState<'board' | 'config'>(products.length ? 'board' : 'config')

  return (
    <>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className={CTITLE}>Module · task nhiều team theo môi trường</div>
          <h1 className="text-xl font-semibold tracking-tight">Releases</h1>
        </div>
        <div className="flex overflow-hidden rounded-md border border-line-strong text-[12.5px]">
          <TabBtn on={tab === 'board'} onClick={() => setTab('board')}>
            Board
          </TabBtn>
          <TabBtn on={tab === 'config'} onClick={() => setTab('config')}>
            Cấu hình{products.length === 0 && <span className="ml-1 text-warn">•</span>}
          </TabBtn>
        </div>
      </header>

      {tab === 'board' ? (
        products.length ? (
          <Board initial={initial} products={products} teams={teams} reportExcludes={reportExcludes} />
        ) : (
          <div className={CARD + ' text-[12.5px] text-ink-2'}>
            Chưa có product nào.{' '}
            <button
              type="button"
              onClick={() => setTab('config')}
              className="text-accent-ink underline underline-offset-2"
            >
              Mở tab Cấu hình
            </button>{' '}
            để thêm product và team.
          </div>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <ProductsManager products={products} />
          <TeamsManager teams={teams} />
          <ExcludesManager products={products} teams={teams} excludes={reportExcludes} />
        </div>
      )}
    </>
  )
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'border-l border-line px-3.5 py-[5px] first:border-l-0 ' +
        (on ? 'bg-accent-soft font-semibold text-accent-ink' : 'bg-surface text-ink-2 hover:bg-surface-2')
      }
    >
      {children}
    </button>
  )
}

// ── board ────────────────────────────────────────────────────────────────────

function Board({
  initial,
  products,
  teams,
  reportExcludes,
}: {
  initial: Task[]
  products: ProductConfig[]
  teams: string[]
  reportExcludes: ReportExclude[]
}) {
  const [tasks, setTasks] = useState<Task[]>(initial)
  const [productName, setProductName] = useState(products[0]?.name ?? '')
  const [team, setTeam] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Draft | null>(null)
  const [reportOpen, setReportOpen] = useState(false)

  const product = products.find((p) => p.name === productName) ?? products[0]
  const envs = product?.environments ?? []

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tasks.filter(
      (t) =>
        t.product === product?.name &&
        (!team || t.team === team) &&
        (!q ||
          t.taskId.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.branchName.toLowerCase().includes(q)),
    )
  }, [tasks, product, team, search])

  // One column per environment, plus a catch-all for tasks whose environment
  // isn't in the product's list any more (e.g. after an env was renamed) — so
  // they stay visible and fixable instead of silently vanishing.
  const columns: Array<{ key: string; label: string; tasks: Task[] }> = envs.map((e) => ({
    key: e,
    label: e,
    tasks: visible.filter((t) => t.environment === e),
  }))
  const orphans = visible.filter((t) => !envs.includes(t.environment))
  if (orphans.length) columns.push({ key: '__orphan__', label: '⚠ môi trường lạ', tasks: orphans })

  function openNew() {
    setEditing({
      taskId: '',
      description: '',
      branchName: '',
      subTasks: [],
      product: product?.name ?? '',
      team: '',
      environment: envs[0] ?? '',
      buildStatus: BUILD_STATUS[0],
      noBranch: false,
      refId: null,
      fixes: [],
      publishedBuild: '',
    })
  }

  const refLabelOf = (id: number) => {
    const rt = tasks.find((x) => x.id === id)
    return rt ? `${rt.product} · ${rt.taskId || rt.description || 'task'}` : ''
  }

  function move(id: number, environment: string) {
    setTasks((list) => list.map((t) => (t.id === id ? { ...t, environment } : t)))
    void patchReleaseTaskAction(id, { environment })
  }

  function toggleBuild(id: number, buildStatus: string) {
    setTasks((list) => list.map((t) => (t.id === id ? { ...t, buildStatus } : t)))
    void patchReleaseTaskAction(id, { buildStatus })
  }

  function remove(id: number) {
    setTasks((list) => list.filter((t) => t.id !== id))
    void deleteReleaseTaskAction(id)
  }

  function setFixes(id: number, fixes: FixCode[]) {
    setTasks((list) => list.map((t) => (t.id === id ? { ...t, fixes } : t)))
    void patchReleaseTaskAction(id, { fixes })
  }

  function link(id: number, refId: number | null) {
    setTasks((list) => list.map((t) => (t.id === id ? { ...t, refId } : t)))
    void patchReleaseTaskAction(id, { refId })
  }

  /** Jumps to the product tab of a linked card. */
  function show(t: Task) {
    setProductName(t.product)
    setSearch(t.taskId)
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-line-strong text-[12.5px]">
          {products.map((p) => {
            const on = p.name === product?.name
            const count = tasks.filter((t) => t.product === p.name).length
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProductName(p.name)}
                className={
                  'inline-flex items-center gap-1.5 border-l border-line px-3 py-[5px] first:border-l-0 ' +
                  (on
                    ? 'bg-accent-soft font-semibold text-accent-ink'
                    : 'bg-surface text-ink-2 hover:bg-surface-2')
                }
              >
                {p.name}
                <span
                  className={
                    'rounded-full px-1.5 font-mono text-[10px] font-normal ' +
                    (on ? 'bg-accent text-white' : 'bg-surface-2 text-ink-3')
                  }
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
        <select
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-[5px] text-[12.5px]"
        >
          <option value="">Team: tất cả</option>
          {teams.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm task / branch…"
          className="min-w-[160px] flex-1 rounded-md border border-line bg-surface px-2.5 py-[5px] text-[12.5px]"
        />
        <button type="button" onClick={() => setReportOpen(true)} className={BTN}>
          Report
        </button>
        <button type="button" onClick={openNew} className={BTN_PRI}>
          + Task
        </button>
      </div>

      <div
        className="grid gap-3 overflow-x-auto pb-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(210px, 1fr))` }}
      >
        {columns.map((column) => {
          const col = column.tasks
          return (
            <div key={column.key} className="rounded-[10px] border border-line bg-surface-2 p-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-semibold">{column.label}</span>
                <span className="rounded-full border border-line bg-surface px-[7px] font-mono text-[10px] text-ink-3">
                  {col.length}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {groupByTeam(col, teams).map(({ team, items }) => (
                  <div key={team || '__none__'}>
                    <div
                      className={
                        'mb-1 inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-wide ' +
                        teamChip(team)
                      }
                    >
                      {team || 'chưa team'} · {items.length}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {items.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          envs={envs}
                          refLabel={t.refId ? refLabelOf(t.refId) : ''}
                          linked={linkedTasks(t, tasks)}
                          suggested={suggestedLinks(t, tasks)}
                          onLink={(other) => (other.refId === t.id ? link(other.id, null) : link(t.id, null))}
                          onSuggestLink={(other) => link(t.id, other.id)}
                          onShow={show}
                          onFixes={(f) => setFixes(t.id, f)}
                          onMove={(e) => move(t.id, e)}
                          onToggleBuild={(s) => toggleBuild(t.id, s)}
                          onEdit={() => setEditing(t)}
                          onDelete={() => remove(t.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {col.length === 0 && <p className="px-1 py-2 text-[11.5px] text-ink-3">—</p>}
              </div>
            </div>
          )
        })}
      </div>

      {editing && (
        <TaskModal
          draft={editing}
          products={products}
          teams={teams}
          allTasks={tasks}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTasks((list) => [t, ...list.filter((x) => x.id !== t.id)])
            setEditing(null)
          }}
          onDelete={(id) => {
            remove(id)
            setEditing(null)
          }}
        />
      )}

      {reportOpen && (
        <ReportModal
          text={renderReleaseReport(buildReportProducts(products, tasks), reportExcludes)}
          onClose={() => setReportOpen(false)}
        />
      )}
    </>
  )
}

function TaskCard({
  task,
  envs,
  refLabel,
  linked,
  suggested,
  onLink,
  onSuggestLink,
  onShow,
  onFixes,
  onMove,
  onToggleBuild,
  onEdit,
  onDelete,
}: {
  task: Task
  envs: string[]
  refLabel: string
  /** Cards in another product this one is linked to (either direction). */
  linked: Task[]
  /** Unlinked cards elsewhere with the same code — probably the same task. */
  suggested: Task[]
  /** Removes the link to `other` (whichever card holds it). */
  onLink: (other: Task) => void
  onSuggestLink: (other: Task) => void
  onShow: (other: Task) => void
  onFixes: (fixes: FixCode[]) => void
  onMove: (env: string) => void
  onToggleBuild: (buildStatus: string) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const statusIdx = Math.max(0, (BUILD_STATUS as readonly string[]).indexOf(task.buildStatus))
  const nextStatus = BUILD_STATUS[(statusIdx + 1) % BUILD_STATUS.length]
  const statusTone = [
    'bg-surface-2 text-ink-2',
    'bg-warn-soft text-warn',
    'bg-blue-soft text-blue',
    'bg-good-soft text-good',
  ][statusIdx]

  async function copyBranch() {
    try {
      await navigator.clipboard.writeText(task.branchName)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="group flex flex-col gap-1 rounded-md border border-line bg-surface px-2 py-1.5">
      <div className="flex items-start gap-1">
        <span className={'min-w-0 flex-1 text-[12.5px] font-semibold leading-tight ' + teamText(task.team)}>
          {task.taskId || '(chưa có tiêu đề)'}
        </span>
        <div className="flex shrink-0 items-center gap-1.5 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            title="Sửa"
            className="grid size-6 place-items-center rounded text-[14px] hover:bg-surface-2 hover:text-accent-ink"
          >
            ✎
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Xoá"
            className="grid size-6 place-items-center rounded text-[14px] hover:bg-crit-soft hover:text-crit"
          >
            ✕
          </button>
        </div>
      </div>

      {task.noBranch ? (
        <div
          title={refLabel ? 'Không có nhánh — ref: ' + refLabel : 'Không có nhánh code'}
          className="flex items-start gap-1 font-mono text-[10.5px] text-ot"
        >
          <span className="shrink-0">⊘</span>
          <span className="break-all">{refLabel || 'không có nhánh code'}</span>
        </div>
      ) : (
        task.branchName && (
          <button
            type="button"
            onClick={copyBranch}
            title={'Copy nhánh: ' + task.branchName}
            className="flex items-start gap-1 text-left font-mono text-[10.5px] text-ink-3 hover:text-accent-ink"
          >
            <span className="shrink-0">{copied ? '✓' : '⑂'}</span>
            <span className="break-all">{task.branchName}</span>
          </button>
        )
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onToggleBuild(nextStatus)}
          title="Bấm để đổi trạng thái build"
          className={'shrink-0 rounded px-1.5 py-px font-mono text-[10px] leading-tight hover:brightness-95 ' + statusTone}
        >
          {task.buildStatus || BUILD_STATUS[0]}
        </button>
        {task.subTasks.length > 0 && (
          <span className="font-mono text-[10px] text-ink-3" title={task.subTasks.length + ' subtask'}>
            ≡{task.subTasks.length}
          </span>
        )}
        {task.publishedBuild && task.buildStatus === REPORTED_STATUS && (
          <span className="truncate font-mono text-[9.5px] text-ink-3" title={'Public ở ' + task.publishedBuild}>
            @{buildShort(task.publishedBuild)}
          </span>
        )}
        <select
          value={task.environment}
          onChange={(e) => onMove(e.target.value)}
          title="Chuyển môi trường"
          className="ml-auto max-w-[104px] rounded border border-line bg-ground px-1 py-0 text-[10.5px] text-ink-2"
        >
          {envs.map((env) => (
            <option key={env} value={env}>
              {env}
            </option>
          ))}
        </select>
      </div>

      <FixList fixes={task.fixes} onChange={onFixes} />

      {linked.map((o) => (
        <div key={o.id} className="flex items-center gap-1 rounded bg-epic-soft/60 px-1.5 py-0.5 text-[10.5px]">
          <span className="shrink-0">🔗</span>
          <button type="button" onClick={() => onShow(o)} className="min-w-0 truncate text-left font-medium text-epic-ink hover:underline" title="Mở thẻ bên kia">
            {o.product} · {o.taskId || o.description}
          </button>
          <span className="shrink-0 text-ink-3">· {o.environment}</span>
          <span className={'shrink-0 rounded px-1 font-mono text-[9.5px] ' + statusChip(o.buildStatus)}>{o.buildStatus}</span>
          {o.fixes.length > 0 && <span className="shrink-0 text-ink-3">· {fixProgress(o.fixes)}</span>}
          <button
            type="button"
            onClick={() => onLink(o)}
            title="Bỏ liên kết"
            className="ml-auto shrink-0 text-ink-3 opacity-0 hover:text-crit group-hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
      {suggested.map((o) => (
        <div key={o.id} className="flex items-center gap-1 rounded border border-dashed border-line px-1.5 py-0.5 text-[10.5px] text-ink-3">
          <span className="shrink-0">🔗?</span>
          <span className="min-w-0 truncate" title="Cùng mã task ở product khác — có thể là cùng một task">
            Có thể liên quan: {o.product} · {o.taskId}
          </span>
          <button type="button" onClick={() => onSuggestLink(o)} className="ml-auto shrink-0 font-medium text-accent-ink hover:underline">
            Nối
          </button>
        </div>
      ))}
    </div>
  )
}

const statusChip = (s: string) =>
  ['bg-surface-2 text-ink-2', 'bg-warn-soft text-warn', 'bg-blue-soft text-blue', 'bg-good-soft text-good'][
    Math.max(0, (BUILD_STATUS as readonly string[]).indexOf(s))
  ]

/** "VipTalk Lite 2.3.0 (515)" → "515", for the tight space on a card. */
const buildShort = (b: string) => /\(([^)]+)\)\s*$/.exec(b)?.[1] ?? b

/**
 * The bug-fix codes raised after a feature built. Click a code's dot to move
 * it to the next stage; type a code and Enter to add one. Codes that went
 * public show the build they went out in.
 */
function FixList({ fixes, onChange }: { fixes: FixCode[]; onChange: (f: FixCode[]) => void }) {
  const [adding, setAdding] = useState('')
  const [open, setOpen] = useState(false)
  const pending = fixes.filter((f) => f.status !== REPORTED_STATUS)
  const shown = open ? fixes : pending.length ? pending : []
  const next = (s: string) => BUILD_STATUS[(Math.max(0, (BUILD_STATUS as readonly string[]).indexOf(s)) + 1) % BUILD_STATUS.length]
  const icon = (s: string) => (s === REPORTED_STATUS ? '✓' : s === BUILD_STATUS[2] ? '●' : s === BUILD_STATUS[1] ? '◐' : '○')

  return (
    <div className="flex flex-col gap-0.5">
      {fixes.length > 0 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-left text-[10.5px] text-ink-3 hover:text-ink">
          Fix: {fixProgress(fixes)} {open ? '▴' : '▾'}
        </button>
      )}
      {shown.map((f) => (
        <div key={f.code} className="group/fix flex items-center gap-1 pl-1 font-mono text-[10.5px]">
          <button
            type="button"
            onClick={() => onChange(fixes.map((x) => (x.code === f.code ? { ...x, status: next(x.status) } : x)))}
            title={`${f.status} — bấm để chuyển sang "${next(f.status)}"`}
            className={'shrink-0 rounded px-1 ' + statusChip(f.status)}
          >
            {icon(f.status)}
          </button>
          <span className="truncate">{f.code}</span>
          <span className="shrink-0 text-ink-3">{f.status === REPORTED_STATUS && f.build ? `@${buildShort(f.build)}` : f.status}</span>
          <button
            type="button"
            onClick={() => onChange(fixes.filter((x) => x.code !== f.code))}
            title="Xoá mã fix"
            className="ml-auto shrink-0 text-ink-3 opacity-0 hover:text-crit group-hover/fix:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
      <input
        value={adding}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          const codes = adding.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean)
          const fresh = codes.filter((c) => !fixes.some((x) => x.code.toUpperCase() === c.toUpperCase()))
          if (fresh.length) onChange([...fixes, ...fresh.map((code) => ({ code, status: BUILD_STATUS[0] }))])
          setAdding('')
        }}
        placeholder="+ mã fix (Enter)"
        className={
          'w-full rounded border border-transparent bg-transparent px-1 py-0 font-mono text-[10.5px] text-ink-2 placeholder:text-ink-3 hover:border-line focus:border-line focus:bg-ground ' +
          // A card with no fixes keeps the field out of sight until hovered.
          (fixes.length || adding ? '' : 'opacity-0 focus:opacity-100 group-hover:opacity-100')
        }
      />
    </div>
  )
}

// ── task modal ───────────────────────────────────────────────────────────────

function TaskModal({
  draft,
  products,
  teams,
  allTasks,
  onClose,
  onSaved,
  onDelete,
}: {
  draft: Draft
  products: ProductConfig[]
  teams: string[]
  allTasks: Task[]
  onClose: () => void
  onSaved: (t: Task) => void
  onDelete: (id: number) => void
}) {
  const [d, setD] = useState<Draft>(draft)
  const [note, setNote] = useState<Note>(null)
  const [saving, startSaving] = useTransition()
  const envs = products.find((p) => p.name === d.product)?.environments ?? []

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function patch(fields: Partial<Draft>) {
    setD((prev) => ({ ...prev, ...fields }))
  }

  function pickProduct(name: string) {
    const list = products.find((p) => p.name === name)?.environments ?? []
    patch({ product: name, environment: list.includes(d.environment) ? d.environment : (list[0] ?? '') })
  }

  function save() {
    startSaving(async () => {
      const refId = d.refId && d.refId !== d.id ? d.refId : null
      const res = await saveReleaseTaskAction({
        id: d.id,
        taskId: d.taskId,
        description: d.description,
        branchName: d.branchName,
        subTasks: d.subTasks,
        product: d.product,
        team: d.team,
        environment: d.environment,
        buildStatus: d.buildStatus,
        noBranch: d.noBranch,
        refId,
        fixes: d.fixes,
        publishedBuild: d.publishedBuild,
      })
      setNote(res)
      if (res.ok && res.id) {
        onSaved({
          id: res.id,
          taskId: d.taskId.trim(),
          description: d.description.trim(),
          branchName: d.branchName.trim(),
          subTasks: d.subTasks.map((s) => s.trim()).filter(Boolean),
          product: d.product,
          team: d.team,
          environment: d.environment,
          buildStatus: d.buildStatus,
          noBranch: d.noBranch,
          refId,
          fixes: d.fixes,
          publishedBuild: d.publishedBuild,
        })
      }
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-auto bg-black/45 p-4 sm:p-8">
      <div role="dialog" aria-modal="true" className="w-full max-w-[560px] rounded-xl border border-line-strong bg-surface shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">{d.id ? 'Sửa task' : 'Task mới'}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="ml-auto grid size-7 place-items-center rounded-md text-[18px] leading-none text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </header>

        <div className="flex flex-col gap-3 px-4 py-4">
          <Field label="Tiêu đề" hint="mã task hoặc gì tuỳ bạn">
            <input
              value={d.taskId}
              onChange={(e) => patch({ taskId: e.target.value })}
              placeholder="Mã task hoặc tiêu đề tự do…"
              className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]"
            />
          </Field>
          <Field label="Nội dung">
            <textarea
              value={d.description}
              onChange={(e) => patch({ description: e.target.value })}
              rows={2}
              placeholder="Nội dung / mô tả…"
              className="w-full resize-y rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px] leading-relaxed"
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Field label="Product" className="flex-1">
              <select
                value={d.product}
                onChange={(e) => pickProduct(e.target.value)}
                className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Team" className="w-[130px]">
              <select
                value={d.team}
                onChange={(e) => patch({ team: e.target.value })}
                className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]"
              >
                <option value="">—</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-3">
            <Field label="Môi trường" className="flex-1">
              <select
                value={d.environment}
                onChange={(e) => patch({ environment: e.target.value })}
                className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]"
              >
                {envs.map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Build status" className="flex-1">
              <select
                value={d.buildStatus}
                onChange={(e) => patch({ buildStatus: e.target.value })}
                className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]"
              >
                {BUILD_STATUS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <input
                type="checkbox"
                checked={d.noBranch}
                onChange={(e) => patch({ noBranch: e.target.checked })}
                className="accent-accent"
              />
              Không có nhánh code (vd Lite chỉ build theo version)
            </label>

            <Field label="Liên kết task ở product khác" hint="vd task Lite đi cùng task MatrixRustSDK">
              <select
                value={d.refId ?? ''}
                onChange={(e) => patch({ refId: e.target.value ? Number(e.target.value) : null })}
                className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]"
              >
                <option value="">— không —</option>
                {allTasks
                  .filter((t) => t.id !== d.id && t.product !== d.product)
                  // Same code first: almost always the card being looked for.
                  .sort((a, b) => Number(sameCode(b.taskId, d.taskId)) - Number(sameCode(a.taskId, d.taskId)))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {sameCode(t.taskId, d.taskId) ? '★ ' : ''}
                      {t.product} · {t.taskId || t.description || 'task'} · {t.environment}
                    </option>
                  ))}
              </select>
            </Field>

            {!d.noBranch && (
              <Field label="Branch">
                <input
                  value={d.branchName}
                  onChange={(e) => patch({ branchName: e.target.value })}
                  placeholder="feature/invite-link"
                  className="w-full rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12.5px]"
                />
              </Field>
            )}
          </div>

          <Field label="Mã fix" hint="bug fix phát sinh sau khi feature build — mỗi mã một trạng thái">
            <div className="flex flex-col gap-1">
              {d.fixes.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={f.code}
                    onChange={(e) => patch({ fixes: d.fixes.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) })}
                    className="w-32 rounded-md border border-line bg-ground px-2 py-1 font-mono text-[12.5px]"
                  />
                  <select
                    value={f.status}
                    onChange={(e) => patch({ fixes: d.fixes.map((x, j) => (j === i ? { ...x, status: e.target.value } : x)) })}
                    className="rounded-md border border-line bg-ground px-2 py-1 text-[12.5px]"
                  >
                    {BUILD_STATUS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <span className="min-w-0 truncate text-[11.5px] text-ink-3">{f.build ? `public ở ${f.build}` : ''}</span>
                  <button
                    type="button"
                    onClick={() => patch({ fixes: d.fixes.filter((_, j) => j !== i) })}
                    className="ml-auto text-ink-3 hover:text-crit"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => patch({ fixes: [...d.fixes, { code: '', status: BUILD_STATUS[0] }] })}
                className="self-start text-[12px] text-accent-ink hover:underline"
              >
                + Thêm mã fix
              </button>
            </div>
          </Field>

          <Field label="Subtask" hint="mỗi dòng một cái">
            <textarea
              value={d.subTasks.join('\n')}
              onChange={(e) => patch({ subTasks: e.target.value.split('\n') })}
              rows={3}
              className="w-full resize-y rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12.5px] leading-relaxed"
            />
          </Field>
        </div>

        <footer className="flex items-center gap-2 border-t border-line bg-surface-2 px-4 py-2.5">
          {note && <span className={'text-[12px] ' + (note.ok ? 'text-good' : 'text-crit')}>{note.message}</span>}
          {d.id && (
            <button type="button" onClick={() => onDelete(d.id!)} className="text-[12px] text-ink-3 hover:text-crit">
              Xoá
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className={BTN}>
              Huỷ
            </button>
            <button type="button" onClick={save} disabled={saving} className={BTN_PRI}>
              {saving ? 'Đang lưu…' : 'Lưu'}
            </button>
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function ReportModal({ text, onClose }: { text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* ignore */
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-auto bg-black/45 p-4 sm:p-8">
      <div className="w-full max-w-[560px] rounded-xl border border-line-strong bg-surface shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold">Report</h3>
          <button
            type="button"
            onClick={copy}
            className="ml-auto rounded-md bg-accent px-3 py-[5px] text-[12.5px] font-medium text-white hover:bg-accent-2"
          >
            {copied ? 'Đã copy ✓' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="grid size-7 place-items-center rounded-md text-[18px] leading-none text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </header>
        <pre className="overflow-x-auto whitespace-pre-wrap px-4 py-4 font-mono text-[12.5px] leading-[1.7]">
          {text}
        </pre>
      </div>
    </div>,
    document.body,
  )
}

// ── config: products & teams ─────────────────────────────────────────────────

function ProductsManager({ products }: { products: ProductConfig[] }) {
  const [list, setList] = useState<ProductConfig[]>(products)
  const [note, setNote] = useState<Note>(null)
  const [saving, startSaving] = useTransition()

  function patchProduct(i: number, fields: Partial<ProductConfig>) {
    setList((l) => l.map((p, j) => (j === i ? { ...p, ...fields } : p)))
  }
  function addProduct() {
    setList((l) => [...l, { id: '', name: '', environments: ['Dev', 'Released'], inReport: true }])
  }
  function removeProduct(i: number) {
    setList((l) => l.filter((_, j) => j !== i))
  }
  function setEnv(i: number, k: number, value: string) {
    setList((l) => l.map((p, j) => (j === i ? { ...p, environments: p.environments.map((e, m) => (m === k ? value : e)) } : p)))
  }
  function addEnv(i: number) {
    setList((l) => l.map((p, j) => (j === i ? { ...p, environments: [...p.environments, ''] } : p)))
  }
  function removeEnv(i: number, k: number) {
    setList((l) =>
      l.map((p, j) =>
        j === i ? { ...p, environments: p.environments.filter((_, m) => m !== k) } : p,
      ),
    )
  }

  function save() {
    startSaving(async () => setNote(await saveProductsAction(list)))
  }

  return (
    <section className={CARD}>
      <div className={'mb-1 ' + CTITLE}>Products (repo / project)</div>
      <p className="mb-3 text-[11.5px] text-ink-3">
        Mỗi product có bộ môi trường riêng — thứ tự từ trên xuống là thứ tự cột trái → phải trên board. Product
        <b> cùng môi trường</b> sẽ được gộp chung dưới một section trong report.
      </p>

      <div className="flex flex-col gap-3">
        {list.map((p, i) => (
          <div key={i} className="rounded-[8px] border border-line bg-ground p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                value={p.name}
                onChange={(e) => patchProduct(i, { name: e.target.value })}
                placeholder="Tên product, vd Lite"
                className="flex-1 rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] font-medium"
              />
              <button type="button" onClick={() => removeProduct(i)} className="text-[12px] text-ink-3 hover:text-crit">
                Xoá
              </button>
            </div>
            <div className="mb-2">
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <input
                  type="checkbox"
                  checked={p.inReport}
                  onChange={(e) => patchProduct(i, { inReport: e.target.checked })}
                  className="accent-accent"
                />
                Ghi vào report
              </label>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-3">Môi trường</span>
              {p.environments.map((env, k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-4 text-center font-mono text-[10px] text-ink-3">{k + 1}</span>
                  <input
                    value={env}
                    onChange={(e) => setEnv(i, k, e.target.value)}
                    placeholder="Dev / Staging / Released…"
                    className="flex-1 rounded-md border border-line bg-surface px-2.5 py-1 text-[12.5px]"
                  />
                  <button
                    type="button"
                    onClick={() => removeEnv(i, k)}
                    aria-label="Xoá môi trường"
                    className="grid size-6 place-items-center rounded-md text-[15px] leading-none text-ink-3 hover:bg-surface-2 hover:text-crit"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => addEnv(i)} className={'self-start ' + BTN}>
                + Môi trường
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={addProduct} className={BTN}>
          + Product
        </button>
        <button type="button" onClick={save} disabled={saving} className={BTN_PRI}>
          {saving ? 'Đang lưu…' : 'Lưu products'}
        </button>
        {note && <span className={'text-[12px] ' + (note.ok ? 'text-good' : 'text-crit')}>{note.message}</span>}
      </div>
    </section>
  )
}

function TeamsManager({ teams }: { teams: string[] }) {
  const [list, setList] = useState<string[]>(teams.length ? teams : [''])
  const [note, setNote] = useState<Note>(null)
  const [saving, startSaving] = useTransition()

  function save() {
    startSaving(async () => setNote(await saveTeamsAction(list)))
  }

  return (
    <section className={CARD}>
      <div className={'mb-3 ' + CTITLE}>Teams</div>
      <div className="flex flex-wrap gap-2">
        {list.map((t, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              value={t}
              onChange={(e) => setList((l) => l.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder="Tên team"
              className="w-[150px] rounded-md border border-line bg-ground px-2.5 py-1 text-[12.5px]"
            />
            <button
              type="button"
              onClick={() => setList((l) => (l.length > 1 ? l.filter((_, j) => j !== i) : ['']))}
              aria-label="Xoá team"
              className="grid size-6 place-items-center rounded-md text-[15px] leading-none text-ink-3 hover:bg-surface-2 hover:text-crit"
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setList((l) => [...l, ''])} className={BTN}>
          + Team
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={save} disabled={saving} className={BTN_PRI}>
          {saving ? 'Đang lưu…' : 'Lưu teams'}
        </button>
        {note && <span className={'text-[12px] ' + (note.ok ? 'text-good' : 'text-crit')}>{note.message}</span>}
      </div>
    </section>
  )
}

function ExcludesManager({
  products,
  teams,
  excludes,
}: {
  products: ProductConfig[]
  teams: string[]
  excludes: ReportExclude[]
}) {
  const [list, setList] = useState<ReportExclude[]>(excludes)
  const [note, setNote] = useState<Note>(null)
  const [saving, startSaving] = useTransition()

  const allEnvs = [...new Set(products.flatMap((p) => p.environments))]

  function patch(i: number, fields: Partial<ReportExclude>) {
    setList((l) => l.map((e, j) => (j === i ? { ...e, ...fields } : e)))
  }

  return (
    <section className={CARD}>
      <div className={'mb-1 ' + CTITLE}>Report — ẩn team theo môi trường</div>
      <p className="mb-3 text-[11.5px] text-ink-3">
        Vd ẩn <b>CXP</b> ở <b>Develop</b>: team đó sẽ không hiện dưới môi trường đó trong report (in-or-above vẫn
        áp cho các môi trường khác).
      </p>

      <div className="flex flex-col gap-2">
        {list.map((e, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={e.environment}
              onChange={(ev) => patch(i, { environment: ev.target.value })}
              className="rounded-md border border-line bg-ground px-2.5 py-1 text-[12.5px]"
            >
              <option value="">— môi trường —</option>
              {allEnvs.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-ink-3">ẩn</span>
            <select
              value={e.team}
              onChange={(ev) => patch(i, { team: ev.target.value })}
              className="rounded-md border border-line bg-ground px-2.5 py-1 text-[12.5px]"
            >
              <option value="">— team —</option>
              {teams.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setList((l) => l.filter((_, j) => j !== i))}
              aria-label="Xoá quy tắc"
              className="grid size-6 place-items-center rounded-md text-[15px] leading-none text-ink-3 hover:bg-surface-2 hover:text-crit"
            >
              ×
            </button>
          </div>
        ))}
        {list.length === 0 && <p className="text-[11.5px] text-ink-3">Chưa có quy tắc nào.</p>}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setList((l) => [...l, { environment: '', team: '' }])}
          className={BTN}
        >
          + Quy tắc
        </button>
        <button
          type="button"
          onClick={() => startSaving(async () => setNote(await saveReportExcludesAction(list)))}
          disabled={saving}
          className={BTN_PRI}
        >
          {saving ? 'Đang lưu…' : 'Lưu quy tắc'}
        </button>
        {note && <span className={'text-[12px] ' + (note.ok ? 'text-good' : 'text-crit')}>{note.message}</span>}
      </div>
    </section>
  )
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={'flex flex-col gap-[5px] ' + (className ?? '')}>
      <span className="flex items-center gap-2 text-xs font-medium text-ink-2">
        {label}
        {hint && <span className="font-normal text-ink-3">· {hint}</span>}
      </span>
      {children}
    </label>
  )
}
