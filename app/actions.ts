'use server'

import { getMyself } from '@/lib/jira/client'
import { generateTask, pointRulesText } from '@/lib/ai/gemini'
import {
  attachToSprint,
  transitionIssue,
  updateDates,
  updateStoryPoints,
  updateDescription,
  updateSummary,
} from '@/lib/jira/issues'
import { createWorklog, loggedMinutesOnDate } from '@/lib/jira/worklog'
import { listDaysOff } from '@/lib/days-off'
import { scheduleForDate } from '@/lib/quota'
import { SETTING_KEYS, getSetting, getWorkSchedule } from '@/lib/settings'
import { type WorklogSlice, DEFAULT_TZ, formatDuration, formatSlices, sliceWorklog } from '@/lib/time'

export interface ActionResult {
  ok: boolean
  message: string
  /**
   * Something reached Jira despite `ok` being false — a write made of several
   * calls that failed partway. The caller must refresh anyway, or the screen
   * keeps showing a total that is already stale.
   */
  partial?: boolean
}

/**
 * Logs work on one issue. The minimum step is enforced here rather than only in
 * the UI, because the value arrives from a client component and could be
 * anything. Over-budget hours are deliberately NOT blocked — story points are an
 * estimate, and the app only ever warns about them.
 */
export async function logWorkAction(input: {
  issueKey: string
  hours: number
  date: string
  comment?: string
}): Promise<ActionResult> {
  const step = Number(getSetting(SETTING_KEYS.logStepHours) ?? '0.5') || 0.5

  if (!Number.isFinite(input.hours) || input.hours <= 0) {
    return { ok: false, message: 'Số giờ không hợp lệ' }
  }
  if (input.hours < step) {
    return { ok: false, message: `Tối thiểu ${step}h mỗi lần log` }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, message: 'Ngày không hợp lệ' }
  }

  try {
    const me = await getMyself()
    const tz = me.timeZone ?? DEFAULT_TZ

    // Where the entry lands is decided here, from what the day already holds —
    // never by the client. Entries used to be stamped 09:00 every time, so a
    // full day arrived in Jira as six overlapping blocks all starting together.
    const already = await loggedMinutesOnDate(input.date, me.accountId, tz, input.issueKey)
    // Usually one piece. Work spanning the break becomes two, because a single
    // Jira worklog runs solid through lunch — see `sliceWorklog`.
    // Half a day of leave moves where the other half sits on the clock: an
    // afternoon worked after a morning off starts at 13:00, not 09:00. Read
    // here rather than taken from the client — the same rule as `already`
    // above, and for the same reason.
    const schedule = scheduleForDate(
      input.date,
      getWorkSchedule(),
      listDaysOff(input.date, input.date),
    )
    const slices = sliceWorklog(already, input.hours * 60, schedule)

    // Sequential, and tracking what landed: this is one POST per piece, so a
    // failure on the second leaves the first already recorded in Jira. Calling
    // that a plain failure would invite a retry that logs the first piece twice.
    const done: WorklogSlice[] = []
    try {
      for (const slice of slices) {
        await createWorklog({
          issueKey: input.issueKey,
          hours: slice.minutes / 60,
          date: input.date,
          comment: input.comment,
          startMinute: slice.start,
          tz,
        })
        done.push(slice)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Không log được'
      if (!done.length) return { ok: false, message: reason }

      // Both figures, named separately. "Log thất bại" would be a lie — part of
      // it is in Jira — and "đã log 1h" alone leaves the user to work out what
      // is still missing. The retry amount is spelled out because the obvious
      // move, logging the original figure again, is the one that double-counts.
      const failed = slices.slice(done.length)
      const landed = done.reduce((n, s) => n + s.minutes, 0) * 60
      const lost = failed.reduce((n, s) => n + s.minutes, 0) * 60

      return {
        ok: false,
        partial: true,
        message:
          `${formatDuration(landed)} (${formatSlices(done)}) đã được log, ` +
          `nhưng xảy ra lỗi khi log ${formatDuration(lost)} (${formatSlices(failed)}): ${reason} ` +
          `— log lại ${formatDuration(lost)} thôi, đừng log lại ${input.hours}h.`,
      }
    }

    // No revalidatePath here: the board is fully dynamic, so there is nothing
    // cached to expire. The caller refreshes the router instead.
    return {
      ok: true,
      message: `Đã log ${input.hours}h cho ${input.issueKey} · ${formatSlices(slices)}`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không log được',
    }
  }
}

/**
 * Writes a story point estimate. Values outside the team's 1–3 scale are
 * rejected for subtasks but allowed on a parent, whose value is the sum of its
 * children and so routinely exceeds 3.
 */
export async function setStoryPointsAction(
  issueKey: string,
  points: number | null,
): Promise<ActionResult> {
  if (points !== null && (!Number.isFinite(points) || points < 0 || points > 999)) {
    return { ok: false, message: 'Story point không hợp lệ' }
  }

  try {
    await updateStoryPoints(issueKey, points)
    return {
      ok: true,
      message: points === null ? `Đã xoá point ${issueKey}` : `${issueKey} → ${points} SP`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không đổi được story point',
    }
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Writes start and/or due date on an existing issue.
 *
 * Both arrive as `undefined` when untouched and `null` when cleared — the two
 * mean different things to Jira, so they must survive the trip separately. The
 * ordering rule is checked here because the popover can send one date while the
 * other stays as it is on the issue; the caller passes both for that reason.
 */
export async function setDatesAction(
  issueKey: string,
  dates: { startDate?: string | null; dueDate?: string | null },
): Promise<ActionResult> {
  for (const value of [dates.startDate, dates.dueDate]) {
    if (value != null && !ISO_DATE.test(value)) return { ok: false, message: 'Ngày không hợp lệ' }
  }
  if (dates.startDate && dates.dueDate && dates.dueDate < dates.startDate) {
    return { ok: false, message: 'Due date không được sớm hơn start date' }
  }

  try {
    await updateDates(issueKey, dates)
    return { ok: true, message: `Đã cập nhật ngày cho ${issueKey}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không đổi được ngày',
    }
  }
}

/**
 * Moves a parent task into the sprint and onto the team's board, from the
 * board's "ngoài sprint" block.
 *
 * The children show here regardless, but leaving the parent sprintless and
 * unlabelled keeps it missing from Jira's own board and from the sprint report —
 * so the fix is offered where the problem is visible.
 */
export async function setSprintAction(
  issueKey: string,
  sprintId: number,
): Promise<ActionResult> {
  if (!Number.isInteger(sprintId) || sprintId <= 0) {
    return { ok: false, message: 'Sprint không hợp lệ' }
  }

  try {
    const { labelAdded } = await attachToSprint(issueKey, sprintId)
    return {
      ok: true,
      message: labelAdded
        ? `Đã đưa ${issueKey} vào sprint và gắn label ${labelAdded}`
        : `Đã đưa ${issueKey} vào sprint`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không gán được sprint',
    }
  }
}

/**
 * Ghi lại mô tả issue — chỉ chạy khi người dùng bấm Lưu.
 */
export async function updateDescriptionAction(
  issueKey: string,
  description: string,
  dod: string,
): Promise<ActionResult> {
  try {
    await updateDescription(issueKey, description, dod)
    return { ok: true, message: `Đã lưu mô tả ${issueKey}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không lưu được mô tả',
    }
  }
}

/**
 * Nhờ Gemini viết lại mô tả cho một tiêu đề đã đổi.
 *
 * Không ghi gì cả — chỉ trả chữ về để người dùng đọc, sửa, rồi mới bấm Lưu.
 * Đổi tiêu đề xong mà mô tả tự nhảy theo là thứ không ai muốn; đề xuất thì có.
 *
 * Dùng chính `generateTask` của màn Task mới, nên văn phong và luật point giống
 * hệt, và tiêu đề đóng vai "ý tưởng" — đó đúng là thứ vừa thay đổi.
 */
export async function regenerateDescriptionAction(
  title: string,
  parentSummary?: string,
): Promise<ActionResult & { description?: string; dod?: string }> {
  if (!title.trim()) return { ok: false, message: 'Chưa có tiêu đề để dựa vào' }
  try {
    const data = await generateTask(title, {
      pointRules: pointRulesText(),
      parentSummary,
    })
    return {
      ok: true,
      message: `Đã sinh lại mô tả · ${data.model}`,
      description: data.description,
      dod: data.dod,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Gemini lỗi' }
  }
}

/**
 * Đổi tiêu đề issue — chỉ chạy khi người dùng bấm Lưu trên modal chi tiết.
 *
 * Không có đường nào gọi tự động vào đây, cùng luật với `transitionAction`:
 * app không bao giờ tự ghi vào Jira thay người dùng.
 */
export async function updateSummaryAction(
  issueKey: string,
  summary: string,
): Promise<ActionResult> {
  try {
    await updateSummary(issueKey, summary)
    return { ok: true, message: `Đã đổi tiêu đề ${issueKey}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không đổi được tiêu đề',
    }
  }
}

export async function transitionAction(
  issueKey: string,
  transitionId: string,
  toStatusName: string,
): Promise<ActionResult> {
  try {
    await transitionIssue(issueKey, transitionId)
    return { ok: true, message: `${issueKey} → ${toStatusName}` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Không đổi được trạng thái',
    }
  }
}
