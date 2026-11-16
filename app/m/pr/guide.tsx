"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import { CopyBtn } from "@/app/board/copy";
import { useBranchSuggest } from "@/app/m/branches/branch-suggest";
import {
  type PrGuideView,
  listBranchesAction,
  prGuideAction,
  suggestChangesAction,
  togglePrCheckAction,
} from "@/app/m/pr/actions";
import {
  type CheckItem,
  type CheckState,
  SECTION_TITLES,
  checklistProgress,
} from "@/lib/modules/pr/checklist";
import { cleanSummary, suggestPrBody } from "@/lib/modules/pr/suggest";

/** Một dòng trong danh sách: một PR đã có, hoặc một PR nên tạo. */
export interface PrEntry {
  /** Card của module Nhánh; vắng khi nhập tay. */
  cardId?: number;
  issueKey: string;
  title: string;
  repo: string;
  /** Nhánh của việc. */
  branch: string;
  /** Nhánh đích. */
  base: string;
  /** Các đích có thể của nhánh này (thang môi trường của card) — để đổi đích khi chưa có PR. */
  bases: string[];
  pr: { number: number; url: string; state: string } | null;
  updatedAt?: number;
}

/** PR đang xem: nhánh của việc → đích. */
interface Target {
  cardId?: number;
  repo: string;
  branch: string;
  base: string;
}

const MARK: Record<CheckState, { glyph: string; cls: string; title: string }> = {
  ok: { glyph: "✓", cls: "text-good", title: "App đã kiểm: đạt" },
  fail: { glyph: "✗", cls: "text-crit", title: "App đã kiểm: chưa đạt" },
  warn: { glyph: "!", cls: "text-warn", title: "App đã kiểm: đạt nhưng cần lưu ý" },
  wait: { glyph: "…", cls: "text-ink-3", title: "Chưa kiểm được — cần PR, hoặc đang chạy" },
  unknown: { glyph: "?", cls: "text-ink-3", title: "Chưa đủ dữ liệu để kiểm" },
};

const ROUTE_LABEL: Record<PrGuideView["route"], string> = {
  integration: "PR làm việc vào môi trường tích hợp",
  parent: "PR task con vào nhánh cha",
  hotfix: "Hotfix đi thẳng vào staging",
  env: "PR môi trường (Tech Lead)",
};

const idOf = (e: Pick<PrEntry, "repo" | "branch" | "base">) => `${e.repo}|${e.branch}|${e.base}`;
/** Bỏ tiền tố team — giống nhau ở mọi nhánh, chỉ chiếm chỗ. */
const short = (b: string) => b.replace(/^(ctalk|hir)\//, "");

/** Ô nhập của thanh `base ← compare`. */
interface Form {
  repo: string;
  base: string;
  head: string;
}

/**
 * Module "Git & PR", ba cột:
 *   - trái: danh sách PR đang mở / nhánh chưa có PR (đọc từ card của module
 *     Nhánh) — bấm một dòng là điền vào thanh chọn nhánh;
 *   - giữa: thanh `base ← compare` như GitHub, gợi ý PR và checklist;
 *   - phải: gợi ý tên nhánh từ ticket Jira.
 * Hai cột bên đứng yên khi cuộn. PR đang xem nằm trên URL để link từ card mở
 * thẳng đúng PR. App không tạo PR — chỉ là checklist để soát.
 */
export function PrGuide({
  open,
  todo,
  repos,
  initial,
  freshDays,
}: {
  open: PrEntry[];
  todo: PrEntry[];
  repos: string[];
  initial: PrEntry | null;
  freshDays: number;
}) {
  const [form, setForm] = useState<Form>({
    repo: initial?.repo ?? repos[0] ?? "",
    base: initial?.base ?? "ctalk/develop",
    head: initial?.branch ?? "",
  });
  const [sel, setSel] = useState<Target | null>(
    initial ? { cardId: initial.cardId, repo: initial.repo, branch: initial.branch, base: initial.base } : null,
  );

  const select = useCallback((t: Target) => {
    setSel(t);
    setForm({ repo: t.repo, base: t.base, head: t.branch });
    const qs = t.cardId
      ? new URLSearchParams({ card: String(t.cardId), repo: t.repo, base: t.base })
      : new URLSearchParams({ repo: t.repo, head: t.branch, base: t.base });
    window.history.replaceState(null, "", `/m/pr?${qs}`);
  }, []);

  /** Thanh chọn nhánh xác nhận một cặp — nhánh có card thì gắn card đó (mã task, summary Jira). */
  const commit = (f: Form) => {
    const repo = f.repo.trim();
    const base = f.base.trim();
    const head = f.head.trim();
    if (!repo || !base || !head || base === head) return;
    const card = [...open, ...todo].find((e) => e.repo === repo && e.branch === head && e.cardId);
    select({ cardId: card?.cardId, repo, branch: head, base });
  };

  return (
    <div data-wide className="mx-auto flex max-w-[1440px] flex-col gap-4">
      <header>
        <div className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">Module</div>
        <h1 className="text-xl font-semibold tracking-tight">⇄ Git &amp; PR</h1>
        <p className="mt-1 max-w-prose text-[12.5px] text-ink-3">
          Đặt tên nhánh, soát PR theo “Git &amp; Task Management Rules”. App không tạo hay sửa PR — bạn tự làm trên
          GitHub.
        </p>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)_300px]">
        <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <PrList open={open} todo={todo} freshDays={freshDays} selected={sel} onPick={select} />
        </aside>

        <main className="flex min-w-0 flex-col gap-3">
          <CompareBar repos={repos} form={form} onChange={setForm} onCommit={commit} />
          <section className="rounded-[10px] border border-line bg-surface">
            {sel ? (
              <Guide key={idOf(sel)} target={sel} />
            ) : (
              <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">
                Chọn một PR ở cột trái, hoặc chọn nhánh muốn PR vào (base) và nhánh của bạn (compare) — app gợi ý
                tiêu đề, label, mô tả và những gì cần tự soát.
              </p>
            )}
          </section>
        </main>

        <aside className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <BranchNameSuggest />
        </aside>
      </div>
    </div>
  );
}

/** Cột trái: PR đang mở và nhánh chưa có PR, mỗi cái một dòng gọn. */
function PrList({
  open,
  todo,
  freshDays,
  selected,
  onPick,
}: {
  open: PrEntry[];
  todo: PrEntry[];
  freshDays: number;
  selected: Target | null;
  onPick: (t: Target) => void;
}) {
  const [q, setQ] = useState("");
  const match = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (e: PrEntry) =>
      !needle ||
      [e.issueKey, e.title, e.branch, e.base, e.pr ? `#${e.pr.number}` : ""].some((t) =>
        t.toLowerCase().includes(needle),
      );
  }, [q]);
  const selId = selected ? idOf(selected) : "";

  const group = (title: string, hint: string, list: PrEntry[]) => {
    const rows = list.filter(match);
    return (
      <section className="flex flex-col gap-0.5">
        <h2 className="px-1 pb-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3" title={hint}>
          {title} · {rows.length}
        </h2>
        {rows.length === 0 ? (
          <p className="px-1 text-[12px] text-ink-3">Không có.</p>
        ) : (
          rows.map((e) => (
            <button
              key={idOf(e)}
              type="button"
              onClick={() => onPick({ cardId: e.cardId, repo: e.repo, branch: e.branch, base: e.base })}
              title={`${e.repo}\n${e.branch} → ${e.base}`}
              className={
                "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] " +
                (selId === idOf(e) ? "bg-accent-soft" : "hover:bg-surface-2")
              }
            >
              <span
                className={
                  "mt-px shrink-0 rounded-[4px] border px-1 font-mono text-[10.5px] font-semibold " +
                  (e.pr ? "border-accent text-accent-ink" : "border-dashed border-line-strong text-ink-3")
                }
              >
                {e.pr ? `#${e.pr.number}` : "mới"}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                {/* Tiêu đề tối đa 2 dòng; bỏ thẻ [CTALK][iOS Lite] — chiếm chỗ mà dòng nào cũng có. */}
                <span className="line-clamp-2">
                  {e.issueKey && <b className="font-semibold">{e.issueKey} </b>}
                  {cleanSummary(e.title) || short(e.branch)}
                </span>
                {/* Cùng một task có thể có nhánh ở hai repo — tên repo phân biệt hai dòng. */}
                <span className="truncate font-mono text-[11px] text-ink-3">
                  {e.repo.split("/").pop()} · {short(e.branch)} → {short(e.base)}
                </span>
              </span>
            </button>
          ))
        )}
      </section>
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-2.5">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Tìm mã task, nhánh, #PR…"
        className="w-full rounded-md border border-line-strong bg-ground px-2 py-1 text-[12.5px]"
      />
      {group("PR đang mở", "", open)}
      {group("Chưa có PR", `nhánh có commit trong ${freshDays} ngày qua`, todo)}
      <p className="px-1 text-[11px] text-ink-3">Bấm một dòng là điền vào thanh base ← compare.</p>
    </div>
  );
}

/**
 * Gợi ý tên nhánh từ một ticket Jira (mục 1): loại nhánh theo issue type —
 * Story/Epic → feature, Bug → bugfix (+ hotfix), Improve/Task → task; sub-task
 * và việc thuộc FR thì thêm nhánh task. Bấm tên là copy.
 */
function BranchNameSuggest() {
  const [raw, setRaw] = useState("");
  // Dán cả link Jira cũng được — lấy mã đầu tiên trong đó.
  const key = raw.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? "";
  const [copied, setCopied] = useState("");
  const suggest = useBranchSuggest(key, (name) => {
    void navigator.clipboard.writeText(name);
    setCopied(name);
  }, "copy");

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface p-2.5">
      <h2 className="px-1 font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">Gợi ý tên nhánh</h2>
      <div className="flex items-center gap-1.5">
        <input
          value={raw}
          onChange={(ev) => {
            setRaw(ev.target.value);
            setCopied("");
          }}
          placeholder="Mã Jira hoặc link"
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-ground px-2 py-1 font-mono text-[12.5px]"
        />
        {suggest.button}
      </div>
      {suggest.panel}
      {copied && (
        <p className="break-all text-[11.5px] text-good">
          Đã copy <code className="font-mono">{copied}</code>
        </p>
      )}
    </section>
  );
}

/**
 * Thanh `base ← compare` như trang compare của GitHub. Danh sách nhánh đọc từ
 * GitHub (chỉ đọc), mới đẩy trước. Chọn đúng một nhánh trong danh sách là đủ,
 * gõ tay thì bấm Kiểm.
 */
function CompareBar({
  repos,
  form,
  onChange,
  onCommit,
}: {
  repos: string[];
  form: Form;
  onChange: (f: Form) => void;
  onCommit: (f: Form) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [listErr, setListErr] = useState("");
  const [loading, startLoad] = useTransition();

  useEffect(() => {
    if (!form.repo) return;
    setListErr("");
    startLoad(async () => {
      const res = await listBranchesAction(form.repo);
      if (res.ok && res.branches) setBranches(res.branches);
      else {
        setBranches([]);
        setListErr(res.message);
      }
    });
  }, [form.repo]);

  const known = useMemo(() => new Set(branches), [branches]);
  const set = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    onChange(next);
    const v = (patch.base ?? patch.head ?? "").trim();
    if (v && known.has(v)) onCommit(next);
  };
  const same = form.base.trim() !== "" && form.base.trim() === form.head.trim();
  const box = "min-w-0 flex-1 rounded-md border border-line-strong bg-ground px-2 py-1 font-mono text-[12.5px]";

  return (
    <form
      className="flex flex-col gap-1 rounded-[10px] border border-line-strong bg-surface px-3 py-2.5 shadow-sm"
      onSubmit={(ev) => {
        ev.preventDefault();
        onCommit(form);
      }}
    >
      {/* Một dòng, như thanh compare của GitHub: repo · base ← compare. */}
      <div className="flex min-w-0 items-center gap-2">
        <select
          value={form.repo}
          onChange={(ev) => set({ repo: ev.target.value })}
          title={form.repo}
          className="w-[150px] shrink-0 truncate rounded-md border border-line-strong bg-ground px-2 py-1 font-mono text-[12.5px]"
        >
          {repos.map((r) => (
            <option key={r} value={r}>
              {/* Bỏ owner — cùng một org cho mọi repo. */}
              {r.split("/").pop()}
            </option>
          ))}
        </select>
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 text-[12px] text-ink-3">base</span>
          <input
            value={form.base}
            onChange={(ev) => set({ base: ev.target.value })}
            list="pr-branches"
            placeholder="nhánh đích"
            className={box}
          />
        </label>
        <span className="shrink-0 text-ink-3" aria-hidden>
          ←
        </span>
        <label className="flex min-w-0 flex-[1.3] items-center gap-1.5">
          <span className="shrink-0 text-[12px] text-ink-3">compare</span>
          <input
            value={form.head}
            onChange={(ev) => set({ head: ev.target.value })}
            list="pr-branches"
            placeholder={loading ? "đang đọc nhánh…" : "nhánh của bạn"}
            className={box}
          />
        </label>
        <button
          type="submit"
          disabled={!form.base.trim() || !form.head.trim() || same}
          className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-[12.5px] hover:bg-surface-2 disabled:opacity-50"
        >
          Kiểm
        </button>
        <datalist id="pr-branches">
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </div>
      {listErr && <p className="text-[12px] text-crit">{listErr}</p>}
      {same && <p className="text-[12px] text-warn">Nhánh nguồn trùng nhánh đích.</p>}
    </form>
  );
}

/** Checklist cho đúng một PR. Gắn `key` theo PR để đổi PR là làm mới hết. */
function Guide({ target }: { target: Target }) {
  const [view, setView] = useState<PrGuideView | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const load = useCallback(() => {
    setError("");
    start(async () => {
      const res = await prGuideAction(target);
      if (res.ok && res.view) setView(res.view);
      else setError(res.message);
    });
  }, [target]);

  useEffect(load, [load]);

  function toggle(item: CheckItem) {
    if (!view) return;
    const done = !view.ticked.includes(item.id);
    // Lạc quan: đổi ngay, server trả về danh sách thật thì lấy theo đó.
    setView({ ...view, ticked: done ? [...view.ticked, item.id] : view.ticked.filter((t) => t !== item.id) });
    start(async () => {
      const res = await togglePrCheckAction({ repo: view.repo, head: view.head, base: view.base, item: item.id, done });
      if (res.ok && res.ticked) setView((v) => (v ? { ...v, ticked: res.ticked! } : v));
      else setError(res.message);
    });
  }

  if (!view)
    return (
      <div className="px-5 py-4 text-[13px]">
        {error ? <p className="text-crit">{error}</p> : <p className="text-ink-3">Đang đọc PR từ GitHub và Jira…</p>}
      </div>
    );

  const ticked = new Set(view.ticked);
  const prog = checklistProgress(view.items, ticked);
  const sections = (["before", "open", "merge", "after"] as const).filter((s) =>
    view.items.some((i) => i.section === s),
  );

  return (
    <div className="text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
        <span className="min-w-0 flex-1 text-[12.5px] text-ink-2">
          {ROUTE_LABEL[view.route]}
          {/* PR môi trường đi từ môi trường trước, không phải nhánh trên dòng. */}
          {view.route === "env" && (
            <>
              : <code className="font-mono">{view.head}</code> → <code className="font-mono">{view.base}</code>
            </>
          )}
        </span>
        <span className={"font-mono text-[12px] " + (prog.failing ? "text-crit" : "text-good")}>
          {prog.done}/{prog.total} xong{prog.failing ? ` · ${prog.failing} chưa đạt` : ""}
        </span>
        {view.pr ? (
          <a
            href={view.pr.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-line-strong px-2 py-0.5 font-mono text-[12px] hover:bg-surface-2"
          >
            PR #{view.pr.number} · {view.pr.state.toLowerCase()} ↗
          </a>
        ) : (
          <span className="rounded-md border border-dashed border-line-strong px-2 py-0.5 text-[12px] text-ink-3">
            chưa có PR
          </span>
        )}
        <button
          type="button"
          onClick={load}
          disabled={pending}
          title="Đọc lại từ GitHub"
          className="rounded-md border border-line px-2 py-0.5 text-[12px] text-ink-3 hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? "Đang đọc…" : "↻ Đọc lại"}
        </button>
      </div>
      {error && <p className="px-4 pt-2 text-crit">{error}</p>}

      {/* Gợi ý cho PR: tiêu đề và label luôn hiện — thứ cần copy nhiều nhất;
          mô tả và commit squash dài, gập lại cho checklist khỏi bị đẩy xuống. */}
      <div className="mx-4 mt-3 flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="w-[64px] shrink-0 pt-px text-[12px] font-semibold text-ink-2">Tiêu đề</span>
          <span className="min-w-0 flex-1">
            <code className="break-words font-mono text-[12.5px]">{view.suggestedTitle}</code>
            <span
              className="mt-0.5 block text-[11px] text-ink-3"
              title={`Mẫu: ${view.titleSample}`}
            >
              {view.feature ? (
                <>
                  từ FR{" "}
                  <a href={view.feature.url} target="_blank" rel="noreferrer" className="underline hover:text-ink-2">
                    {view.feature.key}
                  </a>{" "}
                  trên Jira
                </>
              ) : (
                "từ summary task — không tìm thấy FR (Epic)"
              )}
            </span>
          </span>
          <CopyBtn text={view.suggestedTitle} what="tiêu đề PR" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[64px] shrink-0 text-[12px] font-semibold text-ink-2">Label</span>
          {view.label.label ? (
            <>
              <code className="rounded-[4px] border border-line-strong bg-surface px-1.5 font-mono text-[12.5px]">
                {view.label.label}
              </code>
              <CopyBtn text={view.label.label} what="label" />
            </>
          ) : (
            <span className="text-[12.5px]">không gắn</span>
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3" title={view.label.note}>
            {view.label.note}
          </span>
        </div>
        {view.body && <BodySuggestion view={view} input={view.body} />}
        {view.squashMessage && (
          <details className="group border-t border-line pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] font-semibold text-ink-2">
              <span className="text-ink-3 group-open:rotate-90">▸</span>
              <span className="flex-1">Commit khi Squash and merge</span>
              {/* Copy không được bật/tắt khối gập. */}
              <span onClick={(e) => e.preventDefault()}>
                <CopyBtn text={view.squashMessage} what="commit message" />
              </span>
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] text-ink-2">
              {view.squashMessage}
            </pre>
            <p className="text-[11px] text-ink-3">
              Thay nội dung GitHub điền sẵn: dòng đầu vào ô tiêu đề, phần còn lại vào ô mô tả.
            </p>
          </details>
        )}
      </div>

      <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
        {sections.map((s) => (
          <section key={s} className="flex flex-col gap-1">
            <h3 className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3">{SECTION_TITLES[s]}</h3>
            {view.items
              .filter((i) => i.section === s)
              .map((i) => (
                <Row key={i.id} item={i} ticked={ticked.has(i.id)} onToggle={() => toggle(i)} />
              ))}
          </section>
        ))}
      </div>


      <footer className="border-t border-line px-4 py-2.5 text-[11.5px] text-ink-3">
        ✓ ✗ app tự kiểm từ GitHub mỗi lần mở · ô vuông là tick tay, lưu theo PR (repo + nhánh nguồn + đích) · Theo “Git
        &amp; Task Management Rules”; không kiểm số approve. App không tạo hay sửa PR.
      </footer>
    </div>
  );
}

/**
 * Khung mô tả PR. Thay đổi mặc định lấy từ commit; bấm nút thì Claude đọc
 * commit + diff và viết lại danh sách đó.
 */
function BodySuggestion({ view, input }: { view: PrGuideView; input: NonNullable<PrGuideView["body"]> }) {
  const [ai, setAi] = useState<{ changes: string[]; model: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const fromCommits = input.changes?.length ?? 0;
  const body = suggestPrBody({ ...input, changes: ai?.changes ?? input.changes });

  function ask() {
    setError("");
    start(async () => {
      const res = await suggestChangesAction({ repo: view.repo, head: view.head, base: view.base });
      if (res.ok && res.changes) setAi({ changes: res.changes, model: res.model ?? "" });
      else setError(res.message);
    });
  }

  return (
    <details className="group border-t border-line pt-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] font-semibold text-ink-2">
        <span className="text-ink-3 group-open:rotate-90">▸</span>
        <span className="flex-1">Mô tả PR</span>
        <span onClick={(e) => e.preventDefault()}>
          <CopyBtn text={body} what="mô tả PR" />
        </span>
      </summary>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-ink-3">
          {ai
            ? `thay đổi do Claude đọc diff${ai.model ? ` · ${ai.model}` : ""}`
            : fromCommits
              ? `thay đổi lấy từ commit message (${fromCommits} dòng)`
              : "chưa có commit để lấy thay đổi"}
        </span>
        <button
          type="button"
          onClick={ask}
          disabled={pending}
          title="Claude Code CLI ở máy này đọc commit + diff (bỏ lock, pbxproj, asset) và viết danh sách thay đổi"
          className="rounded-md border border-line-strong bg-surface px-2 py-0.5 text-[11.5px] hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? "Claude đang đọc diff…" : ai ? "✦ Viết lại" : "✦ Claude đọc diff"}
        </button>
        {ai && (
          <button
            type="button"
            onClick={() => setAi(null)}
            className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-3 hover:bg-surface"
          >
            Dùng commit
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-[12px] text-crit">{error}</p>}
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] text-ink-2">{body}</pre>
      <p className="text-[11px] text-ink-3">Dán lên trên checklist của PR template, sửa lại nếu cần.</p>
    </details>
  );
}

function Row({ item, ticked, onToggle }: { item: CheckItem; ticked: boolean; onToggle: () => void }) {
  const detail = item.detail ? (
    <span className="mt-0.5 block whitespace-pre-line break-words text-[12px] text-ink-3">{item.detail}</span>
  ) : null;

  if (item.kind === "manual")
    return (
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
        <input type="checkbox" checked={ticked} onChange={onToggle} className="mt-[3px] size-[14px] shrink-0" />
        <span className={"min-w-0 " + (ticked ? "text-ink-3 line-through" : "")}>
          {item.text}
          {!ticked && detail}
        </span>
      </label>
    );

  const m = MARK[item.state ?? "unknown"];
  return (
    <div className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
      <span title={m.title} className={"w-[14px] shrink-0 text-center text-[14px] font-bold leading-[1.3] " + m.cls}>
        {m.glyph}
      </span>
      <span className="min-w-0">
        {item.text}
        {detail}
      </span>
    </div>
  );
}
