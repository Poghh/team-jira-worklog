"use server";

import type { ActionResult } from "@/app/actions";
import { getFeatureOf, getIssueStatuses } from "@/lib/jira/issues";
import { getGitHubConfig, getStages } from "@/lib/modules/branches/config";
import { keyInBranch } from "@/lib/modules/branches/git-rules";
import { fetchBranchNames, fetchCompare, fetchPrChecklist } from "@/lib/modules/branches/github";
import { summarizeChanges } from "@/lib/ai/claude";
import { envSteps } from "@/lib/modules/branches/model";
import { getTaskNote } from "@/lib/modules/branches/store";
import {
  type CheckItem,
  type PrRoute,
  buildChecklist,
  type ResolvePlan,
  envHead,
  isResolveBranch,
  originOfResolve,
  resolvePlan,
  isUncountedFile,
  labelAdvice,
  routeOf,
  titlePattern,
  usesSquash,
} from "@/lib/modules/pr/checklist";
import { getPrChecks, setPrCheck } from "@/lib/modules/pr/store";
import { getReviewConfig } from "@/lib/modules/code-review/config";
import { conflictFiles, withRepoLock } from "@/lib/modules/code-review/git";
import {
  type IssueRef,
  changesFromCommits,
  suggestPrBody,
  suggestPrTitle,
  suggestSquashMessage,
} from "@/lib/modules/pr/suggest";
import { isModuleEnabled } from "@/lib/modules/state";
import { SETTING_KEYS, getSetting } from "@/lib/settings";

/** Một PR `head → base`, như trình duyệt cần để vẽ. */
export interface PrGuideView {
  repo: string;
  route: PrRoute;
  head: string;
  base: string;
  items: CheckItem[];
  ticked: string[];
  pr: { number: number; url: string; state: string } | null;
  /** Tiêu đề PR gợi ý từ summary Jira — luôn hiện ở đầu checklist. */
  suggestedTitle: string;
  /** FR (Epic Jira) mà thân tiêu đề gợi ý lấy từ; `null` khi không tìm được. */
  feature: { key: string; summary: string; url: string } | null;
  /**
   * Đầu vào của khung mô tả PR (`suggestPrBody`) — trình duyệt tự dựng lại khi
   * người dùng đổi danh sách thay đổi (vd. nhờ Claude đọc diff). `null` khi
   * không gợi ý mô tả (PR môi trường).
   */
  body: Parameters<typeof suggestPrBody>[0] | null;
  /**
   * Conflict với nhánh đích — từ PR (GitHub) hoặc thử merge dưới máy khi chưa
   * có PR. `resolve` là nhánh resolve theo mục 5 (`null` khi đường này xử lý
   * conflict cách khác). `null` cả cụm khi không conflict hoặc chưa biết.
   */
  conflict: { files: string[]; local: boolean; resolve: ResolvePlan | null } | null;
  /** Commit message cho hộp thoại Squash and merge; `null` khi PR này dùng Merge commit. */
  squashMessage: string | null;
  /** Mẫu tiêu đề của đường này. */
  titleSample: string;
  /** Label cần gắn (mục 6) — `label: null` là không gắn, `note` nói vì sao. */
  label: { label: string | null; note: string };
}

/**
 * Checklist cho một PR `head → base`.
 *
 * Đọc GitHub lúc người dùng mở, không chạy nền: chỉ một PR, và chỉ khi có
 * người nhìn. Chỉ đọc — app không tạo PR, không gắn label, không ghi Jira;
 * người dùng tự làm trên GitHub và dùng checklist để soát từng mục.
 *
 * `branch` là nhánh của việc (của card, hoặc gõ tay). Đích là môi trường sau
 * `ctalk/develop` thì nguồn của PR là môi trường đứng trước, không phải nhánh
 * của việc — theo sơ đồ, đó là PR của Tech Lead gom nhiều task.
 */
export async function prGuideAction(input: {
  repo: string;
  branch: string;
  base: string;
  /** Card của module Nhánh — có thì lấy mã task, link Jira và độ tụt master từ đó. */
  cardId?: number;
}): Promise<ActionResult & { view?: PrGuideView }> {
  if (!isModuleEnabled("pr")) return { ok: false, message: "Module Git & PR đang tắt" };
  const repo = input.repo.trim();
  const branch = input.branch.trim();
  const base = input.base.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, message: "Repo phải có dạng owner/name" };
  if (!branch || !base) return { ok: false, message: "Cần nhánh nguồn và nhánh đích" };
  if (branch === base) return { ok: false, message: "Nhánh nguồn trùng nhánh đích" };

  const cfg = getGitHubConfig();
  if (!cfg.token) return { ok: false, message: "Chưa có GitHub token — vào Settings của module Nhánh" };

  const envs = envSteps(getStages()).map((s) => s.branch);
  // Nhánh resolve đi đường của nhánh gốc (hotfix resolve vẫn là hotfix vào
  // staging) và giữ label, cách merge của nó. Tìm nhánh gốc trên GitHub.
  const origin = isResolveBranch(branch)
    ? originOfResolve(branch, await fetchBranchNames(cfg.token, repo).catch(() => []))
    : "";
  const route = routeOf(origin || branch, base, envs);
  const head = route === "env" && !envs.includes(branch) ? envHead(base, envs) : branch;
  if (!head) return { ok: false, message: `Không biết nhánh nào PR vào ${base}` };

  const card = input.cardId ? getTaskNote(input.cardId) : null;
  const side = card?.sides.find((s) => s.repo === repo && s.branch.trim() === branch);
  const jiraBase = getSetting(SETTING_KEYS.jiraBaseUrl)?.replace(/\/+$/, "") ?? "";
  const urlOf = (key: string, jiraUrls: Record<string, string> = {}) =>
    jiraUrls[key] || `${jiraBase}/browse/${key}`;

  // Mã task của PR. PR môi trường gom nhiều task, không có mã riêng.
  const keys =
    route === "env" ? [] : card?.issueKeys.length ? card.issueKeys : [keyInBranch(branch)].filter(Boolean);
  let issues: IssueRef[] = keys.map((k) => ({ key: k, summary: "", url: urlOf(k, card?.jiraUrls) }));

  // Summary thật từ Jira — Jira hỏng thì vẫn gợi ý được, chỉ là bằng tiêu đề card.
  let feature: { key: string; summary: string } | null = null;
  if (getSetting(SETTING_KEYS.jiraApiToken)) {
    if (issues.length) {
      const found = await getIssueStatuses(issues.map((i) => i.key)).catch(
        () => ({}) as Record<string, { summary: string }>,
      );
      issues = issues.map((i) => ({ ...i, summary: found[i.key]?.summary ?? "" }));
    }
    // FR (Epic) của việc: từ mã task, hoặc — task con không mã — từ nhánh cha.
    const frFrom = route === "env" ? [] : [...keys, route === "parent" ? keyInBranch(base) : ""].filter(Boolean);
    if (frFrom.length) feature = await getFeatureOf(frFrom).catch(() => null);
  }

  try {
    const frRef = feature ? { ...feature, url: urlOf(feature.key, card?.jiraUrls) } : null;
    const gh = await fetchPrChecklist(cfg.token, repo, head, base);
    // Chưa có PR thì GitHub không nói gì về conflict: thử merge trong clone
    // review của module Code review (cùng repo), nếu có. Không có clone hay
    // git lỗi thì để trống — checklist hiện "chưa kiểm được".
    let localConflicts: string[] | undefined;
    if (!gh.facts && gh.headExists && route !== "env") {
      const clone = getReviewConfig().repos.find((r) => r.githubRepo === repo)?.localPath;
      if (clone)
        localConflicts = await withRepoLock(clone, () => conflictFiles(clone, base, head)).catch(() => undefined);
    }
    // Commit của PR; chưa có PR thì so nhánh như trang compare của GitHub.
    // Chưa có PR thì so nhánh như trang compare của GitHub: commit và file.
    const compare = !gh.facts && gh.headExists ? await fetchCompare(cfg.token, repo, base, head).catch(() => null) : null;
    const commits = route === "env" ? [] : (gh.facts?.commits ?? compare?.commits ?? []);
    // PR có đổi project.yml không. Danh sách file bị GitHub cắt (100 file của
    // PR, 300 của compare) thì không kết luận được — để trống.
    const paths = gh.facts
      ? gh.facts.changedFiles > gh.facts.files.length
        ? null
        : gh.facts.files.map((f) => f.path)
      : compare && compare.files.length < 300
        ? compare.files.map((f) => f.path)
        : null;
    const sdkChanged = paths ? paths.some((p) => /(^|\/)project\.yml$/.test(p)) : undefined;
    const pair = { repo, head, base };
    const ctx = {
      repo,
      head,
      base,
      route,
      // PR môi trường không phải việc của nhánh card: độ tụt master của nhánh
      // card không nói gì về nó.
      behind: route === "env" ? null : (side?.behind ?? null),
      sdkVersion: gh.sdkVersion,
      issueKeys: issues.map((i) => i.key),
      parentBranch: route === "parent" ? base : undefined,
      headGone: !gh.headExists,
      localConflicts,
      originBranch: origin || undefined,
      sdkChanged,
    };
    const conflicting = gh.facts ? gh.facts.mergeable === "CONFLICTING" : Boolean(localConflicts?.length);
    return {
      ok: true,
      message: "",
      view: {
        repo,
        route,
        head,
        base,
        items: buildChecklist(ctx, gh.facts),
        ticked: getPrChecks(pair),
        pr: gh.facts ? { number: gh.facts.number, url: gh.facts.url, state: gh.facts.state } : null,
        suggestedTitle: suggestPrTitle({
          route,
          head,
          base,
          parentBranch: ctx.parentBranch,
          issues,
          feature,
          fallback: card?.title,
        }),
        feature: frRef,
        conflict: conflicting
          ? { files: localConflicts ?? [], local: !gh.facts, resolve: resolvePlan(ctx) }
          : null,
        squashMessage: usesSquash(route, origin || head)
          ? suggestSquashMessage({ route, head: origin || head, parentBranch: ctx.parentBranch, issues, feature, fallback: card?.title })
          : null,
        body:
          route === "env"
            ? null
            : {
                route,
                head,
                issues,
                feature: frRef,
                sdkPrs: sdkPrsOf(card, repo, base),
                sdkVersion: gh.sdkVersion,
                changes: changesFromCommits(commits),
              },
        titleSample: titlePattern(ctx).sample,
        label: labelAdvice(route, head, origin || undefined),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Không đọc được GitHub" };
  }
}

/** Tick hoặc bỏ tick một mục tay. Lưu theo cặp `repo + head + base`. */
export async function togglePrCheckAction(input: {
  repo: string;
  head: string;
  base: string;
  item: string;
  done: boolean;
}): Promise<ActionResult & { ticked?: string[] }> {
  if (!isModuleEnabled("pr")) return { ok: false, message: "Module Git & PR đang tắt" };
  try {
    return {
      ok: true,
      message: "",
      ticked: setPrCheck({ repo: input.repo, head: input.head, base: input.base }, input.item, input.done),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Không lưu được" };
  }
}

/** Nhánh của một repo cho ô chọn base/compare. Chỉ đọc GitHub. */
export async function listBranchesAction(repo: string): Promise<ActionResult & { branches?: string[] }> {
  if (!isModuleEnabled("pr")) return { ok: false, message: "Module Git & PR đang tắt" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) return { ok: false, message: "Repo phải có dạng owner/name" };
  const cfg = getGitHubConfig();
  if (!cfg.token) return { ok: false, message: "Chưa có GitHub token — vào Settings của module Nhánh" };
  try {
    return { ok: true, message: "", branches: await fetchBranchNames(cfg.token, repo.trim()) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Không đọc được nhánh từ GitHub" };
  }
}

/**
 * PR ở repo khác của cùng card (thường là SDK) để ghi vào "SDK Reference":
 * PR cùng đích nếu có, không thì PR đang mở. Dạng `owner/repo#N`.
 */
function sdkPrsOf(card: ReturnType<typeof getTaskNote>, repo: string, base: string): string[] {
  if (!card) return [];
  const out: string[] = [];
  for (const s of card.sides) {
    if (s.repo === repo) continue;
    const live = s.prs.filter((p) => p.state !== "CLOSED");
    const same = live.filter((p) => p.base === base);
    for (const p of same.length ? same : live.filter((p) => p.state === "OPEN")) out.push(`${s.repo}#${p.number}`);
  }
  return [...new Set(out)];
}

/**
 * Nhờ Claude đọc commit + diff của `base...head` và gợi ý danh sách thay đổi.
 * Diff đọc từ GitHub (chỉ đọc), bỏ lock/pbxproj/asset/code generate; chạy qua
 * Claude Code CLI ở máy này, như nút Generate của Task mới.
 */
export async function suggestChangesAction(input: {
  repo: string;
  head: string;
  base: string;
}): Promise<ActionResult & { changes?: string[]; model?: string }> {
  if (!isModuleEnabled("pr")) return { ok: false, message: "Module Git & PR đang tắt" };
  const cfg = getGitHubConfig();
  if (!cfg.token) return { ok: false, message: "Chưa có GitHub token — vào Settings của module Nhánh" };
  try {
    const cmp = await fetchCompare(cfg.token, input.repo, input.base, input.head);
    const files = cmp.files.filter((f) => !isUncountedFile(f.path));
    if (!cmp.commits.length && !files.length) return { ok: false, message: "Nhánh nguồn không có gì khác nhánh đích" };
    const res = await summarizeChanges({ commits: cmp.commits, files });
    return { ok: true, message: "", changes: res.changes, model: res.model };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Không gợi ý được" };
  }
}
