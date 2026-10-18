"use client";

// Import từ types.ts, không bao giờ từ issues.ts — cái sau kéo cả tầng DB vào
// bundle của trình duyệt.
import type { BoardSubtask } from "@/lib/jira/types";
import { issueHygiene, logDatePastDue, statusTone } from "@/lib/jira/types";
import type { DayOffKind } from "@/lib/quota";
import { DEFAULT_SCHEDULE, type WorkSchedule, formatDuration } from "@/lib/time";

import { BOARD_COLS, WIDE_ONLY } from "./columns";
import { CopyBtn } from "./copy";
import { DatesEditor } from "./dates-editor";
import { HygieneBadge } from "./hygiene-badge";
import { IssueDetail } from "./issue-detail";
import { InlineLog } from "./log-box";
import { LabelFixButton } from "./label-fix";
import { PointsEditor } from "./points-editor";
import { StatusPill } from "./status-pill";
import { TypeIcon } from "./type-icon";
import { useState } from "react";

/**
 * Một task con, một hàng, mọi thứ đọc được không cần bấm.
 *
 * Hàng này từng có hai đời hỏng theo hai kiểu ngược nhau. Đời đầu nhét chín
 * control vào một dòng co giãn: cụm control rộng cứng 525px còn cột tiêu đề là
 * `minmax(0,1fr)`, nên mọi phần hẹp đi dồn hết vào tiêu đề — 1280px còn 68px,
 * 1100px còn **0**, tức hàng không còn chữ nào nói task đó là gì. Đời sau gỡ
 * hết control sang một panel bên phải, đọc được tiêu đề nhưng phải bấm chọn
 * task mới biết nó đang ở trạng thái nào.
 *
 * Đời này giữ cả hai: cột **cố định** ({@link BOARD_COLS}) nên tiêu đề có sàn
 * và không ô nào bóp ô nào, mà trạng thái / ngày / point / giờ vẫn nằm sẵn
 * trên hàng. Cái trả giá là chiều cao — mỗi task ~39px thay vì 28px.
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
  jiraBaseUrl = "",
}: {
  subtask: BoardSubtask;
  date: string;
  dateLabel: string;
  isToday: boolean;
  step: number;
  presets: number[];
  budgets: Record<number, string>;
  /** Hết sprint trên màn hình, mời làm due date bằng một cú bấm. */
  sprintEnd?: string | null;
  /** Luật đặt tên của team, cho badge cảnh báo. */
  team?: { label: string | null; prefix: string | null };
  /** False trên project không có field ngày nào — ẩn hẳn chip ngày. */
  datesSupported?: boolean;
  /** Đã log cả ngày, trên mọi task — thứ quyết định entry này rơi vào đâu. */
  dayLoggedMinutes?: number;
  schedule?: WorkSchedule;
  dayOff?: DayOffKind | null;
  jiraBaseUrl?: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);

  const today = subtask.loggedTodaySeconds;
  const total = subtask.timeSpentSeconds;
  const hygiene = issueHygiene(subtask, team);

  /**
   * Có giờ thật sự được log sau due date của một task đã Done.
   *
   * Đọc từ chính task — ngày log gần nhất — chứ không từ ngày đang xem, nên nó
   * đúng dù bảng đang đứng ở ngày nào. Tô theo ngày đang xem thì cái sai nằm ở
   * 09/09 và phải đứng đúng 09/09 mới thấy.
   */
  const badLogDate = logDatePastDue(
    subtask.dueDate,
    subtask.lastLogDate ?? "",
    subtask.statusName,
  )
    ? subtask.lastLogDate
    : null;

  return (
    <div
      className={
        // `border-l-[3px]` trong suốt: hàng task cha có vạch màu 3px, nên nếu
        // hàng con không chừa đúng 3px đó thì mọi cột của nó lệch 3px so với
        // cha — và cột lệch là mất đúng thứ bảng này có.
        "group border-b border-line border-l-[3px] px-3 py-1.5 last:border-b-0 " +
        BOARD_COLS +
        " " +
        (badLogDate
          ? "border-l-warn bg-warn-soft/40"
          : "border-l-transparent hover:bg-surface-2/60")
      }
    >
      {/* Thụt **nội dung ô đầu**, không thụt cả hàng: thụt cả hàng thì mọi cột
          của task con lệch khỏi cột của task cha, mà bảng này sống bằng chuyện
          quét dọc một cột.
          Thụt phải đủ sâu để vượt qua **cả chip "CHA"** của hàng cha, không
          chỉ qua mép hàng — chip đó đẩy mã task cha sang phải, nên thụt nông
          thì mã con lại nằm bên trái mã cha và đọc ra là ngược tầng. Vạch mảnh
          bên trái là đường nối về hàng cha. */}
      <span className="ml-1.5 flex items-center gap-1 whitespace-nowrap border-l border-line-strong pl-14">
        {/* `"Subtask"` chứ không phải `"Sub-task"`: `TypeIcon` tra file theo
            slug, mà file tên `subtask.svg` — tên có gạch nối ra slug `sub-task`
            và component vẽ **trống** thay vì ảnh vỡ, tức là hỏng im lặng.
            `BoardSubtask` không mang loại issue vì task con ở Jira luôn là
            Sub-task, nên tên này cố định chứ không đọc từ dữ liệu. */}
        <TypeIcon name="Subtask" className="size-3 shrink-0" />
        <JiraKey issueKey={subtask.key} base={jiraBaseUrl} />
        <CopyBtn text={subtask.key} what="mã task" />
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13px]" title={subtask.summary}>
          {subtask.summary}
        </span>
        <CopyBtn text={subtask.summary} what="tiêu đề" />
        {/* Hiện khi rê chuột, hoặc khi bàn phím đang ở trong hàng — một nút
            biến mất hẳn với người dùng bàn phím thì không chấp nhận được, nên
            `focus:` đi kèm `group-hover:`.
            Đứng ở ô tiêu đề chứ không ở ô ghi giờ: ô đó chỉ còn 236px và cụm
            ghi giờ đã chiếm gần hết, nhét thêm nút vào là hàng xuống ba dòng —
            đo được 98px mỗi hàng. */}
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          title={`Mô tả, Definition of Done và lịch sử của ${subtask.key}`}
          className="shrink-0 rounded-md border border-line-strong px-1.5 py-px text-[11px] text-ink-3 opacity-0 hover:border-accent hover:text-accent-ink focus:opacity-100 group-hover:opacity-100"
        >
          Chi tiết
        </button>
        <HygieneBadge hygiene={hygiene} />
        {hygiene.missingLabel && team.label && (
          <LabelFixButton issueKey={subtask.key} label={team.label} />
        )}
      </span>

      {/* `min-w-0`: ô lưới mặc định không nhỏ hơn nội dung của nó, nên một
          trạng thái dài — "READY TO TEST ON DEVELOP" — đẩy pill tràn sang cột
          Ngày và đè lên chip ngày ở đó. */}
      <span className="min-w-0">
        <StatusPill
          issueKey={subtask.key}
          statusName={subtask.statusName}
          compact
        />
      </span>

      <span className={WIDE_ONLY}>
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
      </span>

      <span className={WIDE_ONLY + " justify-end"}>
        <PointsEditor
          issueKey={subtask.key}
          value={subtask.storyPoints}
          budgets={budgets}
          spentSeconds={total}
        />
      </span>

      <span
        title={`${dateLabel}: ${formatDuration(today)} · tổng: ${formatDuration(total)}`}
        className="text-right font-mono text-[11px] text-ink-3"
      >
        <span className={today > 0 ? "font-semibold text-ink-2" : ""}>
          {today > 0 ? formatDuration(today) : "—"}
        </span>
        <span className="opacity-60"> · </span>
        {total > 0 ? formatDuration(total) : "—"}
      </span>

      <span className="flex items-center justify-end">
        <InlineLog
          issueKey={subtask.key}
          date={date}
          dateLabel={dateLabel}
          isToday={isToday}
          dueDate={subtask.dueDate}
          statusName={subtask.statusName}
          step={step}
          presets={presets}
          dayLoggedMinutes={dayLoggedMinutes}
          schedule={schedule}
          dayOff={dayOff}
        />
      </span>

      {detailOpen && (
        <IssueDetail
          issueKey={subtask.key}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Mã task **là** đường dẫn sang Jira.
 *
 * Một mã issue nhìn như link thì bấm vào phải ra Jira; bắt nó mở cửa sổ nội bộ
 * là thứ phải học. Chi tiết nội bộ nằm sau một nút có chữ.
 */
export function JiraKey({
  issueKey,
  base,
}: {
  issueKey: string;
  base: string;
}) {
  if (!base)
    return (
      <span className="font-mono text-[11.5px] font-semibold text-accent-ink">
        {issueKey}
      </span>
    );
  return (
    <a
      href={`${base}/browse/${issueKey}`}
      target="_blank"
      rel="noreferrer"
      title={`Mở ${issueKey} trên Jira`}
      className="font-mono text-[11.5px] font-semibold text-accent-ink underline-offset-2 hover:underline"
    >
      {issueKey} ↗
    </a>
  );
}
