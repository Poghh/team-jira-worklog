import 'server-only'

import { eq, sql } from 'drizzle-orm'

import { db } from './db'
import { jqlPresets, prefixes, reportTemplates, settings } from './db/schema'
import { DEFAULT_SCHEDULE, type WorkSchedule, parseClock } from './time'

/**
 * SQLite is the source of truth for settings. .env.local only seeds the first
 * run, so credentials can be changed in the UI without editing files or
 * restarting. Once a key exists in the DB, the env var is ignored.
 */
export const SETTING_KEYS = {
  jiraBaseUrl: 'jira_base_url',
  jiraEmail: 'jira_email',
  jiraApiToken: 'jira_api_token',
  jiraProjectKey: 'jira_project_key',
  jiraBoardId: 'jira_board_id',
  googleApiKey: 'google_api_key',
  githubToken: 'github_token',
  geminiModel: 'gemini_model',
  geminiFallbackModels: 'gemini_fallback_models',
  dailyQuotaHours: 'daily_quota_hours',
  logStepHours: 'log_step_hours',
  logPresets: 'log_presets',
  weekendCountsToQuota: 'weekend_counts_to_quota',
  workDayStart: 'work_day_start',
  workDayEnd: 'work_day_end',
  breakStart: 'break_start',
  breakEnd: 'break_end',
  sprintPrefixPattern: 'sprint_prefix_pattern',
  teamLabel: 'team_label',
  teamPrefix: 'team_prefix',
  teamSprintFilter: 'team_sprint_filter',
  /** Show the sprint point rollup on the task board. */
  showSprintPoints: 'show_sprint_points',
  pointBudget1: 'point_budget_1',
  pointBudget2: 'point_budget_2',
  pointBudget3: 'point_budget_3',
} as const

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]

const DEFAULTS: Record<string, string> = {
  // No project or board default: they are specific to whoever runs this, and a
  // wrong guess produces confusing empty screens rather than an obvious error.
  [SETTING_KEYS.jiraProjectKey]: '',
  [SETTING_KEYS.jiraBoardId]: '',
  [SETTING_KEYS.geminiModel]: 'gemini-3.1-flash-lite',
  // Tried in order when the primary is out of quota. Retrying the same model
  // cannot fix a spent quota — only a different one can.
  [SETTING_KEYS.geminiFallbackModels]: 'gemini-3-flash-preview,gemini-3.5-flash',
  [SETTING_KEYS.dailyQuotaHours]: '8',
  [SETTING_KEYS.logStepHours]: '0.5',
  [SETTING_KEYS.logPresets]: '0.5,1,2,4,8',
  [SETTING_KEYS.weekendCountsToQuota]: 'false',
  // The working day worklogs are laid out on. Entries stack from `start`,
  // skipping the break, so a day reads as a real timeline instead of six
  // entries all stamped 09:00.
  [SETTING_KEYS.workDayStart]: '09:00',
  [SETTING_KEYS.workDayEnd]: '18:00',
  [SETTING_KEYS.breakStart]: '12:00',
  [SETTING_KEYS.breakEnd]: '13:00',
  [SETTING_KEYS.sprintPrefixPattern]: '[spt {n}]',
  // Team scoping. All three are empty by default — a board with no team split
  // must keep behaving exactly as before, so every rule they drive is opt-in.
  // "Detect" on the settings screen fills them from the board's own filter.
  [SETTING_KEYS.teamLabel]: '',
  [SETTING_KEYS.teamPrefix]: '',
  [SETTING_KEYS.teamSprintFilter]: '',
  /**
   * Off by default.
   *
   * It costs a Jira query per render, and a board whose team does not fill in
   * story points would spend it to be told there are none. A panel is worth
   * having only once somebody asks for it, so the default is the one that
   * costs nothing; read as `=== 'true'` everywhere, so an install that never
   * seeded the key stays off rather than falling open.
   */
  [SETTING_KEYS.showSprintPoints]: 'false',
  // Point budgets are advisory only — they drive a soft warning, never a block.
  [SETTING_KEYS.pointBudget1]: '1-2h',
  [SETTING_KEYS.pointBudget2]: '4h',
  [SETTING_KEYS.pointBudget3]: '1d-2d',
}

/** Env var consulted for each key on first run only. */
const ENV_SEED: Partial<Record<string, string>> = {
  [SETTING_KEYS.jiraBaseUrl]: 'JIRA_BASE_URL',
  [SETTING_KEYS.jiraEmail]: 'JIRA_EMAIL',
  [SETTING_KEYS.jiraApiToken]: 'JIRA_API_TOKEN',
  [SETTING_KEYS.jiraProjectKey]: 'JIRA_PROJECT_KEY',
  [SETTING_KEYS.jiraBoardId]: 'JIRA_BOARD_ID',
  [SETTING_KEYS.googleApiKey]: 'GOOGLE_API_KEY',
  [SETTING_KEYS.githubToken]: 'GITHUB_TOKEN',
  [SETTING_KEYS.geminiModel]: 'GEMINI_MODEL',
  [SETTING_KEYS.teamLabel]: 'JIRA_TEAM_LABEL',
  [SETTING_KEYS.teamPrefix]: 'JIRA_TEAM_PREFIX',
  [SETTING_KEYS.teamSprintFilter]: 'JIRA_TEAM_SPRINT_FILTER',
}

const DEFAULT_PREFIXES = ['[Support]', '[Mobile]', '[BE]', '[Web]', '[Desktop]']

const DEFAULT_REPORT_TEMPLATE = `Daily Report {{next_date}}

Previous day:
{{#issues}}
- {{key}} | {{summary}}
{{/issues}}
Today:
{{#today}}
- {{key}} | {{summary}}
{{/today}}
- `

/**
 * Built-in JQL presets. {sp} is replaced at run time with the discovered story
 * point field id — hardcoding cf[10016] would break on any other project.
 */
const DEFAULT_JQL_PRESETS: Array<{ name: string; jql: string }> = [
  { name: 'của tôi, chưa Done', jql: 'project = {project} AND assignee = currentUser() AND statusCategory != Done{team} ORDER BY created DESC' },
  { name: 'chưa ai nhận', jql: 'project = {project} AND assignee IS EMPTY AND statusCategory != Done{team} ORDER BY created DESC' },
  { name: 'sprint đang mở', jql: 'project = {project} AND sprint IN openSprints() AND assignee = currentUser(){team} ORDER BY created DESC' },
  { name: 'tôi tạo', jql: 'project = {project} AND reporter = currentUser(){team} ORDER BY created DESC' },
  { name: 'subtask chưa có point', jql: 'project = {project} AND type = Subtask AND "cf[{sp}]" IS EMPTY{team} ORDER BY created DESC' },
  { name: 'tôi log 7 ngày qua', jql: 'project = {project} AND worklogAuthor = currentUser() AND worklogDate >= -7d{team} ORDER BY updated DESC' },
  { name: 'thiếu ngày (start/due)', jql: 'project = {project} AND assignee = currentUser() AND statusCategory != Done AND (duedate IS EMPTY OR "Start date" IS EMPTY){team} ORDER BY created DESC' },
]

let seeded = false

/** Idempotent. Runs once per process, before any read. */
export function ensureSeeded() {
  if (seeded) return
  seeded = true

  const existing = new Set(db.select({ key: settings.key }).from(settings).all().map((r) => r.key))

  const rows: Array<{ key: string; value: string }> = []
  for (const key of Object.values(SETTING_KEYS)) {
    if (existing.has(key)) continue
    const envName = ENV_SEED[key]
    const value = (envName ? process.env[envName] : undefined) ?? DEFAULTS[key]
    if (value !== undefined && value !== '') rows.push({ key, value })
  }
  if (rows.length) db.insert(settings).values(rows).run()

  if (db.select({ n: sql<number>`count(*)` }).from(prefixes).get()?.n === 0) {
    db.insert(prefixes)
      .values(DEFAULT_PREFIXES.map((label, i) => ({ label, position: i })))
      .run()
  }

  if (db.select({ n: sql<number>`count(*)` }).from(reportTemplates).get()?.n === 0) {
    db.insert(reportTemplates)
      .values({ name: 'Mặc định', body: DEFAULT_REPORT_TEMPLATE, isDefault: true })
      .run()
  }

  if (db.select({ n: sql<number>`count(*)` }).from(jqlPresets).get()?.n === 0) {
    db.insert(jqlPresets)
      .values(DEFAULT_JQL_PRESETS.map((p, i) => ({ ...p, builtin: true, position: i })))
      .run()
  } else {
    refreshBuiltinPresets()
  }
}

/**
 * Keeps the built-in presets current without resurrecting deleted ones.
 *
 * They are seeded once, so a preset whose text changes in a later version — the
 * team-label clause, say — would stay on the old text forever in an existing
 * install. Matching by name updates what is there and adds nothing back: a
 * built-in the user deleted stays deleted.
 */
function refreshBuiltinPresets() {
  const existing = db.select().from(jqlPresets).all().filter((p) => p.builtin)
  for (const preset of DEFAULT_JQL_PRESETS) {
    const row = existing.find((p) => p.name === preset.name)
    if (row && row.jql !== preset.jql) {
      db.update(jqlPresets).set({ jql: preset.jql }).where(eq(jqlPresets.id, row.id)).run()
    }
  }
}

export function getSetting(key: SettingKey): string | undefined {
  ensureSeeded()
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value
}

export function getSettings(): Record<string, string> {
  ensureSeeded()
  const out: Record<string, string> = {}
  for (const row of db.select().from(settings).all()) out[row.key] = row.value
  return out
}

export function setSetting(key: SettingKey | string, value: string) {
  ensureSeeded()
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: sql`(strftime('%s','now'))` },
    })
    .run()
}

export function setSettings(entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) setSetting(key, value)
}

/** Redacts secrets so settings can be sent to a client component safely. */
export function getSettingsForClient() {
  const all = getSettings()
  const secretKeys: string[] = [
    SETTING_KEYS.jiraApiToken,
    SETTING_KEYS.googleApiKey,
    SETTING_KEYS.githubToken,
  ]
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) {
    out[k] = secretKeys.includes(k) ? (v ? '••••••••' + v.slice(-4) : '') : v
  }
  return out
}

/**
 * Project key, or a clear error.
 *
 * Previously each call site fell back to a hardcoded key. That produced empty
 * boards against a project the user does not own — which reads as "no work
 * today" rather than "not configured yet".
 */
export function requireProjectKey(): string {
  const key = getSetting(SETTING_KEYS.jiraProjectKey)?.trim()
  if (!key) throw new Error('Chưa chọn project — vào Settings điền Project key')
  return key
}

/**
 * The three team settings, read together.
 *
 * One board can be shared by several teams — CTALK-TEAM and HIR-TEAM sit on the
 * same VipTalk project, split only by a label. Every one of these is optional:
 * with all three empty the app behaves as it did on a single-team board.
 *
 *   label   — the Jira label that puts an issue on the team's board, and which
 *             every issue this app creates must carry. Also narrows every read.
 *   prefix  — mandatory leading tag on the summary, e.g. `[CTALK]`.
 *   sprint  — substring that identifies the team's own sprints, e.g. `CTALK`.
 *             Without it the board's sprint list mixes in other teams' sprints
 *             and "the sprint running now" resolves to the wrong one.
 */
export interface TeamScope {
  label: string | null
  prefix: string | null
  sprintFilter: string | null
}

export function getTeamScope(): TeamScope {
  const label = getSetting(SETTING_KEYS.teamLabel)?.trim()
  const prefix = getSetting(SETTING_KEYS.teamPrefix)?.trim()
  const sprintFilter = getSetting(SETTING_KEYS.teamSprintFilter)?.trim()
  return {
    label: label || null,
    prefix: prefix || null,
    sprintFilter: sprintFilter || null,
  }
}

/**
 * The working day, read from settings and falling back per-field.
 *
 * A single bad value must not take the whole schedule down with it: a typo in
 * the break would otherwise push every worklog to a wrong hour, which is
 * tedious to unpick issue by issue in Jira.
 */
export function getWorkSchedule(): WorkSchedule {
  const at = (key: SettingKey, fallback: number) => parseClock(getSetting(key)) ?? fallback

  const breakStart = getSetting(SETTING_KEYS.breakStart)?.trim()
  const breakEnd = getSetting(SETTING_KEYS.breakEnd)?.trim()
  // Clearing either field means "no break", which is a legitimate setup.
  const noBreak = !breakStart || !breakEnd

  return {
    start: at(SETTING_KEYS.workDayStart, DEFAULT_SCHEDULE.start),
    end: at(SETTING_KEYS.workDayEnd, DEFAULT_SCHEDULE.end),
    breakStart: noBreak ? null : (parseClock(breakStart) ?? DEFAULT_SCHEDULE.breakStart),
    breakEnd: noBreak ? null : (parseClock(breakEnd) ?? DEFAULT_SCHEDULE.breakEnd),
  }
}

export function requireBoardId(): string {
  const id = getSetting(SETTING_KEYS.jiraBoardId)?.trim()
  if (!id) throw new Error('Chưa chọn board — vào Settings điền Board id')
  return id
}
