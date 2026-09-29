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
import { createWorklog, deleteWorklog, loggedSpansOnDate } from '@/lib/jira/worklog'
import { listDaysOff } from '@/lib/days-off'
import { scheduleForDate } from '@/lib/quota'
import { SETTING_KEYS, getSetting, getWorkSchedule } from '@/lib/settings'
import {
  type WorklogSlice,
  DEFAULT_TZ,
  formatClock,
  formatDuration,
  formatSlices,
  placementChoices,
  sliceWorklog,
} from '@/lib/time'

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
  /**
   * Giờ bắt đầu người dùng đã chọn, phút tính từ nửa đêm.
   *
   * Chỉ có khi ngày đó có khe trống, tức là có hai chỗ đặt hợp lệ và màn hình đã
   * hỏi. Vẫn được thẩm định lại ở đây: chỉ nhận đúng một trong hai chỗ mà server
   * tự tính ra được từ Jira. Nghĩa là client chọn *chỗ nào*, chứ không đặt được
   * một giờ tuỳ ý.
   */
  startMinute?: number
}): Promise<ActionResult & { worklogIds?: string[] }> {
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

    // Những chỗ đặt nào là hợp lệ vẫn được quyết ở đây, từ chính những gì ngày
    // đó đang giữ. Entry từng bị đóng dấu 09:00 mọi lần, nên một ngày đầy vào
    // Jira thành sáu khối chồng lên nhau cùng bắt đầu một giờ. Client chỉ được
    // chọn *một trong* những chỗ đó, và chỉ khi có nhiều hơn một — xem
    // `startMinute`.
    const busy = await loggedSpansOnDate(input.date, me.accountId, tz, input.issueKey)
    // Half a day of leave moves where the other half sits on the clock: an
    // afternoon worked after a morning off starts at 13:00, not 09:00. Read
    // here rather than taken from the client — the same rule as `busy` above,
    // and for the same reason.
    const schedule = scheduleForDate(
      input.date,
      getWorkSchedule(),
      listDaysOff(input.date, input.date),
    )

    // Hai chỗ đặt hợp lệ, tính lại từ Jira. Client chỉ được chọn một trong hai
    // — một giờ tuỳ ý bị từ chối, vì đó là đường duy nhất để một entry đè lên
    // khoảng đã có người.
    const choices = placementChoices(busy, input.hours * 60, schedule)
    let at = choices.after.at
    if (input.startMinute !== undefined) {
      const picked = [choices.after, choices.gap].find(
        (c) => c && c.start === input.startMinute,
      )
      // Lệch nghĩa là ngày đó đã đổi sau lúc màn hình hỏi — thường là có người
      // vừa log thêm. Báo thay vì đặt vào chỗ gần nhất: đặt bừa đúng là lỗi
      // trùng giờ mà lựa chọn này sinh ra để tránh.
      if (!picked) {
        return {
          ok: false,
          message:
            `Không còn đặt được vào ${formatClock(input.startMinute)} — ngày ${input.date} đã thay đổi. ` +
            `Tải lại trang rồi chọn lại.`,
        }
      }
      at = picked.at
    }

    // Usually one piece. Work spanning the break becomes two, because a single
    // Jira worklog runs solid through lunch — see `sliceWorklog`.
    const slices = sliceWorklog(at, input.hours * 60, schedule)

    // Sequential, and tracking what landed: this is one POST per piece, so a
    // failure on the second leaves the first already recorded in Jira. Calling
    // that a plain failure would invite a retry that logs the first piece twice.
    const done: WorklogSlice[] = []
    // Id của từng lát vừa tạo, để còn xoá lại được.
    //
    // Một lần bấm Log có thể sinh nhiều worklog — nửa ngày vắt qua giờ nghỉ
    // thành hai lát — nên "xoá lần vừa log" phải xoá đủ số lát, không phải một
    // cái. Giữ id chứ không đi tìm lại theo giờ: tìm lại thì không phân biệt
    // được với một lát ai đó log trùng khung giờ.
    const ids: string[] = []
    try {
      for (const slice of slices) {
        const made = await createWorklog({
          issueKey: input.issueKey,
          hours: slice.minutes / 60,
          date: input.date,
          comment: input.comment,
          startMinute: slice.start,
          tz,
        })
        if (made?.id) ids.push(String(made.id))
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
        // Phần đã vào Jira cũng xoá lại được — đây chính là lúc cần nhất: dọn
        // sạch rồi log lại một lần cho gọn, thay vì phải tính phần còn thiếu.
        worklogIds: ids,
      }
    }

    // No revalidatePath here: the board is fully dynamic, so there is nothing
    // cached to expire. The caller refreshes the router instead.
    return {
      ok: true,
      message: `Đã log ${input.hours}h cho ${input.issueKey} · ${formatSlices(slices)}`,
      worklogIds: ids,
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

/**
 * Xoá những worklog vừa log, để log lại.
 *
 * Nhận id chứ không đi tìm theo giờ: một lần bấm Log có thể sinh nhiều
 * worklog — nửa ngày vắt qua giờ nghỉ thành hai lát — và tìm lại theo khung
 * giờ thì không phân biệt được với một lát ai đó log trùng.
 *
 * Xoá từng cái và đếm, không dừng ở cái đầu tiên hỏng: dừng giữa chừng để lại
 * đúng cái mớ nửa vời mà thao tác này sinh ra để dọn.
 */
export async function deleteWorklogsAction(
  issueKey: string,
  ids: string[],
): Promise<ActionResult> {
  if (!issueKey || !ids.length) return { ok: false, message: 'Không có log nào để xoá' }

  const failed: string[] = []
  for (const id of ids) {
    try {
      await deleteWorklog(issueKey, id)
    } catch {
      failed.push(id)
    }
  }

  const gone = ids.length - failed.length
  if (!gone) return { ok: false, message: `Không xoá được log của ${issueKey}` }
  if (failed.length)
    return {
      ok: false,
      partial: true,
      message: `Đã xoá ${gone}/${ids.length} log của ${issueKey}, còn ${failed.length} cái chưa xoá được — kiểm lại trên Jira trước khi log lại.`,
    }

  return {
    ok: true,
    message: `Đã xoá log vừa rồi của ${issueKey} — log lại được rồi`,
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
