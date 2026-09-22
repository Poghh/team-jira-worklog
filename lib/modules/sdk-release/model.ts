/**
 * Rules for naming an iOS SDK release — pure, no `server-only`, so the console,
 * the server and the tests share one definition.
 *
 * The release is done by the team's own tool (`swift run release --version …`),
 * which takes the version on trust and checks nothing. The rule for what that
 * version should be lives in a table in an internal PDF and nowhere else, which
 * is why it drifts. This file is that rule, written once, in the only place it
 * can be checked without a network.
 */

import { extractIssueKeys } from "@/lib/jira/branch-keys";

/** One release tag, taken apart. */
export interface ParsedTag {
  /** `2026.09.18`. */
  date: string;
  /** `ctalkdev`, `dev`, `stag`, `ctalkvt526`… '' for a release off `master`. */
  suffix: string;
  /** Build number within the day. 1 for a bare master tag, which carries none. */
  ordinal: number;
  /**
   * A `pre-*` tag.
   *
   * The tool creates one at the start of a run and deletes it on success, so
   * one still standing marks a run that died partway — there are 48 of them.
   * Worth knowing: it tags `main` HEAD *before* the new commit exists, so it
   * points at the previous release's commit. A leftover therefore means the run
   * died **after** the expensive build, possibly after the push.
   */
  pre: boolean;
}

/**
 * The shape the guide defines, and nothing else.
 *
 * Deliberately strict, because the repository also holds three older shapes
 * that must be ignored rather than misread: `v1.0.30` (17 of them, from before
 * dates), `25.03.06` (two-digit year) and `2025.12.19.password.1` (dots where
 * the dash belongs). Returning null keeps them out of the ordinal arithmetic
 * instead of letting `1.0` parse as a date.
 *
 * The suffix is `[a-z0-9]+` rather than a list: releases from before the team
 * prefixes exist (`-upgrade.3`, `-call.2`, `-password.7`) and are real history.
 */
const TAG_RE = /^(pre-)?(\d{4}\.\d{2}\.\d{2})(?:-([a-z0-9]+))?(?:\.(\d+))?$/;

export function parseReleaseTag(tag: string): ParsedTag | null {
  const m = TAG_RE.exec(tag.trim());
  if (!m) return null;
  return {
    pre: Boolean(m[1]),
    date: m[2],
    suffix: m[3] ?? "",
    // A bare master tag carries no number; it is the first and only one of its
    // day, so 1 is the honest reading rather than a placeholder.
    ordinal: m[4] ? Number(m[4]) : 1,
  };
}

/**
 * Back to the string handed to the tool.
 *
 * A master release prints as a bare date — the guide's rule, and the 39 bare
 * tags confirm nobody has ever written a second one in a day. So the ordinal is
 * dropped rather than rendered; whether today's is already taken is a question
 * for the readiness check, not for this.
 */
export function versionString(v: {
  date: string;
  suffix: string;
  ordinal: number;
}): string {
  return v.suffix ? `${v.date}-${v.suffix}.${v.ordinal}` : v.date;
}

/** Lower-cased with every separator dropped — `VT-526` → `vt526`. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Branch names the guide gives a fixed suffix, and their short forms. */
const ENV_SUFFIX: Record<string, string> = {
  master: "",
  main: "",
  staging: "stag",
  develop: "dev",
};

/**
 * Seeded map; an exact hit always wins, and the user can edit it.
 *
 * Only this team's branches are seeded — `ctalk` is the whole of it here. A
 * `cxp/develop` or `hir/…` branch still resolves correctly through the rules
 * below without anybody declaring anything, so there is no list to maintain.
 */
export const DEFAULT_BRANCH_SUFFIXES: Record<string, string> = {
  master: "",
  staging: "stag",
  develop: "dev",
  "ctalk/develop": "ctalkdev",
  "cxp/develop": "cxpdev",
};

/**
 * Segments that say what kind of work a branch is, not which work.
 *
 * Dropped before slugging, because they are noise in a version string:
 * `ctalk/task/upgrade_…` never shipped as `ctalktaskupgrade…`. `features`
 * plural is in the list because the repository has `cxp/features/…` too.
 */
const KIND_RE = /^(feat|features?|bug|bugfix|task|hotfix|chore|fix|release)$/i;

/**
 * The team prefix, or '' when the branch does not name one.
 *
 * A branch's first segment is a team only when it is not a kind word. Without
 * that test `feature/link-management` read `feature` as the team and proposed
 * `featurelinkmanagement`, which is not a shape anything has ever shipped as.
 *
 * Deliberately not matched against a configured list of teams. The guide names
 * `ctalk` and `cxp`; the repository also has `hir`. A list would have been
 * incomplete the day it shipped, and reading the branch costs nothing to keep
 * current — so a new team works here with no configuration at all.
 */
function teamOf(parts: string[]): string {
  return parts.length > 1 && !KIND_RE.test(parts[0]) ? slug(parts[0]) : "";
}

/**
 * Whole words up to `max` characters — never a cut through the middle of one.
 *
 * `fighting_identity_reset_security_issue_20260426` used to truncate to
 * `ctalkfightingidentityresetse`, which reads as a bug rather than as a name.
 */
function wordCap(team: string, words: string[], max = 24): string {
  let out = team;
  for (const w of words) {
    if (out.length + w.length > max) break;
    out += w;
  }
  // A cap so tight that nothing fits still has to return something usable.
  return out === team && words[0] ? team + words[0].slice(0, max) : out;
}

/**
 * How much the derived suffix can be trusted.
 *
 * `exact` — the configured map named this branch.
 * `derived` — read off a Jira key in the branch name, which is what the team
 *   actually does.
 * `guess` — no key to read; the last segments, slugged. Shown in a warning tone.
 */
export type SuffixConfidence = "exact" | "derived" | "guess";

/**
 * Candidate suffixes for a branch, best first.
 *
 * The order is not taste — it is measured against all 429 release commits in
 * the wrapper repository:
 *
 *   | rule                                   | fires | right |
 *   |----------------------------------------|-------|-------|
 *   | what this same branch used last time   |   360 |  96 % |
 *   | a Jira key in the branch name          |    49 |  63 % |
 *
 * The guide's table is still first for the five branches it names, because for
 * those the rule really is a rule. After that comes history, and only then the
 * guesses. The guide never mentions Jira keys at all: it says the suffix is
 * `<team><tên_feature>` where the feature name is a short word the person
 * picks — and the history agrees, shipping `ctalkqrcode`, `ctalkinvitelink`,
 * `ctalkotperr` from branches that all carried a ticket number. So reading the
 * ticket is a guess dressed as a rule, and it is labelled a guess here.
 */

export interface DerivedSuffix {
  suffix: string;
  confidence: SuffixConfidence;
  /** One line saying where it came from, shown under the field. */
  why: string;
}

/**
 * The suffix a branch releases under — always a suggestion, never a gate.
 *
 * The guide presents this as a table, and the table is not the truth: 50-odd
 * distinct suffixes exist in the history, including `ctackdev` (a typo of
 * `ctalkdev`), and the *same branch* produced two different slugs a week apart
 * (`hirvt111`, then `hirvtl111`). So this proposes, shows its reasoning, and
 * lets the field be typed over.
 *
 * The team prefix is read off the branch's first segment rather than matched
 * against a configured list. The guide names `ctalk` and `cxp`; the repository
 * also has `hir`. A list would have been wrong on the day it shipped, and
 * reading the branch costs nothing to keep current.
 */
export function suffixCandidates(
  branch: string,
  suffixes: Record<string, string>,
  projectKeys: string[],
  history: SdkRelease[] = [],
): DerivedSuffix[] {
  const clean = branch.trim().replace(/^origin\//, "");
  if (!clean) return [{ suffix: "", confidence: "guess", why: "chưa biết nhánh" }];

  const out: DerivedSuffix[] = [];
  const push = (c: DerivedSuffix) => {
    if (!out.some((x) => x.suffix === c.suffix)) out.push(c);
  };

  // 1. The guide's table. For these five branches the suffix is a rule, not a
  //    habit, so nothing measured gets to overrule it.
  if (Object.prototype.hasOwnProperty.call(suffixes, clean))
    push({
      suffix: suffixes[clean],
      confidence: "exact",
      why: `khớp bảng quy tắc trong tài liệu cho nhánh ${clean}`,
    });

  // 2. What this same branch released under last time — the strongest signal
  //    there is, and one nothing else can reconstruct. An empty suffix is
  //    skipped: a bare date is the `master` rule, never a feature name.
  const prev = releasesForBranch(history, clean, 1)[0];
  const prevSuffix = prev ? parseReleaseTag(prev.version)?.suffix : undefined;
  if (prev && prevSuffix)
    push({
      suffix: prevSuffix,
      confidence: "derived",
      why: `nhánh này lần trước release là ${prev.version}`,
    });

  const parts = clean.split("/").filter(Boolean);
  const team = teamOf(parts);
  const last = parts[parts.length - 1].toLowerCase();

  // 3. `hir/develop` is in nobody's table but is plainly an environment branch.
  if (Object.prototype.hasOwnProperty.call(ENV_SUFFIX, last))
    push({
      suffix: team + ENV_SUFFIX[last],
      confidence: "derived",
      why: `nhánh môi trường "${last}"${team ? ` của team ${team}` : ""}`,
    });

  // 4. A ticket number in the branch name. A guess: the guide has no such rule,
  //    and it matched only 63% of the times it fired.
  const keys = extractIssueKeys(clean, projectKeys);
  if (keys.length === 1)
    push({
      suffix: team + slug(keys[0]),
      confidence: "guess",
      why: `đoán từ mã Jira ${keys[0]} — tài liệu nói hậu tố là tên tính năng bạn tự đặt`,
    });
  if (keys.length > 1) {
    // Two keys drop the project prefix entirely — `VTL-286_VTL-610` shipped as
    // `ctalk286610`. Matching the history rather than inventing something
    // tidier, because the tag has to look like the ones beside it.
    const digits = keys.map((k) => k.split("-")[1] ?? "").join("");
    push({
      suffix: team + digits,
      confidence: "guess",
      why: `đoán từ phần số của ${keys.join(" + ")}`,
    });
  }

  // 5. The branch name in lower case. Always last and always a guess.
  //
  //    Deliberately the dumb version. Of the 45 branches here that released
  //    without a ticket number in their name, a generated slug — in any of the
  //    seven word-slicings I measured — matched what shipped 8 times. The names
  //    people chose were editorial: `combined_login_signup_flow` shipped as
  //    `password`, `voice_video_call` as `call`, `missing_mgs` as `sync`. No
  //    rule reaches that, and a cleverer-looking guess would only be wrong with
  //    more confidence. So: lower case, whole words, and an obviously editable
  //    field — with the config map below for the ones worth remembering.
  const words = parts
    .slice(team ? 1 : 0)
    .filter((p) => !KIND_RE.test(p))
    .join("_")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  push({
    suffix: wordCap(team, words),
    confidence: "guess",
    why: "tên nhánh viết thường — tài liệu nói hậu tố là <team><tên tính năng> do bạn đặt, nên sửa lại cho ngắn",
  });

  return out;
}

/** The best candidate. See {@link suffixCandidates} for the order and why. */
export function deriveSuffix(
  branch: string,
  suffixes: Record<string, string>,
  projectKeys: string[],
  history: SdkRelease[] = [],
): DerivedSuffix {
  return suffixCandidates(branch, suffixes, projectKeys, history)[0];
}

/**
 * The next free build number for a date and suffix.
 *
 * `max + 1`, not `count + 1`, and counting `pre-` tags alongside the real ones.
 * Both halves matter and both come from the history:
 *
 *     2026.08.20-cxpdev.1        real
 *     pre-2026.08.20-cxpdev.2    a failed run holding .2
 *     2026.08.20-cxpdev.3        real — the number was skipped by hand
 *
 * Counting would propose `.2` again, and `makeRelease` would then fail creating
 * a tag that already exists — after a forty-minute build.
 */
export function nextOrdinal(
  tags: string[],
  date: string,
  suffix: string,
): number {
  let highest = 0;
  for (const tag of tags) {
    const t = parseReleaseTag(tag);
    if (!t || t.date !== date || t.suffix !== suffix) continue;
    // Bỏ qua tag `pre-`. Log thật của `swift run release` cho thấy nó cắm tag
    // đó lúc "Making release" rồi tự "Delete tag pre-…" ở bước cuối — sổ sách
    // nội bộ, không phải một bản đã phát hành. Đếm nó vào là app nhảy số vì rác
    // mà chính lệnh sẽ dọn, và người dùng thấy `.2` cho một cái tên chưa ai dùng.
    if (t.pre) continue;
    if (t.ordinal > highest) highest = t.ordinal;
  }
  return highest + 1;
}


export interface VersionProposal {
  version: string;
  suffix: string;
  ordinal: number;
  confidence: SuffixConfidence;
  why: string;
  /** Things worth saying out loud before the run. */
  warnings: string[];
  /**
   * The runners-up, ready to use.
   *
   * Offered rather than hidden because the guide puts this choice in the
   * person's hands — the suffix for a feature branch is a short name they
   * pick — and because no rule here is better than 96%. One click beats
   * retyping a date and an ordinal to change three letters.
   */
  alternatives: Array<{ version: string; suffix: string; why: string }>;
}

export function nextVersion(input: {
  branch: string;
  /** `yyyy.mm.dd` in Asia/Saigon — every tag in the history is `+0700`. */
  date: string;
  tags: string[];
  suffixes: Record<string, string>;
  projectKeys: string[];
  /** Past releases, so a branch can be named the way it was named before. */
  history?: SdkRelease[];
}): VersionProposal {
  const candidates = suffixCandidates(
    input.branch,
    input.suffixes,
    input.projectKeys,
    input.history ?? [],
  );
  const d = candidates[0];
  const ordinal = nextOrdinal(input.tags, input.date, d.suffix);
  const version = versionString({
    date: input.date,
    suffix: d.suffix,
    ordinal,
  });

  const warnings: string[] = [];
  // A master release is a bare date with no room for a second one in a day, so
  // rather than invent a format the guide does not have, say so and let the
  // readiness check make it a hard stop.
  if (!d.suffix && input.tags.some((t) => t.trim() === version))
    warnings.push(
      `tag ${version} đã tồn tại — master chưa từng có 2 bản trong ngày, quy tắc đặt tên không có chỗ cho bản thứ hai`,
    );
  return {
    version,
    suffix: d.suffix,
    ordinal,
    confidence: d.confidence,
    why: d.why,
    warnings,
    // Each with its own ordinal: `.1` is free under one suffix and taken under
    // another, and a candidate that collides is not a candidate.
    alternatives: candidates.slice(1, 4).map((c) => ({
      version: versionString({
        date: input.date,
        suffix: c.suffix,
        ordinal: nextOrdinal(input.tags, input.date, c.suffix),
      }),
      suffix: c.suffix,
      why: c.why,
    })),
  };
}

/* ── what has already been released ─────────────────────────────────────── */

export interface SdkRelease {
  version: string;
  /** SDK branch this release was cut from, exactly as the tool recorded it. */
  branch: string;
  /** Full SDK commit the release was built from. */
  sha: string;
  /** Commit time of the bump, epoch seconds. */
  at: number;
}

/**
 * Reads a release back out of the commit the tool wrote.
 *
 *     Bump to version 2026.09.18-ctalkdev.1 (viptalk-matrix-rust-sdk-ruma/ctalk/develop 5fca2f33…)
 *
 * This, not the tag, is the authoritative link between a version and a branch.
 * The tag carries only a slug — and the slug is lossy in both directions: the
 * history holds `ctackdev` (a typo for `ctalkdev`) and the same branch spelled
 * `hirvt111` one week and `hirvtl111` the next. The commit message names the
 * branch in full, so a question like "what has this branch released lately"
 * gets an exact answer rather than a fuzzy one.
 *
 * Shape notes, checked against all 200 most recent bumps: the repository name
 * never contains `/` and the sha is always the full 40, so the branch is
 * everything between the first slash and the last space — which is the only
 * reading that survives a branch called `ctalk/task/upgrade_26.09.09_phase1`.
 */
const BUMP_RE = /^Bump to version (\S+) \((\S+?)\/(.+) ([0-9a-f]{40})\)$/;

export function parseBumpMessage(subject: string, at = 0): SdkRelease | null {
  const m = BUMP_RE.exec(subject.trim());
  return m ? { version: m[1], branch: m[3], sha: m[4], at } : null;
}

/** The `n` most recent releases cut from `branch`, newest first. */
export function releasesForBranch(
  releases: SdkRelease[],
  branch: string,
  n = 3,
): SdkRelease[] {
  if (!branch) return [];
  return releases
    .filter((r) => r.branch === branch)
    .sort((a, b) => b.at - a.at)
    .slice(0, n);
}

/* ── what a failed run left behind ──────────────────────────────────────── */

/**
 * The evidence, read after a run ends badly.
 *
 * Every field is something observable — a ref that exists or does not, a commit
 * that is on this machine and not on the server. Nothing is inferred from the
 * exit code, because the exit code cannot tell `makeRelease` failing on a taken
 * tag apart from `git push` being rejected, and those leave the customer's
 * repository in completely different states.
 */
export interface Aftermath {
  version: string;
  /** `owner/repo` of the swift repo, for linking to the release page. */
  slug: string;
  /** The real tag exists on the remote — the release went through. */
  tagged: boolean;
  /** The `pre-` tag exists — `makeRelease` ran, so a release page is sitting there. */
  preTagged: boolean;
  /** Commits on local `main` that `origin/main` has not got. */
  unpushed: number;
  /** `origin/main` moved after this run started — somebody else released. */
  remoteMoved: boolean;
}

export type Recovery =
  /** Nothing reached GitHub. Run it again; there is nothing to clean. */
  | "clean"
  /** Release page and tag exist, the commit never left. The expensive case. */
  | "push-rejected"
  /** A `pre-` tag with no local commit — an older run died and left litter. */
  | "stranded"
  /** It actually worked. Do not run it again. */
  | "done";

export interface RecoveryStep {
  text: string;
  /** Copyable, run by the user — never by the app. */
  command?: string;
  /** Somewhere to click, when the step is not a command. */
  url?: string;
}

export interface RecoveryPlan {
  state: Recovery;
  title: string;
  /** One line on what is actually true right now. */
  detail: string;
  steps: RecoveryStep[];
}

/**
 * What to do about it, in order.
 *
 * The app writes nothing here — deleting a release on somebody else's
 * repository is a write it has no token for and no business making — so every
 * step is a command to copy or a page to open. That is also why the order
 * matters and is spelled out: rebasing before deleting the `pre-` release
 * leaves a release pointing at a commit that no longer exists, and re-running
 * before deleting it fails on the tag that is already taken.
 */
export function recoveryPlan(a: Aftermath, sdkPath = "", packagePath = ""): RecoveryPlan {
  const pkg = packagePath || "<repo-swift>";
  const releaseUrl = a.slug
    ? `https://github.com/${a.slug}/releases/tag/pre-${a.version}`
    : "";

  if (a.tagged)
    return {
      state: "done",
      title: "Bản release này đã lên rồi",
      detail: `Tag ${a.version} có trên remote — lần chạy đã đi tới đích dù báo lỗi. Đừng chạy lại với tên này.`,
      steps: [
        {
          text: "Kiểm lại trang release trước khi làm gì thêm",
          url: a.slug ? `https://github.com/${a.slug}/releases/tag/${a.version}` : "",
        },
      ],
    };

  if (a.preTagged && a.unpushed > 0)
    return {
      state: "push-rejected",
      title: "Build xong nhưng push bị từ chối",
      detail:
        `Release và tag pre-${a.version} đã nằm trên repo khách, framework đã upload, ` +
        `nhưng ${a.unpushed} commit vẫn kẹt ở máy` +
        (a.remoteMoved ? " vì có người push lên main trước bạn." : "."),
      steps: [
        {
          text: "Lấy về phần người khác vừa push",
          command: `git -C ${pkg} fetch origin main`,
        },
        {
          text: "Đưa commit của bạn lên trên phần đó — rebase, không merge, để lịch sử main thẳng như mọi lần bump khác",
          command: `git -C ${pkg} rebase origin/main`,
        },
        {
          // Chỉ trang release. Tag pre- là sổ sách của lệnh, nó tự dọn.
          text: "Xoá trang release trên GitHub",
          url: releaseUrl,
        },
        {
          text: "Chạy lại — vẫn tên version cũ, vì chưa có bản release thật nào mang tên đó",
        },
      ],
    };

  if (a.preTagged)
    return {
      state: "stranded",
      title: `Còn bản release dở dang ${a.version}`,
      detail:
        "Một lần chạy đã tạo release rồi chết trước khi upload framework, và không có " +
        "commit nào kẹt ở máy. Trang release đó gắn vào tag pre-, Assets trống hoặc chỉ " +
        "có source code tự sinh.\n" +
        // Tag `pre-` là sổ sách của chính lệnh: nó cắm lúc "Making release" và
        // tự `Delete tag pre-…` ở bước cuối. App từng bày cách xoá tag ở đây —
        // vừa thừa vừa sai, vì lệnh mới là chỗ quản nó.
        "Không cần đụng tới tag: lệnh release tự dọn tag pre- của nó.",
      steps: [
        { text: `Xoá trang release ${a.version} trên GitHub`, url: releaseUrl },
        { text: "Rồi chạy lại" },
      ],
    };

  return {
    state: "clean",
    title: "Chưa có gì lên repo khách",
    detail:
      "Không có tag nào mang tên này trên remote và không có commit nào kẹt ở máy — " +
      "lần chạy dừng trước khi tạo release." +
      (a.remoteMoved ? " Nhưng origin/main đã đổi, nên đồng bộ lại trước khi chạy." : ""),
    steps: a.remoteMoved
      ? [
          {
            text: "Đồng bộ lại rồi chạy lại — nút Đồng bộ & kiểm làm đúng việc này",
            command: `git -C ${pkg} fetch origin main && git -C ${pkg} merge --ff-only origin/main`,
          },
        ]
      : [{ text: "Chạy lại là xong." }],
  };
}

/* ── reading the run's log ──────────────────────────────────────────────── */

/**
 * Một dòng log vẽ ra đúng như terminal sẽ vẽ nó.
 *
 * Không phải "cắt lấy phần sau dấu `\r` cuối cùng" — cách đó sai ở hai chỗ mà
 * log thật có cả hai:
 *
 *  - `\b` (backspace) lùi con trỏ rồi ký tự sau viết đè. `script` vọng lại
 *    `^D\b\b` ở đầu log vì stdin đóng ngay, và chỉ có xử lý `\b` mới xoá nó
 *    như terminal xoá.
 *  - `\r` rồi viết một chuỗi **ngắn hơn** thì phần đuôi cũ vẫn còn trên màn
 *    hình. Cắt chuỗi sẽ nuốt mất phần đuôi ấy.
 *
 * Nên: một ô cho mỗi cột, con trỏ chạy trên đó, ký tự ghi đè ô nó đứng. Mã
 * ANSI rộng bằng không — nó bám vào ô kế tiếp chứ không chiếm cột nào, nếu
 * không thì màu sẽ lệch chỗ sau mỗi lần viết đè.
 */
function renderLine(line: string): string {
  const cells: Array<{ pre: string; ch: string }> = [];
  let cur = 0;
  let pending = "";

  // eslint-disable-next-line no-control-regex
  const esc = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./gy;
  for (let i = 0; i < line.length; ) {
    esc.lastIndex = i;
    const m = line[i] === "\x1b" ? esc.exec(line) : null;
    if (m) {
      pending += m[0];
      i = esc.lastIndex;
      continue;
    }
    const ch = line[i++];
    if (ch === "\r") cur = 0;
    else if (ch === "\b") cur = Math.max(0, cur - 1);
    else {
      cells[cur] = { pre: pending, ch };
      pending = "";
      cur++;
    }
  }

  let out = "";
  for (let i = 0; i < cells.length; i++) out += (cells[i]?.pre ?? "") + (cells[i]?.ch ?? " ");
  return out + pending;
}

/**
 * Cả log vẽ ra như terminal.
 *
 * PTY đổi mọi `\n` thành `\r\n`, nên phải tách CRLF ra trước: `\r` cuối dòng là
 * dấu xuống dòng, không phải lệnh viết đè. Thiếu bước đó thì mọi dòng thành
 * rỗng và log trắng bóc.
 *
 * Không phải trang điểm — `cargo` vẽ thanh tiến trình bằng cách trả con trỏ về
 * đầu dòng rồi viết đè, nên bốn mươi phút build tích lại hàng nghìn dòng
 * `Compiling …` trong khi terminal chỉ từng hiện một dòng.
 */
export function terminalText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(renderLine)
    .join("\n");
}

/**
 * Mọi chuỗi điều khiển ANSI, gỡ sạch.
 *
 * Dùng cho phần *đọc hiểu* log — `phaseOf` tìm dòng `🚀 Pushing changes`, và
 * nó phải tìm được dù tool có tô màu dòng đó hay không.
 */
export function stripAnsi(text: string): string {
  // CSI (`ESC [ … chữ cái`) và OSC (`ESC ] … BEL|ST`) — hai dạng duy nhất các
  // tool ở đây phát ra.
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Một đoạn chữ cùng màu, như terminal sẽ vẽ nó. */
export interface AnsiSpan {
  text: string;
  /** CSS color, hoặc '' khi dùng màu chữ mặc định. */
  color: string;
  bold: boolean;
}

/**
 * Bảng 16 màu, lấy theo bộ của GitHub Dark — cùng bộ nền terminal trong app.
 *
 * 0–7 thường, 8–15 sáng. Tool phát số nào thì vẽ màu ấy, không diễn giải lại.
 */
const ANSI_16 = [
  "#484f58", "#ff7b72", "#3fb950", "#d29922",
  "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
  "#6e7681", "#ffa198", "#56d364", "#e3b341",
  "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
];

/** 256-màu: 16 màu đầu, khối 6×6×6, rồi 24 mức xám. */
function xterm256(n: number): string {
  if (n < 16) return ANSI_16[n];
  if (n < 232) {
    const i = n - 16;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    const to = (v: number) => step(v).toString(16).padStart(2, "0");
    return `#${to(Math.floor(i / 36))}${to(Math.floor(i / 6) % 6)}${to(i % 6)}`;
  }
  const g = (n - 232) * 10 + 8;
  return `#${g.toString(16).padStart(2, "0").repeat(3)}`;
}

/**
 * Một dòng log có mã ANSI, đọc thành các đoạn có màu.
 *
 * Chỉ SGR (`ESC[…m`) — màu chữ, đậm, và reset. Không xử lý màu nền hay di
 * chuyển con trỏ: cargo và rustc không dùng chúng trong dòng chảy log, và một
 * bộ mô phỏng terminal đầy đủ là thứ module này không cần.
 *
 * Mọi mã không hiểu được **bỏ qua chứ không in ra** — in ra thì người đọc thấy
 * rác `[0m`, mà đó chính là thứ đang phải tránh.
 */
export function parseAnsi(line: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let color = "";
  let bold = false;
  let at = 0;

  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index), color, bold });
    at = m.index + m[0].length;
    if (m[1] === undefined) continue; // không phải SGR: nuốt, không vẽ

    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = "";
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = "";
      else if (c >= 30 && c <= 37) color = ANSI_16[c - 30];
      else if (c >= 90 && c <= 97) color = ANSI_16[c - 90 + 8];
      else if (c === 38) {
        // `38;5;n` là 256-màu, `38;2;r;g;b` là truecolor.
        if (codes[i + 1] === 5) {
          color = xterm256(codes[i + 2] ?? 0);
          i += 2;
        } else if (codes[i + 1] === 2) {
          const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0];
          color = `rgb(${r} ${g} ${b})`;
          i += 4;
        }
      }
    }
  }
  if (at < line.length) out.push({ text: line.slice(at), color, bold });
  return out;
}

/** The last `n` lines, for a console that must not grow without bound. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(lines.length - n).join("\n");
}

export type RunPhase =
  | "build"
  | "zip"
  | "release"
  | "sources"
  | "push"
  | "finish";

/**
 * Where the run has got to, read from the tool's own `Log.info` lines.
 *
 * Used to word the cancel button, and that is the point: cancelling during the
 * build costs nothing, cancelling after `Pushing changes` cannot take the push
 * back. A button that says the same thing in both cases is lying in one of them.
 *
 * Ordered latest-phase-first, so a log containing every line reports the
 * furthest one reached rather than the first.
 */
export function phaseOf(tail: string): RunPhase {
  const t = terminalText(tail);
  const marks: Array<[RunPhase, string]> = [
    ["finish", "Update release"],
    ["push", "Pushing changes"],
    ["sources", "Copying sources"],
    ["release", "Making release"],
    ["zip", "Zipping framework"],
    ["build", "Building "],
  ];
  for (const [phase, needle] of marks) if (t.includes(needle)) return phase;
  return "build";
}

/** How a finished run is reported. `lost` is not `failed` — see the runner. */
export type RunState = "running" | "ok" | "failed" | "cancelled" | "lost";

export const RUN_LABEL: Record<RunState, string> = {
  running: "đang chạy",
  ok: "xong",
  failed: "lỗi",
  cancelled: "đã huỷ",
  lost: "mất dấu",
};

export interface ChangedFile {
  /** `A` thêm, `M` sửa, `D` xoá, `R` đổi tên — chữ cái đầu của git. */
  status: string;
  path: string;
  /** Đường dẫn cũ, chỉ có khi đổi tên. */
  from?: string;
}

/**
 * `git diff --name-status -M` đọc thành danh sách.
 *
 * Tách khỏi chỗ gọi git để test được mà không cần repo: dòng đổi tên có **ba**
 * cột (`R100\told\tnew`) còn mọi dòng khác chỉ có hai, và đó đúng là trường hợp
 * không dựng lại được bằng tay trong một clone thật.
 */
export function parseNameStatus(raw: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const status = (cols[0] ?? "").charAt(0);
    if (!status) continue;
    if ((status === "R" || status === "C") && cols.length >= 3)
      out.push({ status, path: cols[2], from: cols[1] });
    else if (cols[1]) out.push({ status, path: cols[1] });
  }
  return out;
}

/**
 * `git diff --numstat` đọc thành bảng: đường dẫn → số dòng thêm/bớt.
 *
 * File nhị phân được git ghi là `-\t-\t<path>`, không phải số 0 — hai thứ khác
 * nhau và phải hiện khác nhau, nếu không một file ảnh sẽ đọc như một file
 * không đổi gì.
 */
export function parseNumstat(
  raw: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    let path = rest.join("\t");
    // Đổi tên ở numstat có dạng `old => new` hoặc `dir/{old => new}/file`.
    // Tên mới mới là cái khớp với --name-status, nên lấy vế phải.
    if (path.includes(" => ")) {
      path = path.includes("{")
        ? path.replace(/\{([^{}]*) => ([^{}]*)\}/, "$2").replace(/\/\//g, "/")
        : path.split(" => ")[1];
    }
    if (!path) continue;
    const binary = a === "-" || d === "-";
    out.set(path, {
      added: binary ? 0 : Number(a) || 0,
      removed: binary ? 0 : Number(d) || 0,
      binary,
    });
  }
  return out;
}

export interface DiffLine {
  /** `hunk` là dòng `@@ … @@`, ba loại còn lại là nội dung. */
  kind: "hunk" | "add" | "del" | "ctx";
  /** Số dòng ở bản cũ / bản mới; `null` khi dòng đó không tồn tại ở bên ấy. */
  old: number | null;
  new: number | null;
  text: string;
}

/**
 * Một unified diff của **một** file, đọc thành từng dòng có sẵn số dòng.
 *
 * Số dòng phải tính ở đây chứ không để chỗ hiển thị đếm: đó là thứ duy nhất
 * làm một diff đọc được, và nó chỉ đúng nếu bám theo đầu hunk `@@ -a,b +c,d @@`
 * — nhảy cóc giữa các hunk là chuyện bình thường, không phải lỗi.
 *
 * Phần đầu (`diff --git`, `index`, `---`, `+++`) bị bỏ: người đọc đã biết đang
 * xem file nào vì họ vừa bấm vào nó.
 */
export function parseUnifiedDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let started = false;

  for (const line of raw.split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (at) {
      started = true;
      oldNo = Number(at[1]);
      newNo = Number(at[2]);
      out.push({ kind: "hunk", old: null, new: null, text: line });
      continue;
    }
    if (!started) continue;
    // "\ No newline at end of file" nói về dòng ngay trên, không phải một dòng
    // của file — đếm nó vào số dòng là lệch hết phần còn lại.
    if (line.startsWith("\\")) continue;

    const c = line.charAt(0);
    const text = line.slice(1);
    if (c === "+") out.push({ kind: "add", old: null, new: newNo++, text });
    else if (c === "-") out.push({ kind: "del", old: oldNo++, new: null, text });
    else if (c === " ")
      out.push({ kind: "ctx", old: oldNo++, new: newNo++, text });
  }
  return out;
}

/**
 * Nhánh khớp câu tìm tới mức nào — số càng nhỏ càng sát.
 *
 * Lọc bằng `includes` rồi giữ nguyên thứ tự là chỗ hỏng: đo trên 58 nhánh của
 * clone SDK, gõ `develop` thì nhánh tên đúng `develop` rơi xuống **thứ 8**,
 * dưới cả `ctalk/feature/resolve_ctalkdevelop_upgrade_26.09.09_phase1`; gõ
 * `master` thì `master` đứng sau một nhánh dài 60 ký tự. Danh sách chỉ hiện 10
 * dòng, nên một bậc thôi cũng đủ đẩy câu trả lời đúng ra khỏi màn hình.
 *
 * Bậc xếp theo *ý người gõ*, không theo vị trí ký tự: gõ tên một nhánh là đang
 * gọi đúng nhánh đó, nên khớp cả tên thắng; kế đến là nhánh **mang tên** ấy ở
 * đoạn cuối (`ctalk/develop`), rồi mới tới những nhánh chỉ *nhắc* tới nó.
 */
export function rankBranch(name: string, needle: string): number {
  const n = name.toLowerCase();
  const q = needle.toLowerCase();
  if (!q) return 0;
  if (n === q) return 0;

  const segs = n.split("/");
  if (segs[segs.length - 1] === q) return 1;
  if (segs.includes(q)) return 2;
  if (n.startsWith(q)) return 3;
  if (segs.some((s) => s.startsWith(q))) return 4;
  // Đầu một từ bên trong đoạn: gõ `706` phải thấy `VT_706_permalink_base_urls`.
  if (segs.some((s) => s.split(/[-_.]/).some((w) => w.startsWith(q)))) return 5;
  return n.includes(q) ? 6 : 7;
}

/**
 * Từ khớp đứng thứ mấy trong đoạn chứa nó — `Infinity` nếu không từ nào khớp.
 *
 * Dùng để phá hoà giữa hai nhánh cùng bậc, và nó cần thiết: gõ `706` thì
 * `merge_VT_4_and_VT_706` (từ thứ 5) từng đứng trên
 * `VT_706_permalink_base_urls` (từ thứ 2), chỉ vì tên nó ngắn hơn ba ký tự.
 * Độ dài là tiêu chí sai ở đây — từ khớp càng sớm thì tên càng *về* thứ vừa gõ.
 */
function wordIndex(name: string, q: string): number {
  let best = Infinity;
  for (const seg of name.toLowerCase().split("/")) {
    const words = seg.split(/[-_.]/);
    const i = words.findIndex((w) => w.startsWith(q));
    if (i >= 0) best = Math.min(best, i);
  }
  return best;
}

/**
 * Lọc rồi xếp nhánh theo độ sát với câu tìm.
 *
 * Phá hoà theo thứ tự: từ khớp sớm hơn, rồi tên ngắn hơn, rồi bảng chữ cái —
 * ba tiêu chí đều không phụ thuộc thứ tự đầu vào, nên gõ cùng một chữ hai lần
 * luôn ra cùng một danh sách.
 */
export function searchBranches<T extends { name: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items
    .filter((b) => b.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        rankBranch(a.name, q) - rankBranch(b.name, q) ||
        wordIndex(a.name, q) - wordIndex(b.name, q) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    );
}
