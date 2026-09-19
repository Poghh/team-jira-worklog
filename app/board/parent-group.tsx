import {
  isOwnedByOther,
  issueHygiene,
  loggedButTodo,
  statusTone,
} from "@/lib/jira/types";
import type { BoardParent } from "@/lib/jira/types";
import { getGitHubConfig, getStages } from "@/lib/modules/branches/config";
import { envSteps } from "@/lib/modules/branches/model";
import { taskNotesByIssue } from "@/lib/modules/branches/store";
import { isModuleEnabled } from "@/lib/modules/state";
import { listDaysOff } from "@/lib/days-off";
import { type DayOffKind, scheduleForDate } from "@/lib/quota";
import {
  SETTING_KEYS,
  getSetting,
  getTeamScope,
  getWorkSchedule,
} from "@/lib/settings";
import { formatDuration } from "@/lib/time";

import { CreateIssueButton } from "./create-issue";
import { DatesEditor } from "./dates-editor";
import { HygieneBadge } from "./hygiene-badge";
import { PointsEditor, PointsRollup } from "./points-editor";
import { SprintFixButton } from "./sprint-fix";
import { StatusPill } from "./status-pill";
import { SubtaskRow } from "./subtask-row";
import { TypeIcon } from "./type-icon";

/**
 * A parent task and its subtasks.
 *
 * The header is laid out as three lines rather than one: identity and the two
 * controls that act on the parent (status, points) sit on top where they are
 * reachable, the summary gets a full line so long Vietnamese titles do not
 * squeeze the controls, and the rollup sits underneath as supporting detail.
 */
export function ParentGroup({
  group,
  date,
  dateLabel,
  isToday,
  sprintEnd = null,
  datesSupported = true,
  dayLoggedSeconds = 0,
  myAccountId = null,
  currentSprint = null,
}: {
  group: BoardParent;
  date: string;
  dateLabel: string;
  isToday: boolean;
  /** End of the sprint on screen, offered as a one-click due date. */
  sprintEnd?: string | null;
  /** False on a project with neither date field — hides the chip entirely. */
  datesSupported?: boolean;
  /**
   * Everything this user has logged on the selected day, across every issue.
   * Drives the "what time will this land at" preview — the placement depends on
   * the whole day, not on this row.
   */
  dayLoggedSeconds?: number;
  /** Whose board this is, for deciding what may be edited on the parent. */
  myAccountId?: string | null;
  /** The sprint on screen, so a sprintless parent can be put into it. */
  currentSprint?: { id: number; name: string } | null;
}) {
  const step = Number(getSetting(SETTING_KEYS.logStepHours) ?? "0.5") || 0.5;
  const presets = (getSetting(SETTING_KEYS.logPresets) ?? "0.5,1,2,4,8")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const budgets: Record<number, string> = {
    1: getSetting(SETTING_KEYS.pointBudget1) ?? "1-2h",
    2: getSetting(SETTING_KEYS.pointBudget2) ?? "4h",
    3: getSetting(SETTING_KEYS.pointBudget3) ?? "1d-2d",
  };

  const team = getTeamScope();
  /**
   * The day being logged into, not a generic one.
   *
   * The preview on each row has to agree with what the server will write, and
   * the server now shifts a half day of leave onto its own half of the clock —
   * a preview still reading 09:00 would be the one number the user checks
   * against and the one that turns out wrong.
   */
  const daysOffToday = listDaysOff(date, date);
  const dayOff: DayOffKind | undefined = daysOffToday[date];
  const schedule = scheduleForDate(date, getWorkSchedule(), daysOffToday);
  const isOrphan = group.key === "__orphan__";

  // Branch notes, when the module is on. Read here rather than threaded down
  // from the page: these are local SQLite reads, and every other per-group
  // setting on this screen is fetched the same way.
  const notesOn = isModuleEnabled("branches");
  const notes = notesOn
    ? taskNotesByIssue(group.subtasks.map((s) => s.key))
    : {};
  const stages = notesOn ? getStages() : [];
  const envs = notesOn ? envSteps(stages) : [];
  const gh = notesOn ? getGitHubConfig() : null;

  /**
   * A parent someone else owns is shown but not touched: the subtask under it is
   * the user's work, its status, dates and estimate are not. An unassigned
   * parent stays editable — nobody's plan is being overwritten.
   */
  const ownedByOther = isOwnedByOther(group.assigneeAccountId, myAccountId);
  const hygiene = issueHygiene(group, team);
  const lockReason = ownedByOther
    ? `${group.key} do ${group.assigneeName} phụ trách — chỉ xem, không sửa được từ đây`
    : undefined;
  // Full logged time across every child, not just the ones the filter leaves
  // visible, so the header total doesn't shrink when Done subtasks are hidden.
  const loggedTotal = group.childTimeSpentTotal;

  return (
    <article className="rounded-[9px] border border-line bg-surface">
      <header className="rounded-t-[9px] border-b border-line bg-surface-2 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {!isOrphan && (
            <>
              {/* Tier marker, matching the Epic badge above it: the three levels
                  should be identifiable without counting indentation. */}
              <span className="rounded-[3px] bg-blue-soft px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-blue">
                Task cha
              </span>
              {/* The Jira issue type is separate — a parent may be a Task, a Bug
                  or an Improve, and which one matters when reading the board. */}
              <span className="inline-flex items-center gap-1 rounded-[3px] border border-line-strong px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3">
                <TypeIcon name={group.issueTypeName} className="size-3" />
                {group.issueTypeName}
              </span>
            </>
          )}

          <span className="font-mono text-[11.5px] font-semibold text-ink-2">
            {isOrphan ? "—" : group.key}
          </span>

          {!isOrphan && group.statusName && (
            <StatusPill
              issueKey={group.key}
              statusName={group.statusName}
              readOnly={ownedByOther}
              readOnlyReason={lockReason}
            />
          )}

          {/* Where a QC-filed Bug goes stale: hours logged on its children while
              the Bug itself never left To Do. */}
          {!isOrphan && loggedButTodo(loggedTotal, group.statusName) && (
            <span
              title={`${group.key} đã log ${formatDuration(loggedTotal)} nhưng vẫn đang To Do — nhớ chuyển trạng thái`}
              className="inline-flex h-[18px] items-center rounded-[3px] border border-warn bg-warn-soft px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] text-warn"
            >
              ⚠ vẫn To Do
            </span>
          )}

          {!isOrphan && <HygieneBadge hygiene={hygiene} />}

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
              className="inline-flex h-[18px] items-center gap-1 rounded-[3px] border border-line-strong px-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-ink-3"
            >
              🔒 {group.assigneeName}
            </span>
          )}

          <span className="ml-auto flex flex-wrap items-center gap-2">
            {loggedTotal > 0 && (
              <span className="font-mono text-[11px] text-ink-3">
                đã log {formatDuration(loggedTotal)}
              </span>
            )}
            {!isOrphan && datesSupported && (
              <DatesEditor
                issueKey={group.key}
                startDate={group.startDate}
                dueDate={group.dueDate}
                sprintEnd={sprintEnd}
                // Was missing, so a finished parent went red the day after its
                // due date and stayed that way — the one alarm nobody can act on.
                isDone={statusTone(group.statusName) === "done"}
                readOnly={ownedByOther}
                readOnlyReason={lockReason}
              />
            )}
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
        </div>

        <div className="mt-1.5 text-[13px]">{group.summary}</div>

        {!isOrphan && (
          <div className="mt-1">
            <PointsRollup
              value={group.storyPoints}
              childTotal={group.childPointsTotal}
              childCount={group.childCount}
            />
          </div>
        )}
      </header>

      <div className="flex flex-col">
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
            dayLoggedMinutes={Math.round(dayLoggedSeconds / 60)}
            schedule={schedule}
            dayOff={dayOff ?? null}
            note={notes[subtask.key] ?? null}
            noteStages={stages}
            noteEnvs={envs}
            noteRepos={gh?.repos ?? []}
            noteRepoLabels={gh?.repoLabels ?? {}}
            noteRepoColors={gh?.repoColors ?? {}}
          />
        ))}

        {/* Sits after the last subtask, where "one more" naturally belongs —
            the header is already carrying status and points. */}
        {!isOrphan && (
          <CreateIssueButton
            parentKey={group.key}
            className="flex w-full items-center gap-1.5 border-t border-line px-3.5 py-2 text-left text-[12px] text-ink-3 hover:bg-surface-2 hover:text-accent-ink"
          >
            + Task con cho {group.key}
          </CreateIssueButton>
        )}
      </div>
    </article>
  );
}
