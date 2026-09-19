// Runs the release command, watches for somebody else releasing, and records
// how it ended.
//
// This tiny process exists for reasons an unrelated process cannot serve. The
// build outlives the request that started it and usually the dev server too, so
// by the time anything asks "how did it go", the only witness is gone. This one
// stays for the whole run.
//
// It also watches, and that is not decoration. The release tool builds for
// twenty to sixty minutes and only then touches GitHub; if a colleague pushes
// to the swift repo's `main` at minute five, nothing notices until the `git
// push` at the far end is rejected — with the release and its tag already
// created on the customer's repository. Measured over 465 real releases, one in
// six lands inside another's build window.
//
// Nobody watches a forty-minute build, so a warning on a screen is worth
// nothing. This process is the only thing awake, so it is the thing that has to
// act: poll, and stop the build while stopping is still free.
//
// Plain `.mjs`, deliberately outside the Next module graph, so `process.execPath`
// can run it directly with no bundler involved.
//
// Usage: node supervise.mjs <logPath> <statusPath> <watchJson|-> <command> [args…]

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";

const [, , logPath, statusPath, watchArg, command, ...args] = process.argv;

if (!logPath || !statusPath || !command) {
  console.error("supervise.mjs <logPath> <statusPath> <watchJson|-> <command> [args…]");
  process.exit(2);
}

/** `{ dir, version, mainSha }`, or null when there is nothing to watch. */
const watch = watchArg && watchArg !== "-" ? JSON.parse(watchArg) : null;

// Append, so a re-attached run never truncates what it already wrote.
const fd = openSync(logPath, "a");
const say = (line) => {
  try {
    writeFileSync(fd, `\n${line}\n`);
  } catch {}
};

let finished = false;

/**
 * Why the watcher killed the build, set before the first signal is sent.
 *
 * It has to be recorded here rather than passed to `finish`, because the child
 * dying from that signal fires `close` first and wins the race to write the
 * status file. Without this the reason vanished and the run read as an ordinary
 * failure — the app would then tell the user to go looking for a build error
 * that never happened.
 */
let stopReason = "";

const finish = (payload) => {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  try {
    writeFileSync(
      statusPath,
      JSON.stringify({
        ...payload,
        ...(stopReason ? { stopped: stopReason } : {}),
        endedAt: Math.floor(Date.now() / 1000),
      }),
    );
  } catch {
    // Nothing useful left to do: the reaper treats a missing status file as
    // "lost", which is the honest answer when this could not be written.
  }
  try {
    closeSync(fd);
  } catch {}
  process.exit(0);
};

const child = spawn(command, args, { stdio: ["ignore", fd, fd] });

// A command that cannot start at all — a missing binary, a bad cwd — never
// reaches `close`, and without this the run would sit at "running" until
// something noticed the pid was gone.
child.on("error", (err) => finish({ exitCode: null, signal: null, error: String(err && err.message) }));
child.on("close", (exitCode, signal) => finish({ exitCode, signal }));

/* ── watching ──────────────────────────────────────────────────────────── */

const sh = (file, argv, timeout = 25_000) =>
  new Promise((res) => execFile(file, argv, { timeout }, (err, out) => res(err ? "" : out)));

/**
 * Everything below `root`, deepest first, read from one snapshot.
 *
 * The same walk the app uses to cancel, and for the same reason: the release
 * tool starts `xtask` in a session of its own, so signalling one process group
 * misses the build entirely. The list has to be complete before the first
 * signal, because killing a parent reparents its children to init and the
 * evidence of who they belonged to is gone.
 */
async function tree(root) {
  const out = await sh("/bin/ps", ["-ax", "-o", "pid=,ppid="], 10_000);
  const kids = new Map();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !Number.isFinite(ppid)) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const order = [];
  const seen = new Set([root]);
  for (const queue = [root]; queue.length; )
    for (const c of kids.get(queue.shift()) ?? []) {
      if (c <= 1 || c === process.pid || seen.has(c)) continue;
      seen.add(c);
      order.push(c);
      queue.push(c);
    }
  return order.reverse();
}

/** The log's last 64 KB — enough to see which phase the tool has announced. */
function tail() {
  try {
    const size = statSync(logPath).size;
    const from = Math.max(0, size - 64 * 1024);
    return readFileSync(logPath, "utf8").slice(from);
  } catch {
    return "";
  }
}

/**
 * Has the tool started writing to the customer's repository?
 *
 * `🚀 Making release` is the line immediately before the first GitHub write.
 * Before it, stopping costs nothing but CPU: `build()` only writes into the SDK
 * clone's `target/`, no commit exists yet, and no ref has been created. After
 * it, a release page and a `pre-` tag are sitting on somebody else's
 * repository, and what to keep is a judgement this process must not make.
 */
const wroteToGitHub = () => /🚀 Making release/.test(tail());

let warned = false;

async function look() {
  if (finished || !watch?.dir) return;

  const out = await sh("/usr/bin/git", [
    "-C", watch.dir,
    "ls-remote", "origin",
    "refs/heads/main",
    `refs/tags/${watch.version}`,
    `refs/tags/pre-${watch.version}`,
  ]);
  if (!out) return; // offline, or the remote is having a moment — say nothing

  let mainSha = "";
  let taken = false;
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!ref) continue;
    if (ref.trim() === "refs/heads/main") mainSha = sha.trim();
    else taken = true;
  }

  const moved = Boolean(watch.mainSha && mainSha && mainSha !== watch.mainSha);
  if (!moved && !taken) return;

  const why = taken
    ? `tag ${watch.version} đã bị người khác tạo trên remote`
    : `có người push lên main của repo swift (${watch.mainSha.slice(0, 8)} → ${mainSha.slice(0, 8)})`;

  if (wroteToGitHub()) {
    // Too late to stop for free. Say it once, in the log, and let it finish —
    // killing here leaves the same litter as finishing, minus the information.
    if (!warned) {
      warned = true;
      say(`=== ⚠ ${why}. Build đã qua "Making release" nên app không tự dừng — push ở cuối nhiều khả năng bị từ chối. ===`);
    }
    return;
  }

  say(`=== ⚠ ${why}. Chưa có gì lên repo khách, app dừng build tại đây. ===`);
  stopReason = why;
  const pids = [...(await tree(child.pid)), child.pid];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    finish({ exitCode: null, signal: "SIGTERM" });
  }, 2000);
}

// Two minutes: often enough that the wasted build is minutes rather than an
// hour, rare enough that twenty `ls-remote` calls over a long build is nothing.
// `ls-remote` writes nothing into the clone, which is what makes it safe to run
// against a directory that is being built in.
const timer = watch ? setInterval(() => void look(), 120_000) : null;
if (watch) setTimeout(() => void look(), 20_000);
