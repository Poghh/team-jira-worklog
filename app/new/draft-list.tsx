'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { formatDayMonth } from '@/lib/time'

import { LinkPending } from '../link-pending'
import { Working } from '../spinner'
import { deleteDraftAction } from './actions'

export interface DraftSummary {
  id: number
  title: string
  updatedAt: number
}

/** Same string on the server and in the browser — see formatDayMonth. */
const when = (epochSeconds: number) => formatDayMonth(epochSeconds)

export function DraftList({
  drafts,
  activeId,
  onDeleted,
}: {
  drafts: DraftSummary[]
  activeId?: number
  onDeleted?: (id: number) => void
}) {
  const router = useRouter()
  const [items, setItems] = useState(drafts)
  const [pending, startTransition] = useTransition()
  const [confirming, setConfirming] = useState<number | null>(null)

  if (!items.length) return null

  function remove(id: number) {
    startTransition(async () => {
      const res = await deleteDraftAction(id)
      if (res.ok) {
        setItems((list) => list.filter((d) => d.id !== id))
        setConfirming(null)
        onDeleted?.(id)
        // Leaving the URL pointing at a deleted draft would reload nothing.
        if (activeId === id) router.push('/new')
      }
    })
  }

  return (
    <section className="rounded-[9px] border border-line bg-surface p-[17px]">
      <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">
        Draft đã lưu ({items.length})
      </div>

      <div className="flex flex-col">
        {items.map((d, i) => {
          const active = d.id === activeId
          return (
            <div
              key={d.id}
              className={
                'flex items-center gap-2 py-[5px] ' + (i ? 'border-t border-line' : '')
              }
            >
              <Link
                href={`/new?draft=${d.id}`}
                className={
                  'min-w-0 flex-1 truncate text-[12.5px] ' +
                  (active ? 'font-semibold text-accent-ink' : 'hover:text-accent-ink')
                }
                title={d.title}
              >
                <span className="inline-flex max-w-full items-center gap-1.5">
                  <span className="truncate">
                    {active && '● '}
                    {d.title}
                  </span>
                  <LinkPending />
                </span>
              </Link>

              <span className="shrink-0 font-mono text-[11px] text-ink-3">{when(d.updatedAt)}</span>

              {confirming === d.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => remove(d.id)}
                    className="rounded px-1.5 py-0.5 text-[11px] font-medium text-crit hover:bg-crit-soft disabled:opacity-60"
                  >
                    {pending ? <Working>Đang xoá…</Working> : 'Xoá?'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-1 py-0.5 text-[11px] text-ink-3 hover:text-ink"
                  >
                    huỷ
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(d.id)}
                  className="shrink-0 rounded px-1 text-[13px] leading-none text-ink-3 hover:text-crit"
                  aria-label={`Xoá draft ${d.title}`}
                  title="Xoá draft"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
