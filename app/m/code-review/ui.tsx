'use client'

import { useState, useTransition } from 'react'

import type { ClaudeCheck } from '@/lib/modules/code-review/claude'
import {
  type FindingStatus,
  FINDING_STATUS_LABEL,
  ROUND_LABEL,
  type RoundState,
  SEVERITY_LABEL,
  type Severity,
} from '@/lib/modules/code-review/model'

import { useNow } from '@/lib/use-now'

import { claudeStatusAction } from './actions'

export const CARD = 'rounded-[9px] border border-line bg-surface p-[17px]'
export const CTITLE = 'font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3'
export const BTN =
  'rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-2 disabled:opacity-50'
export const BTN_PRI =
  'rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:bg-accent-2 disabled:opacity-50'
export const INPUT = 'w-full rounded-md border border-line bg-ground px-2.5 py-1.5 text-[13px]'

export function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
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

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      disabled={!text.trim()}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {}
      }}
      className={className ?? BTN}
    >
      {done ? '✓ Đã copy' : label}
    </button>
  )
}

const SEVERITY_CLS: Record<Severity, string> = {
  blocker: 'bg-crit-soft text-crit',
  major: 'bg-orange-soft text-orange',
  minor: 'bg-blue-soft text-blue-ink',
  nit: 'bg-surface-2 text-ink-3',
}

export function SeverityPill({ s }: { s: Severity }) {
  return (
    <span className={`rounded px-1.5 py-[1px] font-mono text-[10.5px] font-semibold uppercase ${SEVERITY_CLS[s]}`}>
      {SEVERITY_LABEL[s]}
    </span>
  )
}

const STATUS_CLS: Record<FindingStatus, string> = {
  open: 'bg-accent-soft text-accent-ink',
  fixed: 'bg-good-soft text-good',
  partial: 'bg-warn-soft text-warn',
  not_fixed: 'bg-crit-soft text-crit',
  dismissed: 'bg-surface-2 text-ink-3',
}

export function StatusPill({ s }: { s: FindingStatus }) {
  return <span className={`rounded px-1.5 py-[1px] text-[11px] font-medium ${STATUS_CLS[s]}`}>{FINDING_STATUS_LABEL[s]}</span>
}

const ROUND_CLS: Record<RoundState, string> = {
  queued: 'bg-surface-2 text-ink-2',
  preparing: 'bg-blue-soft text-blue-ink',
  running: 'bg-blue-soft text-blue-ink',
  finalizing: 'bg-blue-soft text-blue-ink',
  done: 'bg-good-soft text-good',
  failed: 'bg-crit-soft text-crit',
  cancelled: 'bg-surface-2 text-ink-3',
  lost: 'bg-warn-soft text-warn',
}

export function RoundPill({ s }: { s: RoundState }) {
  const live = s === 'running' || s === 'preparing' || s === 'finalizing'
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-[1px] text-[11px] font-medium ${ROUND_CLS[s]}`}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {ROUND_LABEL[s]}
    </span>
  )
}

/**
 * The gate every review passes: is the Claude Code CLI here and signed in?
 * Shown at the top of every screen of the module, green or red.
 */
export function ClaudeBanner({ check: c, onChange }: { check: ClaudeCheck; onChange: (c: ClaudeCheck) => void }) {
  const [busy, start] = useTransition()
  const recheck = () => start(async () => onChange(await claudeStatusAction(true)))

  if (c.ok) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-ink-2">
        <span className="font-medium text-good">● Claude Code CLI sẵn sàng</span>
        <span className="font-mono text-ink-3">{c.version}</span>
        {c.account && <span>· {c.account}</span>}
        <button type="button" onClick={recheck} disabled={busy} className="ml-auto text-ink-3 hover:text-ink">
          {busy ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
        </button>
      </div>
    )
  }
  return (
    <div className="mb-4 rounded-md border border-crit bg-crit-soft px-3 py-2.5 text-[12.5px] text-crit">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">✗ Chưa review được — Claude Code CLI chưa sẵn sàng</span>
        <button type="button" onClick={recheck} disabled={busy} className={BTN + ' ml-auto text-ink'}>
          {busy ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
        </button>
      </div>
      <p className="mt-1 text-ink-2">{c.problem}</p>
      {c.bin && <p className="mt-0.5 font-mono text-[11px] text-ink-3">{c.bin}</p>}
    </div>
  )
}

export function timeAgo(epoch: number | null | undefined, now: number): string {
  if (!epoch) return ''
  const s = Math.max(0, now - epoch)
  if (s < 60) return 'vừa xong'
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`
  return `${Math.floor(s / 86400)} ngày trước`
}

export function duration(from: number | null, to: number): string {
  if (!from) return ''
  const s = Math.max(0, to - from)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** "3 phút trước" — rendered only once in the browser (see useNow). */
export function Ago({ epoch, prefix = '' }: { epoch: number | null | undefined; prefix?: string }) {
  const now = useNow(30)
  if (!epoch || now === null) return null
  return (
    <>
      {prefix}
      {timeAgo(epoch, now)}
    </>
  )
}

/** Elapsed time; ticks every second while `to` is still open. */
export function Elapsed({ from, to }: { from: number | null; to: number | null }) {
  const now = useNow(1)
  if (!from) return null
  if (to !== null) return <>{duration(from, to)}</>
  return now === null ? null : <>{duration(from, now)}</>
}
