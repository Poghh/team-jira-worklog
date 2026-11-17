/**
 * Checklist "trước khi PR vào môi trường X thì phải xong những việc gì".
 *
 * Nguồn, theo thứ tự ưu tiên:
 *   1. Confluence "Git & Task Management Rules" bản 6 (14/11/2026) — mục 1, 2,
 *      3, 4, 5, 6 và hai sơ đồ ở mục 0. Kiểm **đúng chữ của tài liệu**, kể cả
 *      khi team trên GitHub đang làm khác (label `pr-bugfix`, tiêu đề
 *      `[CTalk] fix: VT-1 | …`): đó là quyết định của người dùng, PR theo kiểu
 *      cũ bị đánh ✗ cho tới khi team đổi.
 *   2. PR template của repo iOS — phiên bản `MatrixRustSDK` trong `project.yml`
 *      phải khớp môi trường đích, và các mục test UI/timeline tick tay.
 *
 * Số approve **không** kiểm: trên GitHub hầu hết PR iOS đã merge có 0
 * approve, nên con số đó không phản ánh việc review thật (quyết định của
 * người dùng).
 *
 * Hàm thuần: dữ kiện GitHub được đọc ở `fetchPrChecklist`, ở đây chỉ đánh giá.
 */

import { keyInBranch, kindOfBranch, resolveBranchName } from "@/lib/modules/branches/git-rules";

/** Loại PR theo sơ đồ luồng của tài liệu. */
export type PrRoute =
  /** Nhánh làm việc (feature/bugfix/task) → `ctalk/develop`. */
  | "integration"
  /** Task con → nhánh cha. */
  | "parent"
  /** Hotfix → `staging`, đi thẳng. */
  | "hotfix"
  /** PR môi trường của Tech Lead: `ctalk/develop → develop → staging`. */
  | "env";

/** Những gì GitHub nói về một PR — `null` khi chưa có PR. */
export interface PrFacts {
  number: number;
  url: string;
  /** OPEN | CLOSED | MERGED */
  state: string;
  title: string;
  body: string;
  labels: string[];
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  /** SUCCESS | FAILURE | ERROR | PENDING | EXPECTED, `""` khi không có CI. */
  ci: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Tối đa 100 file đầu — đủ để lọc file không tính. */
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** Commit message đầy đủ của các commit trong PR. */
  commits: string[];
}

/** Bối cảnh mà không cần PR cũng biết. */
export interface ChecklistContext {
  repo: string;
  /** Nhánh nguồn. */
  head: string;
  /** Nhánh đích. */
  base: string;
  route: PrRoute;
  /** Commit `master` mà nhánh nguồn chưa có; `null` khi chưa đo. */
  behind: number | null;
  /** `MatrixRustSDK.exactVersion` trong `project.yml` ở nhánh nguồn; `null` = repo không có. */
  sdkVersion: string | null;
  /** Mã task của card, để soi tiêu đề và `Ref:`. */
  issueKeys: string[];
  /** Nhánh cha khi `route === "parent"`. */
  parentBranch?: string;
  /** Nhánh nguồn không còn trên GitHub (đã xoá). */
  headGone?: boolean;
  /**
   * Conflict đo dưới máy khi chưa có PR (git merge-tree trong clone review):
   * danh sách file, `[]` là merge sạch, vắng là không đo được.
   */
  localConflicts?: string[];
  /**
   * Nhánh gốc khi `head` là nhánh resolve (mục 5) — PR resolve giữ label,
   * cách merge và loại commit của nhánh gốc. Vắng khi không tìm ra.
   */
  originBranch?: string;
}

/** Nhánh resolve và lệnh tạo nó, theo mục 5. */
export interface ResolvePlan {
  branch: string;
  commands: string;
}

/**
 * Cách xử lý conflict theo mục 5 — chỉ cho PR làm việc vào môi trường và
 * hotfix. Task con conflict với nhánh cha thì rebase/merge nhánh cha, PR môi
 * trường thì Tech Lead xử lý: không có nhánh resolve.
 */
export function resolvePlan(ctx: Pick<ChecklistContext, "route" | "head" | "base" | "issueKeys">): ResolvePlan | null {
  if (ctx.route !== "integration" && ctx.route !== "hotfix") return null;
  if (kindOfBranch(ctx.head) === "resolve") return null;
  const team = ctx.head.split("/")[0] || "ctalk";
  const key = ctx.issueKeys[0] || keyInBranch(ctx.head) || "VT-?";
  const branch = resolveBranchName(team, key, ctx.base);
  return {
    branch,
    commands: [
      "git fetch origin",
      `git checkout -b ${branch} origin/${ctx.head}`,
      `git merge origin/${ctx.base}      # sửa conflict rồi commit`,
      `git push -u origin ${branch}`,
    ].join("\n"),
  };
}

export type CheckState = "ok" | "fail" | "warn" | "wait" | "unknown";

export interface CheckItem {
  /** Khoá ổn định — tick tay được lưu theo khoá này. */
  id: string;
  section: "before" | "open" | "merge" | "after";
  text: string;
  /** `auto` = app tự kiểm; `manual` = người dùng tick. */
  kind: "auto" | "manual";
  /** Chỉ có ở mục `auto`. */
  state?: CheckState;
  /** Giải thích kết quả, hoặc gợi ý cách làm. */
  detail?: string;
}

export const SECTION_TITLES: Record<CheckItem["section"], string> = {
  before: "Trước khi tạo PR",
  open: "Khi tạo PR",
  merge: "Trước khi merge",
  after: "Sau khi merge",
};

/** Môi trường tích hợp, theo tài liệu. */
export const INTEGRATION = "ctalk/develop";

/**
 * PR này đi đường nào trên sơ đồ.
 *
 * Đích là `ctalk/develop` thì là PR làm việc; đích là `staging` từ nhánh
 * hotfix là đường tắt của hotfix; đích là môi trường khác là PR môi trường;
 * còn lại (đích là một nhánh thường) là task con vào nhánh cha.
 */
export function routeOf(head: string, base: string, envBranches: readonly string[]): PrRoute {
  if (base === INTEGRATION) return "integration";
  if (kindOfBranch(head) === "hotfix" && envBranches.includes(base)) return "hotfix";
  if (envBranches.includes(base) || base === "master") return "env";
  return "parent";
}

/**
 * Bậc nên mở trước khi chọn một nhánh: PR đang mở (việc đang cần soát), rồi
 * bậc đầu tiên chưa có PR, rồi bậc đầu tiên.
 *
 * Không lấy "chưa có PR" trước: task con có PR mở vào nhánh cha thì bậc
 * `ctalk/develop` của nó luôn trống — mở vào đó là giấu mất chính PR cần xem.
 */
export function defaultBase(bases: ReadonlyArray<{ branch: string; state: string }>): string {
  return (bases.find((b) => b.state === "OPEN") ?? bases.find((b) => !b.state) ?? bases[0])?.branch ?? "";
}

/** Nhánh nguồn của PR môi trường vào `base`: môi trường đứng ngay trước nó. */
export function envHead(base: string, envBranches: readonly string[]): string {
  const i = envBranches.indexOf(base);
  return i > 0 ? envBranches[i - 1]! : "";
}

/**
 * Hậu tố phiên bản SDK mà môi trường đòi.
 *
 * Template chỉ liệt kê `dev`/`staging`/`theboytalk`/`master`, nhưng
 * `ctalk/develop` thật đang chạy `2026.11.13-ctalkdev.1` — đọc ngày 14/11 trên
 * cả bốn nhánh: `-ctalkdev.1`, `-dev.1`, `-stag.1`, và `master` không hậu tố.
 */
export function sdkSuffixFor(base: string): string | null {
  switch (base) {
    case "ctalk/develop":
      return "ctalkdev";
    case "develop":
    case "dev":
      return "dev";
    case "staging":
      return "stag";
    case "theboytalk":
      return "theboy";
    case "master":
      return "";
    default:
      return null;
  }
}

/** Phiên bản có đúng dạng `yyyy.mm.dd[-<hậu tố>.N]` của môi trường không. */
export function sdkVersionMatches(version: string, base: string): boolean | null {
  const suffix = sdkSuffixFor(base);
  if (suffix === null) return null;
  const date = String.raw`\d{4}\.\d{2}\.\d{2}`;
  return new RegExp(suffix ? `^${date}-${suffix}\\.\\d+$` : `^${date}$`).test(version.trim());
}

/** Đọc `exactVersion` của `MatrixRustSDK` ra khỏi `project.yml`. */
export function sdkVersionFromProjectYml(text: string): string | null {
  const m = text.match(/MatrixRustSDK:\s*\n(?:[ \t]+[^\n]*\n){0,6}?[ \t]+exactVersion:\s*["']?([^\s"'#]+)/);
  return m?.[1] ?? null;
}

/**
 * File không phải người viết (lock, pbxproj, ảnh/asset, code generate) — bỏ
 * khỏi diff gửi Claude khi gợi ý danh sách thay đổi.
 */
export function isUncountedFile(path: string): boolean {
  return (
    /(^|\/)(Podfile\.lock|Package\.resolved|Cargo\.lock|project\.pbxproj)$/.test(path) ||
    /\.xcassets\//.test(path) ||
    /\.(png|jpe?g|gif|pdf|svg|webp|heic|mp4|json\.lottie|ttf|otf)$/i.test(path) ||
    /(^|\/)(Generated|generated)(\/|$)|\.generated\.|\+Generated\.swift$/.test(path)
  );
}

const KEY = String.raw`[A-Z][A-Z0-9]+-\d+`;
const KEYS = String.raw`\((${KEY})(, ${KEY})*\)`;

/** Prefix tiêu đề của PR task con theo loại nhánh cha (bảng mục 4). */
export function parentTitlePrefix(parentBranch: string): string {
  const k = kindOfBranch(parentBranch);
  return k === "bugfix" ? "[Bugfix]" : k === "hotfix" ? "[Hotfix]" : k === "task" ? "[Improve]" : "[Feature]";
}

/** Prefix tiêu đề PR môi trường: `[Develop]`, `[Staging]`. */
export function envTitlePrefix(base: string): string {
  return base === "staging" ? "[Staging]" : base === "develop" ? "[Develop]" : `[${base}]`;
}

/** Tiêu đề mẫu cho từng đường — để nói "phải là thế này" khi kiểm trượt. */
export function titlePattern(ctx: Pick<ChecklistContext, "route" | "base" | "parentBranch">): {
  re: RegExp;
  sample: string;
} {
  switch (ctx.route) {
    case "integration":
      return { re: new RegExp(`^\\[CTalk\\] \\S.* ${KEYS}$`), sample: "[CTalk] <Tiêu đề> (VT-123)" };
    case "hotfix":
      return {
        re: new RegExp(`^\\[Staging\\]\\[Hotfix\\] \\S.* ${KEYS}$`),
        sample: "[Staging][Hotfix] <Tiêu đề> (VT-301)",
      };
    case "parent": {
      const p = parentTitlePrefix(ctx.parentBranch ?? ctx.base);
      const esc = p.replace(/[[\]]/g, "\\$&");
      return { re: new RegExp(`^${esc} \\S.*?( ${KEYS})?$`), sample: `${p} <Tiêu đề> (VT-101 nếu có)` };
    }
    case "env": {
      const p = envTitlePrefix(ctx.base);
      const esc = p.replace(/[[\]]/g, "\\$&");
      return { re: new RegExp(`^${esc} \\S`), sample: `${p} <Tiêu đề>` };
    }
  }
}

/** Label đúng cho nhánh nguồn (mục 6) — `null` khi PR này không gắn label. */
export function expectedLabel(route: PrRoute, head: string): string | null {
  if (route !== "integration" && route !== "hotfix") return null;
  const k = kindOfBranch(head);
  return k === "feature"
    ? "type:feature"
    : k === "bugfix"
      ? "type:bugfix"
      : k === "hotfix"
        ? "type:hotfix"
        : k === "task"
          ? "type:improve"
          : null;
}

/**
 * Gợi ý label cho người tự tạo PR (mục 6): label nào, hoặc vì sao không gắn.
 * `label` là `null` khi PR này không gắn label, hoặc app không đoán được.
 */
export function labelAdvice(
  route: PrRoute,
  head: string,
  /** Nhánh gốc khi `head` là nhánh resolve. */
  origin?: string,
): { label: string | null; note: string } {
  if (route === "parent") return { label: null, note: "PR task con → nhánh cha không gắn label." };
  if (route === "env") return { label: null, note: "PR môi trường không gắn label." };
  if (isResolveBranch(head)) {
    const kept = origin ? expectedLabel(route, origin) : null;
    return kept
      ? { label: kept, note: `Nhánh resolve giữ label của nhánh gốc ${origin}.` }
      : { label: null, note: "Nhánh resolve: giữ đúng label `type: …` của PR nhánh gốc (không tìm ra nhánh gốc)." };
  }
  const label = expectedLabel(route, head);
  return label
    ? { label, note: "Đúng 1 label, theo loại nhánh nguồn." }
    : { label: null, note: "Không đoán được loại nhánh nguồn — chọn 1 label `type: …` theo loại việc." };
}

const COMMIT_HEAD = /^(feat|fix|refactor|perf|test|chore|style|docs|ci|revert)(\([^)]+\))?: \S/;

/** Một commit message có đúng mục 3 không — `""` khi đúng, còn lại là lý do. */
export function commitProblem(message: string): string {
  const [head = "", ...rest] = message.split("\n");
  if (/^Merge (branch|pull request|remote-tracking)/.test(head)) return "";
  if (!COMMIT_HEAD.test(head)) return "dòng đầu không theo `type(scope): mô tả`";
  if (head.length > 72) return `dòng đầu dài ${head.length} ký tự (tối đa 72)`;
  if (/\.$/.test(head)) return "dòng đầu kết thúc bằng dấu chấm";
  const refAt = rest.findIndex((l) => /^Ref:/.test(l));
  if (refAt >= 0 && rest[refAt - 1]?.trim() !== "") return "thiếu dòng trống trước `Ref:`";
  return "";
}

const BRANCH_RE = new RegExp(
  `^(ctalk|hir)/(feature|bugfix|task|hotfix)/${KEY}(_[a-z0-9]+(-[a-z0-9]+)*)?$`,
);

/** Tên nhánh có theo bảng mục 1 không. */
export function branchNameOk(branch: string): boolean {
  return branchNameProblem(branch) === "";
}

/**
 * Tên nhánh sai ở đâu, theo bảng mục 1 — `""` khi đúng.
 *
 * Nói đúng lỗi của nhánh này chứ không in mẫu chung. Phần `_mo-ta` sau mã
 * task là tùy, với mọi loại nhánh (quyết định của người dùng, 15/11/2026 —
 * tài liệu ghi feature có mô tả, nhưng team không bắt buộc); chỉ khi có thì
 * phải đúng dạng `_viet-thuong-noi-gach`.
 */
export function branchNameProblem(branch: string): string {
  const [team = "", kind = "", ...rest] = branch.split("/");
  const tail = rest.join("/");
  const key = tail.match(new RegExp(`^${KEY}`))?.[0] ?? "";
  if (team !== "ctalk" && team !== "hir") return `phải bắt đầu bằng ctalk/ hoặc hir/ (đang là “${team}/”)`;
  if (!["feature", "bugfix", "task", "hotfix"].includes(kind))
    return `loại nhánh phải là feature, bugfix, task hoặc hotfix (đang là “${kind}”)`;
  if (!key) return `sau ${team}/${kind}/ phải là mã task viết hoa, ví dụ ${team}/${kind}/VT-123`;
  if (!BRANCH_RE.test(branch))
    return `mô tả (tùy) sau mã task phải là _viet-thuong-noi-gach, ví dụ ${team}/${kind}/${key} hoặc ${team}/${kind}/${key}_video-call`;
  return "";
}

const auto = (
  id: string,
  section: CheckItem["section"],
  text: string,
  state: CheckState,
  detail?: string,
): CheckItem => ({ id, section, text, kind: "auto", state, ...(detail ? { detail } : {}) });

const manual = (id: string, section: CheckItem["section"], text: string, detail?: string): CheckItem => ({
  id,
  section,
  text,
  kind: "manual",
  ...(detail ? { detail } : {}),
});

/** Mục 4: feature → ctalk/develop và PR môi trường dùng Merge commit; còn lại Squash and merge. */
/** Nhánh resolve: `<team>/resolve/…` theo mục 5, hoặc kiểu cũ `<team>/task/resolve_…`. */
export function isResolveBranch(branch: string): boolean {
  return kindOfBranch(branch) === "resolve" || /^resolve[_-]/i.test(branch.split("/").pop() ?? "");
}

/**
 * Nhánh gốc của một nhánh resolve trong `branches`: cùng team, cùng mã task,
 * loại feature / bugfix / task / hotfix. `""` khi không có hoặc không phải resolve.
 */
export function originOfResolve(head: string, branches: readonly string[]): string {
  if (!isResolveBranch(head)) return "";
  const key = keyInBranch(head);
  const team = head.split("/")[0] ?? "";
  if (!key) return "";
  return (
    branches.find((b) => {
      const k = kindOfBranch(b);
      return (
        b.split("/")[0] === team &&
        (k === "feature" || k === "bugfix" || k === "task" || k === "hotfix") &&
        !isResolveBranch(b) &&
        keyInBranch(b) === key
      );
    }) ?? ""
  );
}

export function usesSquash(route: PrRoute, head: string): boolean {
  return !(route === "env" || (route === "integration" && kindOfBranch(head) === "feature"));
}

/**
 * Checklist cho một PR `head → base`.
 *
 * `facts === null` nghĩa là chưa có PR: chỉ những mục "Trước khi tạo PR" và
 * các mục tick tay là trả lời được; mục nào cần PR thì ở trạng thái `wait`.
 */
export function buildChecklist(ctx: ChecklistContext, facts: PrFacts | null): CheckItem[] {
  const out: CheckItem[] = [];
  const { route, head, base } = ctx;
  // PR resolve giữ label, cách merge và luật commit của nhánh gốc (mục 5).
  const like = ctx.originBranch || head;
  const merged = facts?.state === "MERGED";
  const noPr = "Chưa có PR.";
  const work = route !== "env";

  /* ── Trước khi tạo PR ─────────────────────────────────────────────── */

  if (work) {
    out.push(
      branchNameOk(head)
        ? auto("branch-name", "before", "Tên nhánh đúng quy ước", "ok", head)
        : auto(
            "branch-name",
            "before",
            "Tên nhánh đúng quy ước",
            kindOfBranch(head) === "resolve" ? "ok" : "fail",
            kindOfBranch(head) === "resolve"
              ? `${head} — nhánh resolve, đặt theo mục 5`
              : `${head} — ${branchNameProblem(head)}.\nNhánh đã có PR thì đổi tên là phải mở PR mới; có thể bỏ qua mục này cho nhánh đang làm dở.`,
          ),
    );
  }

  if (route === "parent") {
    // Task con không sync master, không rebase từ nhánh cha: merge hết task
    // con vào nhánh cha rồi nhánh cha mới sync (người dùng chốt 15/11/2026).
    // Conflict với nhánh cha thì mục "Không conflict" ở dưới chỉ cách xử lý.
  } else if (work) {
    out.push(
      ctx.behind === null
        ? auto("sync-master", "before", "Nhánh đã có bản mới nhất của master", "unknown", "Chưa đo — quét GitHub một lần.")
        : ctx.behind === 0
          ? auto("sync-master", "before", "Nhánh đã có bản mới nhất của master", "ok")
          : auto(
              "sync-master",
              "before",
              "Nhánh đã có bản mới nhất của master",
              merged ? "unknown" : "fail",
              `Tụt ${ctx.behind} commit — xem gợi ý rebase/merge trên card.`,
            ),
    );
  }

  if (route === "integration" && kindOfBranch(like) === "feature")
    out.push(
      manual(
        "children-merged",
        "before",
        "Mọi task con đã merge vào nhánh này, rồi mới sync master",
        "Còn PR task con đang mở thì đợi — nhánh cha sync master sau khi đã nhận hết task con.",
      ),
    );

  if (ctx.sdkVersion !== null && route !== "parent") {
    const ok = sdkVersionMatches(ctx.sdkVersion, base);
    const suffix = sdkSuffixFor(base);
    out.push(
      auto(
        "sdk-version",
        "before",
        "MatrixRustSDK trong project.yml khớp môi trường đích",
        ok === null ? "unknown" : ok ? "ok" : "fail",
        ok === null
          ? `${ctx.sdkVersion} — chưa biết dạng phiên bản của ${base}`
          : `${ctx.sdkVersion}${ok ? "" : ` — ${base} cần yyyy.mm.dd${suffix ? `-${suffix}.N` : " (không hậu tố)"}`}`,
      ),
    );
  }

  // Timeline, test UI, swiftformat: đã là checklist trong PR template của
  // repo iOS — tick trên GitHub, không lặp lại ở đây.

  if (route === "hotfix") {
    out.push(
      manual(
        "hotfix-staging-clean",
        "before",
        "Đã kiểm staging không có code chưa sẵn sàng release",
        "Nếu có, Tech Lead quyết định cho hotfix PR thẳng vào master.",
      ),
      manual("hotfix-scope", "before", "Chỉ sửa đúng lỗi, không kèm refactor hay thay đổi khác"),
    );
  }

  /* ── Khi tạo PR ───────────────────────────────────────────────────── */

  const t = titlePattern(ctx);
  // Tiêu đề gợi ý không nằm ở đây mà ở đầu checklist, luôn hiện — xem
  // `PrGuideView.suggestedTitle`.
  const titleOk = facts ? t.re.test(facts.title.trim()) : false;
  out.push(
    !facts
      ? auto("title", "open", "Tiêu đề đúng format", "wait", t.sample)
      : titleOk
        ? auto("title", "open", "Tiêu đề đúng format", "ok", facts.title)
        : auto("title", "open", "Tiêu đề đúng format", "fail", `“${facts.title}” — phải là ${t.sample}`),
  );

  const want = expectedLabel(route, like);
  if (want || isResolveBranch(head)) {
    const typed = facts?.labels.filter((l) => /^type:/i.test(l)) ?? [];
    // Resolve mà không tìm ra nhánh gốc: chỉ kiểm được "đúng một label type:".
    const resolve = isResolveBranch(head) && !want;
    // So lỏng khoảng trắng và hoa thường: tài liệu viết `type: feature`, repo
    // thật đặt `type:feature` — cùng một label.
    const same = (a: string, b: string) => a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
    const ok = resolve ? typed.length === 1 : typed.length === 1 && same(typed[0]!, want!);
    out.push(
      facts
        ? auto(
            "label",
            "open",
            resolve ? "Giữ label của nhánh gốc (đúng 1 label `type: …`)" : `Đúng 1 label \`${want}\``,
            ok ? "ok" : "fail",
            facts.labels.length ? `Đang có: ${facts.labels.join(", ")}` : "Chưa gắn label nào",
          )
        : auto("label", "open", `Gắn label \`${want ?? "type: …"}\``, "wait", noPr),
    );
  } else if (facts && facts.labels.some((l) => /^type:/i.test(l))) {
    out.push(
      auto("label", "open", "Không gắn label `type: …` cho PR này", "warn", `Đang có: ${facts.labels.join(", ")}`),
    );
  }

  const jiraLinks = facts ? (facts.body.match(/\/browse\/[A-Z][A-Z0-9]+-\d+/g) ?? []).length : 0;
  if (route === "env") {
    out.push(
      facts
        ? auto(
            "body-tasks",
            "open",
            "Mô tả liệt kê các task kèm link Jira",
            jiraLinks > 0 ? "ok" : "fail",
            `${jiraLinks} link Jira trong mô tả`,
          )
        : auto("body-tasks", "open", "Mô tả liệt kê các task kèm link Jira", "wait", noPr),
    );
  } else {
    out.push(
      facts
        ? auto(
            "body-jira",
            "open",
            "Mô tả có link Jira",
            jiraLinks > 0 ? "ok" : "fail",
            jiraLinks ? undefined : "Không thấy link …/browse/VT-… nào trong mô tả",
          )
        : auto("body-jira", "open", "Mô tả có link Jira", "wait", noPr),
      manual("body-content", "open", "Mô tả có nội dung thay đổi, cách kiểm tra, ảnh chụp nếu có UI"),
    );
  }
  if (route === "hotfix")
    out.push(manual("body-hotfix", "open", "Mô tả thêm nguyên nhân lỗi, phạm vi ảnh hưởng, cách rollback"));

  /* ── Trước khi merge ──────────────────────────────────────────────── */

  if (!merged) {
    const conflictFix =
      route === "parent"
        ? "Rebase/merge nhánh cha vào task con — không cần nhánh resolve."
        : route === "env"
          ? "Xử lý conflict giữa hai môi trường."
          : `Không merge ${base} vào nhánh gốc. Tạo ${resolvePlan(ctx)?.branch ?? "nhánh resolve"} từ ${head}, merge origin/${base} vào đó, đóng PR cũ (nếu có), mở PR mới (giữ tiêu đề cũ) — lệnh ở khung "Conflict" phía trên.`;
    const files = (list: string[]) =>
      list.length ? `\nFile conflict: ${list.slice(0, 12).join(", ")}${list.length > 12 ? ` … (+${list.length - 12})` : ""}` : "";
    out.push(
      !facts
        ? ctx.localConflicts === undefined
          ? auto("conflict", "merge", `Không conflict với ${base}`, "wait", noPr)
          : ctx.localConflicts.length
            ? auto("conflict", "merge", `Không conflict với ${base}`, "fail", conflictFix + files(ctx.localConflicts))
            : auto("conflict", "merge", `Không conflict với ${base}`, "ok", "Đã thử merge dưới máy (chưa có PR).")
        : facts.mergeable === "CONFLICTING"
          ? auto("conflict", "merge", `Không conflict với ${base}`, "fail", conflictFix)
          : facts.mergeable === "MERGEABLE"
            ? auto("conflict", "merge", `Không conflict với ${base}`, "ok")
            : auto("conflict", "merge", `Không conflict với ${base}`, "unknown", "GitHub chưa tính xong — mở lại sau ít phút."),
    );

    out.push(
      !facts
        ? auto("ci", "merge", "CI xanh", "wait", noPr)
        : !facts.ci
          ? auto("ci", "merge", "CI xanh", "unknown", "PR không có check nào")
          : facts.ci === "SUCCESS"
            ? auto("ci", "merge", "CI xanh", "ok")
            : facts.ci === "PENDING" || facts.ci === "EXPECTED"
              ? auto("ci", "merge", "CI xanh", "wait", "CI đang chạy")
              : auto("ci", "merge", "CI xanh", "fail", `CI: ${facts.ci}`),
    );
  }

  // Merge commit (feature → ctalk/develop) giữ nguyên từng commit, nên từng
  // commit phải đúng format. Squash thì chỉ commit cuối — kiểm ở hộp thoại.
  const squash = usesSquash(route, like);
  if (route === "integration" && !squash) {
    const bad = (facts?.commits ?? [])
      .map((m) => [m.split("\n")[0]!, commitProblem(m)] as const)
      .filter(([, p]) => p);
    out.push(
      !facts
        ? auto("commits", "merge", "Mọi commit đúng format `type(scope): mô tả`", "wait", noPr)
        : auto(
            "commits",
            "merge",
            "Mọi commit đúng format `type(scope): mô tả`",
            bad.length ? "fail" : "ok",
            bad.length
              ? bad.slice(0, 5).map(([h, p]) => `“${h}” — ${p}`).join("\n") + (bad.length > 5 ? `\n… và ${bad.length - 5} commit nữa` : "")
              : `${facts.commits.length} commit`,
          ),
    );
  }

  out.push(
    squash
      ? manual(
          "merge-method",
          "merge",
          "Bấm Squash and merge, sửa commit message trong hộp thoại đúng format",
          "Dùng commit message gợi ý ở đầu checklist: `type(scope): mô tả` ≤ 72 ký tự, không chấm cuối, dòng trống, `Ref: <mã task>`. Xoá danh sách `* commit…` GitHub điền sẵn.",
        )
      : manual("merge-method", "merge", "Bấm Merge commit (không squash)"),
  );

  /* ── Sau khi merge ────────────────────────────────────────────────── */

  if (work) {
    const throwaway = route === "parent" || kindOfBranch(head) === "resolve";
    out.push(
      throwaway
        ? !merged
          ? auto("delete-branch", "after", "Xoá nhánh ngay sau khi PR được merge", "wait", "PR chưa merge")
          : auto("delete-branch", "after", "Xoá nhánh ngay sau khi PR được merge", ctx.headGone ? "ok" : "fail", ctx.headGone ? undefined : `${head} vẫn còn trên GitHub`)
        : manual("keep-branch", "after", "Giữ nhánh đến khi code lên master mới xoá"),
    );
  }

  return out;
}

/** Đếm cho huy hiệu trên bậc: mục đã xong / tổng số mục. */
export function checklistProgress(items: CheckItem[], ticked: ReadonlySet<string>): {
  done: number;
  total: number;
  failing: number;
} {
  let done = 0;
  let failing = 0;
  for (const i of items) {
    if (i.kind === "manual") done += ticked.has(i.id) ? 1 : 0;
    else if (i.state === "ok") done++;
    else if (i.state === "fail") failing++;
  }
  return { done, total: items.length, failing };
}
