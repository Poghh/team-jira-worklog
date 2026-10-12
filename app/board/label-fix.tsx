'use client'

import { useState, useTransition } from 'react'

import { addTeamLabelAction } from '@/app/actions'

import { Spinner } from '../spinner'
import { useNav } from './navigation'

/**
 * "+ label" on a subtask that is missing the team label.
 *
 * The board shows such a subtask because its parent is the team's, but Jira's
 * own team board — a saved filter over the label — does not, so the work is
 * invisible there. One click puts the label on that one issue, on Jira.
 */
export function LabelFixButton({ issueKey, label }: { issueKey: string; label: string }) {
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { refresh } = useNav()

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending}
        title={`Thêm label "${label}" cho ${issueKey} trên Jira — để task hiện trên board của team`}
        onClick={() =>
          startTransition(async () => {
            setNote(null)
            const res = await addTeamLabelAction(issueKey)
            if (res.ok) refresh()
            else setNote(res.message)
          })
        }
        className="inline-flex h-[18px] items-center gap-1 rounded-[3px] border border-crit bg-crit-soft px-1.5 font-mono text-[9.5px] font-semibold text-crit hover:brightness-110 disabled:opacity-60"
      >
        <span aria-hidden>{pending ? <Spinner className="size-2.5" /> : '+'}</span>
        <span>label {label}</span>
      </button>
      {note && <span className="text-[11px] text-crit">{note}</span>}
    </span>
  )
}
