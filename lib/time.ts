/**
 * Day boundaries and Jira timestamps, computed in the user's own timezone.
 *
 * Getting this wrong shifts worklogs onto the wrong day, which quietly corrupts
 * the daily report — so every conversion here is explicit rather than relying on
 * the server's local zone.
 */

export const DEFAULT_TZ = 'Asia/Saigon'

/** Offset of `tz` at instant `at`, in minutes east of UTC. */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    dtf.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return Math.round((asUtc - at.getTime()) / 60000)
}

/** `+0700` — colon-less, which is the form Jira's worklog API accepts. */
export function offsetString(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

/** Today in `tz`, as YYYY-MM-DD. */
export function todayIn(tz = DEFAULT_TZ, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/**
 * Giờ trong ngày của một mốc thời gian, theo `tz`, tính bằng phút từ nửa đêm.
 *
 * Worklog của Jira mang sẵn offset của nó (`…+0700`), có thể khác offset của
 * người đọc. Đọc qua `Intl` với `tz` nên `13:00` luôn là 13:00 ở múi giờ của
 * người dùng, chứ không phải 13:00 ở múi giờ đã ghi.
 */
export function clockMinuteIn(iso: string, tz = DEFAULT_TZ): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
  return parseClock(parts) ?? 0
}

/** Epoch ms for local midnight starting `date` (YYYY-MM-DD) in `tz`. */
export function startOfDay(date: string, tz = DEFAULT_TZ): number {
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0)
  // Two passes: the first offset may be wrong across a DST edge.
  let offset = tzOffsetMinutes(tz, new Date(guess))
  offset = tzOffsetMinutes(tz, new Date(guess - offset * 60000))
  return guess - offset * 60000
}

export function endOfDay(date: string, tz = DEFAULT_TZ): number {
  return startOfDay(date, tz) + 24 * 60 * 60 * 1000 - 1
}

/**
 * A working day: when it starts and ends, and the break in the middle.
 * All values are minutes from local midnight — `09:00` is `540`.
 */
export interface WorkSchedule {
  start: number
  end: number
  /** Null when the day has no break. */
  breakStart: number | null
  breakEnd: number | null
}

export const DEFAULT_SCHEDULE: WorkSchedule = {
  start: 9 * 60,
  end: 18 * 60,
  breakStart: 12 * 60,
  breakEnd: 13 * 60,
}

/** `09:00` → 540. Returns null on anything that is not HH:MM in range. */
export function parseClock(value: string | undefined | null): number | null {
  const m = (value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 540 → `09:00`. Minutes past the end of the day wrap into the next one. */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Minutes of actual work between the day's start and the break. */
function minutesBeforeBreak(schedule: WorkSchedule): number | null {
  const { start, breakStart, breakEnd } = schedule
  // A break that does not sit inside the working day is no break at all —
  // rather than producing a nonsensical placement, the day is treated as solid.
  if (breakStart === null || breakEnd === null) return null
  if (breakEnd <= breakStart || breakStart <= start) return null
  return breakStart - start
}

/**
 * Where on the clock the Nth minute of work falls.
 *
 * The day is a ribbon of working minutes with the break cut out of it, so on a
 * 09:00 day with a 12:00–13:00 break the 240th working minute is 14:00.
 *
 * The 180th minute — the break boundary exactly — is the one place where a
 * start and an end disagree, and both readings are right: work *finishing*
 * there stops at 12:00, work *starting* there begins at 13:00, because nobody
 * starts a task at the moment lunch does. Hence `edge`.
 *
 * Work past the end of the day keeps running rather than clamping: overtime is
 * real, and pinning entries to 18:00 would recreate the pile-up this replaces.
 */
export function workMinuteToClock(
  workedMinutes: number,
  schedule: WorkSchedule,
  edge: 'start' | 'end' = 'start',
): number {
  const before = minutesBeforeBreak(schedule)
  if (before === null) return schedule.start + workedMinutes

  const stillBeforeBreak = edge === 'end' ? workedMinutes <= before : workedMinutes < before
  if (stillBeforeBreak) return schedule.start + workedMinutes
  return schedule.breakEnd! + (workedMinutes - before)
}

/** One record as Jira will hold it: a start on the clock, and a length. */
export interface WorklogSlice {
  /** Local start time as minutes from midnight — 13:00 is 780. */
  start: number
  minutes: number
}

/**
 * The entry cut into the pieces Jira can actually store.
 *
 * Jira knows nothing about a break: a worklog is a start plus a duration and it
 * runs solid from there. So a 2h entry beginning at 11:00 occupies 11:00–13:00
 * in Jira and lands squarely on lunch — while this app, which lays entries along
 * a ribbon of *working* minutes with the break cut out, calls that same entry
 * 11:00–14:00. No single record can mean both things.
 *
 * Cutting at the break makes them agree: 11:00–12:00 and 13:00–14:00, two
 * records summing to the 2h asked for, neither one overlapping lunch. Anything
 * that does not reach the break comes back as one piece, so the ordinary case is
 * untouched.
 *
 * At most two pieces, because {@link WorkSchedule} models a single break.
 */
export function sliceWorklog(
  alreadyLoggedMinutes: number,
  entryMinutes: number,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): WorklogSlice[] {
  const start = workMinuteToClock(alreadyLoggedMinutes, schedule, 'start')
  const before = minutesBeforeBreak(schedule)

  // `>` rather than `>=` on the far end: work finishing exactly at the break
  // stops there, and must not trail a zero-length second piece.
  const crosses =
    before !== null &&
    alreadyLoggedMinutes < before &&
    alreadyLoggedMinutes + entryMinutes > before

  if (!crosses) return [{ start, minutes: entryMinutes }]

  const untilBreak = before! - alreadyLoggedMinutes
  return [
    { start, minutes: untilBreak },
    { start: schedule.breakEnd!, minutes: entryMinutes - untilBreak },
  ]
}

/** Một khoảng trên đồng hồ đã bị một worklog chiếm. Phút tính từ nửa đêm. */
export interface BusySpan {
  start: number
  minutes: number
}

/**
 * Giờ trên đồng hồ ứng với phút làm việc thứ mấy — nghịch đảo của
 * {@link workMinuteToClock}.
 *
 * Giờ nằm trong giờ nghỉ dồn về đầu giờ nghỉ, vì ở đó không có phút làm việc
 * nào. Giờ trước lúc bắt đầu ngày trả về số âm chứ không kẹp về 0, để người gọi
 * phân biệt được "sớm hơn giờ làm" với "đúng phút đầu tiên của giờ làm".
 */
export function clockToWorkMinute(clock: number, schedule: WorkSchedule): number {
  const before = minutesBeforeBreak(schedule)
  if (before === null) return clock - schedule.start
  if (clock <= schedule.breakStart!) return clock - schedule.start
  if (clock >= schedule.breakEnd!) return before + (clock - schedule.breakEnd!)
  return before
}

/** Các khoảng đã bận, đổi sang trục phút làm việc, gộp lại và bỏ phần ngoài ngày. */
function workRanges(busy: BusySpan[], schedule: WorkSchedule): Array<[number, number]> {
  const ranges = busy
    .map(
      (b) =>
        [
          Math.max(0, clockToWorkMinute(b.start, schedule)),
          clockToWorkMinute(b.start + b.minutes, schedule),
        ] as [number, number],
    )
    // Một worklog nằm hẳn trước giờ làm, hoặc gọn trong giờ nghỉ, không chiếm
    // phút làm việc nào — bỏ đi chứ không để thành khoảng rỗng hay khoảng ngược.
    .filter(([from, to]) => to > from)
    .sort((x, y) => x[0] - y[0])

  const out: Array<[number, number]> = []
  for (const range of ranges) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push(range)
  }
  return out
}

/** Một chỗ có thể đặt entry, tính theo phút làm việc thứ mấy. */
export interface Placement {
  /** Phút làm việc tính từ đầu ngày — đúng thứ {@link sliceWorklog} nhận. */
  at: number
  start: number
  end: number
}

export interface PlacementChoices {
  /** Ngay sau khoảng bận cuối cùng. Luôn có, và luôn an toàn. */
  after: Placement
  /** Khe trống đầu tiên đủ chỗ, nếu nó nằm trước `after`. */
  gap: Placement | null
}

/**
 * Hai chỗ có thể đặt một entry: nối tiếp phía sau, hoặc lấp vào khe trống.
 *
 * Trước đây chỗ đặt tính từ **tổng** số phút đã log trong ngày, nên xoá một
 * worklog ở giữa rồi log lại là **trùng giờ**: xoá lát 09:00–11:00 của một ngày
 * đã có 11:00–12:00 + 13:00–14:00 làm tổng rơi về 120, và 120 phút làm việc trỏ
 * đúng vào 11:00 — chỗ đang có người. Tính từ các khoảng đang bận thì không thể
 * ra kết quả đó.
 *
 * `gap` chỉ có khi khe trống **đủ dài** cho cả entry. Một khe 30 phút không được
 * mời để lấp 2h, vì lấp vào là đè lên khoảng bận ngay sau nó. Và khi không có
 * `gap` thì chỉ còn một chỗ đặt đúng — không có gì để hỏi, không hỏi.
 */
export function placementChoices(
  busy: BusySpan[],
  entryMinutes: number,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): PlacementChoices {
  const ranges = workRanges(busy, schedule)
  const place = (at: number): Placement => ({
    at,
    start: workMinuteToClock(at, schedule, 'start'),
    end: workMinuteToClock(at + entryMinutes, schedule, 'end'),
  })

  const after = ranges.length ? ranges[ranges.length - 1][1] : 0

  let cursor = 0
  let hole: number | null = null
  for (const [from, to] of ranges) {
    if (from - cursor >= entryMinutes) {
      hole = cursor
      break
    }
    cursor = Math.max(cursor, to)
  }

  return { after: place(after), gap: hole === null || hole === after ? null : place(hole) }
}

/** `11:00–12:00 + 13:00–14:00` — how the pieces read back to the user. */
export function formatSlices(slices: WorklogSlice[]): string {
  return slices
    .map((s) => `${formatClock(s.start)}–${formatClock(s.start + s.minutes)}`)
    .join(' + ')
}

/**
 * Builds the `started` value for a worklog.
 *
 * Format is `2026-06-17T14:40:00.000+0700`: milliseconds required, offset
 * without a colon. `Date.prototype.toISOString()` emits `…Z` and is rejected —
 * this is the single most common way worklog POSTs fail.
 *
 * `minuteOfDay` is an absolute local time, not an offset from the working day —
 * the caller decides where the entry belongs, because only it knows what else
 * has been logged.
 */
export function jiraStarted(date: string, tz = DEFAULT_TZ, minuteOfDay = 9 * 60): string {
  const base = startOfDay(date, tz)
  const offset = tzOffsetMinutes(tz, new Date(base))
  const at = base + minuteOfDay * 60000

  const local = new Date(at + offset * 60000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')

  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}${offsetString(offset)}`
  )
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is
 * earlier. Parsed as UTC midnights so no timezone or DST edge can shift the
 * count — these are calendar dates, not instants.
 */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.round((utc(to) - utc(from)) / 86400000)
}

export function hoursToSeconds(hours: number): number {
  return Math.round(hours * 3600)
}

export function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100
}

/** `6.5` → `6h 30m`, the shape Jira shows in its own UI. */
export function formatDuration(seconds: number): string {
  if (!seconds) return '0h'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return day === 0 || day === 6
}

const VI_DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

export function formatDateVi(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${VI_DAYS[day]} · ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d + delta))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`
}

/** Monday-first week containing `date`. */
export function weekOf(date: string): string[] {
  const [y, m, d] = date.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const monday = addDays(date, dow === 0 ? -6 : 1 - dow)
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}
