"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import {
  DEFAULT_BRANCH_SUFFIXES,
  RUN_LABEL,
  type RecoveryPlan,
  type RunState,
  type SdkRelease,
  parseAnsi,
  parseUnifiedDiff,
  phaseOf,
  searchBranches,
} from "@/lib/modules/sdk-release/model";
import type { SdkConfigView } from "@/lib/modules/sdk-release/config";
import type { Check } from "@/lib/modules/sdk-release/preflight";
import type {
  BranchChoice,
  CommitFile,
  CommitFiles,
  FileDiff,
} from "@/lib/modules/sdk-release/repo";
import type { RunView } from "@/lib/modules/sdk-release/runner";
import type { RunRow } from "@/lib/modules/sdk-release/store";

import {
  type Readiness,
  cancelRunAction,
  checkReadinessAction,
  commitDiffAction,
  checkoutAction,
  diagnoseRunAction,
  pollRunAction,
  saveSdkConfigAction,
  startReleaseAction,
} from "./actions";

const CARD = "rounded-[9px] border border-line bg-surface p-[17px]";
const CTITLE = "font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3";
const BTN =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-2 disabled:opacity-50";
const BTN_PRI =
  "rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:bg-accent-2 disabled:opacity-50";
const INPUT = "rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12.5px]";

/**
 * A terminal, and deliberately the same one in both themes.
 *
 * Every other surface here follows the app's light/dark tokens. This one does
 * not: the content is forty minutes of `cargo` output that the user has read a
 * hundred times in a real terminal, and a light-grey code block reads as a
 * document rather than as a process that is running. Fixed colours, close to
 * what a dark terminal actually shows.
 */
const TERM = {
  bg: "#0d1117",
  text: "#c9d1d9",
  dim: "#7d8590",
  edge: "#30363d",
} as const;

/** Something the server said, plus whether it is bad news. */
interface Note {
  ok: boolean;
  text: string;
}

/**
 * A call that never reached its own error handling.
 *
 * The dev server restarting mid-request is the everyday case; the user should
 * read "the server did not answer", not a silent button.
 */
function transportError(err: unknown): string {
  return err instanceof Error
    ? `Không gọi được server — ${err.message}`
    : "Không gọi được server";
}

const RUN_TONE: Record<RunState, string> = {
  running: "bg-accent-soft text-accent-ink",
  ok: "bg-good-soft text-good",
  failed: "bg-crit-soft text-crit",
  cancelled: "bg-surface-2 text-ink-2",
  lost: "bg-warn-soft text-warn",
};

export function SdkRelease({ view, runs }: { view: SdkConfigView; runs: RunRow[] }) {
  const [ready, setReady] = useState<Readiness | null>(null);
  /** Last thing the server said, and whether it went wrong. */
  const [note, setNote] = useState<Note>({ ok: true, text: "" });
  /**
   * Why the switch did not happen, kept apart from everything else.
   *
   * It has its own state because it has its own place on screen: under the
   * button that failed, not in a card further down. A blocked checkout is the
   * one message here the user has to act on — an untracked file to move, a
   * change to commit — and it was being rendered in the version card in the
   * same neutral grey as "Đã fetch hai repo".
   */
  const [switchNote, setSwitchNote] = useState<Note | null>(null);
  const [busy, startBusy] = useTransition();
  /** Branch being previewed. '' means "whatever HEAD is". */
  const [pick, setPick] = useState("");
  const [version, setVersion] = useState("");
  const [confirming, setConfirming] = useState(false);
  /** Màn xem thay đổi của commit sắp build — phủ kín, mở từ thẻ nhánh. */
  const [diffOpen, setDiffOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [run, setRun] = useState<RunView | null>(null);
  const [tab, setTab] = useState<"run" | "config">(
    view.sdkPath && view.packagePath ? "run" : "config",
  );

  /**
   * Every server-action call, with the one thing `useTransition` alone does not
   * give you: a rejection that reaches the screen.
   *
   * An action can fail before its own `try` ever runs — the dev server
   * restarting mid-request is the everyday case here — and an unhandled
   * rejection inside a transition shows the user nothing at all: no message,
   * the button simply stops being busy. One boundary, rather than five of them
   * or none.
   */
  const act = useCallback((fn: () => Promise<void>) => {
    startBusy(async () => {
      try {
        await fn();
      } catch (err) {
        setNote({ ok: false, text: transportError(err) });
      }
    });
  }, []);

  /**
   * Which readiness request is the current one.
   *
   * Two of them overlap at exactly the worst moment. Starting a release issues
   * one (checks computed while the run is alive, so `busy` blocks Release), and
   * seconds later the poller sees the run end and issues another (checks now
   * clean). They race, and the first one resolving *second* put the screen back
   * into "đang có lần chạy #11 chưa kết thúc" after the run had already failed
   * — a locked button with nothing left to unlock it.
   *
   * Measured before fixing: the screen went backwards at +8s and only came
   * right at +14s, and on a slower answer it would not have come right at all.
   */
  const reqId = useRef(0);

  const load = useCallback(
    (opts: { branch?: string; fetch?: boolean } = {}) => {
      const mine = ++reqId.current;
      act(async () => {
        const res = await checkReadinessAction(opts);
        // A newer request has already answered; this one is history.
        if (mine !== reqId.current) return;
        setNote({ ok: res.ok, text: res.message });
        if (res.readiness) {
          setReady(res.readiness);
          setVersion(res.readiness.proposal.version);
          if (res.readiness.liveRunId !== null) {
            const p = await pollRunAction(res.readiness.liveRunId);
            if (p.run) setRun(p.run);
          }
        }
      });
    },
    [act],
  );

  // One read on arrival. Deliberately without `fetch`: touching somebody's
  // clones is not something a page load gets to do on its own.
  useEffect(() => {
    if (view.sdkPath && view.packagePath) load();
  }, [load, view.sdkPath, view.packagePath]);

  /**
   * Follows a live run.
   *
   * Two seconds while it is running, and nothing at all once it is not — a
   * self-rescheduling timeout rather than an interval, so a slow poll can never
   * stack up behind itself. Same shape as the build watcher on the task board.
   */
  const runId = run?.state === "running" ? run.id : null;
  const seen = useRef(0);
  useEffect(() => {
    if (runId === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      void pollRunAction(runId).then((res) => {
        if (!alive) return;
        if (res.run) setRun(res.run);
        seen.current += 1;
        if (res.run?.state === "running") {
          timer = setTimeout(tick, 2000);
          return;
        }
        /*
         * The run just ended, so the readiness has to be asked again.
         *
         * `checks` was computed while the run was alive and carries
         * `fail("busy")` — "đang có lần chạy #6 chưa kết thúc". Nothing else
         * recomputes it: this poller only ever wrote `run`. So the moment a
         * build failed, the Release button locked and stayed locked, with no
         * way back but reloading the page. The one failure the user is most
         * likely to hit is the one that used to leave them stuck.
         */
        if (res.run) load();
      });
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, load]);

  const head = ready?.head ?? "";
  const previewing = Boolean(pick && pick !== head);
  const blocked = (ready?.checks ?? []).some((c) => c.state === "fail");
  const canRun = Boolean(ready) && !blocked && !previewing && !run?.state?.includes("running");

  function doStart() {
    act(async () => {
      const res = await startReleaseAction({ version: version.trim() });
      setNote({ ok: res.ok, text: res.message });
      setConfirming(false);
      setTyped("");
      if (res.id) {
        const p = await pollRunAction(res.id);
        if (p.run) setRun(p.run);
      }
      load();
    });
  }

  const command = `cd ${view.packagePath}/Tools/Release/Sources && swift run release --version ${version}`;

  /**
   * Fetch, then switch the clone onto `pick`.
   *
   * Catches its own rejection rather than letting `act` handle it, so a server
   * that never answered is reported in the same place as a checkout git
   * refused — beside the button, not in another card.
   */
  function doCheckout() {
    setSwitchNote(null);
    act(async () => {
      try {
        const res = await checkoutAction(pick);
        if (!res.ok) return setSwitchNote({ ok: false, text: res.message });
        // The red box is about to unmount with `pick`, so the good news has to
        // land somewhere that stays.
        setSwitchNote(null);
        setNote({ ok: true, text: res.message });
        setPick("");
        load();
      } catch (err) {
        setSwitchNote({ ok: false, text: transportError(err) });
      }
    });
  }

  return (
    <>
      {/*
       * The page is a flex column as tall as the window, so the console below
       * can be `flex-1` without anybody guessing how tall the header is. The
       * only number here is `main`'s own `pt-5 pb-12` — 20 + 48 — read straight
       * off `app/layout.tsx`.
       */}
      <div className="flex flex-col lg:h-[calc(100dvh-68px)]">
        {/* Same header as every other module: eyebrow, title, one line of
            what-this-is on the left; the tab strip on the right. */}
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className={CTITLE}>Release iOS SDK</div>
            <h1 className="text-xl font-semibold tracking-tight">Release SDK</h1>
            <p className="mt-1 text-[12.5px] text-ink-3">
              App <b>fetch</b>, <b>chuyển nhánh</b> và <b>fast-forward main</b> của repo
              swift, gợi ý tên version, kiểm điều kiện rồi chạy release. Lệnh build đọc{" "}
              <b className="text-ink-2">nhánh đang checkout</b>, không phải nhánh chọn trên
              màn hình.
            </p>
          </div>
          <div className="flex overflow-hidden rounded-md border border-line-strong text-[12.5px]">
            <TabBtn on={tab === "run"} onClick={() => setTab("run")}>
              Chạy
            </TabBtn>
            <TabBtn on={tab === "config"} onClick={() => setTab("config")}>
              Cấu hình
            </TabBtn>
          </div>
        </header>

        {tab === "config" ? (
          <ConfigCard view={view} />
        ) : (
          /*
           * Two panes, both full height, because running is two jobs at once.
           *
           * Before a run you are deciding and verifying; after it starts, the
           * terminal is the entire point and everything else is frozen anyway —
           * a second run cannot begin. A grid of equal cards served neither:
           * the widest column held the least, and the page ran out of content
           * two thirds of the way down. So: a rail you read top to bottom, and
           * a console that fills whatever is left.
           */
          <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
            <div className="flex w-full shrink-0 flex-col gap-3 lg:w-[340px] lg:overflow-y-auto lg:pr-1">
              <section className={CARD}>
                <div className="flex items-center justify-between">
                  <span className={CTITLE}>Nhánh sẽ được build</span>
                  <button
                    type="button"
                    onClick={() => load({ branch: pick || undefined, fetch: true })}
                    disabled={busy}
                    title={
                      "git fetch trên cả hai repo, rồi git merge --ff-only origin/main ở repo swift.\n" +
                      "Fast-forward nên không thể sinh conflict; lệch nhánh thì app dừng và báo."
                    }
                    className={BTN}
                  >
                    {busy ? "Đang hỏi…" : "↻ Đồng bộ & kiểm"}
                  </button>
                </div>

                {ready ? (
                  <>
                    {/*
                     * Branch and commit together, in a panel of their own.
                     *
                     * Two attempts at this failed the same way: separating them
                     * by darkness alone means one of them has to be the dim
                     * one. `ink` against `ink-2` measured 2.2:1 in light and
                     * 1.8:1 in dark — indistinguishable; pushing the branch to
                     * `ink-3` fixed the focus by giving the branch away.
                     *
                     * They are not competing for one slot, they are two facts
                     * of different kinds, so they are emphasised in different
                     * currencies: the branch in accent — a *hue* change, 8.6:1
                     * against this panel — and the commit in the darkest
                     * neutral at the largest size, 17.5:1. Neither is dimmed to
                     * make room for the other, and the left rule plus the tint
                     * lift the pair off the card as one unit.
                     */}
                    <div className="mt-2 rounded-[6px] border border-line border-l-[3px] border-l-accent bg-ground px-3 py-2.5">
                      <div className="flex items-baseline gap-1.5">
                        <span className="shrink-0 text-[12px] text-accent-ink">⑂</span>
                        <span className="min-w-0 break-all font-mono text-[13px] font-semibold text-accent-ink">
                          {head || "—"}
                        </span>
                      </div>

                      {ready.headSubject && (
                        <p
                          title={ready.headSubject}
                          className="mt-1.5 line-clamp-3 text-[15px] font-semibold leading-snug text-ink"
                        >
                          {ready.headSubject}
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-ink-3">
                        <span className="font-mono">{ready.headSha.slice(0, 8)}</span>
                        {ready.headAuthor ? ` · ${ready.headAuthor}` : ""}
                        {ready.headAt ? ` · ${ago(ready.headAt)}` : ""}
                      </p>
                      <ChangedFiles
                        files={ready.headFiles}
                        onOpen={() => setDiffOpen(true)}
                      />
                    </div>

                    <BranchPicker
                      branches={ready.branches}
                      head={head}
                      pick={pick}
                      onPick={(name) => {
                        setPick(name);
                        load({ branch: name || undefined });
                      }}
                    />

                    {/* The guide's loudest warning: the tool reads HEAD and
                        takes no branch flag, so a preview of some other branch
                        cannot be released from here — it has to be checked out
                        first, which is now one button rather than a paste. */}
                    {previewing && (
                      <div className="mt-2 rounded-[5px] border border-crit bg-crit-soft px-2.5 py-2 text-[12px] leading-relaxed text-crit">
                        <b>Repo chưa đứng ở nhánh này.</b> Đang ở{" "}
                        <span className="font-mono">{head}</span>, mà lệnh build chỉ đọc
                        nhánh đang checkout — nút Release bị khoá.
                        <button
                          type="button"
                          onClick={doCheckout}
                          disabled={busy || ready.headDirty > 0}
                          title={
                            ready.headDirty > 0
                              ? "Cây làm việc còn thay đổi chưa commit — checkout sẽ mang chúng sang nhánh mới."
                              : `git fetch rồi git checkout ${pick}`
                          }
                          className="mt-2 w-full rounded-md bg-crit px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                          {busy ? "Đang chuyển…" : `Fetch & chuyển sang ${pick}`}
                        </button>

                        {/* Why it did not happen, under the button that did not
                            do it. Usually git's own words, which name the file
                            in the way and say what to move. */}
                        {switchNote && (
                          <p className="mt-2 whitespace-pre-wrap border-t border-crit/30 pt-2 text-[11.5px] leading-relaxed text-crit">
                            <b>Chưa chuyển được.</b> {switchNote.text}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="mt-2 text-[12.5px] text-ink-3">
                    {busy ? "Đang đọc repo…" : note.text || "Chưa đọc được repo."}
                  </p>
                )}
              </section>

              {ready && <RecentCard releases={ready.recent} branch={pick || head} />}

              {ready && (
                <section className={CARD}>
                  <span className={CTITLE}>Tên bản release</span>
                  <input
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    className={
                      INPUT +
                      " mt-1 w-full font-mono text-[14px] " +
                      (ready.proposal.confidence === "guess"
                        ? "border-warn bg-warn-soft/30"
                        : "")
                    }
                  />
                  <p className="mt-1 text-[11.5px] text-ink-3">{ready.proposal.why}</p>

                  {/*
                   * The guide hands this choice to the person: a feature
                   * branch releases as `<team><tên tính năng>`, and the name is
                   * theirs to pick. No rule here beats 96%, so the runners-up
                   * are one click rather than a retype.
                   */}
                  {ready.proposal.alternatives.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-[11px] text-ink-3">hoặc</span>
                      {ready.proposal.alternatives.map((a) => (
                        <button
                          key={a.version}
                          type="button"
                          onClick={() => setVersion(a.version)}
                          title={a.why}
                          className="rounded border border-line px-1.5 py-[1px] font-mono text-[11px] text-ink-2 hover:bg-surface-2"
                        >
                          {a.version}
                        </button>
                      ))}
                    </div>
                  )}
                  {ready.proposal.warnings.map((w) => (
                    <p key={w} className="mt-1 text-[11.5px] text-warn">
                      ⚠ {w}
                    </p>
                  ))}

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      disabled={!canRun || busy}
                      title="Build, tạo release, rồi push lên repo khách hàng."
                      className={
                        "rounded-md bg-crit px-3 py-1 text-[12.5px] font-medium text-white " +
                        "hover:opacity-90 disabled:opacity-50"
                      }
                    >
                      {/* Eight seconds pass between the click and the first log
                          line — fetch, two fast-forwards and the full check
                          pass all run before anything is spawned. A button that
                          simply greys out for that long reads as broken. */}
                      {busy ? "Đang chuẩn bị…" : "Release"}
                    </button>
                    {/* Beside the run button from day one: the app has to stay
                        useful on the days you would rather paste it into a
                        terminal yourself. */}
                    <CopyBtn text={command} />
                  </div>

                  {/*
                   * What stops the run, and only that.
                   *
                   * The checklist panel is gone; the checks behind it are not,
                   * and `startReleaseAction` re-runs them server-side anyway
                   * because the ones the browser saw may be minutes stale. But
                   * a button that is greyed out with no reason given is worse
                   * than either a list or no list, so the failing lines — never
                   * the passing ones — come back here, attached to the control
                   * they are blocking.
                   */}
                  {ready.checks
                    .filter((c) => c.state === "fail")
                    .map((c) => (
                      <p key={c.id} className="mt-2 text-[12px] leading-relaxed text-crit">
                        <b>{c.label}</b> {c.detail}
                        {c.fix && (
                          <span className="mt-1 block overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-ink-2">
                            {c.fix}
                          </span>
                        )}
                      </p>
                    ))}

                  {note.text && (
                    <p
                      className={
                        "mt-2 text-[12px] " + (note.ok ? "text-ink-2" : "text-crit")
                      }
                    >
                      {note.text}
                    </p>
                  )}
                </section>
              )}

              {/* Whatever the last readiness read, falling back to the server
                  render on first paint. */}
              {(ready?.runs ?? runs).length > 0 && (
                <HistoryCard
                  runs={ready?.runs ?? runs}
                  onOpen={(id) =>
                    act(async () => {
                      const p = await pollRunAction(id);
                      if (p.run) setRun(p.run);
                    })
                  }
                />
              )}
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <RunCard
                run={run}
                notifyEnd={view.notifyEnd}
                onCancel={(id) =>
                  act(async () => {
                    const res = await cancelRunAction(id);
                    setNote({ ok: res.ok, text: res.message });
                    const p = await pollRunAction(id);
                    if (p.run) setRun(p.run);
                  })
                }
              />
            </div>
          </div>
        )}
      </div>

      {diffOpen && ready && (
        <DiffScreen
          files={ready.headFiles}
          subject={ready.headSubject}
          sha={ready.headSha}
          onClose={() => setDiffOpen(false)}
        />
      )}

      {confirming && ready && (
        <ConfirmDialog
          version={version}
          head={head}
          headSha={ready.headSha}
          headSubject={ready.headSubject}
          warns={ready.checks.filter((c) => c.state === "warn")}
          typed={typed}
          onTyped={setTyped}
          onCancel={() => {
            setConfirming(false);
            setTyped("");
          }}
          onGo={doStart}
          busy={busy}
        />
      )}
    </>
  );
}

/** "5 giờ trước" — the unit anybody actually reasons in when reading a commit. */
function ago(at: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - at);
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} ngày trước` : `${Math.floor(days / 30)} tháng trước`;
}

const DMY = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Saigon",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Pick a branch by typing, not by scrolling a `<select>`.
 *
 * There are 58 of them in this clone and 51 exist only on the remote, so the
 * native dropdown was a 58-item list in which the branch you want is never
 * visible without scrolling. Filtering is a plain substring match on the whole
 * name, which is what makes `526` find `ctalk/bugfix/VT-526`.
 */
/** The matched run of characters picked out, the way a search box does it. */
function Mark({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b className="font-semibold text-accent-ink">{text.slice(at, at + needle.length)}</b>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * `A` thêm · `M` sửa · `D` xoá · `R` đổi tên — bốn chữ git dùng.
 *
 * `M` để trung tính vì nó là loại đông nhất: tô nó lên thì cả danh sách sáng
 * đều và không chữ nào còn nổi. Màu dành cho ba loại hiếm hơn.
 */
const FILE_TONE: Record<string, string> = {
  A: "text-accent",
  M: "text-ink-3",
  D: "text-crit",
  R: "text-warn",
};

/** `+12 −3`, hoặc `nhị phân` khi git không đếm được dòng. */
function Counts({ f }: { f: CommitFile }) {
  if (f.binary) return <span className="text-ink-3">nhị phân</span>;
  return (
    <>
      {f.added > 0 && <span className="text-accent">+{f.added}</span>}
      {f.removed > 0 && <span className="text-crit">−{f.removed}</span>}
      {f.added === 0 && f.removed === 0 && <span className="text-ink-3">—</span>}
    </>
  );
}

/**
 * Tóm tắt trong rail, và cửa vào màn xem thay đổi.
 *
 * Trong rail chỉ để con số: sha và title nói commit nào, không nói nó có việc
 * của bạn hay không — mà rail rộng 340px thì không đọc nổi một diff.
 */
function ChangedFiles({
  files,
  onOpen,
}: {
  files: CommitFiles;
  onOpen: () => void;
}) {
  if (!files.total)
    return (
      <p className="mt-1.5 text-[11px] text-ink-3">Commit này không đổi file nào.</p>
    );

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={onOpen}
        className="text-[11px] text-accent-ink underline underline-offset-2"
      >
        {files.total} file thay đổi
        {files.added > 0 || files.removed > 0 ? (
          <span className="ml-1.5 inline-flex gap-1 font-mono no-underline">
            <span className="text-accent">+{files.added}</span>
            <span className="text-crit">−{files.removed}</span>
          </span>
        ) : null}
      </button>
      {/* Câu này phải có mặt, không nhét vào tooltip: trên một commit merge,
          "3 file" mà không nói so với cái gì thì là một con số không đọc được. */}
      {files.merge && (
        <p className="text-[10.5px] leading-snug text-ink-3">
          commit merge — so với nhánh gốc của nó
        </p>
      )}
    </div>
  );
}

/** Nền của từng loại dòng trong diff. */
const LINE_BG: Record<string, string> = {
  add: "bg-accent-soft",
  del: "bg-crit-soft",
  hunk: "bg-surface-2 text-ink-3",
  ctx: "",
};

/**
 * Màn xem thay đổi của commit sắp được build.
 *
 * Phủ kín màn hình chứ không nhét vào rail: mục đích của nó là đọc code, và
 * code cần chiều ngang. Danh sách file bên trái, diff bên phải, đúng thứ tự
 * người ta vốn quen.
 */
function DiffScreen({
  files,
  subject,
  sha,
  onClose,
}: {
  files: CommitFiles;
  subject: string;
  sha: string;
  onClose: () => void;
}) {
  const [pick, setPick] = useState(files.files[0]?.path ?? "");
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!pick) return;
    let alive = true;
    setLoading(true);
    setErr("");
    void commitDiffAction({ path: pick })
      .then((res) => {
        if (!alive) return;
        if (!res.ok) setErr(res.message);
        setDiff(res.diff ?? null);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : "Không đọc được");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pick]);

  // Escape đóng màn — cùng phím với mọi lớp phủ khác trong app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = diff ? parseUnifiedDiff(diff.text) : [];
  const current = files.files.find((f) => f.path === pick);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ground">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p title={subject} className="truncate text-[13px] font-semibold text-ink">
            {subject}
          </p>
          <p className="text-[11px] text-ink-3">
            <span className="font-mono">{sha.slice(0, 8)}</span> · {files.total} file
            {files.merge ? " · commit merge, so với nhánh gốc" : ""}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[12px]">
          <span className="text-accent">+{files.added}</span>{" "}
          <span className="text-crit">−{files.removed}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
        >
          Đóng (Esc)
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav className="shrink-0 overflow-y-auto border-line max-lg:max-h-48 max-lg:border-b lg:w-[380px] lg:border-r">
          {files.files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setPick(f.path)}
              className={
                "flex w-full items-baseline gap-2 border-b border-line px-3 py-1.5 text-left " +
                (f.path === pick ? "bg-accent-soft" : "hover:bg-surface-2")
              }
            >
              <span className={`w-3 shrink-0 font-mono text-[11px] ${FILE_TONE[f.status] ?? "text-ink-3"}`}>
                {f.status}
              </span>
              {/* Tên file xuống dòng riêng, không nối đuôi thư mục: gộp một
                  dòng thì `break-all` cắt ngay giữa tên — "…/src/c" rồi
                  "lient.rs" — làm hỏng đúng phần đáng đọc nhất. */}
              <span className="min-w-0 flex-1">
                <span className="block break-all font-mono text-[11.5px] font-semibold text-ink">
                  {f.path.slice(f.path.lastIndexOf("/") + 1)}
                </span>
                {f.path.includes("/") && (
                  <span className="block break-all font-mono text-[10px] leading-snug text-ink-3">
                    {f.path.slice(0, f.path.lastIndexOf("/"))}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 gap-1 font-mono text-[10.5px]">
                <Counts f={f} />
              </span>
            </button>
          ))}
          {files.total > files.files.length && (
            <p className="px-3 py-2 text-[11px] text-ink-3">
              … còn {files.total - files.files.length} file nữa, không liệt kê
            </p>
          )}
        </nav>

        <section className="min-w-0 flex-1 overflow-auto">
          <p className="sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-1.5 font-mono text-[11.5px] text-ink-2">
            {pick || "—"}
          </p>
          {err && <p className="px-3 py-2 text-[12px] text-crit">{err}</p>}
          {loading && !err && (
            <p className="px-3 py-2 text-[12px] text-ink-3">Đang đọc…</p>
          )}
          {!loading && !err && current?.binary && (
            <p className="px-3 py-2 text-[12px] text-ink-3">
              File nhị phân — không có diff dạng chữ.
            </p>
          )}
          {!loading && !err && !current?.binary && lines.length === 0 && (
            <p className="px-3 py-2 text-[12px] text-ink-3">
              Không có thay đổi dạng chữ trong file này.
            </p>
          )}
          {!loading && !err && lines.length > 0 && (
            <table className="w-full border-collapse font-mono text-[11.5px]">
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className={LINE_BG[l.kind]}>
                    {/* Hai cột số dòng: đó là thứ biến một đống +/- thành một
                        đoạn code đọc được, và nó phải không chọn được khi copy. */}
                    <td className="w-11 select-none border-r border-line px-1.5 text-right align-top text-ink-3">
                      {l.old ?? ""}
                    </td>
                    <td className="w-11 select-none border-r border-line px-1.5 text-right align-top text-ink-3">
                      {l.new ?? ""}
                    </td>
                    <td className="w-4 select-none px-1 align-top text-ink-3">
                      {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                    </td>
                    <td className="whitespace-pre-wrap break-all px-1 align-top text-ink">
                      {l.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {diff?.truncated && (
            <p className="px-3 py-2 text-[12px] text-warn">
              Diff quá dài, đã cắt bớt phần cuối.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Pick a branch by typing, with the list only there while you are typing.
 *
 * A standing list of 57 branches is 57 lines of furniture for a field that is
 * touched once per release, and it pushed everything below it off the rail. So
 * it behaves like a search box: nothing until the field has focus, then an
 * overlay that never moves the card, filtered as you type, driven from the
 * keyboard — arrows to move, Enter to take, Escape to leave.
 *
 * Matching is a substring over the whole name, which is what lets `526` find
 * `ctalk/bugfix/VT-526` without knowing the prefix — but the order is
 * {@link searchBranches}, not the order the repository happened to list them
 * in. Only ten rows show, and a plain filter put the branch actually named
 * `develop` eighth.
 */
function BranchPicker({
  branches,
  head,
  pick,
  onPick,
}: {
  branches: BranchChoice[];
  head: string;
  pick: string;
  onPick: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const needle = q.trim().toLowerCase();
  // Xếp theo độ sát, không chỉ lọc: danh sách chỉ hiện 10 dòng, mà lọc trần
  // từng đẩy nhánh tên đúng `develop` xuống thứ 8 trên clone SDK.
  const matches = searchBranches(branches, needle);
  // Capped, not scrolled to the end: past a dozen the answer is to type one
  // more character, and the count says so rather than inviting a scroll.
  const LIMIT = 10;
  const shown = matches.slice(0, LIMIT);
  const selected = pick || head;

  // Keep the keyboard cursor on screen without hijacking the page scroll.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const take = (name: string) => {
    onPick(name === head ? "" : name);
    setQ(name);
    setOpen(false);
  };

  return (
    <div className="relative mt-2.5">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        // Focus alone is not enough: after Escape the field is still focused,
        // so clicking it again fires no focus event and the list would stay
        // shut with no way back but typing.
        onClick={() => setOpen(true)}
        // A click lands on the option before blur would close the list, because
        // each option refuses focus on mousedown — see `onMouseDown` below.
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") return setOpen(false);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) return setOpen(true);
            setActive((i) =>
              e.key === "ArrowDown"
                ? Math.min(i + 1, shown.length - 1)
                : Math.max(i - 1, 0),
            );
          }
          if (e.key === "Enter" && open && shown[active]) {
            e.preventDefault();
            take(shown[active].name);
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls="sdk-branch-list"
        placeholder={`Tìm trong ${branches.length} nhánh…`}
        className={INPUT + " w-full"}
      />

      {open && (
        // Absolute, so opening it never resizes the card underneath.
        <div
          id="sdk-branch-list"
          role="listbox"
          ref={listRef}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[252px] overflow-y-auto rounded-md border border-line-strong bg-surface shadow-lg"
        >
          {shown.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-ink-3">Không có nhánh nào khớp.</p>
          ) : (
            shown.map((b, i) => (
              <button
                key={b.name}
                type="button"
                role="option"
                aria-selected={b.name === selected}
                // Stops the input losing focus, so `onBlur` cannot close the
                // list out from under the click that is landing on it.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => take(b.name)}
                className={
                  "flex w-full items-center gap-1.5 px-2.5 py-[6px] text-left text-[12px] " +
                  (i === active ? "bg-surface-2 " : "") +
                  (b.name === selected ? "font-semibold text-accent-ink" : "")
                }
              >
                {/* Tên nhánh ở đây dài tới 60 ký tự và bị cắt bằng `…`, mà
                    chính cái đuôi bị cắt mới là phần phân biệt hai nhánh cùng
                    tiền tố. Trỏ vào là đọc được đủ. */}
                <span title={b.name} className="truncate font-mono">
                  <Mark text={b.name} needle={needle} />
                </span>
                {b.name === head && (
                  <span className="ml-auto shrink-0 text-[10px] text-ink-3">đang checkout</span>
                )}
                {b.remoteOnly && b.name !== head && (
                  <span
                    title="Chưa có nhánh này ở máy — app sẽ tạo nhánh theo dõi origin khi chuyển."
                    className="ml-auto shrink-0 text-[10px] text-ink-3"
                  >
                    chỉ ở remote
                  </span>
                )}
              </button>
            ))
          )}
          {matches.length > LIMIT && (
            <p className="border-t border-line px-2.5 py-1.5 text-[11px] text-ink-3">
              còn {matches.length - LIMIT} nhánh nữa — gõ thêm để lọc
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What this branch has already shipped.
 *
 * Read from the release tool's own `Bump to version …` commits, not from tags:
 * the commit names the branch in full, while the tag carries only a lossy slug.
 * Three is the useful number — it shows the ordinal climbing within a day, which
 * is the pattern that tells you whether today's proposed name is the first
 * attempt or the fourth.
 */
function RecentCard({ releases, branch }: { releases: SdkRelease[]; branch: string }) {
  return (
    <section className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={CTITLE}>Bản gần nhất của nhánh này</span>
      </div>
      {releases.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-3">
          Chưa có bản release nào từ <span className="font-mono">{branch || "—"}</span>.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {releases.map((r) => (
            <div key={r.version} className="flex items-baseline gap-2 text-[12px]">
              <span className="font-mono text-ink-2">{r.version}</span>
              <span
                className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3"
                title={r.sha}
              >
                {DMY.format(new Date(r.at * 1000))}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TabBtn({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "border-l border-line px-3.5 py-[5px] first:border-l-0 " +
        (on
          ? "bg-accent-soft font-semibold text-accent-ink"
          : "bg-surface text-ink-2 hover:bg-surface-2")
      }
    >
      {children}
    </button>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={text}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className={BTN}
    >
      {done ? "đã copy ✓" : "Copy lệnh"}
    </button>
  );
}

function RunCard({
  run,
  onCancel,
  notifyEnd,
}: {
  run: RunView | null;
  onCancel: (id: number) => void;
  /** Công tắc ở tab Cấu hình — xem `notifyEnd` trong config. */
  notifyEnd: boolean;
}) {
  const bottom = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = bottom.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [run?.log]);

  /*
   * What the run left behind, asked of the remote once it has ended.
   *
   * Only for a run that did not succeed, and only once. The exit code cannot
   * tell the two expensive endings apart — a tag already taken and a rejected
   * push both exit non-zero — so the refs are asked instead, and the answer
   * decides which recovery is the right one.
   */
  /**
   * Kêu một tiếng đúng lúc lần chạy dừng.
   *
   * Lưu state trước đó chứ không dựa vào lần render: bắn khi và chỉ khi nó vừa
   * *chuyển* từ `running` sang kết thúc. Thiếu vế đó thì mở lại trang sau khi
   * build xong từ hôm qua cũng kêu, và một thông báo về việc đã cũ còn tệ hơn
   * không có.
   */
  const was = useRef<RunState | null>(null);
  useEffect(() => {
    const now = run?.state ?? null;
    const before = was.current;
    was.current = now;
    if (!run || !now || now === "running") return;
    if (before !== "running") return;
    if (!notifyEnd) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted")
      return;

    new Notification(`Release ${run.version} — ${RUN_LABEL[now]}`, {
      body: run.message || (now === "ok" ? "Đã lên repo khách." : "Xem log trong app."),
      // Một tag cho cả module: lần chạy sau thay chỗ lần trước chứ không xếp
      // chồng, vì chỉ có một lần chạy tại một thời điểm.
      tag: "sdk-release-run",
    });
  }, [run, notifyEnd]);

  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  /**
   * Bấm tăng khi người dùng hỏi lại remote từ nút trên thẻ khắc phục.
   *
   * Thiếu nó thì thẻ là ảnh chụp một lần: làm đủ bốn bước, tag đã sạch cả hai
   * bên, mà thẻ vẫn nằm đó bảo tên đang bị giữ chỗ — không có cách nào biết
   * mình đã xong ngoài việc tải lại trang, mà tải lại thì thẻ biến mất hẳn kể
   * cả khi chưa dọn.
   */
  const [recheck, setRecheck] = useState(0);
  const [checking, setChecking] = useState(false);
  const runId = run?.id ?? null;
  const ended = run && run.state !== "running";
  useEffect(() => {
    if (runId === null || !ended || run?.state === "ok") {
      setPlan(null);
      return;
    }
    let alive = true;
    setChecking(true);
    void diagnoseRunAction(runId)
      .then((res) => {
        if (!alive) return;
        // Dọn xong thì `recoveryPlan` trả về `clean`, và thẻ tự biến mất —
        // đó là câu trả lời "đã xong", không cần ai xác nhận bằng miệng.
        setPlan(res.plan ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [runId, ended, run?.state, recheck]);

  // Empty, but still a terminal. A paragraph in a white card says "nothing to
  // see here"; a dark screen with a prompt on it says "this is where the build
  // will appear", which is the actual state and takes no explaining.
  if (!run)
    return (
      <section className={CARD + " flex min-h-[320px] flex-1 flex-col"}>
        <div className={CTITLE}>Log</div>
        <Terminal>
          <span style={{ color: TERM.dim }}>
            Chưa có lần chạy nào. Bấm <b style={{ color: TERM.text }}>Release</b> để bắt đầu,
            log sẽ chảy ra ở đây.
          </span>
        </Terminal>
      </section>
    );

  const phase = phaseOf(run.log);
  // Cancel does not mean the same thing all the way through, so the button must
  // not say the same thing all the way through.
  const cancelLabel =
    phase === "push" || phase === "finish"
      ? "Huỷ (đã push rồi — huỷ không thu hồi được)"
      : phase === "sources"
        ? "Huỷ (đang ghi vào repo swift)"
        : "Huỷ (chưa có gì ra ngoài)";

  return (
    <section className={CARD + " flex min-h-[320px] flex-1 flex-col"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={CTITLE}>Log</span>
        <span className="font-mono text-[12px] font-semibold">{run.version}</span>
        <span
          className={
            "rounded-full px-2 py-[2px] text-[11px] font-medium " + RUN_TONE[run.state]
          }
        >
          {RUN_LABEL[run.state]}
        </span>
        {/* Where the title bar used to carry it, next to the rest of the run's
            status rather than floating over the log. */}
        {run.state === "running" && (
          <span title="bước đang chạy" className="font-mono text-[11px] text-good">
            ● {phase}
          </span>
        )}
        {run.localOnly && (
          <span className="rounded-[3px] border border-line-strong px-1.5 font-mono text-[10px] text-ink-3">
            local-only
          </span>
        )}
        {run.state === "running" && (
          <button
            type="button"
            onClick={() => onCancel(run.id)}
            className={BTN + " ml-auto border-crit text-crit hover:bg-crit-soft"}
          >
            {cancelLabel}
          </button>
        )}
      </div>

      {run.message && (
        <p
          className={
            "mt-2 text-[12px] " + (run.state === "lost" ? "text-warn" : "text-ink-2")
          }
        >
          {run.message}
        </p>
      )}

      {plan && plan.state !== "clean" && (
        <RecoveryCard
          plan={plan}
          checking={checking}
          onRecheck={() => setRecheck((n) => n + 1)}
        />
      )}

      <Terminal
        scrollRef={bottom}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {/* Màu do chính lệnh phát ra, không phải app đoán.
            Trước đây mỗi dòng bị tô theo regex — mọi dòng có chữ "error:" đều
            đỏ, kể cả khi đó là tên một hàm trong đoạn code rustc đang trích. */}
        {run.log
          ? run.log.split("\n").map((line, i) => (
              <div key={i}>
                {line ? (
                  parseAnsi(line).map((sp, j) => (
                    <span
                      key={j}
                      style={{
                        color: sp.color || undefined,
                        fontWeight: sp.bold ? 600 : undefined,
                      }}
                    >
                      {sp.text}
                    </span>
                  ))
                ) : (
                  "\u00a0"
                )}
              </div>
            ))
          : <span style={{ color: TERM.dim }}>(chưa có gì)</span>}
        {/* A block cursor while it is alive — the one thing that separates
            "still building" from "stopped and left this behind". */}
        {run.state === "running" && (
          <span
            className="inline-block h-[13px] w-[7px] align-middle"
            style={{ background: TERM.text }}
          />
        )}
      </Terminal>
    </section>
  );
}

/**
 * The terminal chrome, shared by the live log and the empty state.
 *
 * Fixed colours in both themes — see {@link TERM}. The three dots are not
 * ornament: they say "a machine is talking" before a single line is read, and
 * they are what makes the empty state legible as a place rather than an
 * absence.
 */
/**
 * What is lying around, and the order to clean it up in.
 *
 * Numbered because the order is load-bearing, not stylistic: rebasing before
 * the `pre-` release is deleted leaves a release pointing at a commit that no
 * longer exists, and re-running before it is deleted dies on a tag that is
 * already taken. Each step is a command to copy or a page to open — the app
 * has no write token for somebody else's repository and does none of this
 * itself.
 */
function RecoveryCard({
  plan,
  checking,
  onRecheck,
}: {
  plan: RecoveryPlan;
  checking: boolean;
  onRecheck: () => void;
}) {
  const bad = plan.state === "push-rejected";
  return (
    <section
      className={
        "mt-2 rounded-[6px] border px-3 py-2.5 " +
        (plan.state === "done"
          ? "border-good/50 bg-good-soft"
          : bad
            ? "border-crit/60 bg-crit-soft"
            : "border-warn/50 bg-warn-soft")
      }
    >
      <div className="flex items-baseline gap-2">
        <span
          className={
            "rounded-full px-2 py-[2px] text-[10.5px] font-semibold " +
            (plan.state === "done"
              ? "bg-good text-white"
              : bad
                ? "bg-crit text-white"
                : "bg-warn text-white")
          }
        >
          {plan.state === "done" ? "ĐÃ XONG" : bad ? "CẦN DỌN" : "CÒN SÓT"}
        </span>
        <b className={"text-[13px] " + (bad ? "text-crit" : "text-ink")}>{plan.title}</b>
        {/* Bốn bước làm tay xong thì phải có cách hỏi lại. Không có nút này,
            thẻ đứng nguyên như cũ và người dùng không biết mình đã xong. */}
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          title="Hỏi lại remote xem đã dọn xong chưa"
          className="ml-auto shrink-0 rounded-md border border-line bg-surface px-2 py-[3px] text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        >
          {checking ? "Đang hỏi…" : "↻ Kiểm lại"}
        </button>
      </div>

      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{plan.detail}</p>

      {plan.steps.length > 0 && (
        <ol className="mt-2 flex flex-col gap-2">
          {plan.steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
              <span className="mt-[1px] shrink-0 font-mono text-[11px] text-ink-3">
                {i + 1}.
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-ink-2">{step.text}</span>
                {step.command && (
                  <div className="mt-1 flex items-start gap-1.5">
                    <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-[11px] text-ink-2">
                      {step.command}
                    </pre>
                    <CopyBtn text={step.command} />
                  </div>
                )}
                {step.url && (
                  <a
                    href={step.url}
                    target="_blank"
                    rel="noreferrer"
                    title={step.url}
                    className="mt-1 block truncate font-mono text-[11px] text-accent-ink underline underline-offset-2"
                  >
                    {step.url}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Terminal({
  scrollRef,
  onScroll,
  children,
}: {
  scrollRef?: React.RefObject<HTMLPreElement | null>;
  onScroll?: React.UIEventHandler<HTMLPreElement>;
  children: React.ReactNode;
}) {
  return (
    /*
     * Just the screen.
     *
     * It had a title bar with three traffic-light dots — decoration borrowed
     * from a window that is not a window, carrying a command line already
     * spelled out in the header above and a phase badge that now sits beside
     * the state pill where the rest of the run's status lives. Nothing was
     * lost by deleting it, and the log starts a row higher.
     *
     * Fills the pane rather than standing at a fixed height: a log is as long
     * as the window allows, and a 520px box floating in a 1000px column was
     * most of what made the old layout read as empty.
     */
    <div
      className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border"
      style={{ borderColor: TERM.edge, background: TERM.bg }}
    >
      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-[1.5]"
        style={{ color: TERM.text }}
      >
        {children}
      </pre>
    </div>
  );
}

function HistoryCard({ runs, onOpen }: { runs: RunRow[]; onOpen: (id: number) => void }) {
  return (
    <section className={CARD}>
      <div className={CTITLE}>Lần chạy gần đây</div>
      <div className="mt-2 flex flex-col gap-px">
        {runs.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r.id)}
            className="flex items-center gap-2 rounded px-1 py-1 text-left text-[12px] hover:bg-surface-2"
          >
            <span className="font-mono text-[11.5px] text-ink-2">{r.version}</span>
            <span
              className={
                "rounded-full px-1.5 text-[10px] font-medium " + RUN_TONE[r.state as RunState]
              }
            >
              {RUN_LABEL[r.state as RunState]}
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-ink-3">
              {new Date(r.startedAt * 1000).toLocaleString("vi-VN", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The gate `ios-publish` never had.
 *
 * Not a generic "are you sure": it restates the consequences in the terms that
 * matter, and asks for the version to be typed rather than a box to be ticked.
 * The version is the one thing a wrong run gets wrong, so typing it is the check.
 */
function ConfirmDialog({
  version,
  head,
  headSha,
  headSubject,
  warns,
  typed,
  onTyped,
  onCancel,
  onGo,
  busy,
}: {
  version: string;
  head: string;
  headSha: string;
  headSubject: string;
  warns: Check[];
  typed: string;
  onTyped: (s: string) => void;
  onCancel: () => void;
  onGo: () => void;
  busy: boolean;
}) {
  const matches = typed.trim() === version.trim();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="max-h-full w-full max-w-lg overflow-auto rounded-[10px] border border-line bg-surface p-5">
        <div className={CTITLE}>Release thật</div>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">{version}</h2>

        <div className="mt-3 flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-ink-2">
          <div>
            <b>Repo SDK</b> — build từ <span className="font-mono">{head}</span> @{" "}
            <span className="font-mono">{headSha.slice(0, 8)}</span>
            {headSubject && (
              <span className="mt-0.5 block text-[12px] text-ink-3">{headSubject}</span>
            )}
          </div>
          <div className="rounded-[5px] border border-crit/50 bg-crit-soft px-2.5 py-2 text-crit">
            Sẽ tạo release + tag <span className="font-mono">pre-{version}</span>, upload
            framework, rồi <b>commit và push thẳng lên</b>{" "}
            <span className="font-mono">atthetalk/viptalk-matrix-rust-components-swift</span>{" "}
            nhánh <span className="font-mono">main</span>.
          </div>
          <div className="text-ink-3">Mất khoảng 20–60 phút.</div>
          {warns.map((w) => (
            <div key={w.id} className="text-warn">
              ⚠ {w.label}: {w.detail}
            </div>
          ))}
        </div>

        <label className="mt-3 block">
          <span className="text-[12px] text-ink-2">
            Gõ lại tên version để xác nhận
          </span>
          <input
            value={typed}
            onChange={(e) => onTyped(e.target.value)}
            placeholder={version}
            autoFocus
            className={INPUT + " mt-1 w-full font-mono"}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={BTN}>
            Huỷ
          </button>
          <button
            type="button"
            onClick={onGo}
            disabled={!matches || busy}
            className="rounded-md bg-crit px-3 py-1 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Đang chạy…" : "Release"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Trạng thái quyền thông báo, và nút xin lại khi bị chặn.
 *
 * Bật công tắc mà trình duyệt đang chặn thì sẽ không có tiếng nào kêu, và không
 * gì trên màn hình nói ra điều đó — công tắc trông như hỏng.
 */
function NotifyPermission({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    setState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);

  if (!enabled || state === "granted") return null;

  if (state === "unsupported")
    return (
      <p className="mt-1.5 text-[11.5px] text-ink-3">
        Trình duyệt này không có thông báo desktop.
      </p>
    );

  return (
    <p className="mt-1.5 text-[11.5px] text-warn">
      {state === "denied"
        ? "Trình duyệt đang chặn thông báo cho trang này — mở cài đặt site để cho phép."
        : "Chưa cấp quyền thông báo."}
      {state === "default" && (
        <button
          type="button"
          onClick={() =>
            void Notification.requestPermission().then((p) => setState(p))
          }
          className="ml-1.5 underline underline-offset-2"
        >
          Cấp quyền
        </button>
      )}
    </p>
  );
}

function ConfigCard({ view }: { view: SdkConfigView }) {
  const [sdkPath, setSdkPath] = useState(view.sdkPath);
  const [packagePath, setPackagePath] = useState(view.packagePath);
  // An array, not the record it is stored as: a half-typed row has a blank
  // branch name, and a record cannot hold two of those or keep them in order.
  const [rows, setRows] = useState(() =>
    Object.entries(view.suffixes).map(([branch, suffix]) => ({ branch, suffix })),
  );
  const [notifyEnd, setNotifyEnd] = useState(view.notifyEnd);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();

  const setRow = (i: number, patch: Partial<{ branch: string; suffix: string }>) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  const save = () =>
    start(async () => {
      const res = await saveSdkConfigAction({
        sdkPath,
        packagePath,
        suffixes: Object.fromEntries(
          rows.filter((r) => r.branch.trim()).map((r) => [r.branch, r.suffix]),
        ),
        notifyEnd,
      });
      setNote(res.message);
    });

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <section className={CARD}>
        <div className={CTITLE}>Đường dẫn hai clone</div>
      <p className="mt-1.5 text-[12.5px] text-ink-3">
        App chạy đúng ba lệnh ghi trên hai repo này: <span className="font-mono">fetch</span>,{" "}
        <span className="font-mono">checkout</span>, và{" "}
        <span className="font-mono">merge --ff-only origin/main</span> ở repo swift, rồi{" "}
        <span className="font-mono">swift run release</span> ở{" "}
        <span className="font-mono">Tools/Release/Sources</span>. Không{" "}
        <span className="font-mono">pull</span>, không merge thật, không{" "}
        <span className="font-mono">rebase</span>,{" "}
        <span className="font-mono">reset</span>,{" "}
        <span className="font-mono">-f</span> hay{" "}
        <span className="font-mono">-B</span> — không thao tác nào ở đây xoá được việc bạn
        chưa push.
        <br />
        Fast-forward chỉ dời con trỏ nên không thể sinh conflict; hai nhánh đã đi lệch thì
        app dừng và báo. Checkout bị từ chối khi cây làm việc còn thay đổi chưa commit, vì
        nó sẽ mang những thay đổi đó sang nhánh mới.
        <br />
        Môi trường build — toolchain, <span className="font-mono">PATH</span>,{" "}
        <span className="font-mono">~/.netrc</span> — là phần của bạn. App không kiểm và không
        sửa gì trong đó; nó thừa hưởng nguyên môi trường của tiến trình server và chạy lệnh.
        Thiếu gì thì log nói.
      </p>

      <div className="mt-3 flex flex-col gap-2.5">
        <label className="block">
          <span className="text-[11.5px] text-ink-3">Repo SDK (Rust)</span>
          <input
            value={sdkPath}
            onChange={(e) => setSdkPath(e.target.value)}
            placeholder="/Users/ban/Repo/viptalk-matrix-rust-sdk-ruma"
            className={INPUT + " mt-1 w-full font-mono text-[12px]"}
          />
        </label>
        <label className="block">
          <span className="text-[11.5px] text-ink-3">Repo swift (nơi release đi ra)</span>
          <input
            value={packagePath}
            onChange={(e) => setPackagePath(e.target.value)}
            placeholder="/Users/ban/Repo/viptalk-matrix-rust-components-swift"
            className={INPUT + " mt-1 w-full font-mono text-[12px]"}
          />
        </label>
        </div>
      </section>

      {/*
       * Thông báo desktop khi lần chạy kết thúc.
       *
       * Build mất 20–60 phút và không ai ngồi nhìn màn hình suốt chừng ấy — đó
       * đúng là lý do chạy trong app thay vì trong Terminal. Xin quyền ngay tại
       * chỗ bật, chứ không lúc trang tải: trình duyệt chỉ cho xin khi người dùng
       * vừa bấm một cái gì đó.
       */}
      <section className={CARD}>
        <div className={CTITLE}>Thông báo</div>
        <label className="mt-2 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={notifyEnd}
            onChange={(e) => {
              setNotifyEnd(e.target.checked);
              if (
                e.target.checked &&
                typeof Notification !== "undefined" &&
                Notification.permission === "default"
              )
                void Notification.requestPermission();
            }}
            className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-[12.5px] text-ink-2">
            Báo lên desktop khi lần chạy <b>kết thúc</b> — xong, lỗi, hay bị huỷ.
            <span className="mt-0.5 block text-[11.5px] text-ink-3">
              Log vẫn chạy trong app dù bạn ở tab khác; cái này chỉ là tiếng gọi
              lúc nó dừng.
            </span>
          </span>
        </label>
        <NotifyPermission enabled={notifyEnd} />
      </section>

      {/*
       * The guide's table, editable.
       *
       * It ships seeded with the five branches the guide names, and it exists so
       * this module is not one team's tool. Everything else derives from the
       * branch itself — the team prefix is its first segment, so `hir/…` or a
       * team created tomorrow works with nothing configured. What a map is for is
       * the exceptions: the branches whose suffix was a human decision
       * (`share_code_via_qr_code` shipped as `ctalkqrcode`) and which would
       * otherwise be re-decided, differently, every release.
       */}
      <section className={CARD}>
      <div className={CTITLE}>Bảng hậu tố theo nhánh</div>
      <p className="mt-1.5 text-[12.5px] text-ink-3">
        Khớp chính xác tên nhánh thì thắng mọi luật suy đoán. Năm dòng đầu là bảng trong
        tài liệu; thêm nhánh của team bạn vào đây. Hậu tố <b>để trống</b> nghĩa là version
        chỉ còn ngày trần — đó là cách <span className="font-mono">master</span> được viết.
        <br />
        Tiền tố team <b>không cần khai báo</b>: app đọc từ segment đầu của tên nhánh, nên{" "}
        <span className="font-mono">hir/…</span> hay một team mới đều chạy đúng ngay.
      </p>

      <div className="mt-2.5 flex flex-col gap-1">
        <div className="flex gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
          <span className="flex-1">Nhánh</span>
          <span className="w-[150px]">Hậu tố</span>
          <span className="w-5" />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={r.branch}
              onChange={(e) => setRow(i, { branch: e.target.value })}
              placeholder="ctalk/develop"
              className={INPUT + " min-w-0 flex-1 font-mono text-[12px]"}
            />
            <input
              value={r.suffix}
              onChange={(e) => setRow(i, { suffix: e.target.value })}
              placeholder="(trống)"
              className={INPUT + " w-[150px] font-mono text-[12px]"}
            />
            <button
              type="button"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              title="Bỏ dòng này"
              className="w-5 shrink-0 text-[13px] text-ink-3 hover:text-crit"
            >
              ×
            </button>
          </div>
        ))}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, { branch: "", suffix: "" }])}
            className={BTN}
          >
            + Thêm nhánh
          </button>
          {/* The seed only runs when the setting has never been written, so a
              map saved before a row was added to the guide never gains it.
              Merges what is missing; never touches a row already here. */}
          {Object.keys(DEFAULT_BRANCH_SUFFIXES).some(
            (b) => !rows.some((r) => r.branch.trim() === b),
          ) && (
            <button
              type="button"
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  ...Object.entries(DEFAULT_BRANCH_SUFFIXES)
                    .filter(([b]) => !rs.some((r) => r.branch.trim() === b))
                    .map(([branch, suffix]) => ({ branch, suffix })),
                ])
              }
              title="Thêm những dòng trong bảng tài liệu mà bảng này đang thiếu"
              className={BTN}
            >
              + Bổ sung bảng tài liệu
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={busy} onClick={save} className={BTN_PRI}>
          {busy ? "Đang lưu…" : "Lưu"}
        </button>
        {note && <span className="text-[12px] text-ink-3">{note}</span>}
      </div>
      </section>
      </div>
  );
}
