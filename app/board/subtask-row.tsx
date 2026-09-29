"use client";

import { useEffect, useState, useTransition } from "react";

import { deleteWorklogsAction, logWorkAction } from "@/app/actions";
// Import from types.ts, never issues.ts — the latter pulls in the DB layer and
// would end up in the browser bundle.
import type { BoardSubtask } from "@/lib/jira/types";
import {
  issueHygiene,
  logDatePastDue,
  loggedButTodo,
  statusTone,
} from "@/lib/jira/types";
import type { StageConfig, TaskNoteRow } from "@/lib/modules/branches/model";
import type { DayOffKind } from "@/lib/quota";
import {
  type BusySpan,
  DEFAULT_SCHEDULE,
  type Placement,
  type WorkSchedule,
  formatClock,
  formatDuration,
  formatSlices,
  placementChoices,
  sliceWorklog,
} from "@/lib/time";

import { Spinner } from "../spinner";
import { BranchLine, BranchNote } from "./branch-note";
import { DatesEditor } from "./dates-editor";
import { HygieneBadge } from "./hygiene-badge";
import { IssueDetail } from "./issue-detail";
import { useNav } from "./navigation";
import { PointsEditor } from "./points-editor";
import { Popover, PopoverTitle } from "./popover";
import { StatusPill } from "./status-pill";
import { TypeIcon } from "./type-icon";

/**
 * One subtask, on a single 42px line.
 *
 * The row previously ran three lines and ~100px, so ten subtasks filled more
 * than a screen. Only what is touched on every log stays inline — the hour
 * stepper and the Log button. Points and the worklog note moved into popovers,
 * and the two hour figures merged into one `today · total` column.
 */
export function SubtaskRow({
  subtask,
  date,
  dateLabel,
  isToday,
  step,
  presets,
  budgets,
  sprintEnd = null,
  team = { label: null, prefix: null },
  datesSupported = true,
  dayBusy = [],
  schedule = DEFAULT_SCHEDULE,
  dayOff = null,
  note = null,
  noteStages = [],
  noteEnvs = [],
  noteRepos = [],
  noteRepoLabels = {},
  noteRepoColors = {},
}: {
  subtask: BoardSubtask;
  date: string;
  dateLabel: string;
  isToday: boolean;
  step: number;
  presets: number[];
  budgets: Record<number, string>;
  /** End of the sprint on screen, offered as a one-click due date. */
  sprintEnd?: string | null;
  /** The team's filing rules, for the warning badge. */
  team?: { label: string | null; prefix: string | null };
  /** False on a project with neither date field — hides the chip entirely. */
  datesSupported?: boolean;
  /**
   * Các khoảng giờ đã bận trong cả ngày — thứ quyết định entry này nằm ở đâu.
   *
   * Là khoảng chứ không phải tổng: xoá một worklog giữa ngày rồi log lại, tổng
   * không nói được chỗ vừa trống ra nằm ở đâu.
   */
  dayBusy?: BusySpan[];
  schedule?: WorkSchedule;
  /**
   * Leave marked on the day being logged into. Not used to place the entry —
   * `schedule` already carries that — only to say why the clock reads the way
   * it does, since a start of 13:00 with no explanation looks like a bug.
   */
  dayOff?: DayOffKind | null;
  /** Branch + notes for this issue. Null when none, or when the module is off. */
  note?: TaskNoteRow | null;
  /** Columns offered in the note editor. Empty when the module is off. */
  noteStages?: StageConfig[];
  /** Deployment pipeline, so the row can show how far this branch's code got. */
  noteEnvs?: StageConfig[];
  noteRepos?: string[];
  noteRepoLabels?: Record<string, string>;
  noteRepoColors?: Record<string, string>;
}) {
  const [hours, setHours] = useState(step);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  /** Danh sách worklog của ngày đang xem, mở ra để xoá. */
  const [logsOpen, setLogsOpen] = useState(false);
  /**
   * Chỗ đặt người dùng đã chọn, khi ngày có nhiều hơn một chỗ đặt đúng.
   *
   * Giữ lựa chọn thay vì hỏi lại ở mỗi lần bấm, để còn xem trước được khung giờ
   * đã chọn ngay trên dòng. Xoá sau mỗi lần log xong: ngày đã đổi, câu hỏi cũ
   * không còn nói về ngày đó nữa.
   */
  const [pick, setPick] = useState<"gap" | "after" | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const { refresh } = useNav();

  function submit(where: Placement) {
    setAskOpen(false);
    startTransition(async () => {
      const res = await logWorkAction({
        issueKey: subtask.key,
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
      // `partial` means part of the entry did reach Jira — the totals on screen
      // are already wrong, so refresh even though the action reports a failure.
      if (res.ok || res.partial) refresh();
    });
  }

  const today = subtask.loggedTodaySeconds;
  const entries = subtask.todayEntries ?? [];
  const total = subtask.timeSpentSeconds;
  const hygiene = issueHygiene(subtask, team);
  /**
   * The day on screen is after the due date of a task already marked Done.
   *
   * Checked against `date` — the day being logged to — not against today, so
   * it is right whichever day the board is showing.
   */
  const pastDue = logDatePastDue(subtask.dueDate, date, subtask.statusName);
  /**
   * Time really was logged after this finished task's due date — whichever day
   * the board is showing.
   *
   * Two wrong versions came before this one. Colouring on `pastDue` alone made
   * the sprint calendar a warning generator: pick any past day and half the
   * board lit up about nothing that had happened. Colouring only when the
   * *selected* day carried the time then hid it again — the mistake was on
   * 09/09 and you had to already be standing on 09/09 to find out.
   *
   * The fact is about the task, so it is read off the task: the latest day it
   * was logged to, which the board already fetches for the whole sprint.
   */
  const badLogDate = logDatePastDue(
    subtask.dueDate,
    subtask.lastLogDate ?? "",
    subtask.statusName,
  )
    ? subtask.lastLogDate
    : null;

  // Where this entry will land, worked out with the same function the server
  // uses. Shown before the click, because "log 6h" reading back as 11:00–18:00
  // is the difference between trusting the timesheet and re-checking it in Jira.
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
  const slotLabel = `${formatClock(slot.start)}–${formatClock(slot.end)}`;
  // The same cut the server will make. The label above stays the span as a
  // human reads it (11:00–14:00); this is what Jira will actually hold, and the
  // two only differ when the entry crosses the break.
  const slices = sliceWorklog(slot.at, hours * 60, schedule);
  /**
   * Why the clock reads the way it does.
   *
   * A half day of leave moves the whole working day — an afternoon worked
   * after a morning off starts at 13:00 — and a start time that jumps with no
   * reason given is indistinguishable from a bug. Said first, because it is
   * the part the reader did not already know.
   */
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
            // A half day is worked straight through, so there is no break left
            // for an entry to step over and saying otherwise would be
            // describing the behaviour this change removed.
            (offNote ? " trong buổi." : " trong ngày, nhảy qua giờ nghỉ")));

  return (
    <div
      title={
        badLogDate
          ? `${subtask.key} đã Done, làm xong ${subtask.startDate} → ${subtask.dueDate}.\n` +
            `Nhưng có giờ log vào ${badLogDate}, nằm sau due date.\n\n` +
            `Một trong hai đang sai: due date chưa được dời, hoặc trạng thái đóng sớm.`
          : undefined
      }
      className={
        "border-b border-line last:border-b-0 " +
        // The whole row, not only the date chip. The chip is a small control
        // among eight on a crowded line, and the thing being said is about the
        // row as a whole: this task is finished, and the day you are on is not
        // one of its days. A wash plus a rule down the left reads at a glance
        // scanning the list, which is how a row this wide is actually read.
        (badLogDate
          ? "border-l-2 border-l-warn bg-warn-soft/40 hover:bg-warn-soft/60"
          : "hover:bg-surface-2/60")
      }
    >
      {/* Height follows the title rather than fixing it: the row carries eight
          controls now, so a single truncated line left most summaries unreadable
          — and the summary is what you actually pick a task by. */}
      <div className="grid min-h-[42px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          title={`Xem chi tiết ${subtask.key}`}
          className="flex items-center gap-1.5 whitespace-nowrap rounded px-0.5 hover:bg-accent-soft"
        >
          <TypeIcon name="Subtask" className="size-3" />
          <span className="font-mono text-[11.5px] font-semibold text-accent-ink underline-offset-2 hover:underline">
            {subtask.key}
          </span>
        </button>

        {/* Two lines, then ellipsis. Anything longer is still in the tooltip and
            in the detail panel; three lines would push the controls apart enough
            to lose the scannable grid. */}
        {/* The branch sits under the summary rather than in the control cluster
            on the right: it is the one field here that is long, and the whole
            point of showing it is being able to read it without hovering. */}
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-start gap-1.5">
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              title={subtask.summary}
              className="line-clamp-2 min-w-0 text-left text-[13px] leading-[1.35] hover:text-accent-ink"
            >
              {subtask.summary}
            </button>
            {(hygiene.missingLabel || hygiene.missingPrefix) && (
              <span className="shrink-0 pt-px">
                <HygieneBadge hygiene={hygiene} />
              </span>
            )}
          </span>
          <BranchLine
            note={note}
            envs={noteEnvs}
            repos={noteRepos}
            repoLabels={noteRepoLabels}
            repoColors={noteRepoColors}
          />
        </span>

        <span className="flex items-center gap-1.5 whitespace-nowrap">
          {badLogDate && (
            <span
              title={
                `${subtask.key} đã Done với due date ${subtask.dueDate}, ` +
                `nhưng ngày ${badLogDate} vẫn có giờ được log.\n\n` +
                `Một trong hai đang sai: due date chưa được dời, hoặc trạng thái đóng sớm.`
              }
              className="rounded-[3px] border border-warn bg-warn-soft px-1 py-px font-mono text-[9.5px] font-semibold text-warn"
            >
              ⚠ log {badLogDate.slice(8)}/{badLogDate.slice(5, 7)} · sau due
            </span>
          )}
          {loggedButTodo(total, subtask.statusName) && (
            <span
              title={`${subtask.key} đã log ${formatDuration(total)} nhưng vẫn đang To Do — nhớ chuyển trạng thái`}
              className="rounded-[3px] border border-warn bg-warn-soft px-1 py-px font-mono text-[9.5px] font-semibold text-warn"
            >
              ⚠ vẫn To Do
            </span>
          )}
          <StatusPill
            issueKey={subtask.key}
            statusName={subtask.statusName}
            compact
          />

          {datesSupported && (
            <DatesEditor
              issueKey={subtask.key}
              startDate={subtask.startDate}
              dueDate={subtask.dueDate}
              sprintEnd={sprintEnd}
              isDone={statusTone(subtask.statusName) === "done"}
              loggingPastDue={badLogDate}
            />
          )}

          <PointsEditor
            issueKey={subtask.key}
            value={subtask.storyPoints}
            budgets={budgets}
            spentSeconds={total}
          />

          {noteStages.length > 0 && (
            <BranchNote
              issueKey={subtask.key}
              summary={subtask.summary}
              note={note}
              stages={noteStages}
            />
          )}

          <span
            className="relative min-w-[62px] text-right font-mono text-[11px] text-ink-3"
            title={`${isToday ? "Hôm nay" : dateLabel}: ${formatDuration(today)} · tổng: ${formatDuration(total)}`}
          >
            {/* Con số hôm nay bấm được khi có log: đó là chỗ người ta nhìn khi
                nghi mình log nhầm, nên cũng là chỗ để sửa. Đọc từ Jira chứ
                không từ state, nên chuyển tab rồi quay lại vẫn xoá được. */}
            {entries.length > 0 ? (
              <button
                type="button"
                onClick={() => setLogsOpen((v) => !v)}
                title="Xem và xoá từng worklog của ngày này"
                className="font-semibold text-accent-ink underline decoration-dotted underline-offset-2"
              >
                {formatDuration(today)}
              </button>
            ) : (
              <span>{today > 0 ? formatDuration(today) : "—"}</span>
            )}
            <span className="opacity-60"> · </span>
            {total > 0 ? formatDuration(total) : "—"}
            {logsOpen && (
              <WorklogList
                issueKey={subtask.key}
                entries={entries}
                pending={pending}
                onClose={() => setLogsOpen(false)}
                onDelete={(id: string) =>
                  startTransition(async () => {
                    const res = await deleteWorklogsAction(subtask.key, [id]);
                    setResult(res);
                    if (res.ok) setLogsOpen(false);
                    refresh();
                  })
                }
              />
            )}
          </span>

          <HourStepper
            hours={hours}
            step={step}
            presets={presets}
            onChange={setHours}
          />

          {/* Directly after the stepper that determines it: the slot is the one
              thing about a log that used to be invisible and wrong at the same
              time, and seeing it move as the hours change is the explanation. */}
          <span className="relative min-w-[76px] text-right font-mono text-[10.5px] tabular text-ink-3">
            {/* Không có khe trống: một chỗ đặt duy nhất, hiện thẳng như cũ.
                Có khe trống: bấm được, vì lúc này khung giờ là một lựa chọn. */}
            {!choices.gap ? (
              <span title={slotTitle}>
                {slotLabel}
                {/* The split is invisible in the span above — 11:00–14:00 reads
                    the same whether it is one record or two — so it gets a mark. */}
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
                {chosen ? slotLabel : "chọn chỗ"}
                <span className="ml-0.5 opacity-70">▾</span>
                {chosen && slices.length > 1 && (
                  <sup className="ml-px text-ot">×2</sup>
                )}
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

          <NoteButton
            value={comment}
            onChange={setComment}
            issueKey={subtask.key}
          />

          <button
            type="button"
            // Chưa chốt chỗ đặt thì bấm Log là mở câu hỏi, không phải log. Đây
            // là chỗ duy nhất app được phép không tự quyết: hai chỗ đặt đều
            // đúng, chỉ người log biết mình muốn cái nào.
            onClick={() => (chosen ? submit(chosen) : setAskOpen(true))}
            disabled={pending}
            title={
              (chosen
                ? `Ghi ${hours}h vào ${dateLabel}, ${formatSlices(slices)}`
                : `Ngày này có khe trống — bấm để chọn ghi ${hours}h vào đâu`) +
              // Before the entry exists, not only after: the cheapest moment
              // to notice a wrong day is before pressing.
              (pastDue
                ? `\n\n⚠ ${subtask.key} đã Done với due date ${subtask.dueDate} — ${dateLabel} nằm sau đó.`
                : "")
            }
            className={
              "h-[26px] rounded-md px-2.5 text-[12px] font-medium text-white disabled:opacity-60 " +
              (isToday
                ? "bg-accent hover:bg-accent-2"
                : "bg-ot hover:brightness-110")
            }
          >
            {pending ? (
              <Spinner className="size-3 border-white/40 border-t-white" />
            ) : (
              "Log"
            )}
          </button>
        </span>
      </div>

      {detailOpen && (
        <IssueDetail
          issueKey={subtask.key}
          onClose={() => setDetailOpen(false)}
        />
      )}

      {result && (
        <p
          className={
            "px-3 pb-1.5 text-[11.5px] " +
            (result.ok ? "text-good" : "text-crit")
          }
        >
          {result.message}

          {/* Said at the moment it happened, once. A permanent mark on every
              Done row whose due date has passed would be on most rows most
              days, and a warning that is always on is not read. */}
          {result.ok && pastDue && (
            <span className="text-warn">
              {" · ⚠ ngày này sau due date "}
              {subtask.dueDate}
              {" của task đã Done"}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function HourStepper({
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

/**
 * Từng worklog của ngày đang xem, xoá được.
 *
 * Đọc từ Jira qua dữ liệu trang đã fetch, không phải từ state sau khi log —
 * bản đầu giữ id ở state và người dùng chuyển tab một cái là mất nút, mà đó
 * đúng là lúc người ta nhận ra mình log nhầm.
 *
 * Liệt kê từng cái thay vì một nút "xoá lần vừa rồi": nửa ngày vắt qua giờ
 * nghỉ nằm trong Jira thành hai worklog, và sau khi tải lại trang thì không có
 * gì nói cái nào đi với cái nào. Người dùng nhìn giờ là biết cái nào sai.
 */
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
        <span className="font-sans text-[12px] font-medium text-ink">
          {label}
        </span>
        <span className="font-mono text-[10.5px] text-ink-3">
          {cut.length > 1 ? formatSlices(cut) : `${formatClock(place.start)}–${formatClock(place.end)}`}
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
        {option(
          "gap",
          gap,
          `Log từ ${formatClock(gap.start)}`,
          "lấp lại khe đang trống",
        )}
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

function WorklogList({
  issueKey,
  entries,
  pending,
  onClose,
  onDelete,
}: {
  issueKey: string;
  entries: Array<{ id: string; seconds: number; started: string }>;
  pending: boolean;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Bấm ra ngoài là đóng. Không dùng `onBlur` vì nút xoá nằm bên trong,
          và blur sẽ đóng trước khi cú bấm kịp tới nó. */}
      <span
        className="fixed inset-0 z-20 cursor-default"
        onClick={onClose}
        aria-hidden
      />
      <span className="absolute right-0 top-[calc(100%+4px)] z-30 flex w-[212px] flex-col gap-1 rounded-md border border-line-strong bg-surface p-1.5 text-left shadow-lg">
        <span className="px-1 text-[10px] uppercase tracking-[0.06em] text-ink-3">
          Worklog ngày này · {issueKey}
        </span>
        {entries.map((e) => (
          <span key={e.id} className="flex items-center gap-1.5">
            <span className="flex-1 font-mono text-[11px] text-ink-2">
              {e.started.slice(11, 16)} · {formatDuration(e.seconds)}
            </span>
            <button
              type="button"
              onClick={() => onDelete(e.id)}
              disabled={pending}
              title="Xoá worklog này khỏi Jira"
              className="rounded border border-line px-1.5 py-px font-sans text-[11px] text-ink-2 hover:border-crit hover:text-crit disabled:opacity-50"
            >
              {pending ? "…" : "Xoá"}
            </button>
          </span>
        ))}
      </span>
    </>
  );
}

/** Worklog note. Behind a button because most logs do not carry one. */
function NoteButton({
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
