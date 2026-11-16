"use client";

import { useState, useTransition } from "react";

import { CopyBtn } from "@/app/board/copy";
import {
  type BranchSuggestData,
  branchSlugAction,
  branchSuggestAction,
} from "@/app/m/branches/actions";
import {
  type BranchSuggestion,
  TEAMS,
  branchSuggestions,
  createCmd,
  keyInBranch,
} from "@/lib/modules/branches/git-rules";

/** Bỏ tiền tố team khi hiển thị — giống nhau ở mọi dòng. */
const short = (b: string) => b.replace(/^(ctalk|hir)\//, "");

/** Chỗ chờ mô tả trong tên nhánh task của FR — Claude điền thay. */
const PLACEHOLDER = "_mo-ta-ngan";

/**
 * Nút "Gợi ý" tên nhánh và bảng lựa chọn bên dưới nó.
 *
 * Trả về hai mảnh rời — nút đứng cạnh ô nhập, bảng nằm dưới cả hàng — vì cả
 * hai chỗ dùng (popover 320px trên board task, form sửa card) đều chật bề
 * ngang: bảng thả xuống tuyệt đối thì bị cắt mép.
 *
 * Hỏi Jira một lần rồi tính ở trình duyệt: đổi `ctalk`/`hir` là đổi ngay.
 */
export function useBranchSuggest(
  issueKey: string,
  onPick: (name: string) => void,
  /** Bấm tên làm gì — mặc định là điền vào ô nhánh. */
  pickVerb = "điền",
) {
  const [data, setData] = useState<BranchSuggestData | null>(null);
  const [team, setTeam] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const key = issueKey.trim();

  function load() {
    if (open) return setOpen(false);
    setError("");
    setOpen(true);
    // Đã hỏi đúng key này rồi thì khỏi hỏi lại.
    if (data && data.issue.key === key.toUpperCase()) return;
    start(async () => {
      const res = await branchSuggestAction(key);
      if (res.ok && res.data) {
        setData(res.data);
        setTeam((t) => t || res.data!.team);
      } else {
        setData(null);
        setError(res.message);
      }
    });
  }

  const button = (
    <button
      type="button"
      onClick={load}
      disabled={!key || pending}
      title={
        key
          ? "Gợi ý tên nhánh theo quy tắc Git của team (đọc issue type từ Jira)"
          : "Nhập issue key trước"
      }
      className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11.5px] hover:bg-surface-2 disabled:opacity-50"
    >
      {pending ? "…" : "Gợi ý"}
    </button>
  );

  const list = data ? branchSuggestions(team || data.team, data.issue, data.envs) : [];

  const panel = open ? (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-2 text-[11.5px]">
      {error ? (
        <span className="text-crit">{error}</span>
      ) : !data ? (
        <span className="text-ink-3">Đang đọc {key} từ Jira…</span>
      ) : (
        <>
          <div className="flex items-center gap-1.5 text-ink-3">
            <span className="min-w-0 flex-1 truncate">
              {data.issue.type}
              {data.issue.parent ? ` · cha ${data.issue.parent.key} (${data.issue.parent.type})` : ""}
            </span>
            {TEAMS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTeam(t)}
                className={
                  "rounded px-1.5 py-px font-mono text-[10.5px] " +
                  ((team || data.team) === t
                    ? "bg-accent-soft text-accent-ink"
                    : "hover:bg-surface")
                }
              >
                {t}/
              </button>
            ))}
          </div>
          {list.map((s, i) => (
            <div
              key={s.name}
              className="flex flex-col gap-0.5 rounded border border-line bg-ground px-2 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    onPick(s.name);
                    setOpen(false);
                  }}
                  title={`Bấm để ${pickVerb} tên nhánh này`}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] font-semibold hover:text-accent-ink"
                >
                  {s.name}
                </button>
                <CopyBtn text={s.command} what="lệnh tạo nhánh" />
              </div>
              {/* Tên nhánh nguồn/đích dài và lặp ở mọi dòng: hiện rút gọn, đủ trong tooltip. */}
              <span
                className="text-[10.5px] text-ink-3"
                title={`Tách từ ${s.from}\nPR vào ${s.into}`}
              >
                {i === 0 ? "★ " : ""}
                {s.label}
                <span className="block truncate font-mono">
                  {short(s.from)} → {short(s.into)}
                </span>
              </span>
              {s.name.endsWith(PLACEHOLDER) && (
                <SlugSuggest
                  s={s}
                  pickVerb={pickVerb}
                  onPick={(name) => {
                    onPick(name);
                    setOpen(false);
                  }}
                />
              )}
            </div>
          ))}
          <span className="text-[10.5px] text-ink-3">
            Bấm tên để {pickVerb}. ⧉ copy lệnh tạo nhánh từ <code>origin</code> mới nhất.
          </span>
        </>
      )}
    </div>
  ) : null;

  return { button, panel };
}

/**
 * Claude gợi ý phần mô tả cho nhánh task của FR: đọc summary FR, các ticket
 * con còn mở, và mô tả bạn gõ (nếu có). Ra vài tên đầy đủ để chọn.
 */
function SlugSuggest({
  s,
  pickVerb,
  onPick,
}: {
  s: BranchSuggestion;
  pickVerb: string;
  onPick: (name: string) => void;
}) {
  const [hint, setHint] = useState("");
  const [slugs, setSlugs] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const stem = s.name.slice(0, -PLACEHOLDER.length);

  function ask() {
    setError("");
    start(async () => {
      const res = await branchSlugAction({ frKey: keyInBranch(stem), hint });
      if (res.ok && res.slugs) {
        setSlugs(res.slugs);
        setModel(res.model ?? "");
      } else setError(res.message);
    });
  }

  return (
    <div className="mt-1 flex flex-col gap-1 border-t border-line pt-1.5">
      <div className="flex items-center gap-1">
        <input
          value={hint}
          onChange={(ev) => setHint(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              ask();
            }
          }}
          placeholder="Bạn định làm gì? (tuỳ chọn, vd. ký header bằng DPoP)"
          className="min-w-0 flex-1 rounded border border-line-strong bg-surface px-1.5 py-0.5 text-[11.5px]"
        />
        <button
          type="button"
          onClick={ask}
          disabled={pending}
          title="Claude đọc summary FR, ticket con còn mở và mô tả của bạn để đặt mô tả nhánh"
          className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] hover:bg-surface disabled:opacity-50"
        >
          {pending ? "Claude đang nghĩ…" : slugs.length ? "✦ Gợi ý lại" : "✦ Gợi ý mô tả"}
        </button>
      </div>
      {error && <span className="text-[11px] text-crit">{error}</span>}
      {slugs.map((slug) => {
        const name = `${stem}_${slug}`;
        return (
          <div key={slug} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onPick(name)}
              title={`Bấm để ${pickVerb} tên nhánh này`}
              className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] hover:text-accent-ink"
            >
              {name}
            </button>
            <CopyBtn text={createCmd(name, s.from)} what="lệnh tạo nhánh" />
          </div>
        );
      })}
      {slugs.length > 0 && model && <span className="text-[10px] text-ink-3">Claude · {model}</span>}
    </div>
  );
}
