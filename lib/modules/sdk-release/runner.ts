import "server-only";

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getSdkConfig } from "./config";
import { terminalText, phaseOf, stripAnsi, tailLines } from "./model";

/** `script` của BSD — cấp TTY cho lệnh để nó phát màu và thanh tiến trình. */
const SCRIPT_BIN = "/usr/bin/script";
import { type RunRow, claimRun, finishRun, getRun, liveRun, updateRun } from "./store";

const run = promisify(execFile);

/**
 * Starting, watching and ending a forty-minute build from an app that has never
 * had a process outlive a request.
 *
 * Nothing here supervises. The parent is a Next dev server that restarts on
 * every save, so the run is *reaped* instead: its state is reconstructed on
 * demand from the pid, the machine's boot time and a status file the
 * supervisor leaves behind. That is why `lost` is a state of its own — the one
 * honest answer when the evidence has gone, and materially different from
 * `failed`, because a lost run may already have pushed.
 */

const LOG_DIR = path.join(process.cwd(), "data", "sdk-release");

/**
 * When this machine last booted, epoch seconds.
 *
 * Checked before the pid, always. A pid recorded before a reboot may since have
 * been handed to something else entirely, and `kill(pid, 0)` would cheerfully
 * report that stranger alive — turning a run that died in a power cut into one
 * that appears to still be going.
 */
async function bootTime(): Promise<number> {
  try {
    const { stdout } = await run("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      timeout: 5_000,
    });
    const m = /sec\s*=\s*(\d+)/.exec(stdout);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Alive, gone, or alive-but-not-ours. */
function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists and belongs to somebody else. Treating that as
    // dead would end the run early; treating it as alive is the safe read.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readTail(logPath: string, bytes = 64 * 1024): Promise<string> {
  try {
    const stat = await fs.stat(logPath);
    const start = Math.max(0, stat.size - bytes);
    const fh = await fs.open(logPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/**
 * Brings every unfinished row up to date with what is actually true.
 *
 * Called at the top of the page and of every poll. Four questions in order, and
 * the order is the whole design:
 *
 *   1. did the machine reboot since this row was written? → `lost`
 *   2. is the pid alive? → still running; note how far it has got
 *   3. is there a status file? → `ok` or `failed`, by exit code
 *   4. otherwise → `lost`, not `failed`
 *
 * Step four is the one worth defending. "The process is gone and left no word"
 * is not the same as "it failed", and saying `failed` would be the app
 * inventing a fact — one that matters, because a run can die after the push.
 */
export async function reapRuns(): Promise<void> {
  const live = liveRun();
  if (!live) return;

  const boot = await bootTime();
  if (boot && live.bootAt && live.startedAt < boot) {
    finishRun(live.id, "lost", {
      message:
        "Máy đã khởi động lại kể từ lúc chạy — không còn cách nào biết lệnh đã đi tới đâu. Xem log để biết nó dừng ở bước nào.",
    });
    return;
  }

  const tail = await readTail(live.logPath);
  if (pidAlive(live.pid)) {
    updateRun(live.id, { phase: phaseOf(stripAnsi(tail)) });
    return;
  }

  let status: {
    exitCode: number | null;
    signal: string | null;
    error?: string;
  } | null = null;
  try {
    status = JSON.parse(await fs.readFile(`${live.logPath}.status`, "utf8")) as {
      exitCode: number | null;
      signal: string | null;
      error?: string;
    };
  } catch {
    status = null;
  }

  if (!status) {
    finishRun(live.id, "lost", {
      phase: phaseOf(stripAnsi(tail)),
      message:
        "Tiến trình không còn chạy và không ghi lại kết quả — nhiều khả năng bị kill. Xem log để biết nó dừng ở bước nào.",
    });
    return;
  }

  const code = status.exitCode;
  finishRun(live.id, code === 0 ? "ok" : "failed", {
    exitCode: code,
    phase: phaseOf(stripAnsi(tail)),
    message: status.error
      ? `Không khởi động được lệnh: ${status.error}`
      : code === 0
        ? ""
        : `Lệnh thoát với mã ${code ?? "?"}${status.signal ? ` (signal ${status.signal})` : ""}.`,
  });
}

export interface StartResult {
  ok: boolean;
  message: string;
  id?: number;
}

/**
 * Starts a release and returns immediately.
 *
 * The ordering is load-bearing: the row is inserted **before** anything is
 * spawned, so the unique index — not a check — decides whether a second run
 * may start. A spawn that then throws frees the slot by finishing the row.
 */
export async function startRun(input: {
  version: string;
  branch: string;
  commitSha: string;
  suffix: string;
  ordinal: number;
  localOnly: boolean;
  /** `origin/main` của repo swift lúc bắt đầu — lưu để đối chiếu về sau. */
  mainSha: string;
}): Promise<StartResult> {
  const cfg = getSdkConfig();
  if (!cfg.packagePath) return { ok: false, message: "Chưa cấu hình đường dẫn repo swift." };

  await reapRuns();
  if (liveRun()) return { ok: false, message: "Đang có một lần chạy khác chưa kết thúc." };

  const boot = await bootTime();
  let id: number;
  try {
    id = claimRun({ ...input, bootAt: boot });
  } catch {
    // The unique index refused: something claimed the slot between the reap
    // above and here. That is exactly the race the index exists to settle.
    return { ok: false, message: "Vừa có một lần chạy khác giành trước." };
  }

  const logPath = path.join(LOG_DIR, `${id}-${input.version}.log`);
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    // `data/` is gitignored and already the app's writable directory. Not
    // `/tmp`: this log has to still be findable tomorrow.
    await fs.writeFile(logPath, "", { flag: "a" });

    const argv = cfg.fakeCommand
      ? // A stand-in, for exercising all of this without a forty-minute build.
        // Split on whitespace only — it is a developer-set setting, not input.
        cfg.fakeCommand.split(/\s+/).filter(Boolean)
      : [
          "swift",
          "run",
          "release",
          "--version",
          input.version,
          ...(input.localOnly ? ["--local-only"] : []),
        ];

    // Chạy dưới TTY thật, qua `script`.
    //
    // Không có nó thì stdout của lệnh là một file, và cargo/rustc tự tắt hết:
    // không màu, không thanh tiến trình vẽ đè. Log lưu xuống là một thứ khác
    // với thứ người ta thấy khi gõ lệnh trong Terminal — mà cả điểm của cái
    // console này là chiếu lại đúng nó.
    //
    // `script -q /dev/null <lệnh>` là dạng BSD, đúng cho macOS — và module này
    // chỉ chạy được trên macOS vì cần Xcode. Đo trước khi dùng: mã thoát đi
    // qua nguyên vẹn (thử `exit 3` ra 3), và `test -t 1` bên trong báo có tty.
    // Thiếu `script` thì chạy thẳng, mất màu chứ không hỏng.
    const argvTty = existsSync(SCRIPT_BIN)
      ? [SCRIPT_BIN, "-q", "/dev/null", ...argv]
      : argv;

    const child = spawn(
      process.execPath,
      [
        path.join(process.cwd(), "lib/modules/sdk-release/supervise.mjs"),
        logPath,
        `${logPath}.status`,
        ...argvTty,
      ],
      {
        // `Tools/Release/Sources`, exactly where the guide says to stand.
        // An earlier note here claimed the command had to run one level up
        // because that is where `Package.swift` lives; that was wrong —
        // SwiftPM walks up to find the package, and `swift run release --help`
        // from `Sources/` builds and runs. The guide was right.
        cwd: path.join(cfg.packagePath, "Tools", "Release", "Sources"),
        // Its own process group: survives the dev server restarting, and lets
        // cancel take the whole `swift → cargo → rustc` tree down rather than
        // orphaning a forty-minute compile.
        detached: true,
        stdio: "ignore",
        // Môi trường thừa hưởng nguyên, chỉ thêm đúng mấy biến bật màu.
        //
        // Không đụng `PATH`: từng có ô cấu hình chèn thư mục vào đầu `PATH`,
        // lý do là "Next server không có ~/.cargo/bin". Đo trên server đang
        // chạy thì nó có — cả ba thư mục mặc định của ô đó đều đã nằm sẵn, và
        // thứ duy nhất nó đổi là **thứ tự**, tức là toolchain nào thắng. Quyết
        // định đó không phải việc của module này.
        //
        // Màu thì khác. stdout của lệnh là một file, không phải TTY, nên cargo
        // và rustc tự tắt màu — log lưu xuống là chữ trắng trơn, và app phải
        // đoán màu bằng regex để bù. Đoán thì sai: nó tô mọi dòng có chữ
        // "error:" kể cả khi đó là tên hàm. Bật màu thật rồi chiếu nguyên xi
        // thì log trong app đúng bằng log trong Terminal.
        env: {
          ...process.env,
          CARGO_TERM_COLOR: "always",
          CLICOLOR_FORCE: "1",
          FORCE_COLOR: "1",
          // Có TERM thì những tool hỏi terminfo mới chịu phát mã màu.
          TERM: process.env.TERM || "xterm-256color",
        },
      },
    );
    child.unref();

    updateRun(id, { pid: child.pid ?? 0, pgid: child.pid ?? 0, logPath, phase: "build" });
    return { ok: true, message: `Đã chạy ${input.version}`, id };
  } catch (error) {
    finishRun(id, "failed", {
      logPath,
      message: error instanceof Error ? error.message : "Không khởi động được lệnh",
    });
    return { ok: false, message: error instanceof Error ? error.message : "Không khởi động được" };
  }
}

export interface RunView extends RunRow {
  /** Log tail, carriage returns collapsed and capped. */
  log: string;
}

/** One run plus what its log currently says. */
export async function viewRun(id: number, lines = 400): Promise<RunView | null> {
  const row = getRun(id);
  if (!row) return null;
  const raw = await readTail(row.logPath, 256 * 1024);
  return { ...row, log: tailLines(terminalText(raw), lines) };
}

/**
 * Every descendant of `root`, deepest first.
 *
 * Read from one `ps` snapshot and returned as a plain list, because the list
 * has to be complete *before* a single signal is sent. Killing top-down
 * destroys the evidence: the moment a parent dies its children are reparented
 * to init, their `ppid` becomes 1, and nothing on the machine can still say
 * which build they belonged to. That is exactly how a cancelled release left
 * `xtask` → `cargo` → `rustc` running with no way to find them but guessing
 * from elapsed time and command names.
 *
 * `root` itself is not included; the caller signals it last.
 */
async function descendants(root: number): Promise<number[]> {
  if (!root || root <= 1) return [];
  let out = "";
  try {
    ({ stdout: out } = await run("/bin/ps", ["-ax", "-o", "pid=,ppid="], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return [];
  }

  const kids = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !Number.isFinite(ppid)) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }

  // Breadth-first, then reversed: children are signalled before their parents,
  // so nothing is orphaned into invisibility half way through.
  const order: number[] = [];
  const seen = new Set<number>([root]);
  for (const queue = [root]; queue.length; ) {
    for (const child of kids.get(queue.shift()!) ?? []) {
      // `process.pid` can never be in here — the walk only goes down from the
      // supervisor, which is this server's child — but a cycle in a corrupt
      // snapshot would be fatal, so the guard is explicit.
      if (child <= 1 || child === process.pid || seen.has(child)) continue;
      seen.add(child);
      order.push(child);
      queue.push(child);
    }
  }
  return order.reverse();
}

/** Alive after the grace period, so worth a signal that cannot be ignored. */
function signal(pids: number[], sig: NodeJS.Signals): number {
  let hit = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
      hit += 1;
    } catch {
      // Gone already, or somebody else's. Either way, not ours to chase.
    }
  }
  return hit;
}

/**
 * Stops a run, and everything it started.
 *
 * The first version sent `kill(-pgid)` and trusted that one process group held
 * the whole build. It does not: the release tool starts `xtask` in a session of
 * its own, so `xtask`, `cargo`, every `rustc` and `sccache` under them sat
 * outside the group and survived. The app wrote "đã huỷ", the machine kept
 * compiling at 370% CPU, and nothing on screen disagreed — worse than not
 * cancelling, because it looked finished.
 *
 * So: walk the tree first, then signal it leaves-first, `SIGTERM` then
 * `SIGKILL` for whatever ignored it. The group kill stays as well — it costs
 * nothing and catches anything that joined the group without being a
 * descendant.
 */
export async function cancelRun(id: number): Promise<{ ok: boolean; message: string }> {
  const row = getRun(id);
  if (!row) return { ok: false, message: "Không thấy lần chạy này." };
  if (row.state !== "running") return { ok: false, message: "Lần chạy này đã kết thúc." };

  const tree = await descendants(row.pid);
  const all = [...tree, row.pid];

  signal(all, "SIGTERM");
  try {
    if (row.pgid) process.kill(-row.pgid, "SIGTERM");
  } catch {}

  // A short grace period, then no more asking. Two seconds is enough for a
  // shell to fall over and far less than the user would spend wondering
  // whether the button worked.
  await new Promise((r) => setTimeout(r, 2000));
  const stubborn = all.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (stubborn.length) signal(stubborn, "SIGKILL");

  try {
    await fs.appendFile(
      row.logPath,
      `\n=== đã huỷ từ app — hạ ${all.length} tiến trình${stubborn.length ? `, ${stubborn.length} phải SIGKILL` : ""} ===\n`,
    );
  } catch {}
  // The count goes on the run, not into a toast: a toast is overwritten by the
  // readiness refresh a second later, and "how much did that actually kill" is
  // the one thing worth still being able to read afterwards.
  finishRun(id, "cancelled", {
    message:
      `Huỷ từ app — hạ ${all.length} tiến trình` +
      `${stubborn.length ? `, ${stubborn.length} phải SIGKILL` : ""}.`,
  });
  return { ok: true, message: `Đã huỷ — hạ ${all.length} tiến trình.` };
}
