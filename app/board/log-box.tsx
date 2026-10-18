"use client";

import { useEffect, useState, useTransition } from "react";

import { logWorkAction } from "@/app/actions";
import { logDatePastDue } from "@/lib/jira/types";
import type { DayOffKind } from "@/lib/quota";
import {
  type BusySpan,
  DEFAULT_SCHEDULE,
  type Placement,
  type WorkSchedule,
  formatClock,
  formatSlices,
  placementChoices,
  sliceWorklog,
} from "@/lib/time";

import { Spinner } from "../spinner";
import { useNav } from "./navigation";
import { Popover, PopoverTitle } from "./popover";

/**
 * Ghi giờ cho một task, nằm gọn ở ô cuối của hàng.
 *
 * Tách khỏi hàng vì phép tính "entry này rơi vào khung giờ nào" dài hơn cả phần
 * vẽ, và nó phải **một bản** — server dùng đúng hàm này để đặt worklog, nên hai
 * bản lệch nhau là màn hình hứa một đằng Jira ghi một nẻo.
 */
export function InlineLog({
  issueKey,
  date,
  dateLabel,
  isToday,
  dueDate,
  statusName,
  step,
  presets,
  dayBusy = [],
  schedule = DEFAULT_SCHEDULE,
  dayOff = null,
}: {
  issueKey: string;
  date: string;
  dateLabel: string;
  isToday: boolean;
  dueDate: string | null;
  statusName: string;
  step: number;
  presets: number[];
  /**
   * Các khoảng giờ đã bận trong cả ngày — thứ quyết định entry này rơi vào đâu.
   *
   * Là khoảng chứ không phải tổng: xoá một worklog giữa ngày rồi log lại, tổng
   * không nói được chỗ vừa trống ra nằm ở đâu.
   */
  dayBusy?: BusySpan[];
  schedule?: WorkSchedule;
  dayOff?: DayOffKind | null;
}) {
  const [hours, setHours] = useState(step);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    /** Bản ngắn của tin báo, cho ô hẹp — xem `logWorkAction`. */
    slots?: string;
  } | null>(null);
  /**
   * Chỗ đặt người dùng đã chọn, khi ngày có nhiều hơn một chỗ đặt đúng.
   *
   * Giữ lựa chọn thay vì hỏi lại ở mỗi lần bấm, để còn xem trước được khung giờ
   * đã chọn ngay trên hàng. Xoá sau mỗi lần log xong: ngày đã đổi, câu hỏi cũ
   * không còn nói về ngày đó nữa.
   */
  const [pick, setPick] = useState<"gap" | "after" | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const { refresh } = useNav();

  function submit(where: Placement) {
    setAskOpen(false);
    startTransition(async () => {
      const res = await logWorkAction({
        issueKey,
        hours,
        date,
        comment,
        // Chỉ ghim giờ khi màn hình thật sự đã hỏi. Ngày chỉ có một chỗ đặt thì
        // để server tự tính — ghim một con số client đọc được từ dữ liệu có thể
        // đã cũ chỉ tạo ra lỗi "tải lại trang" cho một câu không có gì để chọn.
        startMinute: choices.gap ? where.start : undefined,
      });
      setResult(res);
      if (res.ok) {
        setComment("");
        setPick(null);
      }
      // `partial` nghĩa là một phần đã tới Jira — số trên màn hình đã sai rồi,
      // nên vẫn phải refresh dù action báo thất bại.
      if (res.ok || res.partial) refresh();
    });
  }

  const pastDue = logDatePastDue(dueDate, date, statusName);
  /**
   * `CN · 18/10/2026` → `18/10`. Nhãn đầy đủ vẫn đứng ở đầu khối và ở dải tổng
   * quan; nhắc lại cả năm ngay trên mặt nút chỉ làm nút dài ra mà không nói
   * thêm gì — ngày đang log đã hiện to ở hai chỗ khác trên cùng màn hình.
   */
  const shortDate = `${date.slice(8, 10)}/${date.slice(5, 7)}`;

  // Chỗ entry sẽ rơi vào, tính bằng đúng hàm server dùng. Hiện trước khi bấm,
  // vì "log 6h" đọc ra thành 11:00–18:00 là khác biệt giữa tin bảng chấm công
  // và phải mở Jira kiểm lại.
  const choices = placementChoices(dayBusy, hours * 60, schedule);
  /**
   * Chỗ đã chốt cho lần log này. `null` nghĩa là còn phải hỏi.
   *
   * Không có khe trống thì chỉ có một chỗ đặt, không hỏi gì — đó là mọi ngày
   * bình thường. Có khe trống (thường vì vừa xoá một worklog) thì có hai chỗ
   * đúng theo hai nghĩa khác nhau, và không có chỗ nào app được tự chọn thay:
   * lấp lại chỗ vừa xoá, hay log tiếp sau phần đã có.
   */
  const chosen: Placement | null = !choices.gap
    ? choices.after
    : pick === "gap"
      ? choices.gap
      : pick === "after"
        ? choices.after
        : null;
  const slot = chosen ?? choices.after;
  const slices = sliceWorklog(slot.at, hours * 60, schedule);
  const offNote =
    dayOff === "morning"
      ? `Ngày này nghỉ sáng — buổi làm bắt đầu lúc ${formatClock(schedule.start)}.\n`
      : dayOff === "afternoon"
        ? `Ngày này nghỉ chiều — buổi làm kết thúc lúc ${formatClock(schedule.end)}.\n`
        : "";
  /** Đang lấp khe trống, chứ không phải xếp nối tiếp như thường lệ. */
  const filling = Boolean(choices.gap) && pick === "gap";
  /**
   * Chỗ đặt này là một lựa chọn, và lựa chọn kia là gì.
   *
   * Chỉ nói khi thật sự có hai chỗ. Ngày bình thường chỉ có một chỗ đặt đúng,
   * và mời người đọc cân nhắc một lựa chọn không tồn tại là tự tạo nghi ngờ.
   */
  const placeNote = !choices.gap
    ? ""
    : filling
      ? `Lấp vào khe trống lúc ${formatClock(choices.gap.start)}.\n`
      : `Nối sau phần đã log — khe trống lúc ${formatClock(choices.gap.start)} vẫn để nguyên.\n`;
  const slotTitle =
    offNote +
    placeNote +
    (slices.length > 1
      ? `Vắt qua giờ nghỉ — Jira sẽ nhận ${slices.length} entry: ${formatSlices(slices)}`
      : `Worklog sẽ bắt đầu lúc ${formatClock(slot.start)}` +
        (filling
          ? "."
          : " — xếp nối tiếp" +
            (offNote ? " trong buổi." : " trong ngày, nhảy qua giờ nghỉ")));

  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      <HourStepper
        hours={hours}
        step={step}
        presets={presets}
        onChange={setHours}
      />

      {/* Chỉ giờ **bắt đầu**, khoảng đầy đủ nằm trong tooltip.
          Cả khoảng `09:00–09:30` rộng ~68px, và ô ghi giờ chỉ có 236px —
          thêm 30px đó là cụm xuống hai dòng, đo được hàng cao 71px thay vì 45.
          Giờ bắt đầu mới là thứ người ta liếc xem có đúng chỗ không; nửa sau
          suy ra được từ số giờ đang chọn. */}
      <span className="relative font-mono text-[10.5px] tabular text-ink-3">
        {/* Không có khe trống: một chỗ đặt duy nhất, hiện thẳng. Có khe trống
            thì bấm được, vì lúc đó khung giờ là một lựa chọn. */}
        {!choices.gap ? (
          <span title={slotTitle}>
            {formatClock(slot.start)}
            {/* Chỗ cắt không nhìn thấy trong chuỗi trên — 11:00–14:00 đọc y hệt
                nhau dù là một entry hay hai — nên nó được đánh dấu. */}
            {slices.length > 1 && (
              <sup className="ml-px text-ot" title={slotTitle}>
                ×2
              </sup>
            )}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAskOpen((v) => !v)}
            title={
              chosen
                ? `${slotTitle}\n\nBấm để đổi sang "${
                    filling
                      ? `log tiếp sau, từ ${formatClock(choices.after.start)}`
                      : `log từ ${formatClock(choices.gap.start)}`
                  }".`
                : `Ngày này có khe trống lúc ${formatClock(choices.gap.start)} — bấm để chọn log vào đâu.`
            }
            className={
              "rounded-[4px] border px-1 py-px " +
              (chosen
                ? "border-line text-ink-2 hover:border-line-strong"
                : "border-warn bg-warn-soft font-semibold text-warn")
            }
          >
            {chosen ? formatClock(slot.start) : "chọn"}
            <span className="ml-0.5 opacity-70">▾</span>
            {chosen && slices.length > 1 && <sup className="ml-px text-ot">×2</sup>}
          </button>
        )}
        {askOpen && choices.gap && (
          <PlacePicker
            hours={hours}
            dateLabel={dateLabel}
            gap={choices.gap}
            after={choices.after}
            schedule={schedule}
            onClose={() => setAskOpen(false)}
            onPick={(which) => {
              setPick(which);
              setAskOpen(false);
            }}
          />
        )}
      </span>

      <NoteButton value={comment} onChange={setComment} issueKey={issueKey} />

      <button
        type="button"
        // Chưa chốt chỗ đặt thì bấm Log là mở câu hỏi, không phải log. Đây là
        // chỗ duy nhất app không được tự quyết: hai chỗ đặt đều đúng, chỉ người
        // log mới biết mình muốn cái nào.
        onClick={() => (chosen ? submit(chosen) : setAskOpen(true))}
        disabled={pending}
        title={
          (chosen
            ? `Ghi ${hours}h vào ${dateLabel}, ${formatSlices(slices)}`
            : `Ngày này có khe trống — bấm để chọn ghi ${hours}h vào đâu`) +
          // Nói trước khi entry tồn tại, không phải sau: lúc rẻ nhất để nhận ra
          // sai ngày là trước khi bấm.
          (pastDue
            ? `\n\n⚠ ${issueKey} đã Done với due date ${dueDate} — ${dateLabel} nằm sau đó.`
            : "")
        }
        className={
          "h-[26px] rounded-md px-2.5 text-[12px] font-medium text-white disabled:opacity-60 " +
          (isToday ? "bg-accent hover:bg-accent-2" : "bg-ot hover:brightness-110")
        }
      >
        {pending ? (
          <Spinner className="size-3 border-white/40 border-t-white" />
        ) : (
          "Log"
        )}
      </button>

      {/* Kết quả nằm ngay dưới cụm, chiếm trọn chiều ngang của ô nhờ
          `basis-full` — không đẩy hàng nào khác đi.
          Báo thành công gói trong **một dòng**: ô này rộng 236px, mà câu đầy
          đủ "Đã log 4h cho VT-3784 · 09:00–12:00 + 13:00–14:00" dài 48 ký tự
          nên nó xuống hai dòng và dồn chữ về lề phải, xấu đúng ở khoảnh khắc
          vừa làm xong một việc. Mã task và số giờ đã nằm sẵn trên hàng; thứ
          duy nhất còn lại là khung giờ, nên chỉ nó hiện ra, câu đầy đủ lùi
          vào tooltip.
          Báo lỗi thì ngược lại — vẫn cho xuống dòng. Nó hiếm, nó dài vì có
          việc phải làm theo, và cắt một câu như vậy là giấu đúng phần cần
          đọc. */}
      {result && (
        <span
          title={result.message}
          className={
            "basis-full leading-snug " +
            (result.ok
              ? "truncate text-right font-mono text-[10.5px] text-good"
              : "text-left text-[11px] text-crit")
          }
        >
          {result.ok ? `✓ ${result.slots ?? result.message}` : result.message}
        </span>
      )}
    </span>
  );
}

export function HourStepper({
  hours,
  step,
  presets,
  onChange,
}: {
  hours: number;
  step: number;
  presets: number[];
  onChange: (h: number) => void;
}) {
  return (
    <span className="flex h-[26px] items-center rounded-md border border-line-strong bg-surface">
      <button
        type="button"
        onClick={() => onChange(Math.max(step, +(hours - step).toFixed(2)))}
        className="h-full w-[22px] rounded-l-[5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        aria-label="Giảm"
      >
        −
      </button>

      <Popover
        align="right"
        panelClassName="w-[92px] p-1"
        trigger={() => (
          <button
            type="button"
            className="flex h-[26px] w-[48px] items-center justify-center gap-0.5 border-x border-line font-mono text-[12px] hover:bg-surface-2"
          >
            {hours}h <em className="text-[8px] not-italic text-ink-3">▾</em>
          </button>
        )}
      >
        {(close) => (
          <>
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  onChange(p);
                  close();
                }}
                className="block w-full rounded px-2 py-[5px] text-left font-mono text-[12.5px] hover:bg-accent-soft hover:text-accent-ink"
              >
                {p}h
              </button>
            ))}
          </>
        )}
      </Popover>

      <button
        type="button"
        onClick={() => onChange(+(hours + step).toFixed(2))}
        className="h-full w-[22px] rounded-r-[5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        aria-label="Tăng"
      >
        +
      </button>
    </span>
  );
}

/** Ghi chú worklog. Nằm sau một nút vì phần lớn lần log không kèm ghi chú. */
export function NoteButton({
  value,
  onChange,
  issueKey,
}: {
  value: string;
  onChange: (v: string) => void;
  issueKey: string;
}) {
  return (
    <Popover
      align="right"
      panelClassName="w-[248px]"
      trigger={() => (
        <button
          type="button"
          title={value ? `Ghi chú: ${value}` : "Thêm ghi chú cho lần log này"}
          className={
            "grid h-[26px] w-[26px] place-items-center rounded-md border text-[12px] " +
            (value
              ? "border-accent bg-accent-soft text-accent-ink"
              : "border-line-strong bg-surface text-ink-3 hover:border-accent hover:text-accent-ink")
          }
        >
          ✎
        </button>
      )}
    >
      {(close) => (
        <>
          <PopoverTitle>{issueKey} · ghi chú worklog</PopoverTitle>
          <textarea
            rows={3}
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) close();
            }}
            placeholder="Không bắt buộc…"
            className="w-full resize-y rounded-md border border-line bg-ground px-2 py-1.5 text-[12.5px] leading-relaxed"
          />
          <p className="mt-1.5 text-[11px] text-ink-3">
            Đi kèm lần bấm Log tiếp theo.
          </p>
        </>
      )}
    </Popover>
  );
}

/**
 * Ngày này có hai chỗ đặt đúng — hỏi người log muốn chỗ nào.
 *
 * Chỉ mở ra khi có khe trống, gần như luôn là vì vừa xoá một worklog để log
 * lại. Trước đây app tự chọn, và chọn sai: chỗ đặt tính từ **tổng** số phút đã
 * log, nên xoá lát 09:00–11:00 của một ngày đã có 11:00–12:00 + 13:00–14:00 làm
 * entry mới rơi đúng vào 11:00, trùng giờ với cái đang có, còn 09:00 vẫn trống.
 *
 * Không có chỗ nào để app đoán cho đúng: "log lại đúng chỗ vừa xoá" và "log
 * thêm một việc nữa" là hai ý khác nhau, cùng một cú bấm. Nên hỏi.
 */
function PlacePicker({
  hours,
  dateLabel,
  gap,
  after,
  schedule,
  onClose,
  onPick,
}: {
  hours: number;
  dateLabel: string;
  gap: Placement;
  after: Placement;
  schedule: WorkSchedule;
  onClose: () => void;
  onPick: (which: "gap" | "after") => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const option = (
    which: "gap" | "after",
    place: Placement,
    label: string,
    why: string,
  ) => {
    const cut = sliceWorklog(place.at, hours * 60, schedule);
    return (
      <button
        type="button"
        onClick={() => onPick(which)}
        className="flex flex-col items-start gap-px rounded-md border border-line px-2 py-1.5 text-left hover:border-accent hover:bg-accent-soft"
      >
        <span className="font-sans text-[12px] font-medium text-ink">{label}</span>
        <span className="font-mono text-[10.5px] text-ink-3">
          {cut.length > 1
            ? formatSlices(cut)
            : `${formatClock(place.start)}–${formatClock(place.end)}`}
          <span className="font-sans"> · {why}</span>
        </span>
      </button>
    );
  };

  return (
    <>
      <span
        className="fixed inset-0 z-20 cursor-default"
        onClick={onClose}
        aria-hidden
      />
      <span className="absolute right-0 top-[calc(100%+4px)] z-30 flex w-[244px] flex-col gap-1 rounded-md border border-line-strong bg-surface p-1.5 text-left shadow-lg">
        <span className="px-1 font-sans text-[10px] uppercase tracking-[0.06em] text-ink-3">
          {dateLabel} còn khe trống · log {hours}h vào đâu?
        </span>
        {option("gap", gap, `Log từ ${formatClock(gap.start)}`, "lấp lại khe đang trống")}
        {option(
          "after",
          after,
          `Log tiếp sau, từ ${formatClock(after.start)}`,
          "nối sau phần đã log",
        )}
      </span>
    </>
  );
}
