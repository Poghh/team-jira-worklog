"use client";

import { useState, useTransition } from "react";

import { saveNoteAction } from "@/app/m/branches/actions";
import { NotesEditor } from "@/app/m/branches/board";
import { EnvLadder, PR_CLS } from "@/app/m/branches/github-panel";
import {
  asPullRequest,
  githubLinkOf,
  parseEnvState,
  prBadge,
  repoLabel,
  repoSolidClass,
} from "@/lib/modules/branches/github-model";
import {
  type StageConfig,
  type TaskNoteRow,
  noteProgress,
  parseNotes,
  suggestBranch,
} from "@/lib/modules/branches/model";

import { Popover, PopoverTitle } from "./popover";

/**
 * Branch and notes for one subtask, edited without leaving the board.
 *
 * The board is where the work happens, so this is where the note gets written —
 * a second screen to visit is a second screen to forget. The `branches` module
 * owns the data; this only renders when that module is on, which is why a core
 * board component reaches into `app/m/branches` for its action.
 */
export function BranchNote({
  issueKey,
  summary,
  note,
  stages,
}: {
  issueKey: string;
  /** Seeds the title on a card that does not exist yet. */
  summary: string;
  note: TaskNoteRow | null;
  stages: StageConfig[];
}) {
  const [row, setRow] = useState<TaskNoteRow | null>(note);
  const has = Boolean(row?.branch || row?.body);
  // Counted once — the title used to parse the body twice to build one phrase.
  const prog = noteProgress(parseNotes(row?.body ?? ""));

  return (
    <Popover
      align="right"
      panelClassName="w-[320px]"
      trigger={() => (
        <button
          type="button"
          title={
            has
              ? `${row?.branch || "chưa có nhánh"} · ${prog.done}/${prog.total} lưu ý — bấm để sửa`
              : "Ghi nhánh và lưu ý cho task này"
          }
          className={
            "grid h-[26px] w-[26px] place-items-center rounded-md border text-[13px] " +
            (has
              ? "border-accent/40 bg-accent-soft text-accent-ink"
              : "border-line text-ink-3 hover:border-line-strong hover:text-ink")
          }
        >
          ⑂
        </button>
      )}
    >
      {(close) => (
        <Editor
          issueKey={issueKey}
          summary={summary}
          row={row}
          stages={stages}
          onSaved={(saved) => {
            setRow(saved);
            close();
          }}
          onCancel={close}
        />
      )}
    </Popover>
  );
}

function Editor({
  issueKey,
  summary,
  row,
  stages,
  onSaved,
  onCancel,
}: {
  issueKey: string;
  summary: string;
  row: TaskNoteRow | null;
  stages: StageConfig[];
  onSaved: (row: TaskNoteRow) => void;
  onCancel: () => void;
}) {
  const [branch, setBranch] = useState(row?.branch ?? "");
  const linkWas = row ? githubLinkOf(row) : "";
  const [link, setLink] = useState(linkWas);
  const [body, setBody] = useState(row?.body ?? "");
  const [stage, setStage] = useState(row?.stage ?? stages[0]?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await saveNoteAction({
        id: row?.id,
        issueKey,
        // The popover edits one subtask's card; it never changes which tickets
        // that card covers, so whatever it already holds is carried through.
        issueKeys: row?.issueKeys ?? [issueKey],
        // The card keeps its own title once it has one; otherwise it takes the
        // summary as it reads now.
        title: row?.title || summary,
        branch,
        stage,
        body,
        // The popover has no Jira-link field; keep whatever the card holds.
        jiraUrls: row?.jiraUrls ?? {},
        // The popover has no build field either; keep whatever the card holds.
        build: row?.build ?? "",
        buildBranch: row?.buildBranch ?? "",
        buildAt: row?.buildAt ?? 0,
        builds: row?.builds ?? [],
        // The popover has no PR field; keep whatever the card pinned.
        prPins: row?.prPins ?? [],
        // The popover has no branch picker per repo either.
        branchPins: row?.branchPins ?? [],
        // Sent only when touched, so saving a note never disturbs the pairing.
        ...(link.trim() === linkWas.trim() ? {} : { githubLink: link }),
      });
      if (res.ok && res.row) onSaved(res.row);
      else setError(res.message);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <PopoverTitle>Nhánh &amp; lưu ý · {issueKey}</PopoverTitle>

      <div className="flex gap-1.5">
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="feature/…"
          className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-[12px]"
        />
        <button
          type="button"
          onClick={() =>
            setBranch(suggestBranch(issueKey, row?.title || summary))
          }
          title="Dựng tên nhánh từ key + tiêu đề"
          className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11.5px] hover:bg-surface-2"
        >
          Gợi ý
        </button>
      </div>

      <input
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="link GitHub — sửa nếu ghép nhầm repo"
        title="Dán URL nhánh hoặc pull request. Sửa vào đây sẽ ghim, quét sau không đổi nhánh nữa."
        className="rounded-md border border-line bg-ground px-2 py-1 font-mono text-[11px]"
      />

      <select
        value={stage}
        onChange={(e) => setStage(e.target.value)}
        className="rounded-md border border-line bg-ground px-2 py-1 text-[12px]"
      >
        {stages.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>

      <NotesEditor value={body} onChange={setBody} />

      {error && <p className="text-[11.5px] text-crit">{error}</p>}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:bg-accent-2 disabled:opacity-60"
        >
          {pending ? "Đang lưu…" : "Lưu"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] hover:bg-surface-2"
        >
          Huỷ
        </button>
        <a
          href="/m/branches"
          className="ml-auto text-[11.5px] text-accent-ink underline underline-offset-2"
        >
          Mở bảng
        </a>
      </div>
    </div>
  );
}

/** The branch line under a subtask summary — only when there is something to show. */
export function BranchLine({
  note,
  envs = [],
  repos = [],
  repoLabels = {},
  repoColors = {},
}: {
  note: TaskNoteRow | null;
  /** The deployment pipeline, so the row can show how far the code got. */
  envs?: StageConfig[];
  /** Watched repos and their short names — a subtask can live in either one. */
  repos?: string[];
  repoLabels?: Record<string, string>;
  repoColors?: Record<string, string>;
}) {
  if (!note?.branch && !note?.body) return null;
  const prog = noteProgress(parseNotes(note.body));
  // The strip shows one request, taken from the first side — the same one the
  // card's own flat columns describe. It is a one-line summary on another
  // screen; a list would break the layout, and the card is where the rest is.
  const first = note.sides[0]?.prs[0];
  const badge = prBadge(first ? asPullRequest(first) : null);

  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-ink-3">
      {note.repo && (
        <span
          title={note.repo}
          className={
            "shrink-0 rounded-[3px] px-1 py-px text-[9.5px] font-bold uppercase tracking-[0.04em] " +
            repoSolidClass(repoColors[note.repo])
          }
        >
          {repoLabel(note.repo, repoLabels, repos)}
        </span>
      )}
      {note.branch && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-accent-ink">⑂</span>
          <span className="truncate">{note.branch}</span>
        </span>
      )}
      {note.stage && (
        <span className="rounded-[3px] bg-surface-2 px-1 py-px text-[9.5px]">
          {note.stage}
        </span>
      )}
      {(note.localOnly || note.localAhead > 0) && (
        <span
          title={
            note.localOnly
              ? "Chỉ có trên máy bạn — chưa push"
              : `${note.localAhead} commit chưa đẩy lên server`
          }
          className={note.localOnly ? "text-warn" : "text-ink-2"}
        >
          ⇡ {note.localOnly ? "chưa push" : note.localAhead}
        </span>
      )}
      <EnvLadder
        state={parseEnvState(note.envState)}
        envs={envs}
        expected={Boolean(note.repo && note.branch && !note.localOnly)}
      />
      {badge && (
        <a
          href={note.prUrl}
          target="_blank"
          rel="noreferrer"
          title={`Mở PR trên GitHub${note.repo ? ` · ${note.repo}` : ""}`}
          className={
            "rounded-[3px] border px-1 py-px text-[9.5px] font-semibold hover:underline " +
            PR_CLS[badge.tone]
          }
        >
          {badge.label}
        </a>
      )}
      {prog.total > 0 && (
        <span
          title={parseNotes(note.body)
            .map((i) => `${i.done ? "☑" : "☐"} ${i.text}`)
            .join("\n")}
          className={prog.done === prog.total ? "text-good" : "text-ink-3"}
        >
          ✎ {prog.done}/{prog.total}
        </span>
      )}
    </span>
  );
}
