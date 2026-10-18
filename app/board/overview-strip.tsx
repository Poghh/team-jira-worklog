import Link from "next/link";

import type { PointsSummary } from "@/lib/jira/types";
import { type QuotaRules, quotaForDate } from "@/lib/quota";
import { formatDuration } from "@/lib/time";

import { LinkPending } from "../link-pending";
import { DatePicker } from "./date-picker";
import { DayOffButton } from "./day-off-button";

/**
 * Tổng quan ngày và sprint, nằm **ngang** trên đầu bảng.
 *
 * Trước đây đây là một cột dọc 296px bên phải, chở bốn thẻ: giờ hôm nay, point
 * sprint, danh sách ngày, và ngày chưa đủ. Cột đó phải nhường chỗ cho panel chi
 * tiết — không thể có hai cột phải — nên cùng lượng thông tin xoay ngang: một
 * dải cao ~64px thay cho một cột dài 900px.
 *
 * Dải ngày là phần lãi rõ nhất: bản dọc phải cuộn mới thấy hết 14 ngày, bản
 * ngang thì cả sprint nằm gọn trong một hàng. Cái mất là con số giờ ghi trên
 * từng ngày — cột hẹp quá — nên nó lùi vào tooltip.
 */
export function OverviewStrip({
  date,
  dateLabel,
  isToday,
  sprints,
  sprintId,
  sprintName,
  start,
  end,
  today,
  secondsByDate,
  rules,
  baseQuery,
  quotaHours,
  points,
  showPoints,
}: {
  date: string;
  dateLabel: string;
  isToday: boolean;
  sprints: Parameters<typeof DatePicker>[0]["sprints"];
  sprintId: number | null;
  /** Null khi bảng không đứng trong sprint nào — dải ngày lùi về tuần. */
  sprintName: string | null;
  start: string | null;
  end: string | null;
  today: string;
  secondsByDate: Record<string, number>;
  rules: QuotaRules;
  /** Bộ lọc hiện tại trừ `date`, để link ngày không làm rơi sprint. */
  baseQuery: string;
  quotaHours: number;
  points: PointsSummary | null;
  showPoints: boolean;
}) {
  const hrefFor = (d: string) => `/?${baseQuery ? baseQuery + "&" : ""}date=${d}`;
  const quotaFor = (d: string) => quotaForDate(d, rules);

  const days = start && end ? daysBetween(start, end) : [];
  const elapsed = days.filter((d) => d <= today);
  const workdays = elapsed.filter((d) => quotaFor(d) > 0);
  const shortDays = workdays.filter(
    (d) => (secondsByDate[d] ?? 0) < quotaFor(d) * 3600,
  );
  const offDays = days.filter((d) => rules.daysOff[d]);
  const totalSeconds = days.reduce((n, d) => n + (secondsByDate[d] ?? 0), 0);
  const expectedSeconds = workdays.reduce((n, d) => n + quotaFor(d) * 3600, 0);

  const todaySeconds = secondsByDate[date] ?? 0;
  const todayQuota = quotaHours * 3600;
  const missingToday = Math.max(0, todayQuota - todaySeconds);

  return (
    <section className="relative z-[5] mb-3 flex flex-wrap items-stretch rounded-[9px] border border-line bg-surface">
      {/* Không bọc trong <Seg label>: `DatePicker` tự in nhãn "NGÀY ĐANG LOG"
          của nó, nên lồng thêm một nhãn nữa là chữ đó hiện hai lần. */}
      <div className="flex items-center border-r border-line px-3 py-2">
        <DatePicker
          date={date}
          label={dateLabel}
          sprints={sprints}
          sprintId={sprintId}
          isToday={isToday}
          today={today}
        />
      </div>

      <Seg label="Giờ hôm nay">
        <span className="flex items-baseline gap-1.5">
          <b className="font-mono text-[19px] font-medium tracking-[-0.02em] tabular">
            {todaySeconds ? (todaySeconds / 3600).toFixed(
              todaySeconds % 3600 === 0 ? 0 : 1,
            ) : 0}
          </b>
          <span className="font-mono text-[12px] text-ink-3">
            / {quotaHours}h
          </span>
          {quotaHours > 0 &&
            (missingToday > 0 ? (
              <span className="rounded-full bg-warn-soft px-2 py-[2px] text-[11px] font-medium text-warn">
                thiếu {formatDuration(missingToday)}
              </span>
            ) : (
              <span className="rounded-full bg-good-soft px-2 py-[2px] text-[11px] font-medium text-good">
                đủ ✓
              </span>
            ))}
        </span>
      </Seg>

      {showPoints && points && sprintName && (
        <Seg label={`Point · ${sprintName}`}>
          <span className="flex items-baseline gap-1.5">
            <b className="font-mono text-[19px] font-medium tracking-[-0.02em] tabular">
              {points.donePoints}
            </b>
            <span className="font-mono text-[12px] text-ink-3">
              / {points.points} xong
            </span>
            <span className="rounded-[4px] border border-line px-1.5 py-px font-mono text-[10.5px] text-ink-3">
              {points.tasks} task
            </span>
          </span>
        </Seg>
      )}

      {workdays.length > 0 && (
        <Seg label="Cả sprint">
          <span className="flex items-baseline gap-1.5">
            <b className="font-mono text-[19px] font-medium tracking-[-0.02em] tabular">
              {formatDuration(totalSeconds)}
            </b>
            <span className="font-mono text-[12px] text-ink-3">
              / {formatDuration(expectedSeconds)} ·{" "}
              {workdays.length - shortDays.length}/{workdays.length} ngày đủ
            </span>
          </span>
        </Seg>
      )}

      {/* `min-w-[460px]` + `flex-wrap` của thẻ cha: còn chỗ thì dải ngày nằm cùng
          hàng với mấy ô thống kê; hết chỗ thì nó rơi xuống thành một hàng riêng
          chạy hết bề ngang, thay vì bị bóp còn 13px một cột và nhãn ngày chồng
          lên nhau. */}
      {days.length > 0 && (
        <div className="flex min-w-[460px] flex-1 items-end gap-[3px] border-l border-line px-3 py-2">
          {days.map((d) => (
            <DayCell
              key={d}
              date={d}
              href={hrefFor(d)}
              seconds={secondsByDate[d] ?? 0}
              quota={quotaFor(d)}
              dayOff={rules.daysOff[d] ?? null}
              selected={d === date}
              isToday={d === today}
              future={d > today}
            />
          ))}
        </div>
      )}

      {(shortDays.length > 0 || offDays.length > 0) && (
        <Seg label="Ngày chưa đủ" className="border-l border-line">
          <span className="flex flex-wrap items-center gap-1">
            {shortDays.slice(0, 3).map((d) => (
              <Link
                key={d}
                href={hrefFor(d)}
                className="rounded-[4px] border border-warn bg-warn-soft px-1.5 py-px font-mono text-[10.5px] text-warn hover:brightness-95"
              >
                {label(d)}
              </Link>
            ))}
            {shortDays.length > 3 && (
              <span className="font-mono text-[10.5px] text-ink-3">
                +{shortDays.length - 3}
              </span>
            )}
            {shortDays.length === 0 && (
              <span className="font-mono text-[10.5px] text-good">đủ hết ✓</span>
            )}
          </span>
          {offDays.length > 0 && (
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-ink-3">
              {offDays.length} ngày nghỉ · không tính
            </span>
          )}
        </Seg>
      )}
    </section>
  );
}

function Seg({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "flex shrink-0 flex-col justify-center gap-1 border-r border-line px-3 py-2 last:border-r-0 " +
        className
      }
    >
      <span className="font-mono text-[9px] uppercase tracking-[0.07em] text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Một ngày trong dải: cột dọc cao bằng tỉ lệ giờ đã log trên hạn mức.
 *
 * Cột là một link sang ngày đó, còn nút đánh dấu nghỉ nổi lên khi rê chuột —
 * cùng cách bản dọc làm, chỉ xoay chiều. Ngày nghỉ gạch chéo và hạn mức về 0,
 * nên nó không bao giờ bị đếm là "thiếu giờ": đó là cả điểm của việc đánh dấu.
 */
function DayCell({
  date,
  href,
  seconds,
  quota,
  dayOff,
  selected,
  isToday,
  future,
}: {
  date: string;
  href: string;
  seconds: number;
  quota: number;
  dayOff: "full" | "morning" | "afternoon" | null;
  selected: boolean;
  isToday: boolean;
  future: boolean;
}) {
  const pct = quota > 0 ? Math.min(100, (seconds / (quota * 3600)) * 100) : 0;
  const short = quota > 0 && !future && seconds < quota * 3600;
  const hours = seconds ? (seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1) : "—";

  return (
    <span className="group relative flex min-w-0 flex-1 flex-col items-center gap-1">
      {/* Số giờ đứng ngay trên cột.
          Trước đây chiều cao cột là thứ **duy nhất** nói ngày đó log bao nhiêu,
          mà cột chỉ cho biết tỉ lệ: 6/8 và 3/4 cao bằng nhau, và một ngày
          nghỉ hạn mức 0 thì không có cột nào để đọc. Con số thật phải nằm
          trên dải, không phải trong tooltip — tooltip đòi rê chuột qua từng
          ngày một, tức là đúng việc mà dải này sinh ra để khỏi phải làm. */}
      <span
        className={
          "font-mono text-[8.5px] leading-none tabular " +
          (seconds === 0
            ? "text-ink-3 opacity-50"
            : short
              ? "text-warn"
              : "text-accent-ink")
        }
      >
        {hours}
      </span>

      <Link
        href={href}
        title={
          `${label(date)} · ${hours}h / ${quota}h` +
          (dayOff ? " · ngày nghỉ, không tính" : short ? " · thiếu giờ" : "")
        }
        className={
          "flex h-[22px] w-full items-end overflow-hidden rounded-[3px] " +
          (dayOff
            ? "bg-[repeating-linear-gradient(45deg,var(--color-surface-2),var(--color-surface-2)_3px,transparent_3px,transparent_6px)]"
            : "bg-surface-2") +
          (selected ? " outline outline-2 outline-offset-1 outline-accent" : "")
        }
      >
        {pct > 0 && (
          <i
            style={{ height: `${pct}%` }}
            className={
              "block w-full rounded-[3px] " + (short ? "bg-warn" : "bg-accent")
            }
          />
        )}
      </Link>

      {/* Thứ và ngày/tháng **hai dòng**, không phải một.
          Một dòng `T6 16/10` cần 41px, mà ở 1800px mỗi cột chỉ rộng 36.4px —
          đo được cả 15 cột đều tràn, chữ của ngày này đè sang ngày bên cạnh.
          Tách đôi thì dòng rộng nhất còn 5 ký tự. */}
      <span
        className={
          "flex flex-col items-center whitespace-nowrap font-mono text-[8.5px] leading-tight " +
          (selected
            ? "font-bold text-accent-ink"
            : isToday
              ? "text-accent"
              : "text-ink-3")
        }
      >
        <span>
          <LinkPending className="mr-0.5 align-[-1px]" />
          {weekday(date)}
        </span>
        <span className={selected || isToday ? "" : "opacity-80"}>
          {date.slice(8, 10)}/{date.slice(5, 7)}
        </span>
      </span>

      <span className="absolute -top-1.5 right-0">
        <DayOffButton date={date} current={dayOff} label={label(date)} />
      </span>
    </span>
  );
}

/**
 * `2026-10-16` → `T6 16/10`.
 *
 * Có tháng chứ không chỉ ngày: dải này chạy suốt một sprint, mà sprint hay vắt
 * qua hai tháng — `T6 30` rồi `T7 01` thì số 01 đọc ra là ngày nào phải suy từ
 * cái trước nó.
 */
function label(d: string): string {
  return `${weekday(d)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

/** `2026-10-16` → `T6`. */
function weekday(d: string): string {
  return ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][
    new Date(`${d}T00:00:00`).getDay()
  ];
}

/** Mọi ngày từ `start` tới `end`, kể cả hai đầu. */
function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
