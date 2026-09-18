'use server'

import { revalidatePath } from 'next/cache'

import { detectTeamScope } from '@/lib/jira/board-config'
import { getMyself } from '@/lib/jira/client'
import { clearMetaCache } from '@/lib/jira/meta'
import { SETTING_KEYS, getSetting, setSettings } from '@/lib/settings'

/** Placeholder the server sends instead of a stored secret; means "unchanged". */
const MASK_PREFIX = '••••'

export interface SaveResult {
  ok: boolean
  message: string
}

export async function saveSettings(_prev: SaveResult | null, formData: FormData): Promise<SaveResult> {
  const entries: Record<string, string> = {}

  for (const [key, raw] of formData.entries()) {
    if (typeof raw !== 'string') continue
    if (!Object.values(SETTING_KEYS).includes(key as never)) continue
    // A masked secret means the user did not retype it — keep what is stored.
    if (raw.startsWith(MASK_PREFIX)) continue
    entries[key] = raw.trim()
  }

  /**
   * An unchecked checkbox submits nothing, so absence has to mean false.
   *
   * A list rather than a line per setting: the loop above only ever sees keys
   * the browser sent, so a checkbox left out of this list can be turned on and
   * never turned off again — it saves fine, and unchecking it silently keeps
   * the old value. That is invisible until somebody tries to switch a feature
   * off and it comes back on the next render.
   */
  const CHECKBOXES = [
    SETTING_KEYS.weekendCountsToQuota,
    SETTING_KEYS.showSprintPoints,
  ]
  for (const key of CHECKBOXES) entries[key] = formData.has(key) ? 'true' : 'false'

  try {
    setSettings(entries)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không lưu được settings' }
  }

  // Field ids, issue types and the board's estimation field are all cached per
  // project for a day. Pointing the app at a different project or board without
  // dropping that cache serves yesterday's instance for the next 24 hours, which
  // looks exactly like Jira returning nothing.
  clearMetaCache()

  revalidatePath('/settings')
  revalidatePath('/')
  return { ok: true, message: 'Đã lưu settings' }
}

export interface DetectResult {
  ok: boolean
  message: string
  detail?: string
  scope?: { label: string | null; prefix: string | null; sprintFilter: string | null }
}

/**
 * Reads the team split off the configured board.
 *
 * Returns the values rather than writing them: the user still has to look at
 * what was found and press Save, because a board filter can mention a label
 * nobody actually files under.
 */
export async function detectTeamAction(): Promise<DetectResult> {
  const boardId = getSetting(SETTING_KEYS.jiraBoardId)?.trim()
  if (!boardId) return { ok: false, message: 'Chưa điền Board id — lưu board trước đã' }

  try {
    const found = await detectTeamScope()
    if (!found) return { ok: false, message: 'Không đọc được cấu hình board' }

    return {
      ok: true,
      message: found.label
        ? `Board "${found.boardName}" lọc theo label ${found.label}`
        : `Board "${found.boardName}" không lọc theo label nào`,
      detail: found.filterJql ?? undefined,
      scope: {
        label: found.label,
        prefix: found.prefix,
        sprintFilter: found.sprintFilter,
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không dò được board' }
  }
}

export interface TestResult {
  ok: boolean
  message: string
  detail?: string
}

/**
 * Tests whatever is currently stored, so it reflects the saved state rather than
 * unsaved form input. Read-only — GET /myself creates nothing.
 */
export async function testJiraConnection(): Promise<TestResult> {
  const baseUrl = getSetting(SETTING_KEYS.jiraBaseUrl)
  if (!baseUrl) return { ok: false, message: 'Chưa điền Jira base URL' }

  try {
    const me = await getMyself()
    return {
      ok: true,
      message: `Kết nối OK · ${me.displayName}`,
      detail: [me.emailAddress, me.timeZone].filter(Boolean).join(' · '),
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không kết nối được Jira',
    }
  }
}

export async function testGeminiConnection(): Promise<TestResult> {
  const key = getSetting(SETTING_KEYS.googleApiKey)
  const model = getSetting(SETTING_KEYS.geminiModel) ?? 'gemini-2.5-flash'
  if (!key) return { ok: false, message: 'Chưa điền Google API key' }

  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
      cache: 'no-store',
    })
    const body = (await res.json().catch(() => null)) as
      | { models?: Array<{ name?: string }>; error?: { message?: string; status?: string } }
      | null

    if (!res.ok) {
      return { ok: false, message: body?.error?.message ?? `Google trả về HTTP ${res.status}` }
    }

    const names = (body?.models ?? []).map((m) => m.name?.split('/').pop()).filter(Boolean)
    const hasModel = names.includes(model)
    return {
      ok: hasModel,
      message: hasModel ? `Kết nối OK · ${model}` : `Key hợp lệ nhưng không thấy model ${model}`,
      detail: `${names.length} model khả dụng`,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không gọi được Google API' }
  }
}
