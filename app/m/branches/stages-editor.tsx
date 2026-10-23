"use client";

import { useRef, useState, useTransition } from "react";

import {
  envSteps,
  stageRule,
  type StageConfig,
  type StagePair,
} from "@/lib/modules/branches/model";
import {
  GROUP_LABEL,
  fromGroups,
  groupBranch,
  groupExpects,
  groupName,
  groupPairs,
  groupProblem,
  newGroup,
  retagGroup,
  renameGroup,
  setGroupBranch,
  setGroupExpects,
  setGroupKind,
  setGroupPairs,
  toGroups,
  type GroupTag,
  type StageGroup,
} from "@/lib/modules/branches/stage-groups";

import { saveStagesAction } from "./actions";

const CARD = "rounded-[9px] border border-line bg-surface p-[17px]";
const CTITLE = "font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3";
const BTN =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-2";
const BTN_PRI =
  "rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:bg-accent-2 disabled:opacity-50";
const INP = "rounded-md border border-line bg-ground px-2 py-1 text-[12.5px]";
const SEL = "rounded-md border border-line bg-ground px-2 py-1 text-[12px]";
const LBL = "shrink-0 text-[11.5px] text-ink-3";

/**
 * Lựa chọn cho ô ngưỡng cảnh báo, gọi đúng tên trạng thái của Jira.
 *
 * Tên lấy nguyên văn từ project chứ không diễn đạt lại: ô này nói về trạng
 * thái trên Jira, và một cái tên gần đúng thì người dùng phải tự đoán nó ứng
 * với trạng thái nào — mà đoán sai thì cảnh báo trên bảng sai theo.
 */
function expectLabels(
  env: string,
  statusNames: string[],
): { value: StageConfig["expects"]; label: string }[] {
  const up = env.trim().toUpperCase();
  const find = (p: string) =>
    statusNames.find((n) => n.trim().toUpperCase() === p) ?? "";
  const ready = up ? find(`READY TO TEST ON ${up}`) : "";
  const verified = up ? find(`VERIFIED ON ${up}`) : "";
  const done = find("DONE");

  return [
    { value: "", label: "— không kiểm tra —" },
    { value: "prog", label: find("IN PROGRESS") || "In Progress" },
    {
      value: "test",
      label:
        ready || (up ? `(Jira chưa có READY TO TEST ON ${up})` : "(cần điền nhánh)"),
    },
    {
      value: "done",
      // Cột gắn môi trường thì `VERIFIED` trên chính môi trường ấy đã thoả;
      // cột cuối không gắn môi trường nào nên nó đòi đúng `Done`.
      label: verified || done || "Done",
    },
  ];
}

const BADGE: Record<GroupTag, string> = {
  kind: "border-line bg-surface-2 text-ink-3",
  review: "border-warn bg-warn-soft text-warn",
  env: "border-accent bg-accent-soft text-accent",
  end: "border-good bg-good-soft text-good",
  raw: "border-line-strong bg-ground text-ink-3",
};

/**
 * Câu một dòng mô tả nhóm, đủ để không phải mở chi tiết ra xem.
 *
 * `full` là câu đầy đủ, treo ở tooltip. Dòng chỉ in vế đầu: `stageRule` vốn
 * viết cho một màn hình mỗi cột một dòng riêng, nên phần sau dấu gạch của nó
 * đụng ngay dấu gạch của dòng này — "resolve — nhánh resolve chưa mở PR —
 * hoặc PR còn draft" có hai dấu gạch mà không dấu nào ngăn đúng ý.
 */
function summaryOf(g: StageGroup): { text: string; warn: boolean; full: string } {
  const full = g.cols.map((s) => stageRule(s)).join(" · ");
  if (g.tag === "env" || g.tag === "end") {
    const b = groupBranch(g);
    if (!b) return { text: "chưa chọn nhánh", warn: true, full };
    return {
      text: g.tag === "env" ? `nhánh ${b}` : `code đã về ${b}`,
      warn: false,
      full,
    };
  }
  if (g.tag === "review") {
    const rules = groupPairs(g).filter((r) => r.into.trim());
    return rules.length
      ? {
          text: rules.map((r) => `${r.from || "mọi loại"} → ${r.into}`).join(", "),
          warn: false,
          full,
        }
      : { text: "chưa có rule nào — cột không nhận nhánh nào", warn: true, full };
  }
  // Sinh từ đúng những trường engine đọc, nên không thể lệch với nó.
  return { text: stageRule(g.cols[0]).split(" — ")[0], warn: false, full };
}

export function StagesManager({
  stages,
  statusNames,
  branchOptions,
  kindOptions,
}: {
  stages: StageConfig[];
  statusNames: string[];
  /** Nhánh dài hạn thấy trong repo, để ô nhánh là chọn chứ không phải gõ. */
  branchOptions: string[];
  /** Loại nhánh thấy trong repo, kèm số nhánh — chỉ là gợi ý, user vẫn gõ được. */
  kindOptions: { kind: string; n: number }[];
}) {
  const [groups, setGroups] = useState<StageGroup[]>(() =>
    stages.length ? toGroups(stages) : [newGroup("kind")],
  );
  const [open, setOpen] = useState<number | null>(null);
  /**
   * Dòng đang kéo, giữ ở ref chứ không chỉ ở state.
   *
   * `onDrop` phải đọc được chỉ số ngay trong lượt của nó. State thì React mới
   * đặt lịch cập nhật, nên nếu hai sự kiện rơi vào cùng một lượt dựng lại —
   * kéo rất nhanh, hoặc một thư viện nào đó phát sự kiện tổng hợp — `onDrop`
   * đọc trúng giá trị cũ và cú kéo im lặng không làm gì. State bên dưới chỉ để
   * vẽ mờ dòng đang kéo.
   */
  const dragRef = useRef<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const list = fromGroups(groups);
  const problems = groups
    .map((g, i) => ({ i, why: groupProblem(g) }))
    .filter((p) => p.why);
  const patch = (i: number, g: StageGroup) =>
    setGroups((l) => l.map((x, n) => (n === i ? g : x)));

  function drop(to: number) {
    const from = dragRef.current;
    setGroups((l) => {
      if (from === null || from === to) return l;
      const next = [...l];
      const [moved] = next.splice(from, 1);
      next.splice(from < to ? to - 1 : to, 0, moved);
      return next;
    });
    // Chi tiết đang mở bám theo chỉ số, mà chỉ số vừa đổi hết — đóng lại còn
    // hơn mở nhầm một nhóm khác.
    setOpen(null);
    dragRef.current = null;
    setDrag(null);
    setOver(null);
  }

  /**
   * Thêm một dòng và mở nó ra ngay.
   *
   * Một nút chứ không phải bốn: loại dòng là ô đầu tiên của phần chi tiết,
   * nên chọn loại và đặt tên là cùng một thao tác ở cùng một chỗ. Bốn nút thì
   * loại đã bị chốt trước khi người dùng thấy dòng, và đổi ý là phải xoá đi
   * thêm lại.
   *
   * Loại mặc định là "loại nhánh" — một cột, không đòi nhánh, nên là dòng ít
   * dở dang nhất trong lúc người dùng còn chưa chọn.
   */
  function add() {
    setGroups((l) => [...l, newGroup("kind")]);
    setOpen(groups.length);
  }

  function save() {
    if (problems.length) {
      setNote(
        "Chưa lưu được — " +
          problems.map((p) => `dòng ${p.i + 1} ${p.why}`).join(", "),
      );
      setOpen(problems[0].i);
      return;
    }
    startTransition(async () => {
      const res = await saveStagesAction(list);
      setNote(res.message);
      // Card gom theo **tên cột**, nên đổi tên là card trỏ vào một cột không
      // còn tồn tại — bảng dồn chúng vào khối "không thuộc cột nào" chứ không
      // làm mất.
      if (res.ok) location.reload();
    });
  }

  return (
    <section className={CARD}>
      <div className={CTITLE}>Đường đi của code</div>
      <p className="mt-1 max-w-prose text-[12.5px] text-ink-3">
        <b>Một danh sách duy nhất, đúng thứ tự thật.</b> Kéo{" "}
        <span className="font-mono">⠿</span> để sắp xếp, bấm một dòng để sửa chi
        tiết. App không tự sinh dòng nào — bạn thêm bằng nút ở cuối rồi chọn
        loại ngay trong dòng. Một dòng <b>môi trường</b> thành ba cột trên
        bảng; các dòng khác thành một.
      </p>

      {/* Thứ tự môi trường, nói thẳng ra. Nó vốn đã được suy từ danh sách này,
          nhưng không màn hình nào nói điều đó — nên người dùng không có cách
          nào biết app đang hiểu đường ống thế nào cho tới lúc nhìn một card và
          thấy nó sai. */}
      <EnvPipeline list={list} />

      <datalist id="stage-kinds">
        {kindOptions.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.n} nhánh trong repo
          </option>
        ))}
      </datalist>

      <div className="mt-3 flex flex-col gap-1.5">
        {groups.map((g, i) => {
          const sum = summaryOf(g);
          return (
            <div key={i}>
              <div
                draggable
                onDragStart={() => {
                  dragRef.current = i;
                  setDrag(i);
                }}
                onDragEnd={() => {
                  dragRef.current = null;
                  setDrag(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (dragRef.current === null || dragRef.current === i) return;
                  e.preventDefault();
                  setOver(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(i);
                }}
                onClick={() => setOpen(open === i ? null : i)}
                title={sum.full}
                className={
                  "flex items-center gap-2.5 rounded-lg border bg-surface px-[11px] py-2 hover:border-line-strong " +
                  (drag === i ? "opacity-40 " : "") +
                  (over === i ? "border-t-2 border-t-accent " : "") +
                  (open === i
                    ? "rounded-b-none border-accent"
                    : groupProblem(g)
                      ? "border-warn"
                      : "border-line")
                }
              >
                <span
                  title="Kéo để đổi thứ tự"
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-grab select-none px-0.5 text-[13px] leading-none text-ink-3 active:cursor-grabbing"
                >
                  ⠿
                </span>
                <span className="w-4 shrink-0 text-center font-mono text-[11px] text-ink-3">
                  {i + 1}
                </span>
                <span
                  className={
                    "w-[92px] shrink-0 rounded border py-0.5 text-center font-mono text-[9.5px] uppercase tracking-[0.05em] " +
                    BADGE[g.tag]
                  }
                >
                  {GROUP_LABEL[g.tag]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  {/* Ngoặc chứ không phải gạch: vế sau đã mở đầu bằng một
                      dấu gạch rồi, hai cái liền nhau thì không cái nào còn
                      ngăn được gì. */}
                  {groupName(g) || (
                    <span className="text-warn">(chưa đặt tên)</span>
                  )}{" "}
                  <span className={sum.warn ? "text-warn" : "text-ink-3"}>
                    — {sum.text}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-ink-3">
                  {g.cols.length} cột
                </span>
                <button
                  type="button"
                  title="Bỏ dòng này"
                  onClick={(e) => {
                    e.stopPropagation();
                    setGroups((l) => l.filter((_, n) => n !== i));
                    setOpen(null);
                  }}
                  className="shrink-0 rounded px-1.5 text-[13px] text-ink-3 hover:bg-crit-soft hover:text-crit"
                >
                  ✕
                </button>
              </div>

              {open === i && (
                <div className="rounded-b-lg border border-t-0 border-accent bg-ground px-[13px] py-[11px]">
                  <Detail
                    g={g}
                    list={list}
                    statusNames={statusNames}
                    branchOptions={branchOptions}
                    onChange={(next) => patch(i, next)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3">
        <button type="button" onClick={add} className={BTN}>
          + Thêm dòng
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <button type="button" onClick={save} disabled={pending} className={BTN_PRI}>
          {pending ? "Đang lưu…" : "Lưu"}
        </button>
        {note && (
          <span
            className={
              "text-[12px] " + (problems.length ? "text-warn" : "text-ink-3")
            }
          >
            {note}
          </span>
        )}
        <span className="text-[11.5px] text-ink-3">
          Đổi cột xong nên chạy lại quét — card sẽ tự xếp về đúng chỗ.
        </span>
      </div>

      {/* Đường thoát, không khoá cứng: khuôn trên gói được mọi cấu hình bình
          thường, nhưng nó vẫn là một khuôn — và người dùng phải xem được đúng
          thứ engine sẽ đọc, không chỉ bản tóm tắt. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-[11.5px] text-ink-3 hover:text-ink-2">
          Xem dạng cột chi tiết ({list.length} cột engine thật sự đọc)
        </summary>
        <ol className="mt-1.5 flex flex-col gap-px pl-5 text-[11.5px] text-ink-3">
          {list.map((s, n) => (
            <li key={n} className="list-decimal">
              <span className="font-mono text-ink-2">{s.name}</span> —{" "}
              {stageRule(s)}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

/* --------------------------- chi tiết một nhóm --------------------------- */

function Detail({
  g,
  list,
  statusNames,
  branchOptions,
  onChange,
}: {
  g: StageGroup;
  list: StageConfig[];
  statusNames: string[];
  branchOptions: string[];
  onChange: (g: StageGroup) => void;
}) {
  const name = (
    <>
      {/* Ô đầu tiên, trước cả tên: nó quyết định những ô còn lại là gì. */}
      <span className={LBL}>loại dòng</span>
      <select
        value={g.tag}
        onChange={(e) =>
          onChange(retagGroup(g, e.target.value as Exclude<GroupTag, "raw">))
        }
        className={`w-[130px] ${SEL}`}
      >
        {(["kind", "env", "review", "end"] as const).map((t) => (
          <option key={t} value={t}>
            {GROUP_LABEL[t]}
          </option>
        ))}
        {/* Chỉ hiện khi dòng đang là cột lẻ, để nó không mất tăm khỏi ô này
            trước khi người dùng kịp chọn loại khác. */}
        {g.tag === "raw" && <option value="raw">{GROUP_LABEL.raw}</option>}
      </select>
      <span className={LBL}>tên cột</span>
      <input
        value={groupName(g)}
        onChange={(e) => onChange(renameGroup(g, e.target.value))}
        placeholder="tên"
        className={`w-[150px] ${INP}`}
      />
    </>
  );

  const expects = (
    <ExpectPicker g={g} list={list} statusNames={statusNames} onChange={onChange} />
  );

  if (g.tag === "env")
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          {name}
          <span className={LBL}>nhánh</span>
          <BranchPicker
            value={groupBranch(g)}
            options={branchOptions}
            onChange={(b) => onChange(setGroupBranch(g, b))}
          />
          <span className={LBL}>sau khi build, ticket ít nhất ở</span>
          {expects}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-3">
          Thành 3 cột:{" "}
          {g.cols.map((s, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <code className="font-mono text-ink-2">{s.name || "—"}</code>
            </span>
          ))}
        </p>
      </>
    );

  if (g.tag === "end")
    return (
      <div className="flex flex-wrap items-center gap-2">
        {name}
        <span className={LBL}>code đã về nhánh</span>
        <BranchPicker
          value={groupBranch(g)}
          options={branchOptions}
          onChange={(b) => onChange(setGroupBranch(g, b))}
        />
        <span className={LBL}>ticket ít nhất ở</span>
        {expects}
      </div>
    );

  if (g.tag === "review") return <ReviewDetail g={g} onChange={onChange} name={name} expects={expects} />;

  if (g.tag === "kind")
    return (
      <div className="flex flex-wrap items-center gap-2">
        {name}
        <span className={LBL}>nhận nhánh loại</span>
        <input
          value={g.cols[0].kind}
          list="stage-kinds"
          onChange={(e) => onChange(setGroupKind(g, e.target.value))}
          placeholder="— mọi loại —"
          title={
            "Khớp theo một đoạn của tên nhánh: `feature` khớp ctalk/feature/VT-1, " +
            "không khớp ctalk/bugfix/resolve_feature.\nĐể trống thì cột nhận mọi loại."
          }
          className={`w-[150px] font-mono ${INP}`}
        />
        <span className={LBL}>ticket ít nhất ở</span>
        {expects}
      </div>
    );

  // Cột lẻ: không khớp khuôn nào, nên sửa thẳng từng trường như bản cũ.
  const s = g.cols[0];
  const set = (p: Partial<StageConfig>) => onChange({ ...g, cols: [{ ...s, ...p }] });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {name}
      <span className={LBL}>nhánh</span>
      <input
        value={s.branch}
        onChange={(e) => set({ branch: e.target.value })}
        className={`w-[150px] font-mono ${INP}`}
      />
      <span className={LBL}>card vào cột khi</span>
      <select
        value={s.branch.trim() ? s.reach : `phase:${s.phase}`}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith("phase:"))
            set({ reach: "queued", phase: v.slice(6) as StageConfig["phase"] });
          else set({ reach: v as StageConfig["reach"] });
        }}
        className={SEL}
      >
        {s.branch.trim() ? (
          <>
            <option value="queued">có PR đang mở vào nhánh</option>
            <option value="merged">code đã nằm trong nhánh</option>
            <option value="built">đã có bản build</option>
          </>
        ) : (
          <>
            <option value="phase:nopr">chưa mở PR</option>
            <option value="phase:open">PR đang mở</option>
            <option value="phase:">không khớp cột nào khác</option>
          </>
        )}
      </select>
      {expects}
    </div>
  );
}

/**
 * Rule review: nhánh loại X gửi PR vào nhánh loại Y.
 *
 * Mỗi rule một dòng, thêm bằng nút chứ không ngăn bằng dấu phẩy — một ô chứa
 * `task, bugfix` đọc được nhưng không nói ra được rằng cả hai cùng nhắm vào
 * `feature`, và cũng không cho hai rule khác đích.
 */
function ReviewDetail({
  g,
  onChange,
  name,
  expects,
}: {
  g: StageGroup;
  onChange: (g: StageGroup) => void;
  name: React.ReactNode;
  expects: React.ReactNode;
}) {
  const rules = groupPairs(g);
  const setRules = (next: StagePair[]) => onChange(setGroupPairs(g, next));

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {name}
        <span className="ml-auto flex items-center gap-2">
          <span className={LBL}>ticket ít nhất ở</span>
          {expects}
        </span>
      </div>
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 py-[3px]">
          <span className="w-4 shrink-0 text-center font-mono text-[11px] text-ink-3">
            {i + 1}
          </span>
          <span className={LBL}>nhánh loại</span>
          <input
            value={r.from}
            list="stage-kinds"
            onChange={(e) =>
              setRules(rules.map((x, n) => (n === i ? { ...x, from: e.target.value } : x)))
            }
            placeholder="— mọi loại —"
            className={`w-[150px] font-mono ${INP}`}
          />
          <span className={LBL}>gửi PR vào nhánh loại</span>
          <input
            value={r.into}
            list="stage-kinds"
            onChange={(e) =>
              setRules(rules.map((x, n) => (n === i ? { ...x, into: e.target.value } : x)))
            }
            placeholder="— chưa khai —"
            className={
              "w-[150px] shrink-0 rounded-md border bg-ground px-2 py-1 font-mono text-[12.5px] " +
              (r.into.trim()
                ? "border-line"
                : "border-warn bg-warn-soft text-warn placeholder:text-warn/70")
            }
          />
          <button
            type="button"
            title="Bỏ rule"
            onClick={() => setRules(rules.filter((_, n) => n !== i))}
            className="ml-auto rounded px-1.5 text-[13px] text-ink-3 hover:bg-crit-soft hover:text-crit"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRules([...rules, { from: "", into: "" }])}
        className={`mt-1.5 ${BTN}`}
      >
        + Thêm rule
      </button>
      <p className="mt-2 text-[11.5px] text-ink-3">
        Chưa có rule nào thì cột không nhận nhánh nào.
      </p>
    </>
  );
}

/**
 * Ô nhánh là chọn, không phải gõ.
 *
 * Gõ tay thì một ký tự thừa là cột lặng lẽ không khớp gì, và không màn hình
 * nào nói ra. Vẫn có đường gõ cho nhánh chưa thấy trong repo — danh sách này
 * dựng từ những nhánh đã quét, nên nó mô tả hiện tại chứ không ra luật.
 */
function BranchPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const known = options.includes(value);

  if (typing || (value && !known))
    return (
      <input
        autoFocus={typing}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTyping(false)}
        placeholder="tên nhánh"
        className={`w-[200px] font-mono ${INP}`}
      />
    );

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === "\u0000other") {
          setTyping(true);
          onChange("");
        } else onChange(e.target.value);
      }}
      className={`min-w-[190px] max-w-[270px] font-mono ${SEL}`}
    >
      <option value="">— chọn nhánh —</option>
      {options.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
      <option disabled>──────────</option>
      <option value="&#0;other">+ nhánh khác…</option>
    </select>
  );
}

function ExpectPicker({
  g,
  list,
  statusNames,
  onChange,
}: {
  g: StageGroup;
  list: StageConfig[];
  statusNames: string[];
  onChange: (g: StageGroup) => void;
}) {
  const branch = groupBranch(g);
  return (
    <select
      value={groupExpects(g)}
      onChange={(e) =>
        onChange(setGroupExpects(g, e.target.value as StageConfig["expects"]))
      }
      title={
        "Chỉ bật cảnh báo, không quyết định card vào cột nào.\n" +
        "Tới cột này mà Jira chưa tới trạng thái đã chọn thì card hiện cảnh báo lệch.\n\n" +
        "Ngưỡng là **ít nhất**: chọn READY TO TEST ON DEVELOP thì ticket đã " +
        "VERIFIED ON DEVELOP cũng thoả. Nhưng tính theo đúng môi trường của cột này."
      }
      className={`min-w-[230px] ${SEL}`}
    >
      {expectLabels(
        envSteps(list).find((e) => e.branch === branch)?.name ?? "",
        statusNames,
      ).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Đường ống môi trường mà cấu hình cột đang nói ra.
 *
 * Đọc bằng đúng `envSteps` của phần còn lại, không dựng lại luật ở đây — nếu
 * hai chỗ hiểu khác nhau thì màn hình này thành lời trấn an sai.
 */
function EnvPipeline({ list }: { list: StageConfig[] }) {
  const envs = envSteps(list);

  return (
    <div className="mt-3 rounded-md border border-line bg-ground px-3 py-2">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-3">
        Thứ tự môi trường app đang hiểu
      </div>
      {envs.length ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {envs.map((e, i) => (
            <span key={e.branch} className="flex items-center gap-1.5">
              {i > 0 && <span className="font-mono text-[11px] text-ink-3">→</span>}
              <span
                title={`Nhánh: ${e.branch}`}
                className="rounded-[3px] border border-line-strong bg-surface px-1.5 py-px font-mono text-[11px] text-ink-2"
              >
                {e.name}
                <span className="ml-1 text-ink-3">{e.branch}</span>
              </span>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[12px] text-warn">
          Chưa có môi trường nào — thêm một dòng <b>môi trường</b> ở dưới thì nó
          hiện ở đây.
        </p>
      )}
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
        Suy từ các dòng <b>môi trường</b> ở trên, theo đúng thứ tự bạn kéo. Và
        đó cũng là thứ tự quyết định lời mời “tạo PR lên bậc kế tiếp” khi ticket
        đã verified.
      </p>
    </div>
  );
}
