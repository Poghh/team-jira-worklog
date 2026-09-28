// Runs one `claude -p` review and records how it ended. Nothing else.
//
// The review outlives the request that queued it, and often a dev-server
// restart too, so the app never holds the child directly: this process does,
// writes stdout/stderr to the log, and leaves a status file when the child
// exits. The queue in runner.ts reads both back.
//
// Plain `.mjs`, outside the Next module graph, so `process.execPath` can run it
// with no bundler involved. Same shape as sdk-release/supervise.mjs, kept
// separate so neither module's needs can bend the other's.
//
// Usage: node supervise.mjs <logPath> <statusPath> <command> [args…]

import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";

const [, , logPath, statusPath, command, ...args] = process.argv;

if (!logPath || !statusPath || !command) {
  console.error("supervise.mjs <logPath> <statusPath> <command> [args…]");
  process.exit(2);
}

const fd = openSync(logPath, "a");
let finished = false;

const finish = (payload) => {
  if (finished) return;
  finished = true;
  try {
    writeFileSync(statusPath, JSON.stringify({ ...payload, endedAt: Math.floor(Date.now() / 1000) }));
  } catch {}
  try {
    closeSync(fd);
  } catch {}
  process.exit(0);
};

const child = spawn(command, args, { stdio: ["ignore", fd, fd] });

// Cancelling signals this process's group; pass it on so the review stops too.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {}
  });
}

child.on("error", (err) => finish({ exitCode: null, signal: null, error: String(err && err.message) }));
child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
