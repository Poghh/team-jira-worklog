"use client";

import { deleteWorklogsAction, issueWorklogDaysAction } from "@/app/actions";
// Import từ types.ts, không bao giờ từ issues.ts — cái sau kéo cả tầng DB vào
// bundle của trình duyệt.
import type { BoardSubtask } from "@/lib/jira/types";
import { issueHygiene, logDatePastDue, statusTone } from "@/lib/jira/types";
import type { StageConfig, TaskNoteRow } from "@/lib/modules/branches/model";
import type { IssueWorklogDays } from "@/lib/jira/worklog";
import type { DayOffKind } from "@/lib/quota";
import {
  type BusySpan,
  DEFAULT_SCHEDULE,
  type WorkSchedule,
  formatDuration,
} from "@/lib/time";

import { Spinner } from "../spinner";
import { BranchLine, BranchNote } from "./branch-note";
import { BOARD_COLS, WIDE_ONLY } from "./columns";
import { CopyBtn } from "./copy";
import { DatesEditor } from "./dates-editor";
import { HygieneBadge } from "./hygiene-badge";
import { IssueDetail } from "./issue-detail";
import { InlineLog } from "./log-box";
import { LabelFixButton } from "./label-fix";
import { PointsEditor } from "./points-editor";
import { useNav } from "./navigation";
import { StatusPill } from "./status-pill";
import { TypeIcon } from "./type-icon";
import { useEffect, useState, useTransition } from "react";

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
  dayBusy = [],
  schedule = DEFAULT_SCHEDULE,
  dayOff = null,
  jiraBaseUrl = "",
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
  /** Hết sprint trên màn hình, mời làm due date bằng một cú bấm. */
  sprintEnd?: string | null;
  /** Luật đặt tên của team, cho badge cảnh báo. */
  team?: { label: string | null; prefix: string | null };
  /** False trên project không có field ngày nào — ẩn hẳn chip ngày. */
  datesSupported?: boolean;
  /**
   * Các khoảng giờ đã bận trong cả ngày, trên mọi task — thứ quyết định entry
   * này rơi vào đâu. Là khoảng chứ không phải tổng: xoá một worklog giữa ngày
   * rồi log lại, tổng không nói được chỗ vừa trống ra nằm ở đâu.
   */
  dayBusy?: BusySpan[];
  schedule?: WorkSchedule;
  dayOff?: DayOffKind | null;
  jiraBaseUrl?: string;
  /** Nhánh + ghi chú của issue này. Null khi chưa có, hoặc khi module đang tắt. */
  note?: TaskNoteRow | null;
  /** Các cột mà ô sửa ghi chú bày ra. Rỗng khi module tắt. */
  noteStages?: StageConfig[];
  /** Dải môi trường, để hàng nói được code của nhánh này đã đi tới đâu. */
  noteEnvs?: StageConfig[];
  noteRepos?: string[];
  noteRepoLabels?: Record<string, string>;
  noteRepoColors?: Record<string, string>;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  /** Danh sách worklog của ngày đang xem, mở ra để xoá. */
  const [logsOpen, setLogsOpen] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  /** Phân rã con số "tổng" theo ngày. `null` = chưa mở, `"loading"` = đang đọc. */
  const [spread, setSpread] = useState<
    null | "loading" | IssueWorklogDays | { error: string }
  >(null);
  const [pending, startTransition] = useTransition();
  const { refresh } = useNav();

  const today = subtask.loggedTodaySeconds;
  const entries = subtask.todayEntries ?? [];
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

      {/* Chỉ **tiêu đề và dòng nhánh** xếp chồng; mọi nút của hàng vẫn nằm
          ngoài, ở ô căn giữa.
          Lồng chúng vào trong khối hai dòng thì chúng bám theo dòng tiêu đề —
          đo được cao hơn tâm hàng 9.6px, tức lệch hẳn khỏi pill trạng thái,
          chip ngày và nút Log của cùng hàng đó.
          `BranchLine` tự trả về null khi task chưa có nhánh, nên hàng thường
          vẫn cao đúng 39px và khối này chỉ còn một dòng. */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px]" title={subtask.summary}>
              {subtask.summary}
            </span>
            <CopyBtn text={subtask.summary} what="tiêu đề" />
          </span>

          <BranchLine
            note={note}
            envs={noteEnvs}
            repos={noteRepos}
            repoLabels={noteRepoLabels}
            repoColors={noteRepoColors}
          />
        </span>

        {/* Hiện khi rê chuột, hoặc khi bàn phím đang ở trong hàng — một nút
            biến mất hẳn với người dùng bàn phím thì không chấp nhận được, nên
            `focus:` đi kèm `group-hover:`.
            Đứng ngoài khối tiêu đề, cùng hàng với nút ghi chú và badge quy
            ước: nằm trong khối đó thì nó bám dòng tiêu đề và lệch khỏi tâm
            hàng ở mọi task có dòng nhánh.
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

        {noteStages.length > 0 && (
          /* Hiện hẳn khi đã có ghi chú — lúc đó nút mang thông tin. Chưa có
             thì nó im như "Chi tiết", vì một ô trống trên mọi hàng chỉ làm
             bảng rậm thêm mà không nói gì. */
          <span
            className={
              "shrink-0 " +
              (note?.branch || note?.body
                ? ""
                : "opacity-0 focus-within:opacity-100 group-hover:opacity-100")
            }
          >
            <BranchNote
              issueKey={subtask.key}
              summary={subtask.summary}
              note={note}
              stages={noteStages}
            />
          </span>
        )}
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
        className="relative text-right font-mono text-[11px] text-ink-3"
      >
        {/* Con số hôm nay bấm được khi có log: đó là chỗ người ta nhìn khi nghi
            mình log nhầm, nên cũng là chỗ để sửa. Đọc từ Jira chứ không từ
            state sau khi log, nên chuyển tab rồi quay lại vẫn xoá được. */}
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setDelError(null);
              setLogsOpen((v) => !v);
            }}
            title="Xem và xoá từng worklog của ngày này"
            className="font-semibold text-ink-2 underline decoration-dotted underline-offset-2"
          >
            {formatDuration(today)}
          </button>
        ) : (
          <span>{today > 0 ? formatDuration(today) : "—"}</span>
        )}
        <span className="opacity-60"> · </span>
        {/* Con số tổng cũng bấm được, và trả lời một câu khác hẳn con số bên
            trái: không phải "hôm nay bao nhiêu" mà "ngần ấy giờ rải ở những
            ngày nào". Trước đó nó là chữ chết, và cách duy nhất để biết là mở
            Jira ra đọc tab Work log. */}
        {total > 0 ? (
          <button
            type="button"
            onClick={() => {
              if (spread) return setSpread(null);
              setSpread("loading");
              startTransition(async () => {
                const res = await issueWorklogDaysAction(subtask.key);
                setSpread(res.ok ? res.data : { error: res.message });
              });
            }}
            title={`${formatDuration(total)} này log vào những ngày nào?`}
            className="underline decoration-dotted underline-offset-2 hover:text-ink-2"
          >
            {formatDuration(total)}
          </button>
        ) : (
          "—"
        )}
        {spread && (
          <WorklogSpread
            issueKey={subtask.key}
            total={total}
            state={spread}
            onClose={() => setSpread(null)}
          />
        )}
        {logsOpen && (
          <WorklogList
            issueKey={subtask.key}
            entries={entries}
            pending={pending}
            error={delError}
            onClose={() => setLogsOpen(false)}
            onDelete={(id: string) =>
              startTransition(async () => {
                const res = await deleteWorklogsAction(subtask.key, [id]);
                if (res.ok) {
                  setLogsOpen(false);
                  setDelError(null);
                } else {
                  // Hiện ngay trong hộp đang mở, chỗ người dùng vừa bấm —
                  // không đẩy sang một ô khác trên hàng.
                  setDelError(res.message);
                }
                refresh();
              })
            }
          />
        )}
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
          dayBusy={dayBusy}
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
function WorklogList({
  issueKey,
  entries,
  pending,
  error,
  onClose,
  onDelete,
}: {
  issueKey: string;
  entries: Array<{ id: string; seconds: number; started: string }>;
  pending: boolean;
  error: string | null;
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
        {error && (
          <span className="px-1 font-sans text-[11px] leading-snug text-crit">
            {error}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Con số "tổng" rã ra theo ngày.
 *
 * Gộp theo **ngày**, không liệt kê từng entry: một ngày vắt qua giờ nghỉ nằm
 * trong Jira thành hai worklog, mà câu hỏi ở đây là "hôm nào" chứ không phải
 * "mấy lần" — nên số lần chỉ hiện khi nhiều hơn một, như một chú thích.
 *
 * Giờ của người khác tách riêng ở chân hộp. Con số trên hàng là field
 * `timespent` của Jira, tức mọi người cộng lại; không nói ra thì bảng rã ra
 * ít hơn con số vừa bấm và đọc như mất dữ liệu.
 */
function WorklogSpread({
  issueKey,
  total,
  state,
  onClose,
}: {
  issueKey: string;
  total: number;
  state: "loading" | IssueWorklogDays | { error: string };
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = typeof state === "object" && "days" in state ? state : null;
  const peak = data?.days.reduce((n, d) => Math.max(n, d.seconds), 0) ?? 0;

  return (
    <>
      <span
        className="fixed inset-0 z-20 cursor-default"
        onClick={onClose}
        aria-hidden
      />
      <span className="absolute right-0 top-[calc(100%+4px)] z-30 flex w-[244px] flex-col gap-1 rounded-md border border-line-strong bg-surface p-1.5 text-left shadow-lg">
        <span className="px-1 font-sans text-[10px] uppercase tracking-[0.06em] text-ink-3">
          {issueKey} · {formatDuration(total)} log vào ngày nào
        </span>

        {state === "loading" && (
          <span className="flex items-center gap-1.5 px-1 py-1 font-sans text-[11px] text-ink-3">
            <Spinner className="size-3" />
            Đang đọc worklog từ Jira…
          </span>
        )}

        {typeof state === "object" && "error" in state && (
          <span className="px-1 py-1 font-sans text-[11px] leading-snug text-crit">
            {state.error}
          </span>
        )}

        {data && data.days.length === 0 && (
          <span className="px-1 py-1 font-sans text-[11px] leading-snug text-ink-3">
            Không có worklog nào của bạn trên task này.
          </span>
        )}

        {data?.days.map((d) => (
          <span key={d.date} className="flex items-center gap-1.5">
            <span className="w-[66px] shrink-0 whitespace-nowrap font-mono text-[11px] text-ink-2">
              {dayLabel(d.date)}
            </span>
            {/* Vạch tỉ lệ so với ngày nhiều giờ nhất: một danh sách mười ngày
                toàn số thì phải đọc từng dòng mới thấy ngày nào nặng. */}
            <span className="h-[3px] flex-1 rounded-full bg-surface-2">
              <i
                style={{ width: `${peak ? (d.seconds / peak) * 100 : 0}%` }}
                className="block h-full rounded-full bg-accent"
              />
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink-2 tabular">
              {formatDuration(d.seconds)}
              {d.count > 1 && (
                <span className="ml-0.5 text-ink-3" title={`${d.count} entry`}>
                  ×{d.count}
                </span>
              )}
            </span>
          </span>
        ))}

        {data && data.othersSeconds > 0 && (
          <span className="border-t border-line px-1 pt-1 font-sans text-[10.5px] leading-snug text-ink-3">
            Của bạn {formatDuration(data.mineSeconds)} · người khác{" "}
            {formatDuration(data.othersSeconds)} — con số trên hàng là tổng của
            mọi người.
          </span>
        )}

        {data?.truncated && (
          <span className="px-1 font-sans text-[10.5px] leading-snug text-warn">
            Task này có quá nhiều worklog — danh sách trên chưa đủ.
          </span>
        )}
      </span>
    </>
  );
}

/**
 * `2026-09-29` → `T3 29/09`, và `T3 29/09/25` khi khác năm hiện tại.
 *
 * Năm chỉ hiện khi nó nói thêm điều gì. `T3 · 29/09/2026` đầy đủ cần hơn 86px
 * nên bị bẻ làm hai dòng trong hộp hẹp — mà mười hai chữ số năm giống hệt nhau
 * chồng lên nhau thì không ai đọc.
 */
function dayLabel(d: string): string {
  const wd = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][
    new Date(`${d}T00:00:00`).getDay()
  ];
  const sameYear = d.slice(0, 4) === String(new Date().getFullYear());
  return `${wd} ${d.slice(8, 10)}/${d.slice(5, 7)}${sameYear ? "" : `/${d.slice(2, 4)}`}`;
}
