'use server'

import { revalidatePath } from 'next/cache'

import { probeClaude } from '@/lib/ai/cli'
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

export async function testClaudeConnection(): Promise<TestResult> {
  const check = await probeClaude(getSetting(SETTING_KEYS.claudeBin) ?? '')
  if (!check.ok) return { ok: false, message: check.problem }

  const model = getSetting(SETTING_KEYS.claudeModel)?.trim()
  return {
    ok: true,
    // Nói rõ tài khoản nào: CLI dùng gói đăng ký của người đã `claude auth
    // login` trên máy này, không phải của người đang mở trình duyệt.
    message: `Sẵn sàng · ${check.account || 'đã đăng nhập'}`,
    detail: [check.version, check.bin, model ? `model ${model}` : 'model mặc định của CLI']
      .filter(Boolean)
      .join(' · '),
  }
}
