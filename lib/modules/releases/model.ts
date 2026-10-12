/**
 * Types, defaults and report rendering for the releases board — pure, no
 * `server-only`, so the client board and the server share them. Products and
 * teams are user config (see config.ts); the values here are only the seed a
 * fresh install starts from. Ported from the task-tracking tool.
 */

/** A tracked repo/project and the environments its builds move through. */
export interface ProductConfig {
  id: string
  name: string
  /** Ordered low → high; also the left → right column order on the board. */
  environments: string[]
  /** Include this product's tasks in the generated report. */
  inReport: boolean
}

/** Progress of a task's build, low → high. */
export const BUILD_STATUS = ['đang PR', 'đã merge', 'đã build', 'đã public'] as const

/** "Hide team X at environment Y" in the report (e.g. CXP not shown at Develop). */
export interface ReportExclude {
  environment: string
  team: string
}

export const DEFAULT_PRODUCTS: ProductConfig[] = [
  { id: 'lite', name: 'Lite', environments: ['CTalk Dev', 'Integration', 'Staging', 'Released'], inReport: true },
  { id: 'matrix', name: 'MatrixRustSDK', environments: ['CTalk Dev', 'Integration', 'Staging', 'Released'], inReport: true },
  { id: 'classic', name: 'Classic', environments: ['Dev', 'Staging', 'Released'], inReport: true },
]

export const DEFAULT_TEAMS = ['CTalk', 'Hir', 'CXP']

/**
 * A bug-fix task code raised after the feature built. Fixes keep coming and
 * keep being rebuilt long after the feature itself went public, so each one
 * carries its own status and remembers the build it went out in.
 */
export interface FixCode {
  code: string
  status: string
  /** Build it went public in, e.g. "VipTalk Lite 2.3.0 (515)". */
  build?: string
}

export interface ReleaseTaskShape {
  taskId: string
  description: string
  branchName: string
  subTasks: string[]
  product: string
  team: string
  environment: string
  buildStatus: string
  /** No code branch of its own (e.g. Lite just rebuilds against a new SDK). */
  noBranch: boolean
  /**
   * The related task in another product — a Lite task and the MatrixRustSDK
   * task it builds on. Shown on both cards; one link per pair is enough.
   */
  refId: number | null
  fixes: FixCode[]
  /** Build the feature code itself went public in. */
  publishedBuild: string
}

interface ReportTask {
  taskId: string
  description: string
  team: string
  environment: string
  buildStatus: string
}

export interface ReportProduct {
  name: string
  /** This product's own environments, low → high. */
  environments: string[]
  tasks: ReportTask[]
}

/** Only fully-shipped tasks reach the report — the last build stage. */
export const REPORTED_STATUS = BUILD_STATUS[BUILD_STATUS.length - 1]

/** The stage where a build exists and is ready to hand to testers. */
export const BUILT_STATUS = BUILD_STATUS[2] // 'đã build'

/** The task fields the "What to Test" seed needs. */
export interface BuiltTaskLike {
  team: string
  taskId: string
  description: string
  product: string
  environment: string
  buildStatus: string
}

/**
 * Groups tasks by team as TestFlight-ready lines:
 *
 *   - Hir: VTL-456, VTL-555
 *   - CTalk: VTL-222
 *
 * Uses the task id, falling back to the description when a task has no id. Teams
 * appear in first-seen order.
 */
function groupByTeam(tasks: BuiltTaskLike[]): string {
  const teams = [...new Set(tasks.map((t) => t.team).filter(Boolean))]
  return teams
    .map((team) => {
      const ids = tasks
        .filter((t) => t.team === team)
        .map((t) => t.taskId.trim() || t.description.trim())
        .filter(Boolean)
        .join(', ')
      return ids ? `- ${team}: ${ids}` : null
    })
    .filter(Boolean)
    .join('\n')
}

/** Every "đã build" task grouped by team — the unscoped seed. */
export function renderBuiltTasksByTeam(tasks: BuiltTaskLike[]): string {
  return groupByTeam(tasks.filter((t) => t.buildStatus === BUILT_STATUS))
}

/**
 * "What to Test" seed for one iOS app, scoped to the product and environment the
 * app is mapped to. A build at a given environment carries every "đã build" task
 * of that product that has reached that environment or higher — the same
 * "in or above" rule the status report uses — grouped by team.
 *
 * With no environment mapping (or one the product no longer lists), the env
 * filter is dropped and all of the product's built tasks are used.
 */
export function renderBuiltForApp(
  tasks: BuiltTaskLike[],
  productName: string,
  environment: string,
  environments: string[],
): string {
  const rankHere = environments.indexOf(environment)
  const active = tasks.filter(
    (t) =>
      t.product === productName &&
      t.buildStatus === BUILT_STATUS &&
      (rankHere < 0 || environments.indexOf(t.environment) >= rankHere),
  )
  return groupByTeam(active)
}

/**
 * Copy-ready status report, in the shape the original task-tracking tool used:
 *
 *   🚀 Tính năng đã deploy lên môi trường Staging:
 *   *Lite:
 *          - CTalk: KAN-1
 *   *MatrixRustSDK:
 *          - Hir: SDK-9
 *
 * Only tasks whose build status is "đã public" are reported. One section per
 * environment — products sharing an environment merge under it, each as its own
 * *Product block. A task that reached a higher env is also listed under the
 * lower ones ("in or above"), ranked within its own product.
 */
export function renderReleaseReport(
  products: ReportProduct[],
  excludes: ReportExclude[] = [],
): string {
  const isHidden = (environment: string, team: string) =>
    excludes.some((e) => e.environment === environment && e.team === team)

  // Section order: every environment, in first-appearance order.
  const sections: string[] = []
  for (const p of products) {
    for (const env of p.environments) {
      if (!sections.includes(env)) sections.push(env)
    }
  }

  const text = sections
    .map((env) => {
      const title = `🚀 Tính năng đã deploy lên môi trường ${env}:`
      const blocks = products
        .map((p) => {
          const rankHere = p.environments.indexOf(env)
          if (rankHere < 0) return null // product has no such environment
          const active = p.tasks.filter(
            (t) =>
              t.buildStatus === REPORTED_STATUS &&
              p.environments.indexOf(t.environment) >= rankHere,
          )
          const teams = [...new Set(active.map((t) => t.team).filter(Boolean))]
          const lines = teams
            .map((team) => {
              if (isHidden(env, team)) return null // team hidden at this environment
              const ids = active
                .filter((t) => t.team === team)
                .map((t) => t.taskId.trim() || t.description.trim())
                .filter(Boolean)
                .join(', ')
              return ids ? `       - ${team}: ${ids}` : null
            })
            .filter(Boolean)
          return lines.length ? `*${p.name}:\n${lines.join('\n')}` : null
        })
        .filter(Boolean)
      return blocks.length ? `${title}\n${blocks.join('\n')}` : `${title}\nNo active tasks`
    })
    .join('\n\n')

  return text || '(chưa có task để report)'
}

/* ── fix codes, publishing and cross-product links ─────────────────────────── */

export interface TaskLike {
  id: number
  taskId: string
  description: string
  product: string
  team: string
  environment: string
  buildStatus: string
  refId: number | null
  fixes: FixCode[]
  publishedBuild: string
}

/** One code that can go into a TestFlight build: a feature, or a fix of one. */
export interface PublishCandidate {
  /** release_tasks row the code lives on. */
  taskRowId: number
  code: string
  kind: 'feature' | 'fix'
  team: string
  /** The feature's code / title, for grouping and for "fix of …". */
  feature: string
}

const normCode = (s: string) => s.trim().toUpperCase()

/** Same task code, ignoring case and spacing — how Lite and SDK cards of one task match. */
export function sameCode(a: string, b: string): boolean {
  return Boolean(a.trim()) && normCode(a) === normCode(b)
}

/** Tasks linked to this one either way (its refId, or theirs pointing here). */
export function linkedTasks<T extends TaskLike>(task: T, tasks: T[]): T[] {
  return tasks.filter((t) => t.id !== task.id && (t.id === task.refId || t.refId === task.id))
}

/** Cards in another product with the same code that are not linked yet — likely the same task. */
export function suggestedLinks<T extends TaskLike>(task: T, tasks: T[]): T[] {
  const linked = new Set(linkedTasks(task, tasks).map((t) => t.id))
  return tasks.filter(
    (t) => t.id !== task.id && t.product !== task.product && !linked.has(t.id) && sameCode(t.taskId, task.taskId),
  )
}

/**
 * Codes ready to go into the next build of an app mapped to `productName` at
 * `environment`: features still at "đã build" and fixes at "đã build", on tasks
 * that reached that environment or higher. Anything already public is left out
 * — the point is that each code goes out once.
 */
export function publishCandidates(
  tasks: TaskLike[],
  productName: string,
  environment: string,
  environments: string[],
): PublishCandidate[] {
  const rankHere = environments.indexOf(environment)
  const out: PublishCandidate[] = []
  for (const t of tasks) {
    if (productName && t.product !== productName) continue
    if (rankHere >= 0 && environments.indexOf(t.environment) < rankHere) continue
    const feature = t.taskId.trim() || t.description.trim()
    if (t.buildStatus === BUILT_STATUS && feature) {
      out.push({ taskRowId: t.id, code: feature, kind: 'feature', team: t.team, feature })
    }
    for (const f of t.fixes) {
      if (f.status === BUILT_STATUS && f.code.trim()) {
        out.push({ taskRowId: t.id, code: f.code.trim(), kind: 'fix', team: t.team, feature })
      }
    }
  }
  return out
}

/** Every code of a product already public, with the build it went out in. */
export function publishedCodes(tasks: TaskLike[], productName: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of tasks) {
    if (productName && t.product !== productName) continue
    const feature = t.taskId.trim()
    if (feature && t.buildStatus === REPORTED_STATUS) out.set(normCode(feature), t.publishedBuild || 'build trước')
    for (const f of t.fixes) {
      if (f.status === REPORTED_STATUS && f.code.trim()) out.set(normCode(f.code), f.build || 'build trước')
    }
  }
  return out
}

/** Codes from `published` that `text` mentions — "you are about to announce these again". */
export function republished(text: string, published: Map<string, string>): Array<{ code: string; build: string }> {
  const upper = text.toUpperCase()
  const out: Array<{ code: string; build: string }> = []
  for (const [code, build] of published) {
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^A-Z0-9])${esc}([^A-Z0-9]|$)`).test(upper)) out.push({ code, build })
  }
  return out
}

/**
 * "What to Test" from the chosen codes, grouped by team in first-seen order:
 *
 *   - CTalk: VT-2511, VT-2633 (fix VT-2511)
 *   - Hir: VT-2256
 */
export function renderWhatToTest(chosen: PublishCandidate[]): string {
  const teams = [...new Set(chosen.map((c) => c.team))]
  return teams
    .map((team) => {
      const codes = chosen
        .filter((c) => c.team === team)
        .map((c) => (c.kind === 'fix' && c.feature && !sameCode(c.feature, c.code) ? `${c.code} (fix ${c.feature})` : c.code))
      return `- ${team || 'Khác'}: ${codes.join(', ')}`
    })
    .join('\n')
}

/** "3/5 fix đã public" — the line a feature card shows under its title. */
export function fixProgress(fixes: FixCode[]): string {
  if (!fixes.length) return ''
  const pub = fixes.filter((f) => f.status === REPORTED_STATUS).length
  return `${pub}/${fixes.length} fix đã public`
}
