import type { BoardParent } from "@/lib/jira/types";
import {
  isOwnedByOther,
  issueHygiene,
  loggedButTodo,
  statusTone,
} from "@/lib/jira/types";
import { formatDuration } from "@/lib/time";

import { BOARD_COLS, WIDE_ONLY } from "./columns";
import { CopyBtn } from "./copy";
import { DatesEditor } from "./dates-editor";
import { HygieneBadge } from "./hygiene-badge";
import { PointsEditor, PointsRollup } from "./points-editor";
import { SprintFixButton } from "./sprint-fix";
import { StatusPill } from "./status-pill";
import { JiraKey } from "./subtask-row";
import { TypeIcon } from "./type-icon";

/**
 * Task cha, trên cùng bộ cột với task con của nó.
 *
 * Dùng chung {@link BOARD_COLS} chứ không tự bày một hàng riêng: cha và con
 * đứng thẳng cột với nhau thì đọc ra ngay "point của cha là —, của ba con cộng
 * lại là 7" mà không phải dò. Bản trước để cha thành một dải chữ riêng ở trên,
 * và hai tầng không có cột nào trùng nhau.
 *
 * Ô cuối là chỗ ghi giờ của task con, nên ở hàng cha nó đổi vai: cảnh báo của
 * task cha đứng đó — sai quy ước, chưa gán sprint — thay vì bỏ trống.
 */
/**
 * Màu của tầng "task cha", theo **loại issue** của chính nó.
 *
 * Một Bug cha mà mang dải xanh của Task thì bảng đang nói sai về thứ quan
 * trọng nhất của hàng đó. Jira đã có màu cho từng loại — đỏ cam cho Bug, xanh
 * cho Task — nên bảng đi theo, không bịa hệ màu riêng.
 *
 * Nền **nhạt**, chữ đậm màu, và icon để nguyên màu Jira. Nền đặc thì icon phải
 * bị `brightness-0 invert` ép về trắng mới đọc được — mất luôn màu mà Jira đã
 * dùng để phân biệt loại, trong khi đó chính là thứ nhận ra nhanh nhất. Dải
 * EPIC ở trên vẫn đặc vì nó là tầng cao nhất và chỉ có một màu.
 */
function tierOf(typeName: string): { chip: string; band: string; bar: string } {
  const t = typeName.toLowerCase();
  if (t.includes("bug"))
    return {
      chip: "bg-orange-soft text-orange ring-1 ring-orange/40",
      band: "bg-orange-soft/60",
      bar: "border-l-orange",
    };
  if (t.includes("improve"))
    return {
      chip: "bg-good-soft text-good ring-1 ring-good/40",
      band: "bg-good-soft/60",
      bar: "border-l-good",
    };
  return {
    chip: "bg-blue-soft text-blue ring-1 ring-blue/40",
    band: "bg-blue-soft/60",
    bar: "border-l-blue",
  };
}

export function ParentRow({
  group,
  team = { label: null, prefix: null },
  datesSupported = true,
  sprintEnd = null,
  myAccountId = null,
  currentSprint = null,
  jiraBaseUrl = "",
}: {
  group: BoardParent;
  team?: { label: string | null; prefix: string | null };
  datesSupported?: boolean;
  sprintEnd?: string | null;
  /** Bảng này của ai, để quyết cái gì trên hàng cha được sửa. */
  myAccountId?: string | null;
  currentSprint?: { id: number; name: string } | null;
  jiraBaseUrl?: string;
}) {
  const isOrphan = group.key === "__orphan__";
  const tier = tierOf(group.issueTypeName);
  const hygiene = issueHygiene(group, team);
  /**
   * Task cha của người khác thì xem được, không sửa được: task con dưới nó là
   * việc của user này, còn trạng thái / ngày / ước lượng của cha thì không.
   * Cha chưa có ai nhận vẫn sửa được — không đè lên kế hoạch của ai cả.
   */
  const ownedByOther = isOwnedByOther(group.assigneeAccountId, myAccountId);
  const lockReason = ownedByOther
    ? `${group.key} do ${group.assigneeName} phụ trách — chỉ xem, không sửa được từ đây`
    : undefined;
  // Giờ của **mọi** task con, không chỉ những cái bộ lọc còn cho hiện, nên
  // tổng của cha không co lại khi ẩn task đã Done.
  const loggedTotal = group.childTimeSpentTotal;

  return (
    <div
      className={
        // Cùng ngữ pháp với dải epic, khác màu: nền nhạt + vạch đậm bên trái.
        // Ba tầng khi đó nhận ra được bằng màu chứ không phải bằng cách đếm
        // mức thụt lề — tím là epic, xanh là task cha, task con không có dải.
        // Dùng lại cặp `blue` vốn đã là màu của chip "Task cha", không bịa màu
        // mới.
        "group border-b border-line border-l-[3px] px-3 py-1.5 " +
        tier.bar +
        " " +
        tier.band +
        " " +
        BOARD_COLS
      }
    >
      <span className="flex items-center whitespace-nowrap">
        {isOrphan ? (
          <span className="font-mono text-[11.5px] text-ink-3">—</span>
        ) : (
          <>
            {/* Ô đặc màu, đúng ngữ pháp của chip EPIC ở dải trên: nền đặc,
                chữ trắng, icon bị `brightness-0 invert` ép về trắng — cách duy
                nhất đổi màu một <img> mà trình duyệt coi là đục. Chip viền
                nhạt như bản trước đọc ra là một nhãn phụ, không phải một tầng. */}
            <span
              title={group.issueTypeName}
              className={
                "mr-1 inline-flex items-center gap-0.5 rounded-[3px] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] " +
                tier.chip
              }
            >
              <TypeIcon name={group.issueTypeName} className="size-3" />
              Cha
            </span>
            <JiraKey issueKey={group.key} base={jiraBaseUrl} />
            <CopyBtn text={group.key} what="mã task cha" />
          </>
        )}
      </span>

      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[12.5px] text-ink-2" title={group.summary}>
          {group.summary}
        </span>
        {!isOrphan && <CopyBtn text={group.summary} what="tiêu đề" />}
        {!isOrphan && <HygieneBadge hygiene={hygiene} />}
      </span>

      {/* `min-w-0`: ô lưới mặc định không nhỏ hơn nội dung của nó, nên một
          trạng thái dài — "READY TO TEST ON DEVELOP" — đẩy pill tràn sang cột
          Ngày và đè lên chip ngày ở đó. */}
      <span className="min-w-0">
        {!isOrphan && group.statusName && (
          <StatusPill
            issueKey={group.key}
            statusName={group.statusName}
            compact
            readOnly={ownedByOther}
            readOnlyReason={lockReason}
          />
        )}
      </span>

      <span className={WIDE_ONLY}>
        {!isOrphan && datesSupported && (
          <DatesEditor
            issueKey={group.key}
            startDate={group.startDate}
            dueDate={group.dueDate}
            sprintEnd={sprintEnd}
            // Thiếu nó thì một task cha đã xong vẫn đỏ từ hôm sau due date trở
            // đi — đúng kiểu cảnh báo không ai làm gì được.
            isDone={statusTone(group.statusName) === "done"}
            childDates={group.subtasks.map((x) => ({
              startDate: x.startDate,
              dueDate: x.dueDate,
            }))}
            readOnly={ownedByOther}
            readOnlyReason={lockReason}
          />
        )}
      </span>

      <span className={WIDE_ONLY + " items-center justify-end gap-1"}>
        {!isOrphan && (
          <PointsEditor
            issueKey={group.key}
            value={group.storyPoints}
            suggestion={group.childPointsTotal || null}
            variant="parent"
            readOnly={ownedByOther}
            readOnlyReason={lockReason}
          />
        )}
      </span>

      <span className="text-right font-mono text-[11px] text-ink-3">
        {loggedTotal > 0 ? formatDuration(loggedTotal) : "—"}
      </span>

      <span className="flex flex-wrap items-center justify-end gap-1.5">
        {!isOrphan && (
          <PointsRollup
            value={group.storyPoints}
            childTotal={group.childPointsTotal}
            childCount={group.childCount}
          />
        )}
        {!isOrphan && loggedButTodo(loggedTotal, group.statusName) && (
          <span
            title={`${group.key} đã log ${formatDuration(loggedTotal)} nhưng vẫn đang To Do`}
            className="inline-flex h-[18px] items-center rounded-[3px] border border-warn bg-warn-soft px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-warn"
          >
            ⚠ vẫn To Do
          </span>
        )}
        {group.outOfSprint && (
          <span
            title={`${group.key} không thuộc sprint nào — task con của bạn vẫn hiện ở đây để log giờ`}
            className="inline-flex h-[18px] items-center rounded-[3px] border border-warn bg-warn-soft px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-warn"
          >
            ⚠ chưa gán sprint
          </span>
        )}
        {group.outOfSprint && currentSprint && !ownedByOther && (
          <SprintFixButton
            issueKey={group.key}
            sprintId={currentSprint.id}
            sprintName={currentSprint.name}
            addsLabel={hygiene.missingLabel ? team.label : null}
          />
        )}
        {ownedByOther && group.assigneeName && (
          <span
            title={lockReason}
            className="inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] border border-line-strong px-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3"
          >
            🔒 {group.assigneeName}
          </span>
        )}
      </span>
    </div>
  );
}
