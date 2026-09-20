"use client";

import { useEffect, useState, useTransition } from "react";

import {
  type EnvState,
  type GitHubConfigView,
  type PlanAction,
  type PlanRow,
  REPO_COLORS,
  envLadder,
  prBadge,
  repoSolidClass,
  repoLabel,
  shortRepo,
} from "@/lib/modules/branches/github-model";
import { type StageConfig, envSteps } from "@/lib/modules/branches/model";
import type { ScanResult } from "@/lib/modules/branches/scan";

import {
  applyPlanAction,
  deleteNotesAction,
  detectGitHubAction,
  listReposAction,
  detectWorkflowAction,
  saveGitHubConfigAction,
  checkLocalPathsAction,
  scanGitHubAction,
} from "./actions";

const CARD = "rounded-[9px] border border-line bg-surface p-[17px]";
const CTITLE = "font-mono text-[10.5px] uppercase tracking-[0.09em] text-ink-3";
const BTN =
  "rounded-md border border-line-strong bg-surface px-2.5 py-1 text-[12.5px] hover:bg-surface-2 disabled:opacity-50";
const BTN_PRI =
  "rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:bg-accent-2 disabled:opacity-50";
const INPUT =
  "w-full rounded-md border border-line bg-ground px-2.5 py-[5px] text-[12.5px]";
const LABEL = "mb-1 block text-[11.5px] font-medium text-ink-2";

/** Comma-separated text ⇄ list, the shape every identity field here takes. */
const toList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const toText = (xs: string[]) => xs.join(", ");

export function GitHubPanel({
  view,
  stages,
  baseUrl,
}: {
  view: GitHubConfigView;
  stages: StageConfig[];
  baseUrl: string;
}) {
  const [logins, setLogins] = useState(toText(view.identity.logins));
  /** '' means untouched — see `setGitHubConfig`. Never pre-filled: the
      browser is not sent the token, only whether there is one. */
  const [token, setToken] = useState("");
  const [useEvents, setUseEvents] = useState(view.useEvents);
  const [localPaths, setLocalPaths] = useState(view.localPaths.join("\n"));
  const [pathRows, setPathRows] = useState<Array<{
    path: string;
    repo: string;
    branches: number;
    watched: boolean;
    why: string;
  }> | null>(null);
  const [pathNote, setPathNote] = useState("");
  const [repoLabels, setRepoLabels] = useState<Record<string, string>>(
    view.repoLabels,
  );
  const [repoColors, setRepoColors] = useState<Record<string, string>>(
    view.repoColors,
  );
  const [repos, setRepos] = useState<string[]>(view.repos);
  const [buildWorkflow, setBuildWorkflow] = useState(view.buildWorkflow);
  const [buildRepo, setBuildRepo] = useState(view.buildRepo);
  /** How the workflow above was arrived at, for the line that explains it. */
  const [wfFound, setWfFound] = useState<"detected" | "unknown" | null>(null);
  /** The two boxes stay hidden until asked for — see the notes beside them. */
  const [repoOpen, setRepoOpen] = useState(false);
  const [wfOpen, setWfOpen] = useState(false);
  const [buildEnabled, setBuildEnabled] = useState(view.buildEnabled);
  const [buildNotify, setBuildNotify] = useState(view.buildNotify);
  const [buildApps, setBuildApps] = useState<Record<string, string>>(
    view.buildApps,
  );

  /** Whether iOS publish holds a credential for the app name typed in. */
  const ascKnows = (name: string) =>
    view.ascApps.some(
      (a) => a.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  /** One row per environment, in pipeline order. */
  const envBranches = envSteps(stages).map((s) => s.branch);
  const hasToken = view.hasToken;

  const [owner, setOwner] = useState("");
  const [available, setAvailable] = useState<string[]>([]);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [busy, start] = useTransition();

  // Work the workflow out once the build channel is on, and again whenever the
  // repo it reads changes. A value already saved is left alone: the lookup is
  // there to spare the first setup a question, not to correct a later answer.
  useEffect(() => {
    if (!buildEnabled) return;
    let alive = true;
    void detectWorkflowAction(buildRepo)
      .then((res) => {
        if (!alive) return;
        setWfFound(res.workflow ? "detected" : "unknown");
        if (res.workflow && !buildWorkflow) {
          setBuildWorkflow(res.workflow);
          save({ buildWorkflow: res.workflow });
        }
      })
      .catch(() => {
        if (alive) setWfFound("unknown");
      });
    return () => {
      alive = false;
    };
    // `buildWorkflow` is read, not watched: saving what was just found must not
    // send this round again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildEnabled, buildRepo]);

  function save(extra?: Partial<{ repos: string[]; buildWorkflow: string }>) {
    const nextRepos = extra?.repos ?? repos;
    // A <select> saves on change, so the new value has to be passed in rather
    // than read from state that React has not committed yet.
    const nextWorkflow = extra?.buildWorkflow ?? buildWorkflow;
    start(async () => {
      const res = await saveGitHubConfigAction({
        repos: nextRepos,
        identity: {
          logins: toList(logins),
        },
        useEvents,
        localPaths: localPaths
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        repoLabels,
        repoColors,
        buildWorkflow: nextWorkflow,
        buildEnabled,
        buildNotify,
        buildRepo,
        buildApps,
      });
      setNote({ ok: res.ok, text: res.message });
      if (res.view) {
        setRepos(res.view.repos);
      }
    });
  }

  // Ai cầm token thì GitHub biết chắc, nên app đọc lấy thay vì để một cái nút
  // hỏi lại người dùng câu mà token đã trả lời. Login đã có thì không ghi đè:
  // ô này là danh sách, người dùng có thể thêm tài khoản thứ hai vào đó.
  useEffect(() => {
    if (!hasToken) return;
    let alive = true;
    void detectGitHubAction()
      .then((res) => {
        if (!alive) return;
        // Token hỏng thì phải nói ra. Im lặng ở đây từng là lỗi đắt ở module
        // kia: một token hết hạn trông y như "không có nhánh nào của bạn".
        if (!res.ok) {
          setNote({ ok: false, text: res.message });
          return;
        }
        if (res.login && !toList(logins).includes(res.login))
          setLogins((v) => toText([...toList(v), res.login!]));
        setOrgs(res.orgs ?? []);
        if (res.orgs?.length) setOwner((o) => o || res.orgs![0]);
      })
      .catch((e: unknown) => {
        if (alive)
          setNote({
            ok: false,
            text: e instanceof Error ? e.message : "Không đọc được token",
          });
      });
    return () => {
      alive = false;
    };
    // `logins` được đọc chứ không theo dõi: điền xong không được gọi lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken]);

  function loadRepos(who: string) {
    if (!who.trim()) return;
    start(async () => {
      const res = await listReposAction(who);
      setNote({ ok: res.ok, text: res.message });
      setAvailable(res.repos ?? []);
    });
  }

  function checkPaths() {
    start(async () => {
      const res = await checkLocalPathsAction(localPaths.split("\n"));
      setPathNote(res.message);
      setPathRows(res.rows ?? []);
    });
  }

  function runScan() {
    start(async () => {
      const res = await scanGitHubAction();
      setNote({ ok: res.ok, text: res.message });
      setScan(res.result ?? null);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {note && (
        <p
          className={
            "rounded-md border px-3 py-2 text-[12.5px] " +
            (note.ok
              ? "border-line bg-surface-2 text-ink-2"
              : "border-crit bg-crit-soft text-crit")
          }
        >
          {note.text}
        </p>
      )}

      {/* ── identity ───────────────────────────────────────────────────────── */}
      <section className={CARD}>
        <span className={CTITLE}>Nhánh nào là của tôi</span>
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          Một nhánh được coi là của bạn nếu commit cuối do bạn tạo. Nhánh bạn
          push mà commit cuối là của người khác thì dựa vào ô bên dưới.
        </p>
        <div className="mt-2.5">
          <label className={LABEL}>
            Personal access token{" "}
            <span className="font-normal text-ink-3">
              {hasToken ? "· đã có, để trống nếu không đổi" : "· scope repo"}
            </span>
          </label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder={hasToken ? "••••••••" : "ghp_…"}
            className={INPUT + " sm:max-w-sm"}
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Chỉ module này dùng GitHub. Lần đầu lấy từ{" "}
            <span className="font-mono">GITHUB_TOKEN</span> trong{" "}
            <span className="font-mono">.env.local</span> nếu có.
          </p>
        </div>

        <div className="mt-2.5">
          <label className={LABEL}>Login GitHub</label>
          <input
            value={logins}
            onChange={(e) => setLogins(e.target.value)}
            placeholder="windxfeng"
            className={INPUT + " sm:max-w-sm"}
          />
        </div>
        <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-md border border-line bg-ground px-2.5 py-2">
          <input
            type="checkbox"
            checked={useEvents}
            onChange={(e) => setUseEvents(e.target.checked)}
            className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-[12.5px] text-ink-2">
            <b>Nhận cả nhánh do tôi tạo / push</b> — đọc từ nhật ký hoạt động
            GitHub của bạn.
            <span className="mt-0.5 block text-[11.5px] text-ink-3">
              Đây là tín hiệu duy nhất bắt được nhánh vừa tạo mà chưa có commit
              nào của bạn: nếu tách nhánh từ{" "}
              <span className="font-mono">develop</span> rồi push ngay, commit ở
              đầu nhánh vẫn là của người khác. GitHub chỉ giữ khoảng 300 sự kiện
              gần nhất, nên đây là bổ sung cho ô trên chứ không thay thế.
            </span>
          </span>
        </label>

        {orgs.length > 0 && (
          <p className="mt-2 font-mono text-[11px] text-ink-3">
            org thấy được: {orgs.join(", ")}
          </p>
        )}
      </section>

      {/* ── repos ──────────────────────────────────────────────────────────── */}
      <section className={CARD}>
        <div className={CTITLE}>Repo cần quét · {repos.length} đã chọn</div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <label className={LABEL}>Owner / org</label>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadRepos(owner)}
              placeholder="tên tổ chức GitHub"
              className={INPUT}
            />
          </div>
          <button
            type="button"
            onClick={() => loadRepos(owner)}
            disabled={busy}
            className={BTN}
          >
            Tải danh sách repo
          </button>
        </div>

        {repos.length > 0 && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            {repos.map((r) => (
              <div key={r} className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2"
                  title={r}
                >
                  {r}
                </span>
                <input
                  value={repoLabels[r] ?? ""}
                  onChange={(e) =>
                    setRepoLabels((m) => ({ ...m, [r]: e.target.value }))
                  }
                  placeholder={shortRepo(r, repos)}
                  title="Tên ngắn in trên card. Bỏ trống thì dùng phần khác nhau giữa các repo."
                  className="w-[92px] shrink-0 rounded-md border border-line bg-ground px-2 py-[3px] text-center font-mono text-[11px]"
                />
                <select
                  value={repoColors[r] ?? ""}
                  onChange={(e) =>
                    setRepoColors((m) => ({ ...m, [r]: e.target.value }))
                  }
                  title="Màu chip trên card"
                  className="w-[104px] shrink-0 rounded-md border border-line bg-ground px-1.5 py-[3px] text-[11.5px]"
                >
                  <option value="">— xám —</option>
                  {REPO_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span
                  title="Xem trước"
                  className={
                    "w-[84px] shrink-0 truncate rounded-[3px] px-1 py-px text-center font-mono text-[10px] font-bold uppercase tracking-[0.04em] " +
                    repoSolidClass(repoColors[r])
                  }
                >
                  {repoLabel(r, repoLabels, repos)}
                </span>
                <button
                  type="button"
                  title="Bỏ khỏi danh sách quét"
                  onClick={() => setRepos((xs) => xs.filter((x) => x !== r))}
                  className="grid size-6 shrink-0 place-items-center rounded text-[13px] text-ink-3 hover:bg-crit-soft hover:text-crit"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {available.length > 0 && (
          <div className="mt-2.5 max-h-[210px] overflow-y-auto rounded-md border border-line bg-ground p-2">
            <div className="flex flex-wrap gap-1">
              {available
                .filter((r) => !repos.includes(r))
                .map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRepos((xs) => [...xs, r])}
                    className="rounded border border-line-strong bg-surface px-1.5 py-px font-mono text-[10.5px] text-ink-2 hover:border-accent hover:text-accent-ink"
                  >
                    + {r.split("/")[1] ?? r}
                  </button>
                ))}
            </div>
          </div>
        )}
      </section>

      {/* ── local clones ────────────────────────────────────────────────── */}
      <section className={CARD}>
        <div className={CTITLE}>Clone trên máy · nhánh chưa push</div>
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          Nhánh chưa push chỉ tồn tại trên ổ đĩa — token GitHub không thể thấy.
          Điền đường dẫn tới các clone, mỗi dòng một cái. Khi quét, app chỉ{" "}
          <b>đọc</b>: liệt kê nhánh và đếm commit chưa đẩy lên, không{" "}
          <span className="font-mono">fetch</span>,{" "}
          <span className="font-mono">pull</span> hay ghi gì vào repo của bạn.
          Vị trí môi trường vẫn hỏi GitHub như cũ, nên nhánh chưa push chưa có
          dữ liệu môi trường.{" "}
          <span className="text-ink-2">
            Module <b>Release SDK</b> có chạy <span className="font-mono">fetch</span>,{" "}
            <span className="font-mono">checkout</span> và{" "}
            <span className="font-mono">merge --ff-only</span> trên hai repo của riêng nó —
            nó tự nói trước khi làm, và dừng lại khi cây làm việc chưa sạch hoặc hai nhánh
            đã đi lệch.
          </span>
        </p>
        <textarea
          value={localPaths}
          onChange={(e) => {
            setLocalPaths(e.target.value);
            setPathRows(null);
          }}
          rows={3}
          placeholder={
            "~/Code/my-ios-app\n~/Code/my-sdk\nMỗi dòng một clone — bấm Kiểm tra để xem app đọc ra repo nào"
          }
          className={INPUT + " mt-2 font-mono text-[11.5px] leading-relaxed"}
        />
        {/* Checked here rather than as a side effect of a scan. Finding out a
            path has a typo in it should not cost a walk of every branch in
            every repository. */}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={checkPaths}
            disabled={busy || !localPaths.trim()}
            className={BTN + " disabled:opacity-50"}
          >
            Kiểm tra đường dẫn
          </button>
          {pathNote && (
            <span className="font-mono text-[11.5px] text-ink-3">
              {pathNote}
            </span>
          )}
        </div>
        {pathRows && pathRows.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {pathRows.map((r) => (
              <li
                key={r.path}
                className="flex min-w-0 items-baseline gap-2 font-mono text-[11.5px]"
              >
                <span
                  className={
                    "shrink-0 " +
                    (r.why || !r.watched ? "text-warn" : "text-good")
                  }
                >
                  {r.why || !r.watched ? "✕" : "✓"}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {r.path}
                </span>
                <span className="shrink-0 text-ink-3">
                  {r.why
                    ? r.why
                    : !r.watched
                      ? `${r.repo} — chưa có trong danh sách repo theo dõi`
                      : `${r.repo} · ${r.branches} nhánh`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── project keys ─────────────────────────────────────────────────── */}
      {/* The build channel. Merging is not shipping: QC installs a TestFlight
          build, so a column that means "ready to test" has to be able to see
          one. A run alone is not enough either — it proves the code compiled,
          not that anyone can install it — hence the App Store Connect app. */}
      <section className={CARD}>
        {/* The switch sits on the heading, not under the fields: this whole
            section is written for a team that ships a mobile app, and for
            anybody else the honest thing is to let them put it away rather than
            scroll past six boxes they can never fill in. */}
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={buildEnabled}
            onChange={(e) => setBuildEnabled(e.target.checked)}
            className="size-3.5 shrink-0 accent-[var(--accent)]"
          />
          <span className={CTITLE}>Bản build đã lên TestFlight</span>
        </label>
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          {buildEnabled ? (
            <>
              Cột <b>đã build</b> chỉ tính khi có bản build thật lên TestFlight.
              App ghép run của workflow với build number trên App Store Connect
              — build number là dấu thời gian do runner đóng, nên nó chỉ ra đúng
              commit mà bản build đó chứa.
            </>
          ) : (
            <>
              Đang tắt — phần này chỉ dành cho team có ship app. Board bỏ hẳn mọi
              thứ về bản build: không ô build trên card, không nút{" "}
              <span className="font-mono">↻ Bản build</span>, và không gọi App
              Store Connect lần nào. Cấu hình đã điền vẫn được giữ, bật lại là
              có ngay.
            </>
          )}
        </p>

        {buildEnabled && (
        <>
        {/*
         * Not a question any more.
         *
         * There was a picker here, listing every workflow in the repo. But the
         * repo answers it: exactly one of the twelve active workflows packages
         * the app itself — the rest lint, scan, test, or just call that one —
         * so the app reads them and says what it found. The box stays reachable
         * because a team whose build does not look like this one's has to be
         * able to say so.
         */}
        <p className="mt-3 text-[12.5px] text-ink-3">
          {wfFound === "unknown" && !buildWorkflow ? (
            <span className="text-warn">
              Chưa dò ra workflow nào dựng bản cài được trong{" "}
              <span className="font-mono">{buildRepo || "repo build"}</span> —
              điền tên file bên dưới.
            </span>
          ) : (
            <>
              Workflow build{" "}
              <span className="font-mono text-ink-2">{buildWorkflow || "—"}</span>
              {wfFound === "detected" && " · app tự đọc ra từ repo"}
            </>
          )}
          {!wfOpen && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => setWfOpen(true)}
                className="text-accent-ink underline underline-offset-2"
              >
                đổi workflow
              </button>
            </>
          )}
        </p>

        {wfOpen && (
          <label className="mt-1.5 block max-w-md">
            <span className={CTITLE}>Workflow build</span>
            <input
              value={buildWorkflow}
              onChange={(e) => setBuildWorkflow(e.target.value)}
              onBlur={() => save()}
              placeholder="build.yml"
              className="mt-1 w-full rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12px]"
            />
            <span className="mt-1 block text-[11.5px] text-ink-3">
              Tên file trong <span className="font-mono">.github/workflows/</span>.
            </span>
          </label>
        )}

        {/*
         * The repo is not a second question.
         *
         * The workflow list above is read *from* it, so picking a workflow
         * already implies the repo — showing both made the screen restate
         * itself. It stays reachable because the build does not have to live in
         * a repo the board watches: another team may run it from a release repo
         * of its own, and then there is nothing to infer it from.
         */}
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          Đọc từ repo{" "}
          <span className="font-mono text-ink-2">{buildRepo || "—"}</span>
          {!repoOpen && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => setRepoOpen(true)}
                className="text-accent-ink underline underline-offset-2"
              >
                đổi repo
              </button>
            </>
          )}
        </p>

        {repoOpen && (
          <label className="mt-1.5 block max-w-md">
            <span className={CTITLE}>Repo chạy workflow</span>
            <input
              value={buildRepo}
              onChange={(e) => setBuildRepo(e.target.value)}
              onBlur={() => save()}
              placeholder={view.buildRepo || "owner/repo"}
              className="mt-1 w-full rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-[12px]"
            />
            <span className="mt-1 block text-[11.5px] text-ink-3">
              Để trống thì lấy repo có nhãn <span className="font-mono">iOS</span>.
              SDK không tự build được — app iOS dựng bản tương ứng cho nó.
            </span>
          </label>
        )}

        {/* Đo trên 90 bản build thật: run GitHub cho biết commit của 57 bản,
            ghi chú What to Test chỉ nêu ticket cho 20. Hai đường bổ cho nhau,
            và thiếu hai ô này thì fetchEnvBuilds thoát ngay, không gọi cả ASC. */}
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-3">
          App ghép <b>run của workflow</b> với <b>bản build trên App Store
          Connect</b>. Run cho biết bản build đó dựng từ <b>commit nào</b> và
          đóng băng lúc nào — App Store Connect không biết điều đó, nó chỉ có số
          hiệu build và ghi chú. Không có cặp này thì app không đọc build nào
          cả, kể cả bản đã lên TestFlight.
        </p>

        {envBranches.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <span className={CTITLE}>
              App trên App Store Connect cho từng môi trường
            </span>
            {envBranches.map((b) => (
              <label key={b} className="flex items-center gap-2">
                <span className="w-[128px] shrink-0 truncate font-mono text-[11.5px] text-ink-2">
                  {b}
                </span>
                <input
                  value={buildApps[b] ?? ""}
                  onChange={(e) =>
                    setBuildApps((m) => ({ ...m, [b]: e.target.value }))
                  }
                  onBlur={() => save()}
                  placeholder="— chưa map, môi trường này không đo được build —"
                  title="Tên app đúng như trên App Store Connect. Lấy credential từ module iOS publish."
                  className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2.5 py-1.5 text-[12px]"
                />
                {/* Checked here because this is where it is fixable. A name
                    that matches no configured app made the environment produce
                    no builds at all, silently — indistinguishable from "no
                    build yet", for ever. */}
                <span
                  className={
                    "w-[150px] shrink-0 text-[11px] " +
                    (!buildApps[b]?.trim()
                      ? "text-ink-3"
                      : ascKnows(buildApps[b])
                        ? "text-good"
                        : "text-warn")
                  }
                >
                  {!buildApps[b]?.trim()
                    ? ""
                    : ascKnows(buildApps[b])
                      ? "✓ có credential"
                      : "✕ chưa có trong iOS publish"}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-ink-3">
            Chưa có cột nào là môi trường — thêm ở tab &ldquo;Cột&rdquo; trước.
          </p>
        )}

        {/* Its own switch, at the end of the section it belongs to. The board
            is useful for branches alone — a team with no TestFlight to watch
            should not be paying for a watcher, nor be asked for a notification
            permission it can never use. */}
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-line bg-ground px-2.5 py-2">
          <input
            type="checkbox"
            checked={buildNotify}
            onChange={(e) => setBuildNotify(e.target.checked)}
            className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]"
          />
          <span className="text-[12.5px] text-ink-2">
            <b>Báo khi có bản build mới</b> — nền, nửa tiếng một lần.
            <span className="mt-0.5 block text-[11.5px] text-ink-3">
              App hỏi App Store Connect ở mọi màn, miễn còn mở một tab; có bản
              mới thì hiện chấm cạnh mục{" "}
              <b className="font-medium text-ink-2">Nhánh &amp; ghi chú</b>, và
              bắn thông báo trình duyệt nếu bạn đã cho phép. Tắt thì không gọi
              gì cả — nút{" "}
              <span className="font-mono">↻ Bản build</span> vẫn dùng được khi
              bạn tự bấm.
            </span>
          </span>
        </label>
        </>
        )}
      </section>

      {/* Columns and environments are one ordered list now, edited on the
          "Cột" tab — the same ordering used to live in three places here and
          had to be kept consistent by hand. */}
      <section className={CARD}>
        <div className={CTITLE}>Cột & môi trường</div>
        <p className="mt-1.5 text-[12.5px] text-ink-3">
          Cột của bảng chính là đường đi của code. Sửa ở tab <b>Cột</b>.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {stages.map((st, i) => (
            <span key={st.name} className="flex items-center gap-1">
              {i > 0 && <span className="text-ink-3">›</span>}
              <span
                title={
                  st.branch
                    ? `Môi trường — nhánh ${st.branch}`
                    : "Trước khi merge — xét theo PR"
                }
                className={
                  "rounded-[3px] border px-1.5 py-px font-mono text-[10.5px] " +
                  (st.branch
                    ? "border-good bg-good-soft text-good"
                    : "border-line bg-surface-2 text-ink-3")
                }
              >
                {st.name}
                {st.branch && (
                  <span className="opacity-70"> · {st.branch}</span>
                )}
              </span>
            </span>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => save()}
          disabled={busy}
          className={BTN_PRI}
        >
          Lưu cấu hình
        </button>
        <button type="button" onClick={runScan} disabled={busy} className={BTN}>
          {busy ? "Đang chạy…" : "Quét GitHub"}
        </button>
        <span className="text-[11.5px] text-ink-3">
          Quét chỉ đọc — chưa ghi gì cho tới khi bạn bấm Áp dụng.
        </span>
      </div>

      {scan && (
        <ScanReview
          scan={scan}
          baseUrl={baseUrl}
          envs={stages}
          onApplied={() => setScan(null)}
        />
      )}
    </div>
  );
}

// ── plan review ──────────────────────────────────────────────────────────────

const ACTION_STYLE: Record<PlanAction, { label: string; cls: string }> = {
  create: { label: "tạo mới", cls: "border-good bg-good-soft text-good" },
  fill: { label: "cập nhật", cls: "border-blue bg-blue-soft text-blue" },
  conflict: { label: "khác nhánh", cls: "border-warn bg-warn-soft text-warn" },
  match: { label: "đã khớp", cls: "border-line bg-surface-2 text-ink-3" },
};

function ScanReview({
  scan,
  baseUrl,
  envs,
  onApplied,
}: {
  scan: ScanResult;
  baseUrl: string;
  envs: StageConfig[];
  onApplied: () => void;
}) {
  // A conflict overwrites a branch name the user typed, so it starts unticked:
  // everything else on this screen is safe to accept without reading, and that
  // one is not.
  const [picked, setPicked] = useState<Set<string>>(
    () =>
      new Set(
        scan.rows
          .filter((r) => r.action === "create" || r.action === "fill")
          .map((r) => r.issueKey),
      ),
  );
  const [done, setDone] = useState<string | null>(null);
  const [confirmGone, setConfirmGone] = useState(false);
  const [goneDone, setGoneDone] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const toggle = (key: string) =>
    setPicked((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const chosen = scan.rows.filter(
    (r) => r.action !== "match" && picked.has(r.issueKey),
  );

  function apply() {
    start(async () => {
      const res = await applyPlanAction(
        chosen,
        scan.gone.map((g) => g.id),
      );
      setDone(res.message);
      if (res.ok) {
        // The board reads its cards on the server, so a reload is the honest
        // way to show what was just written rather than guessing at it here.
        setTimeout(() => window.location.reload(), 700);
        onApplied();
      }
    });
  }

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <div className={CTITLE}>Kết quả quét</div>
        <span
          className="ml-auto font-mono text-[11px] text-ink-3"
          title={Object.entries(scan.mineBy)
            .map(([k, n]) => `${MINE_LABEL[k] ?? k}: ${n}`)
            .join(" · ")}
        >
          {scan.scanned} nhánh đọc được · {scan.mine} của bạn
          {scan.localOnly ? ` · ${scan.localOnly} chưa push` : ""}
          {scan.localAheadOf
            ? ` · ${scan.localAheadOf} có commit chưa đẩy`
            : ""}{" "}
          · {scan.rows.length} có ticket
        </span>
      </div>

      {scan.localHidden.length > 0 && (
        <div className="mt-2 rounded-md border border-warn bg-warn-soft/40 px-2.5 py-2 text-[12px] text-ink-2">
          <b>Commit chưa đẩy, nằm ngoài bảng</b> — nhánh này có việc chưa push
          nhưng thua nhánh khác trong cuộc tranh card (cùng ticket, hai repo).
          <div className="mt-1 flex flex-col gap-px font-mono text-[11px]">
            {scan.localHidden.map((h) => (
              <div key={`${h.repo}#${h.branch}`}>
                ⇡ {h.ahead} · {h.repo.split("/")[1]} · {h.branch}
              </div>
            ))}
          </div>
        </div>
      )}

      {scan.badPaths.length > 0 && (
        <div className="mt-2 rounded-md border border-warn bg-warn-soft/40 px-2.5 py-1.5 text-[12px] text-ink-2">
          {scan.badPaths.map((b) => (
            <div key={b.path}>
              <span className="font-mono">{b.path}</span> — {b.why}
            </div>
          ))}
        </div>
      )}

      {scan.truncated.length > 0 && (
        <p className="mt-2 rounded-md border border-warn bg-warn-soft/40 px-2.5 py-1.5 text-[12px] text-ink-2">
          Quét dừng sớm ở{" "}
          <span className="font-mono">{scan.truncated.join(", ")}</span> — repo
          có quá nhiều nhánh. Kết quả có thể thiếu.
        </p>
      )}

      {scan.skipped.length > 0 && (
        <p className="mt-2 rounded-md border border-warn bg-warn-soft/40 px-2.5 py-1.5 text-[12px] text-ink-2">
          Không đọc được:{" "}
          <span className="font-mono">{scan.skipped.join(", ")}</span> — repo đã
          đổi tên, đã xoá, hoặc token không thấy.
        </p>
      )}

      {scan.unmatched > 0 && (
        <div className="mt-2 rounded-md border border-line bg-surface-2 px-2.5 py-2">
          <p className="text-[12px] text-ink-2">
            {scan.unmatched} nhánh của bạn không có mã ticket trong tên. Chúng vẫn
            lên board, chỉ là card không có link Jira.
          </p>
          {scan.unmatchedSamples.length > 0 && (
            <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-ink-3">
              {scan.unmatchedSamples.join(" · ")}
            </p>
          )}
        </div>
      )}

      {scan.gone.length > 0 && (
        <div className="mt-2.5 rounded-md border border-line bg-surface-2 px-2.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={CTITLE}>
              Nhánh không còn tồn tại · {scan.gone.length}
            </span>
            {goneDone ? (
              <span className="ml-auto text-[12px] text-ink-2">{goneDone}</span>
            ) : confirmGone ? (
              <span className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      const res = await deleteNotesAction(
                        scan.gone.map((g) => g.id),
                      );
                      setGoneDone(res.message);
                    })
                  }
                  className="rounded-md bg-crit px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                >
                  Chắc chắn xoá {scan.gone.length}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmGone(false)}
                  className={BTN}
                >
                  Khoan
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmGone(true)}
                className="ml-auto rounded-md border border-crit px-2.5 py-1 text-[12px] font-medium text-crit hover:bg-crit-soft"
              >
                Xoá {scan.gone.length} card này
              </button>
            )}
          </div>
          <p className="mt-1 text-[12px] text-ink-3">
            Nhánh đã bị xoá — trên GitHub thường là đã release xong, còn nhánh
            chưa push thì là bạn tự xoá ở clone. Card vẫn giữ nguyên cho tới khi
            bạn dọn; xoá chỉ gỡ khỏi bảng, không đụng GitHub hay Jira.
          </p>
          <div className="mt-1.5 flex flex-col gap-1">
            {scan.gone.map((g) => (
              <div
                key={g.id}
                className="flex flex-wrap items-center gap-2 text-[12px]"
              >
                <span className="w-[86px] shrink-0 font-mono text-[11px] font-semibold text-accent-ink">
                  {g.issueKey || "—"}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3"
                  title={g.branch}
                >
                  {g.branch}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-ink-3">
                  {g.stage}
                </span>
                {g.bodyLines > 0 && (
                  <span
                    title="Card này có ghi chú bạn tự viết — xoá là mất"
                    className="shrink-0 rounded-[3px] border border-warn bg-warn-soft px-1 py-px font-mono text-[9.5px] text-warn"
                  >
                    ✎ {g.bodyLines} lưu ý
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {scan.rows.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-3">
          Không có nhánh nào gắn được vào ticket.
        </p>
      ) : (
        <div className="mt-2.5 flex flex-col gap-1 overflow-x-auto">
          {scan.rows.map((row) => (
            <PlanLine
              key={row.issueKey}
              row={row}
              baseUrl={baseUrl}
              envs={envs}
              checked={picked.has(row.issueKey)}
              onToggle={() => toggle(row.issueKey)}
            />
          ))}
        </div>
      )}

      {done && <p className="mt-2 text-[12.5px] text-ink-2">{done}</p>}

      {scan.rows.some((r) => r.action !== "match") && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={apply}
            disabled={busy || !chosen.length}
            className={BTN_PRI}
          >
            Áp dụng {chosen.length} thay đổi
          </button>
          <span className="text-[11.5px] text-ink-3">
            Chỉ ghi nhánh, PR và cột. Tiêu đề và ghi chú bạn đã viết không bị
            đụng tới.
          </span>
        </div>
      )}
    </section>
  );
}

function PlanLine({
  row,
  baseUrl,
  envs,
  checked,
  onToggle,
}: {
  row: PlanRow;
  baseUrl: string;
  envs: StageConfig[];
  checked: boolean;
  onToggle: () => void;
}) {
  const style = ACTION_STYLE[row.action];
  const pr = prBadge(row.branch.pr);
  const disabled = row.action === "match";

  return (
    <label
      className={
        "flex min-w-[720px] items-center gap-2 rounded-md border px-2 py-1.5 text-[12px] " +
        (disabled
          ? "border-line bg-surface-2 opacity-60"
          : "cursor-pointer border-line hover:bg-surface-2")
      }
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={onToggle}
        className="size-3.5 shrink-0 accent-[var(--accent)]"
      />
      <span
        className={
          "w-[74px] shrink-0 rounded-[3px] border px-1 py-px text-center font-mono text-[9.5px] font-semibold uppercase " +
          style.cls
        }
      >
        {style.label}
      </span>
      <a
        href={`${baseUrl}/browse/${row.issueKey}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="w-[90px] shrink-0 font-mono text-[11px] font-semibold text-accent-ink hover:underline"
      >
        {row.issueKey}
      </a>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2"
        title={`${row.branch.repo} · ${row.branch.name}`}
      >
        <span className="text-ink-3">{row.branch.repo.split("/")[1]}/</span>
        {row.branch.name}
      </span>
      {pr && (
        <a
          href={row.branch.pr!.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={
            "shrink-0 rounded-[3px] border px-1 py-px font-mono text-[9.5px] hover:underline " +
            PR_CLS[pr.tone]
          }
        >
          {pr.label}
        </a>
      )}
      <EnvLadder state={row.envState} envs={envs} />
      {row.stage && (
        <span className="shrink-0 font-mono text-[10.5px] text-ink-3">
          {row.currentStage && row.currentStage !== row.stage
            ? `${row.currentStage} → `
            : "→ "}
          <b className="text-ink-2">{row.stage}</b>
        </span>
      )}
      {row.action === "conflict" && (
        <span
          className="shrink-0 font-mono text-[10.5px] text-warn"
          title={`Card đang ghi nhánh: ${row.currentBranch}`}
        >
          đè lên: {row.currentBranch}
        </span>
      )}
    </label>
  );
}

/**
 * How far the code has travelled, as one glanceable strip.
 *
 * Every configured environment is shown, including the ones not reached —
 * "đã tới Integration" only means something next to the Staging it has not
 * reached. A number is the commits still missing, which separates "one commit
 * behind" from "never merged".
 */
export function EnvLadder({
  state,
  envs,
  /** True when the card names a branch, so "no data" means "not scanned yet". */
  expected = false,
  className = "",
}: {
  state: EnvState;
  envs: StageConfig[];
  expected?: boolean;
  className?: string;
}) {
  if (!envs.length) return null;
  const cells = envLadder(state, envs);

  // Nothing measured. Silence used to be the answer here, which read as "this
  // branch is nowhere" — and appeared exactly when a card was freshly pinned,
  // at the moment the user was looking for the environment strip.
  if (cells.every((c) => c.kind === "absent")) {
    if (!expected) return null;
    return (
      <span
        title="Chưa đo được môi trường cho nhánh này — bấm ↻ Quét GitHub"
        className={
          "inline-flex shrink-0 items-center rounded-[3px] border border-dashed border-line px-1 py-px font-mono text-[9.5px] text-ink-3 " +
          className
        }
      >
        chưa quét môi trường
      </span>
    );
  }

  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-px font-mono text-[9px] " +
        className
      }
    >
      {cells.map((c, i) => (
        <span
          key={c.env.branch}
          title={
            c.kind === "arrived"
              ? `Code đã nằm trong ${c.env.branch}`
              : c.kind === "landed"
                ? `Code ĐÃ VÀO ${c.env.branch} — nhưng qua đường khác (nhánh resolve, squash hoặc rebase) nên ${c.ahead} commit trên nhánh này mang SHA khác. Nhánh gốc đã lệch, đừng dùng lại.`
                : c.kind === "behind"
                  ? `Chưa vào ${c.env.branch} — còn ${c.ahead} commit chưa có ở đó`
                  : `Repo này không có nhánh ${c.env.branch}`
          }
          className={
            "whitespace-nowrap border px-[3px] py-px " +
            (i === 0 ? "rounded-l-[3px] " : "") +
            (i === cells.length - 1 ? "rounded-r-[3px] " : "") +
            (c.kind === "arrived"
              ? "border-good bg-good-soft font-semibold text-good"
              : c.kind === "landed"
                ? "border-good/60 bg-good-soft/50 font-semibold text-good"
                : c.kind === "behind"
                  ? "border-line bg-surface-2 text-ink-3"
                  : "border-dashed border-line text-ink-3 opacity-60")
          }
        >
          {c.env.name}
          {c.kind === "arrived" && "✓"}
          {/* A tilde, not a second tick: the work is there, the branch is not. */}
          {c.kind === "landed" && "✓~"}
          {/* No commit count here. A grey chip already says "not there yet",
              and the exact distance is a number nobody acts on at a glance —
              it lives in the tooltip, where it is read on purpose. */}
          {c.kind === "absent" && " n/a"}
        </span>
      ))}
    </span>
  );
}

const MINE_LABEL: Record<string, string> = {
  push: "bạn tạo/push",
  login: "commit cuối là bạn",
};

export const PR_CLS: Record<string, string> = {
  done: "border-good bg-good-soft text-good",
  prog: "border-blue bg-blue-soft text-blue",
  warn: "border-warn bg-warn-soft text-warn",
  muted: "border-line bg-surface-2 text-ink-3",
};
