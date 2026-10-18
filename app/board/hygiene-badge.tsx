import type { IssueHygiene } from '@/lib/jira/types'

/**
 * Flags an issue that breaks the team's filing rules.
 *
 * The one that actually hurts is the missing label: the team's board is a saved
 * filter over it, so an unlabelled issue is invisible there while still showing
 * up here — the kind of gap nobody notices until standup. Prefix and dates are
 * conventions Jira will never enforce on its own.
 *
 * Deliberately one small badge rather than a row of them: the detail belongs in
 * the tooltip, and the chips beside it already carry their own colour when a
 * date is missing. Renders nothing when everything is in order, so a tidy board
 * stays quiet.
 */
export function HygieneBadge({ hygiene }: { hygiene: IssueHygiene }) {
  if (!hygiene.any) return null

  // Dates alone are already shown, and coloured, by the date chip — repeating
  // them here would double-report the same thing on every unscheduled issue.
  const structural = hygiene.missingLabel || hygiene.missingPrefix

  return (
    <span
      title={hygiene.problems.join(' · ')}
      className={
        // `shrink-0 whitespace-nowrap`: badge có `h-[18px]` cố định, nên khi ô
        // bị bóp mà chữ được phép xuống dòng thì ba dòng chữ tràn ra ngoài cái
        // hộp 18px đó và **đè lên hàng trên dưới** — đo ở 1360px: "sai quy ước"
        // thành ba dòng trong một hàng cao 39px. Badge là nhãn ngắn, thứ đáng
        // bị bóp là tiêu đề bên cạnh, và tiêu đề đã có `truncate`.
        'inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] border px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] ' +
        (structural ? 'border-crit bg-crit-soft text-crit' : 'border-warn bg-warn-soft text-warn')
      }
    >
      ⚠ {structural ? 'sai quy ước' : 'thiếu ngày'}
    </span>
  )
}
