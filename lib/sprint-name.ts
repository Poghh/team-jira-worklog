/**
 * Sprint name helpers, free of server imports so the create modal can derive a
 * prefix from whichever sprint the new issue will actually land in — rather than
 * whichever sprint happens to be running.
 */

/** `VT Sprint 66` → `66`. */
export function sprintNumber(name: string): string | null {
  const m = name.match(/(\d+)\s*$/)
  return m ? m[1] : null
}

export function sprintPrefix(name: string | null | undefined, pattern: string): string | null {
  if (!name || !pattern.trim()) return null
  const n = sprintNumber(name)
  return n ? pattern.replace('{n}', n) : null
}

/**
 * Matches whatever the current pattern produces, so a stale sprint prefix can be
 * swapped out when the target sprint changes.
 *
 * Derived from the pattern rather than hardcoded. `/^\[spt\s/` was fine while
 * the pattern was `[spt {n}]`, but a team writing `[SPT-{n}]` got no match — the
 * old chip stayed and titles ended up carrying two sprint numbers.
 */
export function sprintPrefixRegex(pattern: string): RegExp | null {
  if (!pattern.includes('{n}')) return null
  const escaped = pattern
    .split('{n}')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\d+')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Drops any chip that is a sprint prefix, leaving every other one in place. */
export function withoutSprintPrefix(prefixes: string[], pattern: string): string[] {
  const re = sprintPrefixRegex(pattern)
  return re ? prefixes.filter((p) => !re.test(p)) : prefixes
}

/**
 * Days after a sprint's end that still count as that sprint on the board.
 * Work runs over — a weekend after the last day, a holiday before the next
 * sprint is opened — and those hours belong to the sprint's tasks; without
 * this the day has no sprint, the board shows no task and nothing can be
 * logged. A week covers a weekend and a short gap, not a forgotten sprint.
 */
export const SPRINT_GRACE_DAYS = 7

export interface SprintSpan {
  id: number
  /** `YYYY-MM-DD`, or null for a sprint with no dates yet. */
  start: string | null
  end: string | null
}

/** Whole days from `a` to `b` (calendar dates). */
function dayDiff(a: string, b: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.round((utc(b) - utc(a)) / 86400000)
}

/**
 * The sprint a calendar day belongs to: the one whose dates cover it, else
 * the one that ended most recently, at most {@link SPRINT_GRACE_DAYS} before
 * it (`overrun` then tells the board to say so). Null when neither — the day
 * really is outside every sprint.
 */
export function sprintForDay<S extends SprintSpan>(sprints: S[], day: string): { sprint: S; overrun: boolean } | null {
  const covering = sprints
    .filter((s) => s.start && s.end && day >= s.start && day <= s.end)
    // Overlapping sprints: the one that started last is the one running.
    .sort((a, b) => (b.start! < a.start! ? -1 : b.start! > a.start! ? 1 : b.id - a.id))[0]
  if (covering) return { sprint: covering, overrun: false }
  const ended = sprints
    .filter((s) => s.end && s.end < day && dayDiff(s.end, day) <= SPRINT_GRACE_DAYS)
    .sort((a, b) => (b.end! < a.end! ? -1 : b.end! > a.end! ? 1 : b.id - a.id))[0]
  return ended ? { sprint: ended, overrun: true } : null
}
