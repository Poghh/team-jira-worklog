/**
 * Quy tắc Git của team, đọc thành hàm: đặt tên nhánh, và sync `master` về
 * nhánh đang làm bằng rebase hay merge.
 *
 * Nguồn là trang Confluence "Git & Task Management Rules" (space VipTalk) —
 * mục 1 cho tên nhánh, mục 2 cho cách sync, mục 5 cho nhánh resolve. Đổi quy
 * tắc ở đó thì đổi ở đây; test trong `tests/branches.mts` ghim từng dòng của
 * bảng.
 *
 * Toàn hàm thuần, không chạm mạng hay database, để chạy được cả ở trình duyệt
 * (đổi team là tính lại ngay) lẫn trong test.
 */

/** Đoạn thứ hai của tên nhánh: `ctalk/<kind>/…`. */
export type BranchKind = "feature" | "bugfix" | "task" | "hotfix" | "resolve";

/** Prefix team mà tài liệu liệt kê. HIR cũng PR vào `ctalk/develop`. */
export const TEAMS = ["ctalk", "hir"] as const;

/** Một issue Jira, chỉ những gì tên nhánh cần. */
export interface IssueLite {
  key: string;
  summary: string;
  /** Tên issue type như Jira gọi: `Story`, `Bug`, `Improve`, `Sub-task`… */
  type: string;
  subtask: boolean;
  parent: { key: string; summary: string; type: string } | null;
  /**
   * FR (Epic) chứa issue — chỉ với issue thường (không phải sub-task). Có thì
   * gợi ý thêm nhánh task con của nhánh feature của FR.
   */
  epic?: { key: string; summary: string } | null;
}

/** Một tên nhánh gợi ý, kèm nơi tách và nơi PR vào để người đọc khỏi tra lại. */
export interface BranchSuggestion {
  name: string;
  /** Nói nhánh này là gì: "Task con", "Bugfix"… */
  label: string;
  /** Tách từ nhánh nào. */
  from: string;
  /** PR vào nhánh nào. */
  into: string;
  /** Lệnh tạo nhánh, copy là chạy được. */
  command: string;
}

/** Từ đệm tiếng Anh — bỏ khỏi mô tả nhánh, không thì 4 từ hay cụt ở `for`, `the`. */
const SLUG_STOP = new Set(["a", "an", "the", "for", "of", "to", "in", "on", "at", "by", "with", "from", "and", "or"]);

/**
 * Mô tả ngắn trong tên nhánh: viết thường, không dấu, nối bằng `-`.
 *
 * Bỏ phần trong ngoặc vuông (`[CTALK][spt 69]`) vì đó là nhãn để lọc backlog,
 * không phải mô tả; bỏ `CLONE -` Jira gắn khi nhân bản ticket; bỏ từ đệm tiếng
 * Anh. Đếm theo từ của câu — `Per-request` là một từ — và cắt ở
 * {@link maxWords}: tài liệu ví dụ `video-call`, `call-ui` — mô tả *ngắn*,
 * người dùng sửa thêm nếu muốn.
 */
export function branchSlug(text: string, maxWords = 4): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/^\s*clone\s*-\s*/i, "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((w) => w && !SLUG_STOP.has(w))
    .slice(0, maxWords)
    .join("-");
}

/**
 * Loại nhánh cho một issue type của Jira.
 *
 * Jira ở đây có `Story`, `Bug`, `Improve`, `Task`, `Sub-task`, `Epic`. Tài liệu
 * gọi theo loại task: Feature, Bug, Improve. `Task` thường không phải tính
 * năng mới nên đi chung đường với Improve (`task/`). Hotfix không có issue
 * type riêng — đó là quyết định "lỗi production, đi thẳng staging", nên chỉ
 * xuất hiện như một lựa chọn thêm cạnh Bug.
 */
export function kindOfType(type: string): "feature" | "bugfix" | "task" {
  const t = type.trim().toLowerCase();
  if (/bug|defect|lỗi/.test(t)) return "bugfix";
  if (/story|feature|epic|tính năng/.test(t)) return "feature";
  return "task";
}

/** `ctalk/develop` → `ctalk-develop`: tên nhánh đích không được tạo thêm cấp thư mục. */
export function flatBranch(name: string): string {
  return name.trim().replace(/\//g, "-");
}

/**
 * Tên nhánh theo bảng ở mục 1.
 *
 * Chỉ nhánh `feature` mang mô tả; bugfix, hotfix, task dùng đúng mã task.
 * Task con không có mã thì lấy mã nhánh cha kèm mô tả.
 */
export function branchName(
  team: string,
  kind: Exclude<BranchKind, "resolve">,
  key: string,
  summary = "",
): string {
  const k = key.trim().toUpperCase();
  const slug = branchSlug(summary);
  const tail = kind === "feature" && slug ? `${k}_${slug}` : k;
  return `${team}/${kind}/${tail}`;
}

/** Nhánh resolve của mục 5: chỉ mã task, cộng tên nhánh đích đã làm phẳng. */
export function resolveBranchName(team: string, key: string, target: string): string {
  return `${team}/resolve/${key.trim().toUpperCase()}_${flatBranch(target)}`;
}

/** Mã task đầu tiên trong tên nhánh, `""` khi không có. */
export function keyInBranch(branch: string): string {
  return branch.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? "";
}

/** Đoạn loại của một tên nhánh theo quy ước, `null` khi không theo quy ước. */
export function kindOfBranch(branch: string): BranchKind | null {
  const seg = branch.split("/").map((s) => s.trim().toLowerCase())[1];
  return seg === "feature" ||
    seg === "bugfix" ||
    seg === "task" ||
    seg === "hotfix" ||
    seg === "resolve"
    ? seg
    : null;
}

/** Lệnh tạo nhánh từ origin mới nhất. */
export const createCmd = (name: string, from: string) =>
  `git fetch origin\ngit checkout -b ${name} origin/${from}`;

/**
 * Các tên nhánh hợp lệ cho một issue, cái nên dùng đứng đầu.
 *
 * Issue thường: một nhánh chính tách từ `master`, PR vào môi trường tích hợp
 * (`ctalk/develop`). Bug có thêm lựa chọn hotfix vào `staging`.
 *
 * Sub-task: hai cách đều đúng quy tắc, nên đưa cả hai —
 *   - nhánh task con `<team>/task/<MÃ>`, tách từ nhánh cha và PR vào nhánh cha;
 *   - làm thẳng trên nhánh cha, khi task cha chỉ có mình việc này.
 * Cha là feature thì task con đứng đầu: feature là chỗ nhiều task con gom
 * lại. Cha là bug/improve thì nhánh cha đứng đầu, như ví dụ VT-245 của tài
 * liệu — một bug hiếm khi tách ra nhiều nhánh.
 */
export function branchSuggestions(
  team: string,
  issue: IssueLite,
  envs: { integration: string; hotfix: string; trunk: string },
): BranchSuggestion[] {
  const { integration, hotfix, trunk } = envs;
  const own = (key: string, type: string, summary: string): BranchSuggestion[] => {
    const kind = kindOfType(type);
    const label = kind === "feature" ? "Feature" : kind === "bugfix" ? "Bugfix" : "Improve / task";
    const name = branchName(team, kind, key, summary);
    const out: BranchSuggestion[] = [
      { name, label, from: trunk, into: integration, command: createCmd(name, trunk) },
    ];
    if (kind === "bugfix") {
      const hot = branchName(team, "hotfix", key);
      out.push({
        name: hot,
        label: "Hotfix (lỗi production)",
        from: trunk,
        into: hotfix,
        command: createCmd(hot, trunk),
      });
    }
    return out;
  };

  if (!issue.subtask || !issue.parent) {
    const mine = own(issue.key, issue.type, issue.summary);
    if (kindOfType(issue.type) === "feature") {
      // Feature: nhánh feature và một nhánh task làm việc trên nó. Ticket con
      // của FR là để logwork cho chuẩn, không phải mỗi ticket một nhánh — nên
      // không liệt kê theo ticket. Tên theo mẫu task con không mã của mục 1:
      // `<team>/task/<MÃ-CHA>_<mo-ta-ngan>`.
      const fb = mine[0]!.name;
      const task = `${team}/task/${issue.key.trim().toUpperCase()}_mo-ta-ngan`;
      return [
        ...mine,
        {
          name: task,
          label: "Task trên nhánh feature",
          from: fb,
          into: fb,
          command: createCmd(task, fb),
        },
      ];
    }
    const epic = issue.epic;
    if (!epic || epic.key === issue.key) return mine;
    // Việc thuộc một FR: làm thành task con của nhánh feature của FR (tách từ
    // nhánh đó, PR vào nhánh đó) — mục 1, "Task con (của feature…)".
    const frBranch = branchName(team, "feature", epic.key, epic.summary);
    const child = branchName(team, "task", issue.key);
    const sub: BranchSuggestion = {
      name: child,
      label: `Task con của FR ${epic.key}`,
      from: frBranch,
      into: frBranch,
      command: createCmd(child, frBranch),
    };
    // Improve/task trong một FR gần như luôn đi vào nhánh feature. Bug và
    // story thì hay đứng riêng (bug của phần đã release, story là feature).
    return kindOfType(issue.type) === "task" ? [sub, ...mine] : [...mine, sub];
  }

  const parent = own(issue.parent.key, issue.parent.type, issue.parent.summary);
  const parentBranch = parent[0]!.name;
  const child = branchName(team, "task", issue.key);
  const sub: BranchSuggestion = {
    name: child,
    label: `Task con của ${issue.parent.key}`,
    from: parentBranch,
    into: parentBranch,
    command: createCmd(child, parentBranch),
  };
  const onParent = parent.map((s) => ({ ...s, label: `${s.label} của ${issue.parent!.key} (làm thẳng trên nhánh cha)` }));
  return kindOfType(issue.parent.type) === "feature" ? [sub, ...onParent] : [...onParent, sub];
}

/** Đoán team từ những nhánh người dùng đang có — đa số thắng, mặc định `ctalk`. */
export function guessTeam(branches: string[]): string {
  const count = new Map<string, number>();
  for (const b of branches) {
    const head = b.split("/")[0]?.trim().toLowerCase() ?? "";
    if ((TEAMS as readonly string[]).includes(head)) count.set(head, (count.get(head) ?? 0) + 1);
  }
  let best = "ctalk";
  let n = 0;
  for (const [team, c] of count) if (c > n) [best, n] = [team, c];
  return best;
}

/* ── Sync master về nhánh (mục 2) ────────────────────────────────────── */

export type SyncAction =
  /** Chưa từng vào môi trường nào: rebase lên master. */
  | "rebase"
  /** Đã merge vào môi trường: rebase sẽ viết lại lịch sử người khác đã có. */
  | "merge"
  /** Task con đang mở PR vào nhánh cha: không sync master, merge vào cha trước. */
  | "into-parent"
  /** Nhánh cha còn task con đang mở PR vào nó. */
  | "wait-children";

export interface SyncAdvice {
  action: SyncAction;
  /** Nhãn ngắn trên card. */
  title: string;
  /** Vì sao — câu tooltip, trích luật của tài liệu. */
  why: string;
  /** Lệnh copy là chạy được; rỗng khi việc cần làm là đợi. */
  commands: string;
}

export interface SyncInput {
  branch: string;
  /** Commit của `base` mà nhánh chưa có. */
  behind: number | null | undefined;
  /** Nhánh gốc đã so, thường `master`. */
  base: string;
  /** PR của chính nhánh này. */
  prs: ReadonlyArray<{ base: string; state: string }>;
  /** Các nhánh môi trường, thứ tự từ gần tới xa — đầu tiên là `ctalk/develop`. */
  envBranches: readonly string[];
  /** Môi trường mà nội dung nhánh đã tới (`hasArrived`). */
  arrivedEnvs: readonly string[];
  /** Số PR **đang mở** của nhánh khác nhắm vào nhánh này. */
  openChildPrs: number;
}

/**
 * Nên rebase hay merge `master` về nhánh này — `null` khi không có gì phải làm.
 *
 * Thứ tự của luật: task con merge **hết** vào nhánh cha trước, rồi nhánh cha
 * mới rebase hoặc merge master. Task con không sync master, cũng không rebase
 * từ nhánh cha (người dùng chốt 15/11/2026). Xét theo thứ tự:
 *   1. Nhánh resolve: dùng một lần rồi bỏ, không sync.
 *   2. Task con — có PR **đang mở** vào một nhánh không phải môi trường, không
 *      phải master: không sync, merge vào nhánh cha trước.
 *   3. Còn task con đang mở PR vào nhánh này: đợi merge hết, kể cả khi nhánh
 *      đã vào môi trường.
 *   4. Đã vào môi trường (PR đã merge, hoặc nội dung đã tới): merge, không
 *      rebase — rebase thì commit đổi SHA, môi trường giữ bản cũ, lần PR sau
 *      thành một đống commit trùng.
 *   5. Còn lại: rebase master.
 *
 * Bỏ qua nhánh không theo quy ước tên? Không — card trên board là nhánh của
 * chính người dùng, và luật rebase/merge không phụ thuộc cái tên.
 */
export function syncAdvice(input: SyncInput): SyncAdvice | null {
  const { branch, behind, prs, envBranches, arrivedEnvs, openChildPrs } = input;
  const base = input.base || "master";
  if (!branch.trim() || !behind || behind <= 0) return null;
  if (kindOfBranch(branch) === "resolve") return null;

  const envs = new Set(envBranches);
  const parentPr = prs.find(
    (p) => p.base && !envs.has(p.base) && p.base !== base && (p.state === "OPEN" || p.state === "MERGED"),
  );
  if (parentPr && parentPr.state === "OPEN")
    return {
      action: "into-parent",
      title: "Merge vào nhánh cha trước",
      why:
        `Task con: không sync ${base}. Theo luật, task con merge hết vào ${parentPr.base} trước, ` +
        `rồi nhánh cha mới rebase hoặc merge ${base}. Chỉ khi PR vào nhánh cha bị conflict thì mới ` +
        `rebase/merge nhánh cha vào task con.`,
      commands: "",
    };

  const mergedInto =
    prs.find((p) => p.state === "MERGED" && envs.has(p.base))?.base ??
    envBranches.find((e) => arrivedEnvs.includes(e));
  if (openChildPrs > 0)
    return {
      action: "wait-children",
      title: `Đợi ${openChildPrs} task con merge`,
      why:
        `Còn ${openChildPrs} PR task con đang mở vào nhánh này: chưa sync ${base}. ` +
        `Đợi merge hết task con rồi mới ${mergedInto ? "merge" : "rebase"} ${base}. ` +
        `Ngoại lệ: task con cần code mới của ${base}, hoặc kéo dài qua nhiều lần release — ` +
        `được merge ${base} vào nhánh cha khi Tech Lead hoặc Team Lead đồng ý.`,
      commands: "",
    };

  if (mergedInto)
    return {
      action: "merge",
      title: `Merge ${base}`,
      why:
        `Nhánh đã vào ${mergedInto} — rebase sẽ đổi SHA của những commit môi trường đã giữ. ` +
        `Theo quy tắc: đã merge vào ${envBranches[0] ?? mergedInto} thì merge ${base}, không rebase.`,
      commands: `git fetch origin\ngit merge origin/${base}\ngit push`,
    };

  return {
    action: "rebase",
    title: `Rebase ${base}`,
    why:
      `Nhánh chưa từng merge vào ${envBranches[0] ?? "môi trường"} nên rebase lên ${base}. ` +
      `Chỉ rebase nhánh của chính mình; dùng --force-with-lease, không dùng --force.`,
    commands: `git fetch origin\ngit rebase origin/${base}\ngit push --force-with-lease`,
  };
}

/** Câu ngắn đứng cạnh nhãn: "tụt 29 commit so với master". */
export function behindText(behind: number, base: string): string {
  return `tụt ${behind} commit so với ${base || "master"}`;
}
