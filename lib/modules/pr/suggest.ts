/**
 * Gợi ý tiêu đề PR đúng format của "Git & Task Management Rules" mục 4 — để
 * người dùng đối chiếu ở mục "Tiêu đề đúng format" của checklist. App không
 * tạo PR, không điền gì sẵn lên GitHub.
 *
 * Hàm thuần. Thân tiêu đề lấy từ summary của FR (Epic Jira) mà việc thuộc
 * về; không có FR thì từ summary task. Không lấy từ tên nhánh: tên nhánh chỉ
 * còn mã task (bugfix, hotfix, improve) hoặc một slug không dấu, còn tiêu đề PR
 * là câu người đọc review nhìn thấy đầu tiên.
 */

import { kindOfBranch } from "@/lib/modules/branches/git-rules";

import { type PrRoute, envTitlePrefix, parentTitlePrefix } from "./checklist";

/** Một task Jira mà PR này nói tới. */
export interface IssueRef {
  key: string;
  /** `""` khi Jira không trả lời được. */
  summary: string;
  url: string;
  /** Loại issue trên Jira (`Bug`, `Task`, `Sub-task`…); vắng khi chưa đọc được. */
  type?: string;
}

/** Loại Jira là bug (`Bug`, `Sub-bug`, `Bug QC`…). */
export const isBugType = (type?: string) => /bug/i.test(type ?? "");

/**
 * Task bug đầu tiên của PR — có thì tiêu đề lấy tên task đó chứ không lấy FR:
 * PR sửa một lỗi QC báo trong FR, tên FR không nói gì về lỗi được sửa.
 */
export function bugIssue(issues: IssueRef[]): IssueRef | null {
  return issues.find((i) => isBugType(i.type) && i.summary) ?? null;
}

/**
 * Summary Jira thành phần thân tiêu đề PR.
 *
 * Bỏ các thẻ đầu `[CTALK]`, `[iOS]`: tiêu đề PR có prefix riêng của nó, giữ
 * thêm thẻ của Jira thành `[CTalk] [CTALK] …`. Bỏ dấu chấm cuối.
 */
export function cleanSummary(summary: string): string {
  return summary
    .replace(/^\s*(\[[^\]]*\]\s*)+/, "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/, "")
    .trim();
}

const ddmmyyyy = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

type TitleInput = {
  issues: IssueRef[];
  /** Thân tiêu đề chọn sẵn (vd. từ commit) — có thì bỏ qua Jira. */
  text?: string;
  /** Loại commit chọn sẵn (`fix`, `feat`…) — từ commit conventional. */
  type?: string;
  feature?: { key: string; summary: string } | null;
  fallback?: string;
};

/** Thân tiêu đề (task bug, rồi FR, rồi summary task, rồi tiêu đề card) và các mã task. */
function titleParts(input: TitleInput): { text: string; keys: string[] } {
  const text =
    (input.text ?? "").trim() ||
    cleanSummary(bugIssue(input.issues)?.summary ?? "") ||
    cleanSummary(input.feature?.summary ?? "") ||
    cleanSummary(input.issues.find((i) => i.summary)?.summary ?? "") ||
    cleanSummary(input.fallback ?? "") ||
    "<Tiêu đề>";
  // Không có mã task riêng thì dùng mã FR — vẫn trỏ được về Jira.
  const own = input.issues.map((i) => i.key).filter(Boolean);
  const keys = own.length ? own : input.feature?.key ? [input.feature.key] : [];
  return { text, keys };
}

/**
 * Commit message cho hộp thoại "Squash and merge" (mục 3):
 * `type: mô tả` ≤ 72 ký tự, dòng trống, `Ref: <mã>`.
 *
 * `type` theo loại nhánh của việc — PR task con vào nhánh cha thì theo nhánh
 * cha: feature → `feat`, bugfix/hotfix → `fix`. Nhánh task (improve) không
 * nói được là feat hay refactor: mô tả bắt đầu bằng "Fix/Sửa" thì `fix`, còn
 * lại `refactor` — người merge sửa nếu cần. Task là Bug trên Jira thì luôn
 * `fix`. Không đoán scope.
 */
export function suggestSquashMessage(
  input: TitleInput & { route: PrRoute; head: string; parentBranch?: string },
): string {
  const { text, keys } = titleParts(input);
  const kind = kindOfBranch(input.route === "parent" ? (input.parentBranch ?? input.head) : input.head);
  // Task bug thì là sửa lỗi, dù nó đi vào nhánh feature.
  const type = input.type
    ? input.type
    : input.issues.some((i) => isBugType(i.type))
    ? "fix"
    : kind === "feature"
      ? "feat"
      : kind === "bugfix" || kind === "hotfix" || /^(fix|sửa)\b/i.test(text)
        ? "fix"
        : kind === "task"
          ? "refactor"
          : "feat";
  let subject = `${type}: ${text}`;
  if (subject.length > 72) {
    const cut = subject.slice(0, 72);
    subject = cut.slice(0, cut.lastIndexOf(" ") > type.length + 2 ? cut.lastIndexOf(" ") : 72);
  }
  subject = subject.replace(/[\s.,;:–-]+$/, "");
  return keys.length ? `${subject}\n\nRef: ${keys.join(", ")}` : subject;
}

/**
 * Tiêu đề PR gợi ý cho một đường.
 *
 * Thiếu mã task ở đường bắt buộc có mã thì để `VT-…` cho lộ ra, không bỏ
 * trống — tiêu đề thiếu mã là tiêu đề sai, và checklist sẽ đánh ✗.
 */
export function suggestPrTitle(input: {
  route: PrRoute;
  head: string;
  base: string;
  parentBranch?: string;
  issues: IssueRef[];
  /** FR (Epic Jira) của việc — có thì thân tiêu đề lấy summary của FR. */
  feature?: { key: string; summary: string } | null;
  /** Thân tiêu đề khi Jira không có summary — thường là tiêu đề card. */
  fallback?: string;
  /** Thân tiêu đề chọn sẵn (từ commit) — có thì bỏ qua Jira. */
  text?: string;
  date?: Date;
}): string {
  const { route, head, base, issues } = input;
  if (route === "env")
    return `${envTitlePrefix(base)} ${head} → ${base} ${ddmmyyyy(input.date ?? new Date())}`;

  const { text, keys } = titleParts(input);
  const tail = keys.length ? ` (${keys.join(", ")})` : "";

  switch (route) {
    case "integration":
      return `[CTalk] ${text}${tail || " (VT-…)"}`;
    case "hotfix":
      return `[Staging][Hotfix] ${text}${tail || " (VT-…)"}`;
    case "parent":
      // Task con không có mã riêng thì tiêu đề không cần mã (mục 4).
      return `${parentTitlePrefix(input.parentBranch ?? base)} ${text}${tail}`;
  }
}

/**
 * Khung mô tả PR theo cách team đang viết (vd. PR iOS #1942 thay bằng PR
 * resolve): mục **Summaries** — dòng `Jira:` gom mọi task, `Replaces #…` khi
 * là nhánh resolve, rồi các thay đổi; mục **SDK Reference** — PR SDK đi kèm và
 * phiên bản `MatrixRustSDK`, chỉ ở repo có SDK.
 *
 * Thay đổi lấy từ commit; không có thì để một dòng chờ người viết điền. PR môi
 * trường gom nhiều task mà app không có đủ danh sách nên không gợi ý — `""`.
 */
export function suggestPrBody(input: {
  route: PrRoute;
  head: string;
  issues: IssueRef[];
  feature?: IssueRef | null;
  /** PR SDK đi kèm, dạng `owner/repo#496` — GitHub tự hiện tiêu đề. */
  sdkPrs?: string[];
  /** `MatrixRustSDK` ở nhánh nguồn; `null` khi repo không dùng SDK. */
  sdkVersion?: string | null;
  /** Các thay đổi — từ commit ({@link changesFromCommits}) hoặc Claude đọc diff. */
  changes?: string[];
}): string {
  if (input.route === "env") return "";
  const link = (i: IssueRef) => `[${i.key}](${i.url})`;
  const tasks = input.issues.filter((i) => i.key);
  const fr = input.feature && !tasks.some((i) => i.key === input.feature!.key) ? input.feature : null;

  const out = ["## Summaries", ""];
  if (tasks.length) out.push(`- Jira: ${tasks.map(link).join(", ")}`);
  if (fr) out.push(`- FR: ${link(fr)}${cleanSummary(fr.summary) ? ` — ${cleanSummary(fr.summary)}` : ""}`);
  // `<team>/resolve/…` theo mục 5, hoặc kiểu cũ còn gặp `ctalk/task/resolve_VTL-286_…`.
  if (kindOfBranch(input.head) === "resolve" || /^resolve[_-]/i.test(input.head.split("/").pop() ?? ""))
    out.push("- Replaces #… (review threads answered there)");
  const changes = input.changes ?? [];
  out.push(...(changes.length ? changes.map((c) => `- ${c}`) : ["- <thay đổi chính, mỗi dòng một ý>"]));

  const sdkPrs = input.sdkPrs ?? [];
  if (sdkPrs.length || input.sdkVersion) {
    out.push("", "## SDK Reference", "");
    out.push(...sdkPrs.map((r) => `- ${r}`));
    if (input.sdkVersion) out.push(`- MatrixRustSDK \`${input.sdkVersion}\``);
  }
  return out.join("\n");
}

/**
 * Danh sách thay đổi từ commit message: dòng đầu mỗi commit, bỏ `type(scope):`
 * và mã task ở đầu (`VT-5225 | VT-5660 | …`), bỏ commit merge, bỏ trùng.
 * Thân commit có gạch đầu dòng (không phải `Ref:`) thì lấy thêm các dòng đó.
 */
/** Một dòng commit thành câu mô tả: bỏ `type(scope):`, mã task, chấm cuối; viết hoa đầu. */
function commitLine(line: string): string {
  const t = line
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")
    .replace(/^(\s*[A-Z][A-Z0-9]+-\d+\s*[|,:]?\s*)+/, "")
    .replace(/^[|:\-–]\s*/, "")
    .replace(/\s*\((?:[A-Z][A-Z0-9]+-\d+[,\s]*)+\)\s*$/, "")
    .replace(/[.。]+$/, "")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

const isMergeCommit = (subject: string) => /^Merge (branch|pull request|remote-tracking|commit)\b/i.test(subject);

/**
 * Thân tiêu đề lấy từ commit, cho khi summary Jira là lời tả triệu chứng
 * ("Verify FaceID 3 lần mới vào được Homechat…") chứ không phải việc đã sửa.
 *
 * Commit `fix:`/`feat:` đầu tiên (GitHub trả commit cũ trước — commit đầu là
 * việc chính, sau đó là sửa review), không có thì commit đầu tiên. `type` là
 * loại conventional của commit đó, `""` khi commit không viết theo mục 3.
 */
export function commitHeadline(messages: string[]): { text: string; type: string } | null {
  const subjects = messages.map((m) => m.split("\n")[0] ?? "").filter((s) => s.trim() && !isMergeCommit(s));
  const pick = subjects.find((s) => /^(fix|feat)(\([^)]*\))?!?:/i.test(s)) ?? subjects[0];
  if (!pick) return null;
  const text = commitLine(pick);
  if (!text) return null;
  const type = pick.match(/^([a-z]+)(\([^)]*\))?!?:/i)?.[1]?.toLowerCase() ?? "";
  return { text, type };
}

export function changesFromCommits(messages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (line: string) => {
    const text = commitLine(line);
    if (!text) return;
    const k = text.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(text);
  };
  for (const m of messages) {
    const [subject = "", ...rest] = m.split("\n");
    if (isMergeCommit(subject)) continue;
    add(subject);
    for (const l of rest) {
      const b = l.match(/^\s*[-*•]\s+(.*)$/);
      if (b && !/^Ref:/i.test(b[1])) add(b[1]);
    }
  }
  return out;
}
