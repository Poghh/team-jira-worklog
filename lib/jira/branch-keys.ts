/**
 * Jira keys written into branch names.
 *
 * Lives here rather than inside a module because two modules read it and
 * neither owns it: the branches board matches a branch to its card by the key
 * in its name, and the SDK release module reads the same key when guessing a
 * version suffix. It used to live in `lib/modules/branches/` and be imported
 * across the module boundary, which quietly made one module unbuildable
 * without the other.
 *
 * Pure string work — no database, no network, no `server-only`.
 */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Words that take the `WORD-123` shape in a branch name without being tickets.
 *
 * Only consulted when no project keys are configured; with a list, the list is
 * the answer and nothing else can match.
 */
const NOT_A_PROJECT = new Set([
  "release", "feature", "features", "task", "fix", "hotfix", "bugfix", "chore",
  "refactor", "test", "tests", "build", "ci", "docs", "doc", "wip", "tmp",
  "temp", "dev", "develop", "main", "master", "staging", "prod", "v",
  "version", "rc", "beta", "alpha", "sprint", "week",
  // Ordinals that wear the same shape: `update_framework/preview_2` read as
  // ticket PREVIEW-2 until this line existed.
  "preview", "part", "step", "round", "phase", "batch", "attempt", "try",
]);

/**
 * Every Jira key a branch names, in the order they appear.
 *
 * One branch routinely covers more than one ticket — `ctalk/bugfix/VTL-286_VTL-610`
 * fixes both — and taking only the first left the second with no card at all.
 * Deduplicated, because a branch that repeats a key
 * (`resolve_VTL-286_VTL-286_develop`) means it once, not twice.
 *
 * With `projectKeys` empty it falls back to reading any `WORD-123` that is not
 * an obvious non-ticket. That is deliberately the looser rule and it exists for
 * callers that have no configured list to consult — a guess, and labelled as
 * one wherever its answer is shown.
 */
export function extractIssueKeys(branch: string, projectKeys: string[]): string[] {
  const listed = projectKeys.map((k) => k.trim()).filter(Boolean);
  const found: string[] = [];

  if (listed.length) {
    for (const key of listed) {
      const re = new RegExp(
        `(?:^|[^a-z0-9])(${escapeRe(key)})[-_]?(\\d+)(?![0-9])`,
        "gi",
      );
      for (const m of branch.matchAll(re)) {
        const full = `${key.toUpperCase()}-${m[2]}`;
        if (!found.includes(full)) found.push(full);
      }
    }
  } else {
    for (const m of branch.matchAll(
      /(?:^|[^a-z0-9])([a-z]{2,10})[-_](\d{1,6})(?![0-9])/gi,
    )) {
      const key = m[1].toUpperCase();
      if (NOT_A_PROJECT.has(key.toLowerCase())) continue;
      const full = `${key}-${m[2]}`;
      if (!found.includes(full)) found.push(full);
    }
  }

  // Ordered by where they sit in the name, not by which project key was
  // configured first — the branch's own order is the one a person reads.
  return found.sort(
    (a, b) =>
      branch.toUpperCase().indexOf(a.replace("-", "")) -
        branch.toUpperCase().indexOf(b.replace("-", "")) ||
      branch.toUpperCase().indexOf(a) - branch.toUpperCase().indexOf(b),
  );
}
