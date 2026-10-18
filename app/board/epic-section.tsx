import type { BoardParent } from '@/lib/jira/types'
import { formatDuration } from '@/lib/time'

import { CreateIssueButton } from './create-issue'
import { TypeIcon } from './type-icon'

export interface EpicGroup {
  key: string | null
  name: string
  parents: BoardParent[]
}

/**
 * Groups parent tasks by the epic above them.
 *
 * Deliberately a header band rather than a third nested card: the row already
 * carries a stepper, a note field and a Log button, and each extra level of
 * boxing eats the width those need. Two levels of card plus a light epic rule
 * reads as three levels without costing horizontal room.
 */
export function groupByEpic(parents: BoardParent[], newestFirst = true): EpicGroup[] {
  const groups = new Map<string, EpicGroup>()

  for (const parent of parents) {
    const key = parent.epicKey ?? '__none__'
    if (!groups.has(key)) {
      groups.set(key, {
        key: parent.epicKey,
        name: parent.epicName ?? 'Không thuộc epic nào',
        parents: [],
      })
    }
    groups.get(key)!.parents.push(parent)
  }

  // Order epics by the created date of their leading task, matching the chosen
  // direction — newest-first ranks by the newest task, oldest-first by the
  // oldest — so the sort reads consistently at every level. `parents` arrives
  // pre-sorted, so its first entry is that leading task. The catch-all bucket
  // ("not in any epic") always sinks to the bottom.
  return [...groups.values()].sort((a, b) => {
    if (!a.key) return 1
    if (!b.key) return -1
    const at = a.parents[0]?.created ?? 0
    const bt = b.parents[0]?.created ?? 0
    return newestFirst ? bt - at : at - bt
  })
}

export function EpicHeader({
  group,
  boardSprintId,
}: {
  group: EpicGroup
  /** Sprint the board is filtered to, so a new task lands where the user is looking. */
  boardSprintId: number | null
}) {
  const taskCount = group.parents.length
  // Full child counts and logged time — not the filtered `subtasks` — so hiding
  // Done subtasks doesn't shrink the epic's totals.
  const subtaskCount = group.parents.reduce((n, p) => n + p.childCount, 0)
  const logged = group.parents.reduce((n, p) => n + p.childTimeSpentTotal, 0)

  return (
    /* Dải màu, không phải một dòng chữ có vạch bên trái.
     *
     * Epic là tầng trên cùng của ba tầng (epic → task cha → task con), mà bản
     * cũ vẽ nó nhạt hơn cả thẻ task cha ngay dưới — tầng cao nhất lại là thứ
     * chìm nhất. Nền tím nhạt cộng vạch đậm bên trái cho nó đúng thứ bậc, và
     * dùng lại cặp màu `epic` sẵn có chứ không bịa màu mới. */
    <div className="mb-2 mt-1 flex flex-wrap items-center gap-2 rounded-[7px] rounded-l-none border-l-[3px] border-epic bg-epic-soft py-1.5 pl-2.5 pr-3">
      <span className="inline-flex items-center gap-1 rounded-[3px] bg-epic px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-white">
        {/* The badge is solid purple, and Jira ships this icon in its own colour —
            `brightness-0 invert` flattens any SVG to pure white, which is the only
            way to recolour an <img> the browser treats as opaque. */}
        <TypeIcon name="Epic" className="size-3 brightness-0 invert" />
        Epic
      </span>

      {group.key && (
        <span className="font-mono text-[11.5px] font-semibold text-epic-ink">{group.key}</span>
      )}

      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{group.name}</span>

      <span className="font-mono text-[11px] text-ink-3">
        {taskCount} task · {subtaskCount} task con
        {logged > 0 && <> · {formatDuration(logged)}</>}
      </span>

      {group.key && (
        <CreateIssueButton
          parentKey={group.key}
          mode="task"
          boardSprintId={boardSprintId}
          className="rounded-md border border-epic/50 px-2 py-[2px] font-mono text-[11px] text-epic-ink hover:border-epic hover:bg-epic-soft"
        >
          + Task
        </CreateIssueButton>
      )}
    </div>
  )
}
