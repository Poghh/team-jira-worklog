import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import type { SdkConfig } from "./config";
import type { VersionProposal } from "./model";
import { aheadOfRemote, containsRemote, readHead, topLevel } from "./repo";

/**
 * Everything that can go wrong before the build starts, asked while it is still
 * cheap to ask.
 *
 * This is the feature, not the plumbing. A real dry run costs forty minutes,
 * so it will never be routine — which makes this the only fast feedback loop
 * this module will ever have. Each check therefore earns its place by naming a
 * failure that has actually happened or is one step away, and each says what to
 * do about it rather than only that something is wrong.
 */

export interface Check {
  id: string;
  label: string;
  state: "ok" | "warn" | "fail";
  detail: string;
  /** A command to copy. The app shows it; the user runs it. */
  fix?: string;
}

const ok = (id: string, label: string, detail: string): Check => ({
  id,
  label,
  state: "ok",
  detail,
});
const warn = (id: string, label: string, detail: string, fix?: string): Check => ({
  id,
  label,
  state: "warn",
  detail,
  fix,
});
const fail = (id: string, label: string, detail: string, fix?: string): Check => ({
  id,
  label,
  state: "fail",
  detail,
  fix,
});


/**
 * The SDK directory `Release.swift` will build in, read out of the file itself.
 *
 * Not guessed. `Release.swift` derives `buildDirectory` from `#file` at compile
 * time and offers no flag to override it, so the only way to know where the
 * build will actually look is to read the literal. Reading it also catches the
 * thing nothing else would: this machine carries an **uncommitted** patch
 * changing that literal from `matrix-rust-sdk-ruma` to
 * `viptalk-matrix-rust-sdk-ruma`, to match the clone's name. A `git checkout`
 * of that file takes the patch away and the build then looks in a directory
 * that does not exist.
 */
async function buildDirFromSource(packagePath: string): Promise<string | null> {
  const file = path.join(packagePath, "Tools", "Release", "Sources", "Release.swift");
  try {
    const text = await fs.readFile(file, "utf8");
    // Anchored on `buildDirectory`, not on the first `.appending(component:)`
    // in the file — that one is `~/.netrc`, four lines earlier, and matching it
    // makes every layout check compare against a path in the home directory.
    const m = /buildDirectory[\s\S]*?\.appending\(component:\s*"([^"]+)"\)/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function runChecks(input: {
  cfg: SdkConfig;
  proposal: VersionProposal;
  tags: string[];
  tagsFromRemote: boolean;
  /** A run already in flight, if any. */
  liveRunId: number | null;
}): Promise<Check[]> {
  const { cfg, proposal, tags } = input;
  const out: Check[] = [];
  const both = cfg.sdkPath && cfg.packagePath;
  if (!both) {
    return [
      fail("paths", "Đường dẫn repo", "Chưa điền đường dẫn tới hai clone — xem tab Cấu hình."),
    ];
  }

  /* ── A · the layout Release.swift hardcodes ───────────────────────────── */
  const component = await buildDirFromSource(cfg.packagePath);
  if (!component) {
    out.push(
      fail(
        "layout",
        "Vị trí hai repo",
        "Không đọc được Release.swift để biết nó build ở thư mục nào — kiểm lại đường dẫn repo swift.",
      ),
    );
  } else {
    const expected = path.resolve(cfg.packagePath, "..", component);
    const actual = path.resolve(cfg.sdkPath, "matrix-rust-sdk");
    if (expected !== actual) {
      out.push(
        fail(
          "layout",
          "Vị trí hai repo",
          `Release.swift build cố định ở "${expected}", nhưng repo SDK của bạn ở "${actual}". ` +
            `Đường dẫn này biên dịch từ #file, không có cờ CLI nào đổi được — hai repo phải nằm cạnh nhau và thư mục SDK phải đúng tên.`,
        ),
      );
    } else {
      out.push(ok("layout", "Vị trí hai repo", `Release.swift sẽ build ở ${actual}`));
    }
    // The patch itself, called out separately: the layout can be right today
    // and wrong tomorrow for exactly one reason.
    if (!component.startsWith("viptalk-")) {
      out.push(
        warn(
          "patch",
          "Bản vá nội bộ trong Release.swift",
          `Release.swift đang trỏ tới "${component}" — bản gốc upstream. Nếu clone SDK của bạn tên khác thì build sẽ vào thư mục không tồn tại.`,
          `git -C ${cfg.packagePath} diff -- Tools/Release/Sources/Release.swift`,
        ),
      );
    }
  }

  /* ── B · the SDK repo ─────────────────────────────────────────────────── */
  const sdkTop = await topLevel(cfg.sdkPath);
  if (sdkTop !== path.resolve(cfg.sdkPath)) {
    out.push(
      fail(
        "sdk-root",
        "Repo SDK",
        `"${cfg.sdkPath}" không phải gốc repo${sdkTop ? ` — gốc là ${sdkTop}` : ""}. Lưu ý matrix-rust-sdk/ chỉ là thư mục con, không phải repo riêng.`,
      ),
    );
  } else {
    const head = await readHead(cfg.sdkPath);
    if (!head.branch) {
      out.push(
        fail("sdk-branch", "Nhánh SDK", "Repo SDK đang ở detached HEAD — không suy được hậu tố version."),
      );
    } else {
      out.push(
        ok("sdk-branch", "Nhánh SDK", `đang ở ${head.branch} @ ${head.sha.slice(0, 8)}`),
      );
    }
    if (head.dirty.length) {
      // Not a warning. `cargo` compiles the working tree while the tool stamps
      // the *commit hash* — so a dirty tree ships a release whose recorded sha
      // does not describe what is inside it. That is the worst silent outcome
      // available here, which is why it blocks and has its own override.
      out.push(
        fail(
          "sdk-clean",
          "Cây làm việc SDK",
          `Còn ${head.dirty.length} file sửa chưa commit (${head.dirty.slice(0, 3).join(", ")}). ` +
            `cargo build theo cây làm việc còn tool đóng dấu commit hash, nên bản release sẽ mang một sha không mô tả đúng nội dung của nó.`,
        ),
      );
    } else {
      out.push(ok("sdk-clean", "Cây làm việc SDK", "sạch"));
    }
    const ahead = await aheadOfRemote(cfg.sdkPath, head.branch);
    if (ahead > 0)
      out.push(
        warn(
          "sdk-ahead",
          "Nhánh SDK so với remote",
          `Nhánh đang có ${ahead} commit chưa push — bản SDK này sẽ build từ code chưa ai khác thấy.`,
          `git -C ${cfg.sdkPath} push`,
        ),
      );
  }

  /* ── C · the wrapper repo, which is what gets pushed ──────────────────── */
  const pkg = await readHead(cfg.packagePath);
  if (pkg.branch !== "main") {
    out.push(
      fail(
        "pkg-branch",
        "Nhánh repo swift",
        `Đang ở "${pkg.branch || "detached"}", phải là main — lệnh release commit và push vào đúng nhánh đang checkout.`,
        `git -C ${cfg.packagePath} checkout main`,
      ),
    );
  } else {
    out.push(ok("pkg-branch", "Nhánh repo swift", "main"));
  }
  // `Release.swift` is expected to be modified — that is the local patch. Any
  // other dirty file is a real problem: the tool runs `git add Package.swift
  // Sources` and will sweep it into the commit it pushes to the customer.
  const stray = pkg.dirty.filter((f) => f !== "Tools/Release/Sources/Release.swift");
  if (stray.length) {
    out.push(
      fail(
        "pkg-clean",
        "Cây làm việc repo swift",
        `Còn sửa đổi chưa commit ở ${stray.slice(0, 3).join(", ")}. Lệnh release chạy "git add Package.swift Sources" rồi commit và push, nên file này sẽ bị đẩy lên repo khách hàng.`,
      ),
    );
  } else {
    out.push(ok("pkg-clean", "Cây làm việc repo swift", "chỉ còn bản vá Release.swift"));
  }

  const contains = await containsRemote(cfg.packagePath);
  if (contains === false) {
    out.push(
      fail(
        "pkg-behind",
        "main so với origin/main",
        "main ở máy chưa chứa origin/main. git push ở cuối lệnh sẽ bị từ chối — sau khi đã build xong 40 phút.",
        `git -C ${cfg.packagePath} merge --ff-only origin/main`,
      ),
    );
  } else if (contains === null) {
    out.push(warn("pkg-behind", "main so với origin/main", "Không so sánh được với origin/main."));
  } else {
    out.push(ok("pkg-behind", "main so với origin/main", "đã chứa origin/main"));
  }

  /*
   * Sections D and E — `~/.netrc`, `swift`, `cargo`, the Rust targets, `cargo
   * xtask`, and the toolchain-vs-Xcode comparison — are gone on purpose.
   *
   * They checked the *environment*, and the environment is the user's to
   * provide: this module's job is to run `swift run release --version X` in the
   * right directory, not to have an opinion about the machine it runs on. When
   * the environment is wrong the command says so in the log, and the person who
   * installed the toolchain is the person who can read that.
   *
   * What is still checked below is not the environment: it is the repositories
   * and the version string, which are what this screen is actually about.
   */

  /* ── F · the version itself ───────────────────────────────────────────── */
  if (!input.tagsFromRemote)
    out.push(
      warn(
        "tags",
        "Danh sách tag",
        "Chỉ đọc được tag ở máy, không hỏi được remote. Nếu đồng nghiệp vừa release thì số thứ tự đề xuất có thể đụng.",
      ),
    );

  // Chỉ tag thật. Tag `pre-` là sổ sách của chính `swift run release`: nó cắm
  // lúc "Making release" rồi tự `Delete tag pre-…` ở bước cuối. App cảnh báo về
  // nó là xen vào việc của lệnh, và từng chặn nút Release vì rác lệnh sẽ tự dọn.
  const taken = tags.some((t) => t.trim() === proposal.version);
  if (taken) {
    out.push(
      fail(
        "collision",
        "Tên version",
        `Tag ${proposal.version} đã tồn tại — đã có bản release mang tên này.`,
      ),
    );
  } else {
    out.push(ok("collision", "Tên version", `${proposal.version} chưa ai dùng`));
  }

  /* ── G · one at a time ────────────────────────────────────────────────── */
  if (input.liveRunId !== null)
    out.push(
      fail("busy", "Lần chạy khác", `Đang có lần chạy #${input.liveRunId} chưa kết thúc.`),
    );

  return out;
}

/** True when nothing blocks the run. `warn` never blocks. */
export function blocked(checks: Check[]): boolean {
  return checks.some((c) => c.state === "fail");
}
