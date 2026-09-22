// Runs the release command and records how it ended. Nothing else.
//
// This tiny process exists for a reason an unrelated process cannot serve: the
// build outlives the request that started it and usually the dev server too, so
// by the time anything asks "how did it go", the only witness is gone. This one
// stays for the whole run.
//
// It used to also poll the remote and kill the build when a tag with this
// version appeared. That is gone, and the reason is worth keeping written down:
// `swift run release` cuts its own `pre-<version>` tag as bookkeeping partway
// through, so the watcher kept finding this run's own tag and killing this run's
// own build — three times in one day, each after the tag appeared between two
// polls while the log had not yet reached `🚀 Making release`. Guessing at the
// command's internals from the outside cost more than it ever saved.
//
// The command is the authority on whether a release can proceed. It checks, it
// fails, it says why. This process carries that answer back; it does not form
// its own.
//
// Plain `.mjs`, deliberately outside the Next module graph, so `process.execPath`
// can run it directly with no bundler involved.
//
// Usage: node supervise.mjs <logPath> <statusPath> <command> [args…]

import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";

const [, , logPath, statusPath, command, ...args] = process.argv;

if (!logPath || !statusPath || !command) {
  console.error("supervise.mjs <logPath> <statusPath> <command> [args…]");
  process.exit(2);
}

// Append, so a re-attached run never truncates what it already wrote.
const fd = openSync(logPath, "a");
let finished = false;

const finish = (payload) => {
  if (finished) return;
  finished = true;
  try {
    writeFileSync(
      statusPath,
      JSON.stringify({ ...payload, endedAt: Math.floor(Date.now() / 1000) }),
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
