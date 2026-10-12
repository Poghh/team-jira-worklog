'use server'

import { revalidatePath } from 'next/cache'

import { isModuleEnabled } from '@/lib/modules/state'
import {
  type AppPreset,
  type ProfileView,
  deleteAppPreset,
  deleteAscProfile,
  getAppPreset,
  getIosConfig,
  getProfile,
  saveAppPreset,
  saveAscProfile,
  setNotifyConfig,
  toProfileView,
} from '@/lib/modules/ios-publish/config'
import {
  type BuildStatus,
  resolveStatus,
  submitToExternalTesting,
} from '@/lib/modules/ios-publish/asc'
import { recordIosLog } from '@/lib/modules/ios-publish/store'
import { publishBuiltTasksMentioned, publishCodes } from '@/lib/modules/releases/store'

export interface IosResult {
  ok: boolean
  message: string
  status?: BuildStatus
}
export interface ProfileResult {
  ok: boolean
  message: string
  profile?: ProfileView
}
export interface AppResult {
  ok: boolean
  message: string
  app?: AppPreset
}

interface PublishInput {
  appId: string
  version: string
  groupName: string
  buildNumber: string
  content: string
  /** The codes the reviewer ticked as going out in this build (releases module). */
  codes?: Array<{ taskRowId: number; code: string; kind: 'feature' | 'fix' }>
}

function enabled(): boolean {
  return isModuleEnabled('ios-publish')
}

// ── config: profiles ─────────────────────────────────────────────────────────

export async function saveAscProfileAction(input: {
  id?: string
  name: string
  issuerId: string
  keyId: string
  p8Key: string
}): Promise<ProfileResult> {
  if (!enabled()) return { ok: false, message: 'Module đang tắt' }
  if (!input.name.trim()) return { ok: false, message: 'Đặt tên cho cấu hình' }
  if (!input.issuerId.trim() || !input.keyId.trim()) return { ok: false, message: 'Cần Issuer ID và Key ID' }
  if (!input.id && !input.p8Key.trim()) return { ok: false, message: 'Cần dán nội dung file .p8' }

  try {
    const saved = saveAscProfile(input)
    revalidatePath('/m/ios-publish')
    return { ok: true, message: `Đã lưu cấu hình "${saved.name}"`, profile: toProfileView(saved) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không lưu được' }
  }
}

export async function deleteAscProfileAction(id: string): Promise<ProfileResult> {
  if (!enabled()) return { ok: false, message: 'Module đang tắt' }
  try {
    deleteAscProfile(id)
    revalidatePath('/m/ios-publish')
    return { ok: true, message: 'Đã xoá cấu hình' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không xoá được' }
  }
}

// ── config: app presets ──────────────────────────────────────────────────────

export async function saveAppPresetAction(input: {
  id?: string
  name: string
  profileId: string
  version: string
  groups: string[]
  roomIds: string
  product: string
  environment: string
}): Promise<AppResult> {
  if (!enabled()) return { ok: false, message: 'Module đang tắt' }
  if (!input.name.trim()) return { ok: false, message: 'Điền tên app' }
  if (!input.profileId) return { ok: false, message: 'Chọn cấu hình ASC cho app' }
  if (!input.groups.some((g) => g.trim())) return { ok: false, message: 'Cần ít nhất 1 external group' }

  try {
    const saved = saveAppPreset(input)
    revalidatePath('/m/ios-publish')
    return { ok: true, message: `Đã lưu app "${saved.name}"`, app: saved }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không lưu được' }
  }
}

export async function deleteAppPresetAction(id: string): Promise<AppResult> {
  if (!enabled()) return { ok: false, message: 'Module đang tắt' }
  try {
    deleteAppPreset(id)
    revalidatePath('/m/ios-publish')
    return { ok: true, message: 'Đã xoá app' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không xoá được' }
  }
}

// ── config: notify ───────────────────────────────────────────────────────────

export async function saveNotifyAction(patch: {
  chatWebhook: string
  chatTemplate: string
}): Promise<IosResult> {
  if (!enabled()) return { ok: false, message: 'Module đang tắt' }
  try {
    setNotifyConfig({
      chatTemplate: patch.chatTemplate,
      // Blank means "unchanged" — don't wipe a stored webhook.
      ...(patch.chatWebhook.trim() ? { chatWebhook: patch.chatWebhook } : {}),
    })
    revalidatePath('/m/ios-publish')
    return { ok: true, message: 'Đã lưu notify' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không lưu được' }
  }
}

// ── publish ──────────────────────────────────────────────────────────────────

/** Resolves the app preset + its ASC credentials, erroring with a clear reason. */
function resolvePublish(input: PublishInput) {
  if (!enabled()) throw new Error('Module đang tắt')
  const app = getAppPreset(input.appId)
  if (!app) throw new Error('Chưa chọn app')
  const profile = getProfile(app.profileId)
  if (!profile) throw new Error('App chưa gắn cấu hình ASC hợp lệ')
  if (!input.groupName.trim()) throw new Error('Chưa chọn external group')
  if (!input.buildNumber.trim()) throw new Error('Chưa điền build number')
  return { app, profile }
}

export async function checkStatusAction(input: PublishInput): Promise<IosResult> {
  try {
    const { app, profile } = resolvePublish(input)
    const st = await resolveStatus(profile, {
      appName: app.name,
      groupName: input.groupName.trim(),
      buildNumber: input.buildNumber.trim(),
    })
    return {
      ok: true,
      message: `${st.externalBuildState} / ${st.processingState}`,
      status: { buildId: st.buildId, processingState: st.processingState, externalBuildState: st.externalBuildState },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Không đọc được trạng thái' }
  }
}

export async function submitBuildAction(input: PublishInput): Promise<IosResult> {
  let appName = ''
  try {
    const { app, profile } = resolvePublish(input)
    appName = app.name
    const cfg = getIosConfig()
    const outcome = await submitToExternalTesting(
      profile,
      {
        appName: app.name,
        version: input.version.trim(),
        groupName: input.groupName.trim(),
        buildNumber: input.buildNumber.trim(),
        whatsNew: input.content,
      },
      cfg.chatWebhook
        ? { webhook: cfg.chatWebhook, roomIds: app.roomIds, template: cfg.chatTemplate }
        : undefined,
    )
    recordIosLog({
      appName: app.name,
      buildNumber: input.buildNumber.trim(),
      groupName: input.groupName.trim(),
      state: `${outcome.status.externalBuildState}/${outcome.status.processingState}`,
      ok: outcome.done,
      message: outcome.message,
    })
    revalidatePath('/m/ios-publish')

    // Shipping to testers means these tasks are now public — flip them on the
    // releases board so its status stays in sync with what actually went out.
    let message = outcome.message
    if (outcome.done && isModuleEnabled('releases')) {
      // Recorded with the build they went out in, so the next publish knows
      // not to announce them again. The ticked codes first, then anything the
      // text still names (a code typed in by hand).
      const build = `${app.name} ${input.version.trim()} (${input.buildNumber.trim()})`
      const promoted = [
        ...new Set([...publishCodes(input.codes ?? [], build), ...publishBuiltTasksMentioned(input.content, build)]),
      ]
      if (promoted.length) {
        revalidatePath('/m/releases')
        message += ` · ${promoted.length} mã → đã public (${promoted.join(', ')})`
      }
    }
    return { ok: outcome.done, message, status: outcome.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Submit thất bại'
    recordIosLog({
      appName,
      buildNumber: input.buildNumber.trim(),
      groupName: input.groupName.trim(),
      state: 'error',
      ok: false,
      message,
    })
    revalidatePath('/m/ios-publish')
    return { ok: false, message }
  }
}
