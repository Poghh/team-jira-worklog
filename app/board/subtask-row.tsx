"use client";

import { useState, useTransition } from "react";

import { logWorkAction } from "@/app/actions";
// Import from types.ts, never issues.ts — the latter pulls in the DB layer and
// would end up in the browser bundle.
import type { BoardSubtask } from "@/lib/jira/types";
import {
  issueHygiene,
  logDatePastDue,
  loggedButTodo,
  statusTone,
} from "@/lib/jira/types";
import type { DayOffKind } from "@/lib/quota";
import {
  DEFAULT_SCHEDULE,
  type WorkSchedule,
  formatClock,
  formatDuration,
  formatSlices,
  placeWorklog,
  sliceWorklog,
} from "@/lib/time";

import { Spinner } from "../spinner";
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
  dayLoggedMinutes = 0,
  schedule = DEFAULT_SCHEDULE,
  dayOff = null,
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
  /** Logged across the whole day, which is what decides where this entry lands. */
  dayLoggedMinutes?: number;
  schedule?: WorkSchedule;
  /**
   * Leave marked on the day being logged into. Not used to place the entry —
   * `schedule` already carries that — only to say why the clock reads the way
   * it does, since a start of 13:00 with no explanation looks like a bug.
   */
  dayOff?: DayOffKind | null;
}) {
  const [hours, setHours] = useState(step);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [detailOpen, setDetailOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const { refresh } = useNav();

  function submit() {
    startTransition(async () => {
      const res = await logWorkAction({
        issueKey: subtask.key,
        hours,
        date,
        comment,
      });
      setResult(res);
      if (res.ok) setComment("");
      // `partial` means part of the entry did reach Jira — the totals on screen
      // are already wrong, so refresh even though the action reports a failure.
      if (res.ok || res.partial) refresh();
    });
  }

  const today = subtask.loggedTodaySeconds;
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
  const slot = placeWorklog(dayLoggedMinutes, hours * 60, schedule);
  const slotLabel = `${formatClock(slot.start)}–${formatClock(slot.end)}`;
  // The same cut the server will make. The label above stays the span as a
  // human reads it (11:00–14:00); this is what Jira will actually hold, and the
  // two only differ when the entry crosses the break.
  const slices = sliceWorklog(dayLoggedMinutes, hours * 60, schedule);
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
  const slotTitle =
    offNote +
    (slices.length > 1
      ? `Vắt qua giờ nghỉ — Jira sẽ nhận ${slices.length} entry: ${formatSlices(slices)}`
      : `Worklog sẽ bắt đầu lúc ${formatClock(slot.start)} — xếp nối tiếp` +
        // A half day is worked straight through, so there is no break left for
        // an entry to step over and saying otherwise would be describing the
        // behaviour this change removed.
        (offNote ? " trong buổi." : " trong ngày, nhảy qua giờ nghỉ"));

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

          <span
            className="min-w-[62px] text-right font-mono text-[11px] text-ink-3"
            title={`${isToday ? "Hôm nay" : dateLabel}: ${formatDuration(today)} · tổng: ${formatDuration(total)}`}
          >
            <span className={today > 0 ? "font-semibold text-accent-ink" : ""}>
              {today > 0 ? formatDuration(today) : "—"}
            </span>
            <span className="opacity-60"> · </span>
            {total > 0 ? formatDuration(total) : "—"}
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
          <span
            className="min-w-[76px] text-right font-mono text-[10.5px] tabular text-ink-3"
            title={slotTitle}
          >
            {slotLabel}
            {/* The split is invisible in the span above — 11:00–14:00 reads the
                same whether it is one record or two — so it gets a mark. */}
            {slices.length > 1 && (
              <sup className="ml-px text-ot" title={slotTitle}>
                ×2
              </sup>
            )}
          </span>

          <NoteButton
            value={comment}
            onChange={setComment}
            issueKey={subtask.key}
          />

          <button
            type="button"
            onClick={submit}
            disabled={pending}
            title={
              `Ghi ${hours}h vào ${dateLabel}, ${formatSlices(slices)}` +
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
