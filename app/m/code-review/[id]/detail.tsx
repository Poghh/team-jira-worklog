'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'

import type { ClaudeCheck } from '@/lib/modules/code-review/claude'
import type { ConfluenceAccess } from '@/lib/modules/code-review/confluence'
import type { GithubAccess } from '@/lib/modules/code-review/github'
import {
  DOC_CATEGORIES,
  DOC_CATEGORY_LABEL,
  DOC_ROLE_LABEL,
  type DocCategory,
  type FindingView,
  type ItemView,
  LIVE_STATES,
  type Addressee,
  type DocTemplate,
  HONORIFICS,
  HONORIFIC_LABEL,
  type Honorific,
  type PrLink,
  type RepoPreset,
  addressOf,
  cleanHandle,
  linkLabel,
  validHandle,
  type RoundView,
  VERDICT_LABEL,
  allClipboard,
  blobUrl,
  confluencePages,
  detectJiraKeys,
  isFetched,
  jiraTickets,
  OWN_CATEGORY,
  type DocFile,
  findingClipboard,
  shortSha,
  where,
} from '@/lib/modules/code-review/model'

import {
  type ItemDetail,
  cancelRoundAction,
  itemDetailAction,
  patchFindingAction,
  reReviewAction,
  setAddresseeAction,
  setDocReposAction,
  setJiraAction,
  setLinksAction,
  setSourcesAction,
  setTemplateAction,
  updateSummaryAction,
} from '../actions'
import { ContextPicker, type DocRepo, LinkPicker, type PrContext, RepoRows, type SourceRow, SourceRows, contextReady, sourcePayload, useAttachments, useDocUpload } from '../review'
import { CfAccessNote, CfProvider, FindingConfluence, SendAllConfluence } from './confluence'
import { type ChatHandle, ChatPanel, ChatShortcut } from './chat'
import { CodeTab } from './diff'
import { AccessNote, DiscussionPanel, FindingGithub, GhProvider, ReplyWithBody, SubmitReview, useGh } from './github'
import {
  BTN,
  BTN_PRI,
  CARD,
  CTITLE,
  ClaudeBanner,
  CopyButton,
  INPUT,
  TabBtn,
  RoundPill,
  SeverityPill,
  StatusPill,
  Ago,
  Elapsed,
} from '../ui'

type Tab = 'review' | 'code' | 'discussion'

export function ReviewDetail({
  item,
  repoName,
  githubRepo,
  claude: initialClaude,
  initialTab,
  access,
  repos,
  linkedItems,
  addressee,
  templates,
  cfAccess,
}: {
  item: ItemView
  repoName: string
  githubRepo: string
  claude: ClaudeCheck
  initialTab: Tab
  access: GithubAccess
  /** Doc reviews on Confluence: whether the account may comment on the pages. */
  cfAccess: ConfluenceAccess
  repos: RepoPreset[]
  /** `${repoId}#${prNumber}` → id of the item tracking that linked PR here. */
  linkedItems: Record<string, number>
  /** Resolved: set on the item, remembered for the author, or the default. */
  addressee: Addressee | null
  templates: DocTemplate[]
}) {
  const [claude, setClaude] = useState(initialClaude)
  const onGithub = item.kind === 'pr' && Boolean(item.prNumber) && Boolean(githubRepo)
  const tabs: Tab[] = item.kind === 'pr' ? ['review', 'code', ...(onGithub && access.read ? (['discussion'] as const) : [])] : ['review']
  const [tab, setTab] = useState<Tab>(tabs.includes(initialTab) ? initialTab : 'review')
  const [detail, setDetail] = useState<ItemDetail>({ rounds: [], findings: {}, log: [], logRoundId: null })
  const [selected, setSelected] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  const rounds = detail.rounds
  const current = rounds.find((r) => r.id === selected) ?? rounds.at(-1) ?? null
  const latest = rounds.at(-1) ?? null
  const live = latest ? LIVE_STATES.includes(latest.state) : false

  const refresh = useCallback(
    async (roundId?: number) => {
      const d = await itemDetailAction(item.id, roundId)
      setDetail(d)
      setLoaded(true)
    },
    [item.id],
  )

  useEffect(() => {
    void refresh(selected ?? undefined)
  }, [refresh, selected])

  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => void refresh(selected ?? undefined), 2500)
    return () => clearTimeout(t)
  }, [live, detail, refresh, selected])

  // A new round appearing (Review tiếp) should take the screen.
  const roundCount = rounds.length
  useEffect(() => setSelected(null), [roundCount])

  return (
    <GhProvider itemId={item.id} onGithub={onGithub} initialAccess={access}>
    <CfProvider itemId={item.id} enabled={item.kind === 'doc' && item.sources.length > 0} initialAccess={cfAccess}>
      <header className="mb-4">
        <Link href="/m/code-review" className={CTITLE + ' hover:text-ink'}>
          ← Code review
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          {item.kind === 'doc' ? '📄 ' : item.prNumber ? <span className="text-ink-3">#{item.prNumber} </span> : null}
          {item.title}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
          {repoName && <span>{repoName}</span>}
          {item.kind === 'pr' ? (
            <span className="font-mono">
              {item.headRef} → {item.baseRef}
            </span>
          ) : (
            item.headRef && (
              <span className="font-mono">
                đối chiếu {item.headRef}
                {item.links.map((l) => (
                  <span key={`${l.repoId}:${l.headRef}`}>
                    {' '}
                    · {repos.find((r) => r.id === l.repoId)?.name ?? '?'} {l.headRef}
                  </span>
                ))}
              </span>
            )
          )}
          {item.author && <span>· {item.author}</span>}
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
              {item.kind === 'doc' ? 'Mở trên Confluence ↗' : 'Mở trên GitHub ↗'}
            </a>
          )}
        </div>
      </header>

      {item.kind === 'pr' && <AddresseeBar item={item} addressee={addressee} />}
      {item.kind === 'doc' && <TemplateBar item={item} templates={templates} />}
      {item.kind === 'doc' && <DocSourcesBar item={item} repos={repos} templates={templates} />}
      {item.kind === 'pr' && <LinksBar item={item} repos={repos} linkedItems={linkedItems} />}
      {item.kind === 'pr' && <PrContextBar item={item} />}

      <ClaudeBanner check={claude} onChange={setClaude} />

      {tabs.length > 1 && (
        <div className="mb-3 flex w-fit overflow-hidden rounded-md border border-line-strong text-[12.5px]">
          <TabBtn on={tab === 'review'} onClick={() => setTab('review')}>
            Kết quả review
          </TabBtn>
          <TabBtn on={tab === 'code'} onClick={() => setTab('code')}>
            Thay đổi code
          </TabBtn>
          {tabs.includes('discussion') && (
            <TabBtn on={tab === 'discussion'} onClick={() => setTab('discussion')}>
              <DiscussionLabel />
            </TabBtn>
          )}
        </div>
      )}

      {tab === 'discussion' ? (
        <DiscussionPanel />
      ) : (
        <>
      {rounds.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {rounds.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelected(r.id)}
              className={
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px] ' +
                (current?.id === r.id ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface hover:bg-surface-2')
              }
            >
              Vòng {r.round}
              <RoundPill s={r.state} />
            </button>
          ))}
        </div>
      )}

      {!loaded ? (
        <div className={CARD + ' text-[12.5px] text-ink-3'}>Đang tải…</div>
      ) : !current ? (
        <div className={CARD + ' text-[12.5px] text-ink-2'}>Chưa có vòng review nào.</div>
      ) : tab === 'code' ? (
        <CodeTab
          key={current.id}
          item={item}
          round={current}
          findings={detail.findings[current.id] ?? []}
          githubRepo={githubRepo}
          canRun={claude.ok}
          addressee={addressee}
          onChanged={() => refresh(current.id)}
          renderFinding={(f, onAsk) => (
            <FindingCard
              f={f}
              kind="pr"
              docs={current.docs}
              link={blobUrl(githubRepo, current.headSha, f)}
              compact
              onPatch={(p) => void patchFindingAction(f.id, { body: p.body, status: p.status }).then(() => refresh(current.id))}
              onPosted={() => refresh(current.id)}
              onAsk={onAsk}
            />
          )}
        />
      ) : (
        <RoundPanel
          key={current.id}
          item={item}
          round={current}
          isLatest={current.id === latest?.id}
          findings={detail.findings[current.id] ?? []}
          log={detail.logRoundId === current.id ? detail.log : []}
          githubRepo={githubRepo}
          canRun={claude.ok}
          addressee={addressee}
          templates={templates}
          onChanged={() => refresh(current.id)}
        />
      )}

      {loaded && !live && tab === 'review' && (
        <NextRound item={item} latest={latest} canRun={claude.ok} templates={templates} onQueued={() => refresh()} />
      )}
        </>
      )}
    </CfProvider>
    </GhProvider>
  )
}

/** Which document template this doc review is held to — changeable, from the next round. */
/**
 * What a doc review reads: the pasted Confluence pages (fetched afresh every
 * round) and the repos it is checked against. Changes apply from the next round.
 */
function DocSourcesBar({ item, repos, templates }: { item: ItemView; repos: RepoPreset[]; templates: DocTemplate[] }) {
  const router = useRouter()
  const initialRepos = (): DocRepo[] =>
    item.repoId ? [{ repoId: item.repoId, ref: item.headRef }, ...item.links.map((l) => ({ repoId: l.repoId, ref: l.headRef }))] : []
  const initialSources = () => savedSources(item)
  const [open, setOpen] = useState(false)
  const [docRepos, setDocRepos] = useState(initialRepos)
  const [sources, setSources] = useState(initialSources)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()

  return (
    <div className="-mt-2 mb-4 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        {item.sources.length > 0 ? (
          <span className="text-ink-2">
            🌐{' '}
            {item.sources.map((s, i) => (
              <span key={s.pageId}>
                {i > 0 && ' · '}
                <a href={s.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                  {s.title}
                </a>
                {s.children && <span className="text-ink-3"> (+ subpage)</span>}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-ink-3">🌐 Chưa có trang Confluence</span>
        )}
        <button type="button" className={BTN} onClick={() => setOpen((v) => !v)}>
          {open ? 'Đóng' : 'Sửa link Confluence / repo đối chiếu'}
        </button>
        {msg && <span className="text-ink-2">{msg}</span>}
      </div>
      {open && (
        <div className={CARD + ' mt-2 flex flex-col gap-3'}>
          <SourceRows value={sources} onChange={setSources} templates={templates} fallbackTemplate={item.templateId} />
          <RepoRows repos={repos} value={docRepos} onChange={setDocRepos} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BTN_PRI}
              disabled={busy || docRepos.some((r) => !r.ref.trim())}
              onClick={() =>
                start(async () => {
                  const a = await setSourcesAction(item.id, sourcePayload(sources))
                  const b = a.ok ? await setDocReposAction(item.id, docRepos) : a
                  setMsg(a.ok && b.ok ? `${a.message} ${b.message}` : b.message)
                  if (a.ok && b.ok) {
                    setOpen(false)
                    router.refresh()
                  }
                })
              }
            >
              {busy ? 'Đang kiểm tra link…' : 'Lưu'}
            </button>
            <span className="text-ink-3">Áp dụng từ vòng review tiếp theo.</span>
          </div>
        </div>
      )}
    </div>
  )
}

const savedSources = (item: ItemView): SourceRow[] =>
  item.sources.map((s) => ({ url: s.url, children: s.children, role: s.role, templateId: s.templateId, pages: s.pages, title: s.title, touched: true }))

/**
 * The Jira tickets and Confluence pages a PR review checks the code against —
 * fetched afresh every round. Changes apply from the next round.
 */
function PrContextBar({ item }: { item: ItemView }) {
  const router = useRouter()
  const initial = (): PrContext => ({ jira: item.jira, sources: savedSources(item) })
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(initial)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const detected = detectJiraKeys({ branch: item.headRef, title: item.title })

  return (
    <div className="-mt-2 mb-4 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-3">🎫 Ticket:</span>
        {item.jira.keys.length === 0 && !(item.jira.auto && detected.length) && <span className="text-ink-3">chưa có</span>}
        {item.jira.keys.map((k) => (
          <span key={k} className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono">
            {k}
          </span>
        ))}
        {item.jira.auto && (
          <span className="text-ink-3" title="Ticket có key trong tên nhánh / tiêu đề / mô tả PR được đọc thêm mỗi vòng">
            {detected.filter((k) => !item.jira.keys.includes(k)).length
              ? `+ tự nhận: ${detected.filter((k) => !item.jira.keys.includes(k)).join(', ')}`
              : '+ tự nhận theo nhánh / mô tả PR'}
          </span>
        )}
        {item.sources.length > 0 && (
          <span className="text-ink-2">
            · 🌐{' '}
            {item.sources.map((s, i) => (
              <span key={s.pageId}>
                {i > 0 && ' · '}
                <a href={s.url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                  {s.title}
                </a>
                {s.children && <span className="text-ink-3"> (+ subpage)</span>}
              </span>
            ))}
          </span>
        )}
        <button
          type="button"
          className="text-ink-3 underline-offset-2 hover:text-ink hover:underline"
          onClick={() => {
            if (!open) setValue(initial())
            setOpen((v) => !v)
          }}
        >
          {open ? 'Đóng' : 'Sửa ticket / Confluence'}
        </button>
        {msg && <span className="text-ink-2">{msg}</span>}
      </div>
      {open && (
        <div className={CARD + ' mt-2 !p-3'}>
          <ContextPicker value={value} onChange={setValue} detected={detected} scope="Có hiệu lực từ vòng review tiếp theo." />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className={BTN_PRI}
              disabled={busy || !contextReady(value)}
              onClick={() =>
                start(async () => {
                  const a = await setJiraAction(item.id, value.jira)
                  const b = a.ok ? await setSourcesAction(item.id, sourcePayload(value.sources.filter((s) => !s.error))) : a
                  setMsg(b.ok ? 'Đã lưu — áp dụng từ vòng tiếp theo.' : b.message)
                  if (a.ok && b.ok) {
                    setOpen(false)
                    router.refresh()
                  }
                })
              }
            >
              {busy ? 'Đang kiểm tra link…' : 'Lưu'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TemplateBar({ item, templates }: { item: ItemView; templates: DocTemplate[] }) {
  const router = useRouter()
  const [value, setValue] = useState(item.templateId)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const current = templates.find((t) => t.id === item.templateId)
  return (
    <div className="-mt-2 mb-4 flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-ink-3" title="Dùng cho file TDD không tự chọn mẫu riêng">📐 Mẫu mặc định cho TDD chưa chọn mẫu:</span>
      <select value={value} onChange={(e) => setValue(e.target.value)} className="rounded-md border border-line bg-ground px-2 py-[3px]">
        <option value="">— Không dùng mẫu —</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {item.templateId && !current && <span className="text-warn">mẫu cũ đã bị xoá khỏi Cấu hình</span>}
      {value !== item.templateId && (
        <button
          type="button"
          className={BTN}
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await setTemplateAction(item.id, value)
              setMsg(r.message)
              if (r.ok) router.refresh()
            })
          }
        >
          Lưu
        </button>
      )}
      {msg && <span className="text-ink-2">{msg}</span>}
    </div>
  )
}

/**
 * How this PR's comments address its author: Em → "@login", Anh / Chị →
 * "anh @login" / "chị @login". Remembered per author for their next PRs.
 */
function AddresseeBar({ item, addressee }: { item: ItemView; addressee: Addressee | null }) {
  const router = useRouter()
  const [honorific, setHonorific] = useState<Honorific>(addressee?.honorific ?? 'em')
  const [handle, setHandle] = useState(addressee?.handle ?? item.author)
  const [remember, setRemember] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const preview = cleanHandle(handle) ? addressOf({ handle: cleanHandle(handle), honorific }) : ''
  const dirty = !addressee || addressee.honorific !== honorific || addressee.handle !== cleanHandle(handle)

  return (
    <div className="-mt-2 mb-2 flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-ink-3">🗣 Xưng hô với tác giả:</span>
      <div className="flex overflow-hidden rounded-md border border-line-strong">
        {HONORIFICS.map((h) => (
          <TabBtn key={h} on={honorific === h} onClick={() => setHonorific(h)}>
            {HONORIFIC_LABEL[h]}
          </TabBtn>
        ))}
      </div>
      <span className="flex items-center rounded-md border border-line bg-ground pl-2 font-mono">
        @
        <input
          value={cleanHandle(handle)}
          onChange={(e) => setHandle(e.target.value)}
          className="w-36 bg-transparent px-1 py-[3px] outline-none"
          placeholder="username GitHub"
        />
      </span>
      {preview && (
        <span className="text-ink-2">
          → “Nhờ <span className="font-medium text-ink">{preview}</span> xác nhận thêm…”
        </span>
      )}
      {item.author && (
        <label className="flex items-center gap-1 text-ink-3" title={`Các PR sau của ${item.author} tự dùng xưng hô này`}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          nhớ cho {item.author}
        </label>
      )}
      <button
        type="button"
        className={BTN}
        disabled={busy || !dirty || !validHandle(cleanHandle(handle))}
        onClick={() =>
          start(async () => {
            const r = await setAddresseeAction(item.id, { handle, honorific }, remember)
            setMsg(r.message)
            if (r.ok) router.refresh()
          })
        }
      >
        Lưu
      </button>
      {msg && <span className="text-ink-2">{msg}</span>}
      {!item.addressee && !msg && <span className="text-ink-3">(mặc định — chưa lưu)</span>}
    </div>
  )
}

/**
 * The PRs this one is reviewed with. Editing takes effect from the next round
 * — the current one already ran with what it had.
 */
function LinksBar({ item, repos, linkedItems }: { item: ItemView; repos: RepoPreset[]; linkedItems: Record<string, number> }) {
  const [links, setLinks] = useState<PrLink[]>(item.links)
  const [editing, setEditing] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const router = useRouter()
  const name = (id: string) => repos.find((r) => r.id === id)?.name ?? '?'
  const saved = JSON.stringify(item.links) === JSON.stringify(links)

  return (
    <div className="-mt-2 mb-4 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-3">🔗 PR liên kết:</span>
        {item.links.length === 0 && <span className="text-ink-3">chưa có</span>}
        {item.links.map((l, i) => {
          const tracked = l.prNumber ? linkedItems[`${l.repoId}#${l.prNumber}`] : 0
          return (
            <span key={i} className="flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5">
              {tracked ? (
                <Link href={`/m/code-review/${tracked}`} className="font-medium text-accent-ink hover:underline" title="Mở hồ sơ review của PR này">
                  {linkLabel(l, name(l.repoId))}
                </Link>
              ) : (
                <span className="font-medium">{linkLabel(l, name(l.repoId))}</span>
              )}
              <span className="max-w-[280px] truncate text-ink-3">{l.title}</span>
              {l.url && (
                <a href={l.url} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-accent-ink">
                  ↗
                </a>
              )}
            </span>
          )
        })}
        <button type="button" className="text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Đóng' : item.links.length ? 'Sửa' : '+ Liên kết PR'}
        </button>
        {msg && <span className="text-ink-2">{msg}</span>}
      </div>
      {editing && (
        <div className={CARD + ' mt-2 !p-3'}>
          <p className="mb-2 text-[11.5px] text-ink-3">
            Vd PR SDK mà PR này dựa vào (hoặc PR iOS dùng SDK này). Claude đọc thêm diff + code của PR kia để soi chỗ nối giữa hai bên. Có hiệu lực từ vòng review tiếp theo.
          </p>
          <LinkPicker repos={repos} value={links} onChange={setLinks} preferNot={item.repoId} />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className={BTN_PRI}
              disabled={busy || saved}
              onClick={() =>
                start(async () => {
                  const r = await setLinksAction(item.id, links)
                  setMsg(r.message)
                  if (r.ok) {
                    setEditing(false)
                    router.refresh()
                  }
                })
              }
            >
              Lưu liên kết
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Tests Claude suggests the reviewer run on their own machine — commands to
 * copy, never run by the app. "Dán kết quả" opens the chat with a template so
 * the output goes back to Claude to confirm or drop findings.
 */
function TestPlanCard({
  item,
  round,
  onPaste,
}: {
  item: ItemView
  round: RoundView
  onPaste: (text: string, caret: number) => void
}) {
  const checkout = [
    item.prNumber ? `git fetch origin pull/${item.prNumber}/head` : `git fetch origin ${item.headRef}`,
    `git checkout --detach ${round.headSha}`,
  ].join(' && ')
  return (
    <div className={CARD}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={CTITLE}>🧪 Gợi ý chạy test</span>
        <span className="text-[11px] text-ink-3">bạn tự chạy trên máy — app không chạy gì · dán kết quả vào chat để Claude phân tích</span>
      </div>
      {round.headSha && (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-2">
          <span className="shrink-0">Checkout đúng commit đã review:</span>
          <code className="min-w-0 truncate rounded bg-ground px-1.5 py-0.5 font-mono text-[11.5px]">{checkout}</code>
          <CopyButton text={checkout} />
        </div>
      )}
      <ol className="flex flex-col gap-3">
        {round.testPlan.map((t, i) => {
          const template = `Kết quả chạy test #${i + 1} (${t.purpose}):\n\`${t.command}\`\n\n\`\`\`\n\n\`\`\``
          return (
            <li key={i} className="rounded-md border border-line px-3 py-2">
              <div className="text-[13px] font-medium">
                {i + 1}. {t.purpose}
              </div>
              <div className="mt-1 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap rounded bg-ground px-2 py-1.5 font-mono text-[11.5px]">{t.command}</pre>
                <CopyButton text={t.command} label="Copy lệnh" />
              </div>
              {t.expect && <p className="mt-1 text-[12px] text-ink-2">Đọc kết quả: {t.expect}</p>}
              {t.findings.length > 0 && <p className="mt-0.5 text-[11.5px] text-ink-3">Liên quan: {t.findings.join(' · ')}</p>}
              <button
                type="button"
                className={BTN + ' mt-1.5'}
                // Caret lands inside the empty code fence, ready for ⌘V.
                onClick={() => onPaste(template, template.length - 4)}
              >
                📋 Dán kết quả vào chat
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Tab label with a count of threads waiting on the reviewer. */
function DiscussionLabel() {
  const gh = useGh()
  const d = gh.discussion
  const waiting = d ? d.threads.filter((t) => !t.isResolved && t.comments.at(-1)?.author !== d.viewer).length : 0
  return (
    <>
      Thảo luận GitHub
      {waiting > 0 && <span className="ml-1.5 rounded-full bg-blue-soft px-1.5 text-[11px] text-blue-ink">{waiting}</span>}
    </>
  )
}

/* ── one round ──────────────────────────────────────────────────────────── */

function RoundPanel({
  item,
  round,
  isLatest,
  findings,
  log,
  githubRepo,
  canRun,
  addressee,
  templates,
  onChanged,
}: {
  item: ItemView
  round: RoundView
  isLatest: boolean
  findings: FindingView[]
  log: ItemDetail['log']
  githubRepo: string
  canRun: boolean
  addressee: Addressee | null
  templates: DocTemplate[]
  onChanged: () => void
}) {
  const live = LIVE_STATES.includes(round.state)
  const [showLog, setShowLog] = useState(live || round.state !== 'done')
  const [busy, start] = useTransition()

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-2">
          <RoundPill s={round.state} />
          {round.verdict && (
            <span
              className={
                'rounded px-1.5 py-[1px] text-[11px] font-semibold ' +
                (round.verdict === 'approve'
                  ? 'bg-good-soft text-good'
                  : round.verdict === 'request_changes'
                    ? 'bg-crit-soft text-crit'
                    : 'bg-surface-2 text-ink-2')
              }
            >
              {VERDICT_LABEL[round.verdict]}
            </span>
          )}
          {round.headSha && (
            <span className="font-mono">
              {item.kind === 'doc'
                ? `@${shortSha(round.headSha)}`
                : `${shortSha(round.round > 1 && round.prevHeadSha ? round.prevHeadSha : round.baseSha)}…${shortSha(round.headSha)}`}
            </span>
          )}
          {confluencePages(round.docs).length > 0 && (
            <span title={confluencePages(round.docs).map((d) => `${d.name} · v${d.source.version}`).join('\n')}>
              🌐 {confluencePages(round.docs).length} trang Confluence
            </span>
          )}
          {jiraTickets(round.docs).length > 0 && (
            <span>
              🎫{' '}
              {jiraTickets(round.docs).map((d, i) => (
                <span key={d.ticket.key}>
                  {i > 0 && ', '}
                  <a href={d.ticket.url} target="_blank" rel="noreferrer" className="hover:text-accent-ink hover:underline" title={d.name + (d.ticket.auto ? ' · tự nhận' : '')}>
                    {d.ticket.key}
                  </a>
                </span>
              ))}
            </span>
          )}
          {round.docs.some((d) => !isFetched(d)) && (
            <span>
              {round.docs
                .filter((d) => !isFetched(d))
                .map((d) => {
                  const t = templates.find((x) => x.id === (d.templateId || (d.role === 'spec' ? '' : item.templateId)))
                  return `${DOC_ROLE_LABEL[d.role]}: ${d.name}${t ? ` (📐 ${t.name})` : ''}`
                })
                .join(' · ')}
            </span>
          )}
          {round.links.map((l, i) => (
            <span key={i} className={l.error ? 'text-warn' : ''} title={l.error || `${l.headRef} → ${l.baseRef}`}>
              🔗 {linkLabel(l, l.repoName)}
              {l.headSha ? <span className="font-mono text-ink-3"> @{shortSha(l.headSha)}</span> : ' (không lấy được)'}
            </span>
          ))}
          <span className="text-ink-3">
            {round.startedAt ? (live ? 'chạy ' : 'mất ') : ''}
            <Elapsed from={round.startedAt} to={live ? null : round.endedAt} />
            <Ago epoch={round.endedAt} prefix=" · " />
            {round.costUsd ? ` · ~$${round.costUsd.toFixed(2)}` : ''}
          </span>
          <div className="ml-auto flex gap-1.5">
            {live && (
              <button type="button" className={BTN} disabled={busy} onClick={() => start(async () => { await cancelRoundAction(round.id); onChanged() })}>
                Huỷ
              </button>
            )}
            {!live && (
              <button type="button" className={BTN} onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'Ẩn log' : 'Xem log'}
              </button>
            )}
          </div>
        </div>
        {round.message && <p className={'mt-2 text-[12.5px] ' + (round.state === 'done' ? 'text-ink-2' : 'text-crit')}>{round.message}</p>}
        {round.state === 'queued' && <p className="mt-2 text-[12.5px] text-ink-2">Đang chờ tới lượt — số review song song đặt trong Cấu hình.</p>}
        {showLog && <LogView lines={log} live={live} />}
      </div>

      {round.state === 'done' && (
        <DoneRound item={item} round={round} findings={findings} githubRepo={githubRepo} isLatest={isLatest} canRun={canRun} addressee={addressee} onChanged={onChanged} />
      )}
    </div>
  )
}

function LogView({ lines, live }: { lines: ItemDetail['log']; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <div ref={ref} className="mt-3 max-h-[320px] overflow-y-auto rounded-md bg-ground p-2.5 font-mono text-[11.5px] leading-relaxed">
      {lines.length === 0 ? (
        <div className="text-ink-3">{live ? 'Đang chuẩn bị (fetch, tạo worktree)…' : 'Không có log.'}</div>
      ) : (
        lines.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === 'tool'
                ? 'text-ink-2'
                : l.kind === 'text'
                  ? 'whitespace-pre-wrap py-0.5 font-sans text-[12px] text-ink'
                  : l.kind === 'result'
                    ? 'text-good'
                    : 'text-crit'
            }
          >
            {l.text}
          </div>
        ))
      )}
      {live && <div className="animate-pulse text-ink-3">▍</div>}
    </div>
  )
}

type Filter = 'live' | 'all' | 'fixed' | 'dismissed'

/** Group of PR findings not tied to a line — questions and doubts for the member. */
const LOOSE = '💬 Comment rời (không gắn với dòng code)'

function DoneRound({
  item,
  round,
  findings: initial,
  githubRepo,
  isLatest,
  canRun,
  addressee,
  onChanged,
}: {
  item: ItemView
  round: RoundView
  findings: FindingView[]
  githubRepo: string
  isLatest: boolean
  canRun: boolean
  addressee: Addressee | null
  onChanged: () => void
}) {
  const [findings, setFindings] = useState(initial)
  const [summary, setSummary] = useState(round.summary)
  const [filter, setFilter] = useState<Filter>('live')
  const chat = useRef<ChatHandle>(null)

  useEffect(() => setFindings(initial), [initial])
  // Claude's accepted proposal may have rewritten the summary.
  useEffect(() => setSummary(round.summary), [round.summary])

  const patch = (id: number, p: Partial<FindingView>) => {
    setFindings((all) => all.map((f) => (f.id === id ? { ...f, ...p } : f)))
    void patchFindingAction(id, { body: p.body, status: p.status }).then(() => {
      if (p.status) onChanged()
    })
  }

  const carried = findings.filter((f) => f.origin === 'carried')
  const fresh = findings.filter((f) => f.origin === 'new')
  const tally = {
    fixed: carried.filter((f) => f.status === 'fixed').length,
    partial: carried.filter((f) => f.status === 'partial').length,
    notFixed: carried.filter((f) => f.status === 'not_fixed').length,
    fresh: fresh.filter((f) => f.status !== 'dismissed').length,
  }

  const visible = findings.filter((f) =>
    filter === 'all'
      ? true
      : filter === 'fixed'
        ? f.status === 'fixed'
        : filter === 'dismissed'
          ? f.status === 'dismissed'
          : f.status !== 'fixed' && f.status !== 'dismissed',
  )

  const groups = useMemo(() => {
    const m = new Map<string, FindingView[]>()
    for (const f of visible) {
      const key =
        item.kind === 'doc'
          ? DOC_CATEGORY_LABEL[f.category as DocCategory] ?? f.category
          : f.file || LOOSE
      m.set(key, [...(m.get(key) ?? []), f])
    }
    if (item.kind === 'doc') {
      const order = DOC_CATEGORIES.map((c) => DOC_CATEGORY_LABEL[c])
      return [...m].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    }
    // Loose comments first: they are usually questions the member must answer.
    return [...m].sort((a, b) => Number(b[0] === LOOSE) - Number(a[0] === LOOSE))
  }, [visible, item.kind])

  const count = (f: Filter) =>
    findings.filter((x) =>
      f === 'all' ? true : f === 'fixed' ? x.status === 'fixed' : f === 'dismissed' ? x.status === 'dismissed' : x.status !== 'fixed' && x.status !== 'dismissed',
    ).length

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {round.round > 1 && item.kind === 'pr' && (
          <span className="text-[12px] text-ink-2">
            Vòng {round.round}: <span className="text-good">✓ {tally.fixed} đã sửa</span>
            {tally.partial > 0 && <span className="text-warn"> · ◐ {tally.partial} sửa chưa hết</span>}
            {tally.notFixed > 0 && <span className="text-crit"> · ✗ {tally.notFixed} chưa sửa</span>}
            <span> · {tally.fresh} vấn đề mới</span>
          </span>
        )}
        {!isLatest && <span className="text-[11.5px] text-ink-3">Đây là vòng cũ — kết quả mới nhất ở vòng sau.</span>}
        <div className="ml-auto flex gap-1.5">
          <ChatShortcut />
          <CopyButton text={allClipboard(item.kind, findings)} label="Copy tất cả comment (markdown)" className={BTN_PRI} />
        </div>
      </div>

      {/* Claude's read of the round, for the reviewer only: no Copy, never posted. */}
      {summary.trim() && (
        <div className="rounded-[9px] border border-dashed border-line-strong bg-surface-2 px-4 py-3">
          <div className="mb-1 flex items-center gap-2">
            <span className={CTITLE}>📝 Nhận xét của Claude</span>
            <span className="text-[11px] text-ink-3">chỉ để bạn xem — không gửi cho member</span>
          </div>
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{summary}</div>
        </div>
      )}

      {item.kind === 'pr' && round.testPlan.length > 0 && (
        <TestPlanCard
          item={item}
          round={round}
          onPaste={(text, caret) => chat.current?.prefill(text, caret)}
        />
      )}

      {isLatest && <SubmitReview round={round} findings={findings} onDone={onChanged} />}
      {isLatest && item.kind === 'doc' && <CfAccessNote />}
      {isLatest && item.kind === 'doc' && <SendAllConfluence roundId={round.id} findings={findings} docs={round.docs} onDone={onChanged} />}
      {isLatest && <AccessNote onGithub={item.kind === 'pr' && Boolean(item.prNumber) && Boolean(githubRepo)} />}

      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
        {(
          [
            ['live', 'Còn mở'],
            ['all', 'Tất cả'],
            ['fixed', 'Đã sửa'],
            ['dismissed', 'Bỏ qua'],
          ] as const
        ).map(([f, label]) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              'rounded-md border px-2.5 py-0.5 ' +
              (filter === f ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line bg-surface hover:bg-surface-2')
            }
          >
            {label} <span className="font-mono text-ink-3">{count(f)}</span>
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <div className={CARD + ' text-[12.5px] text-ink-2'}>
          {findings.length === 0 ? 'Claude không thấy vấn đề nào. 🎉' : 'Không có mục nào ở bộ lọc này.'}
        </div>
      ) : (
        groups.map(([group, list]) => (
          <section key={group} className="flex flex-col gap-2">
            <h2 className="font-mono text-[12px] font-semibold text-ink-2">
              {group} <span className="font-normal text-ink-3">· {list.length}</span>
            </h2>
            {list.map((f) => (
              <FindingCard
                key={f.id}
                f={f}
                kind={item.kind}
                docs={round.docs}
                link={blobUrl(githubRepo, round.headSha, f)}
                onPatch={(p) => patch(f.id, p)}
                onPosted={onChanged}
                onAsk={() => chat.current?.ask(f)}
              />
            ))}
          </section>
        ))
      )}

      <ChatPanel ref={chat} roundId={round.id} findings={findings} canRun={canRun} addressee={addressee} onApplied={onChanged} />
    </>
  )
}

function FindingCard({
  f,
  kind,
  docs,
  link,
  onPatch,
  onPosted,
  onAsk,
  compact,
}: {
  f: FindingView
  kind: ItemView['kind']
  docs: DocFile[]
  link: string
  /** Shown under its line in the diff: no code snippet of its own. */
  compact?: boolean
  onPatch: (p: Partial<FindingView>) => void
  onPosted: () => void
  onAsk: () => void
}) {
  const [body, setBody] = useState(f.body)
  useEffect(() => setBody(f.body), [f.body])
  const [editing, setEditing] = useState(false)
  const dim = f.status === 'dismissed' || f.status === 'fixed'
  const loc = kind === 'doc' ? f.location : where(f)

  return (
    <div className={CARD + ' !p-3.5 ' + (dim ? 'opacity-60' : '')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityPill s={f.severity} />
        {kind === 'doc' && (
          <span className="rounded bg-epic-soft px-1.5 py-[1px] text-[11px] font-medium text-epic-ink">
            {DOC_CATEGORY_LABEL[f.category as DocCategory] ?? f.category}
          </span>
        )}
        {(f.origin === 'carried' || f.status === 'dismissed') && <StatusPill s={f.status} />}
        <span className="text-[13px] font-medium">{f.title}</span>
        {kind === 'pr' &&
          f.category &&
          (f.category === OWN_CATEGORY ? (
            <span className="rounded bg-accent-soft px-1.5 py-[1px] text-[11px] font-medium text-accent-ink">✍️ Bạn viết</span>
          ) : /tài liệu/i.test(f.category) ? (
            <span className="rounded bg-epic-soft px-1.5 py-[1px] text-[11px] font-medium text-epic-ink">📎 {f.category}</span>
          ) : (
            <span className="text-[11px] text-ink-3">· {f.category}</span>
          ))}
      </div>
      {kind === 'doc' && f.quote && (
        <div className="mt-1 truncate text-[11.5px] text-ink-3" title={f.quote}>
          ❝ {f.quote}
        </div>
      )}
      {(loc || (kind === 'doc' && f.file)) && (
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-ink-3">
          {kind === 'doc' && f.file && <span>{loc}</span>}
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" className="hover:text-accent-ink">
              {kind === 'doc' ? where({ ...f, location: '' }) : loc} ↗
            </a>
          ) : kind === 'doc' && f.file ? (
            <span>· {where({ ...f, location: '' })}</span>
          ) : (
            <span>{loc}</span>
          )}
          {kind === 'pr' && f.line && (
            <span className={f.inDiff ? 'text-good' : 'text-warn'} title={f.inDiff ? 'Dòng này nằm trong diff — comment inline được' : 'Dòng này ngoài diff — GitHub không cho comment inline, nên dán vào comment chung'}>
              {f.inDiff ? '● comment được trên dòng này' : '○ ngoài diff — gửi thành comment chung'}
            </span>
          )}
        </div>
      )}
      {f.snippet && !compact && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-ground p-2 font-mono text-[11.5px] leading-[1.55]">
          {f.snippet.split('\n').map((line, i) => {
            const n = f.snippetStart + i
            const hit = f.line && n >= f.line && n <= (f.endLine ?? f.line)
            return (
              <div key={i} className={hit ? 'bg-warn-soft' : ''}>
                <span className="mr-3 inline-block w-8 select-none text-right text-ink-3">{n}</span>
                {line}
              </div>
            )
          })}
        </pre>
      )}
      {f.followNote && (
        <p className="mt-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2">
          <span className="font-medium">Vòng này: </span>
          {f.followNote}
        </p>
      )}
      {editing ? (
        <textarea
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => {
            setEditing(false)
            if (body !== f.body) onPatch({ body })
          }}
          rows={Math.min(16, Math.max(3, body.split('\n').length + 1))}
          className={INPUT + ' mt-2 leading-relaxed'}
        />
      ) : (
        <div
          className="mt-2 cursor-text whitespace-pre-wrap text-[13px] leading-relaxed"
          title="Bấm để sửa"
          onClick={() => setEditing(true)}
        >
          {body}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <CopyButton text={findingClipboard({ ...f, body }, kind)} />
        {!f.ghUrl && f.status !== 'dismissed' && f.status !== 'fixed' && <FindingGithub f={{ ...f, body }} onPosted={onPosted} />}
        <ReplyWithBody f={f} body={body} onSent={onPosted} />
        {kind === 'doc' && !f.ghUrl && <FindingConfluence f={f} body={body} docs={docs} onPosted={onPosted} />}
        <button type="button" className={BTN} onClick={() => setEditing(true)}>
          Sửa
        </button>
        <button type="button" className={BTN} title="Hỏi lại / phản biện điểm này với Claude" onClick={onAsk}>
          Hỏi Claude
        </button>
        {f.status === 'dismissed' ? (
          <button type="button" className={BTN} onClick={() => onPatch({ status: f.origin === 'carried' ? 'not_fixed' : 'open' })}>
            Khôi phục
          </button>
        ) : (
          f.status !== 'fixed' && (
            <button type="button" className={BTN} title="Không đưa vào comment, và vòng sau không kiểm tra lại" onClick={() => onPatch({ status: 'dismissed' })}>
              Bỏ qua
            </button>
          )
        )}
      </div>
      {f.ghUrl && (
        <div className="mt-2">
          {kind === 'doc' ? <FindingConfluence f={f} body={body} docs={docs} onPosted={onPosted} /> : <FindingGithub f={{ ...f, body }} onPosted={onPosted} />}
        </div>
      )}
    </div>
  )
}

/* ── next round ─────────────────────────────────────────────────────────── */

function NextRound({
  item,
  latest,
  canRun,
  templates,
  onQueued,
}: {
  item: ItemView
  latest: RoundView | null
  canRun: boolean
  templates: DocTemplate[]
  onQueued: () => void
}) {
  const [note, setNote] = useState(item.note)
  const [msg, setMsg] = useState('')
  const [busy, start] = useTransition()
  const up = useDocUpload({
    itemId: item.id,
    canRun,
    onQueued: () => onQueued(),
    templates,
    fallbackTemplate: item.templateId,
    previous: latest?.docs,
  })
  const attach = useAttachments()
  const done = latest?.state === 'done'
  // Tickets and Confluence pages are fetched afresh; only uploaded files carry over as they are.
  const current = (latest?.docs ?? []).filter((d) => item.kind === 'doc' || !isFetched(d))

  const again = () =>
    start(async () => {
      // PR: newly attached PDFs replace the old ones; none attached = keep them.
      const docs = item.kind === 'pr' ? await attach.upload() : []
      if (!docs) return
      const r = await reReviewAction(item.id, note, docs)
      setMsg(r.message)
      if (r.ok) {
        attach.clear()
        onQueued()
      }
    })

  return (
    <div className={CARD + ' mt-4'}>
      <div className={CTITLE + ' mb-1'}>{done ? 'Member đã sửa xong? Review tiếp' : 'Chạy lại'}</div>
      <p className="mb-2 text-[12px] text-ink-2">
        {item.kind === 'pr'
          ? done
            ? `Claude sẽ lấy commit mới nhất, xem phần vừa sửa so với vòng trước, đánh giá lại từng điểm còn mở và chỉ tìm vấn đề mới trong code vừa đổi.${(latest?.docs ?? []).some(isFetched) || item.jira.keys.length || item.sources.length ? ' Ticket Jira / trang Confluence được đọc lại bản mới nhất.' : ''}`
            : 'Vòng trước không ra kết quả — chạy lại với commit mới nhất.'
          : item.sources.length
            ? 'Claude sẽ lấy bản mới nhất của các trang Confluence (cả subpage), so với bản vòng trước, đánh giá lại từng điểm còn mở và đọc thêm trả lời dưới các comment đã gửi. PDF (nếu có) giữ như cũ, hoặc chọn bản mới bên dưới.'
            : 'Tải bản PDF mới lên để Claude so với bản trước và kiểm tra các điểm còn mở — hoặc chạy lại với đúng tài liệu cũ.'}
      </p>
      {item.kind === 'doc' && <div className="mb-2">{up.picker}</div>}
      {item.kind === 'pr' && current.length > 0 && (
        <p className="mb-2 text-[12px] text-ink-2">
          📎 Vòng sau vẫn đối chiếu với: {current.map((d) => `${DOC_ROLE_LABEL[d.role]}: ${d.name}`).join(' · ')}
          {attach.count > 0 && <span className="text-warn"> — sẽ được thay bằng {attach.count} file mới bên dưới</span>}
        </p>
      )}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={INPUT} placeholder="Ghi chú cho Claude (không bắt buộc)" />
      {item.kind === 'pr' &&
        attach.section(
          current.length
            ? 'Tài liệu đã cập nhật? Chọn bản mới — sẽ thay toàn bộ tài liệu cũ cho vòng này và các vòng sau.'
            : 'Mô tả chức năng, TDD… để Claude kiểm tra PR có làm đúng và đủ theo tài liệu không.',
        )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.kind === 'doc' && (
          <button type="button" className={BTN_PRI} disabled={!up.ready || up.count === 0} onClick={() => void up.submit({ note })}>
            {up.busy ? 'Đang tải lên…' : item.sources.length ? 'Review tiếp với PDF mới + Confluence' : 'Review tiếp với bản mới'}
          </button>
        )}
        <button type="button" className={item.kind === 'pr' || item.sources.length ? BTN_PRI : BTN} disabled={busy || !canRun} onClick={again}>
          {item.kind === 'pr'
            ? busy && attach.count
              ? 'Đang tải tài liệu…'
              : done
                ? 'Review tiếp'
                : 'Chạy lại'
            : item.sources.length
              ? done
                ? 'Review tiếp (lấy bản mới từ Confluence)'
                : 'Chạy lại (lấy bản mới từ Confluence)'
              : 'Chạy lại với tài liệu cũ'}
        </button>
        {(msg || up.msg) && <span className="text-[12px] text-ink-2">{msg || up.msg}</span>}
      </div>
    </div>
  )
}
