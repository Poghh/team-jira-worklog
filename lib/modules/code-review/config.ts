import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'

import type { Addressee, RepoPreset } from './model'

/**
 * Settings for the code-review module, under `mod:code-review:` in the shared
 * `settings` table like every other module. The GitHub token is not here: it is
 * the core `github_token` setting, which already exists for this purpose.
 */
const PREFIX = 'mod:code-review:'
const K = {
  repos: `${PREFIX}repos`,
  /** How many reviews may run at once. Each one is a full Claude session. */
  concurrency: `${PREFIX}concurrency`,
  /** Path to the `claude` binary; empty = look in the usual places. */
  claudeBin: `${PREFIX}claude_bin`,
  /** `--model` for the CLI; empty = whatever the CLI defaults to. */
  model: `${PREFIX}model`,
  /** Rules applied to every review, before the per-repo ones. */
  globalRules: `${PREFIX}global_rules`,
  /** `{githubLogin: {handle, honorific}}` — how to address each author, remembered across PRs. */
  people: `${PREFIX}people`,
} as const

export const DEFAULT_CONCURRENCY = 3
export const MAX_CONCURRENCY = 6

function getRaw(key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value
}

function setRaw(key: string, value: string) {
  const stamp = Math.floor(Date.now() / 1000)
  db.insert(settings)
    .values({ key, value, updatedAt: stamp })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: stamp } })
    .run()
}

export interface ReviewConfig {
  repos: RepoPreset[]
  concurrency: number
  claudeBin: string
  model: string
  globalRules: string
}

/** Hand-editable JSON, so a bad row reads as empty rather than throwing. */
function readRepos(raw: string | undefined): RepoPreset[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        localPath: String(r.localPath ?? ''),
        githubRepo: String(r.githubRepo ?? ''),
        rules: String(r.rules ?? ''),
      }))
      .filter((r) => r.id)
  } catch {
    return []
  }
}

export function getReviewConfig(): ReviewConfig {
  const n = Number(getRaw(K.concurrency))
  return {
    repos: readRepos(getRaw(K.repos)),
    concurrency:
      Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CONCURRENCY) : DEFAULT_CONCURRENCY,
    claudeBin: (getRaw(K.claudeBin) ?? '').trim(),
    model: (getRaw(K.model) ?? '').trim(),
    globalRules: getRaw(K.globalRules) ?? '',
  }
}

export function getRepo(id: string): RepoPreset | undefined {
  return getReviewConfig().repos.find((r) => r.id === id)
}

export function setRepos(repos: RepoPreset[]) {
  setRaw(K.repos, JSON.stringify(repos))
}

export function setRunnerConfig(input: {
  concurrency: number
  claudeBin: string
  model: string
  globalRules: string
}) {
  const n = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(input.concurrency) || 1))
  setRaw(K.concurrency, String(n))
  setRaw(K.claudeBin, input.claudeBin.trim())
  setRaw(K.model, input.model.trim())
  setRaw(K.globalRules, input.globalRules)
}

/* ── how to address each author ────────────────────────────────────────── */

function readPeople(): Record<string, Addressee> {
  try {
    const v = JSON.parse(getRaw(K.people) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function rememberPerson(login: string, a: Addressee) {
  if (!login) return
  setRaw(K.people, JSON.stringify({ ...readPeople(), [login.toLowerCase()]: a }))
}

/**
 * Who a comment speaks to on this item: what the reviewer set on it, else what
 * they set for this author before, else the author's login as someone younger
 * ("@login" — the mention alone). Null when there is no author (a doc, or a
 * branch pair without one).
 */
export function resolveAddressee(item: { author: string; addressee: Addressee | null }): Addressee | null {
  if (item.addressee) return item.addressee
  if (!item.author) return null
  return readPeople()[item.author.toLowerCase()] ?? { handle: item.author, honorific: 'em' }
}
