/**
 * Chỗ đặt worklog kế tiếp, tính từ các khoảng đang bận.
 *
 * Run: npx tsx tests/placement.mts
 *
 * Mọi case ở đây lấy từ một lần đo thật trên Jira: log 2h, log thêm 2h, xoá lát
 * đầu rồi log lại 2h — và entry mới rơi trùng giờ với cái đang có, trong khi
 * 09:00 vẫn trống. Nguyên nhân là chỗ đặt tính từ **tổng** số phút đã log, mà
 * tổng không biết chỗ nào đang trống. Nên case đầu tiên chính là case đó.
 */
import {
  type BusySpan,
  DEFAULT_SCHEDULE,
  type WorkSchedule,
  clockMinuteIn,
  clockToWorkMinute,
  formatClock,
  formatSlices,
  placementChoices,
  sliceWorklog,
  workMinuteToClock,
} from '@/lib/time'

let n = 0
let bad = 0
const eq = (a: unknown, b: unknown, m: string) => {
  n++
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++
    console.log('FAIL', m, '\n  got:', JSON.stringify(a), '\n  want:', JSON.stringify(b))
  }
}

const at = (clock: string, minutes: number): BusySpan => {
  const [h, m] = clock.split(':').map(Number)
  return { start: h * 60 + m, minutes }
}

/** Hai chỗ đặt, đọc ra như người dùng thấy trên màn hình. */
const choices = (busy: BusySpan[], hours: number, schedule: WorkSchedule = DEFAULT_SCHEDULE) => {
  const c = placementChoices(busy, hours * 60, schedule)
  const span = (p: { start: number; end: number }) =>
    `${formatClock(p.start)}–${formatClock(p.end)}`
  return { after: span(c.after), gap: c.gap ? span(c.gap) : null }
}

// ── Chính cái lỗi đã đo được ────────────────────────────────────────────────
//
// Ngày đã có 11:00–12:00 và 13:00–14:00 (phần 09:00–11:00 vừa bị xoá). Tổng còn
// 120 phút, và 120 phút làm việc trỏ vào 11:00 — chỗ đang có người.
const afterDelete = [at('11:00', 60), at('13:00', 60)]
eq(choices(afterDelete, 2), { after: '14:00–16:00', gap: '09:00–11:00' }, 'xoá lát đầu rồi log lại 2h')

// Cùng ngày đó nhưng log 3h: khe 09:00–11:00 chỉ dài 2h, không đủ chỗ. Không
// được mời lấp, vì lấp vào là đè lên 11:00.
eq(choices(afterDelete, 3), { after: '14:00–17:00', gap: null }, 'khe ngắn hơn entry thì không mời')

// Khe rộng đúng bằng entry vẫn được mời — biên, không phải trường hợp lỡ.
eq(choices(afterDelete, 2).gap, '09:00–11:00', 'khe vừa khít vẫn là một chỗ đặt')

// ── Ngày bình thường: không có gì để hỏi ────────────────────────────────────
eq(choices([], 2), { after: '09:00–11:00', gap: null }, 'ngày trắng')
eq(choices([at('09:00', 120)], 2), { after: '11:00–14:00', gap: null }, 'nối tiếp, vắt qua nghỉ')
// Bốn tiếng buổi sáng Jira giữ thành 09:00–12:00 + 13:00–14:00. Hai record liền
// nhau trên trục phút làm việc, nên không được sinh ra khe trống ảo ở giờ nghỉ.
eq(
  choices([at('09:00', 180), at('13:00', 60)], 1),
  { after: '14:00–15:00', gap: null },
  'entry vắt qua nghỉ không tạo khe ảo',
)

// ── Cái gì tính là khe ──────────────────────────────────────────────────────
// Bắt đầu muộn: log 10:00–11:00 để trống đúng một giờ đầu ngày.
eq(choices([at('10:00', 60)], 1), { after: '11:00–12:00', gap: '09:00–10:00' }, 'trống giờ đầu ngày')
// Worklog trùng nhau (đã từng xảy ra, chính vì lỗi trên) phải gộp, không cộng
// dồn: 09:00–11:00 và 10:00–12:00 là ba giờ đồng hồ, không phải bốn. Ba giờ đó
// đầy đúng buổi sáng, nên chỗ nối tiếp là 13:00 — chứ không ai bắt đầu làm lúc
// 12:00, đúng lúc giờ nghỉ bắt đầu.
eq(
  choices([at('09:00', 120), at('10:00', 120)], 1),
  { after: '13:00–14:00', gap: null },
  'hai worklog đè nhau thì gộp, không cộng',
)
// Ngoài giờ làm: một worklog 07:00–08:00 không chiếm phút làm việc nào.
eq(choices([at('07:00', 60)], 1), { after: '09:00–10:00', gap: null }, 'worklog trước giờ làm')
// Một phần trước giờ làm: 08:00–10:00 chỉ chiếm 09:00–10:00.
eq(choices([at('08:00', 120)], 1), { after: '10:00–11:00', gap: null }, 'worklog vắt qua đầu ngày')
// Gọn trong giờ nghỉ: không phải phút làm việc, nhưng cũng không được làm mất
// khoảng bận nào khác.
eq(choices([at('12:15', 30)], 1), { after: '09:00–10:00', gap: null }, 'worklog nằm trong giờ nghỉ')
// Một ngày 8h đã log đủ, đúng như Jira giữ nó: hai record, cắt ở giờ nghỉ. Giờ
// thứ chín là tăng ca và chạy tiếp qua 18:00 chứ không bị kẹp lại ở đó.
eq(
  choices([at('09:00', 180), at('13:00', 300)], 1),
  { after: '18:00–19:00', gap: null },
  'nối sau một ngày đầy',
)

// ── Ngày nghỉ nửa buổi ─────────────────────────────────────────────────────
// Nghỉ sáng: buổi làm bắt đầu 13:00 và không còn giờ nghỉ nào ở giữa.
const afternoon: WorkSchedule = { start: 13 * 60, end: 18 * 60, breakStart: null, breakEnd: null }
eq(choices([], 2, afternoon), { after: '13:00–15:00', gap: null }, 'nghỉ sáng, ngày trắng')
eq(
  choices([at('15:00', 60)], 2, afternoon),
  { after: '16:00–18:00', gap: '13:00–15:00' },
  'nghỉ sáng, có khe đầu buổi',
)

// ── `at` phải khớp đúng thứ sliceWorklog nhận ──────────────────────────────
// Đây là mắt nối giữa hai hàm: `Placement.at` là phút làm việc, và server cắt
// lát từ chính con số đó. Lệch một chỗ ở đây là lệch giờ ghi vào Jira.
{
  const c = placementChoices(afterDelete, 120, DEFAULT_SCHEDULE)
  eq(formatSlices(sliceWorklog(c.after.at, 120)), '14:00–16:00', 'at của `after` cắt ra đúng giờ')
  eq(formatSlices(sliceWorklog(c.gap!.at, 120)), '09:00–11:00', 'at của `gap` cắt ra đúng giờ')
}

// ── clockToWorkMinute ↔ workMinuteToClock ──────────────────────────────────
for (const clock of [540, 600, 719, 720, 780, 840, 1080]) {
  eq(
    workMinuteToClock(clockToWorkMinute(clock, DEFAULT_SCHEDULE), DEFAULT_SCHEDULE, 'start'),
    // 12:00 là chỗ duy nhất hai chiều không khớp, và đúng ra là không khớp:
    // không ai *bắt đầu* làm lúc giờ nghỉ bắt đầu, nên chiều về trả 13:00.
    clock === 720 ? 780 : clock,
    `vòng lại ${formatClock(clock)}`,
  )
}

// ── Đọc giờ từ worklog của Jira ────────────────────────────────────────────
// Worklog mang offset của nó. Đọc theo múi giờ người dùng, không theo chuỗi.
eq(clockMinuteIn('2026-09-25T13:00:00.000+0700', 'Asia/Saigon'), 780, 'giờ Sài Gòn, offset trùng')
eq(clockMinuteIn('2026-09-25T13:00:00.000+0000', 'Asia/Saigon'), 20 * 60, 'giờ UTC đọc sang +07')

console.log(bad ? `\n${bad}/${n} FAILED` : `${n} passed`)
process.exit(bad ? 1 : 0)
