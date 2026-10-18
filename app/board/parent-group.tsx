import type { BoardParent } from "@/lib/jira/types";
import type { DayOffKind } from "@/lib/quota";
import { getTeamScope } from "@/lib/settings";
import { DEFAULT_SCHEDULE, type WorkSchedule } from "@/lib/time";

import { CreateIssueButton } from "./create-issue";
import { ParentRow } from "./parent-row";
import { SubtaskRow } from "./subtask-row";

/**
 * Một task cha và các task con của nó, trên cùng bộ cột.
 *
 * Không còn là một thẻ riêng có viền: cả epic giờ nằm trong **một** bảng, và
 * hàng tiêu đề cột ở trên cùng dùng chung cho mọi nhóm. Mỗi nhóm một thẻ thì
 * mỗi thẻ lại cần một hàng tiêu đề của riêng nó — hoặc không có hàng nào, và
 * người đọc phải tự nhớ cột thứ tư là gì.
 */
export function ParentGroup({
  group,
  date,
  dateLabel,
  isToday,
  step,
  presets,
  budgets,
  sprintEnd = null,
  datesSupported = true,
  dayLoggedMinutes = 0,
  schedule = DEFAULT_SCHEDULE,
  dayOff = null,
  currentSprint = null,
  jiraBaseUrl = "",
}: {
  group: BoardParent;
  date: string;
  dateLabel: string;
  isToday: boolean;
  step: number;
  presets: number[];
  budgets: Record<number, string>;
  sprintEnd?: string | null;
  datesSupported?: boolean;
  dayLoggedMinutes?: number;
  schedule?: WorkSchedule;
  dayOff?: DayOffKind | null;
  currentSprint?: { id: number; name: string } | null;
  jiraBaseUrl?: string;
}) {
  const team = getTeamScope();
  const isOrphan = group.key === "__orphan__";

  return (
    <>
      <ParentRow
        group={group}
        team={team}
        datesSupported={datesSupported}
        sprintEnd={sprintEnd}
        currentSprint={currentSprint}
        jiraBaseUrl={jiraBaseUrl}
      />

      {group.subtasks.map((subtask) => (
        <SubtaskRow
          key={subtask.key}
          subtask={subtask}
          date={date}
          dateLabel={dateLabel}
          isToday={isToday}
          step={step}
          presets={presets}
          budgets={budgets}
          sprintEnd={sprintEnd}
          team={team}
          datesSupported={datesSupported}
          dayLoggedMinutes={dayLoggedMinutes}
          schedule={schedule}
          dayOff={dayOff}
          jiraBaseUrl={jiraBaseUrl}
        />
      ))}

      {/* Đứng sau task con cuối, đúng chỗ "thêm một cái nữa" thuộc về. */}
      {!isOrphan && (
        <CreateIssueButton
          parentKey={group.key}
          className="flex w-full items-center gap-1.5 border-b border-line px-3 py-1.5 text-left text-[12px] text-ink-3 last:border-b-0 hover:bg-surface-2 hover:text-accent-ink"
        >
          + Task con cho {group.key}
        </CreateIssueButton>
      )}
    </>
  );
}
