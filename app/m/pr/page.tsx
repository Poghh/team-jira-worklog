import { connection } from "next/server";

import { ModuleGate } from "@/lib/modules/gate";
import { getGitHubConfig } from "@/lib/modules/branches/config";
import { fetchPrsByNumber } from "@/lib/modules/branches/github";
import { cardLadder, envSteps } from "@/lib/modules/branches/model";
import { listTaskNotes } from "@/lib/modules/branches/store";
import { getReviewConfig } from "@/lib/modules/code-review/config";
import { isModuleEnabled } from "@/lib/modules/state";

import { type PrEntry, PrGuide } from "./guide";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Nhánh chưa có PR nào mà còn được đẩy trong chừng này ngày thì coi là "nên tạo PR". */
const FRESH_DAYS = 30;

export default async function PrPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  if (!isModuleEnabled("pr")) return <ModuleGate id="pr">{null}</ModuleGate>;

  const sp = await searchParams;
  const gh = getGitHubConfig();
  const firstEnv = envSteps(gh.stages)[0]?.branch ?? "ctalk/develop";
  const freshSince = Date.now() / 1000 - FRESH_DAYS * 86400;
  const notes = listTaskNotes();

  /* Hai nhóm, đọc từ card của module Nhánh:
     - PR đang mở — mỗi PR một dòng, dù nó vào môi trường hay vào nhánh cha.
     - Nhánh chưa có PR nào, còn được đẩy gần đây — gợi ý PR vào môi trường
       đầu. Nhánh cũ không PR thường là nhánh bỏ, liệt kê ra chỉ thêm nhiễu. */
  const open: PrEntry[] = [];
  const todo: PrEntry[] = [];
  for (const c of notes)
    for (const s of c.sides) {
      const branch = s.branch.trim();
      if (!branch || s.branchGone) continue;
      const bases = cardLadder(s.prs, [], gh.stages)
        .map((r) => r.branch)
        .filter(Boolean);
      const base = { cardId: c.id, issueKey: c.issueKey, title: c.title, repo: s.repo, branch, bases };
      for (const p of s.prs)
        if (p.state === "OPEN" && p.base)
          open.push({ ...base, base: p.base, pr: { number: p.number, url: p.url, state: p.state } });
      if (!s.prs.length && (s.branchUpdatedAt ?? 0) > freshSince)
        todo.push({ ...base, base: firstEnv, pr: null, updatedAt: s.branchUpdatedAt ?? 0 });
    }
  /* Trạng thái PR trên card là của lần quét gần nhất: PR merge hay đóng sau
     đó vẫn nằm ở "đang mở" cho tới lần quét sau. Hỏi lại GitHub — mỗi repo
     một truy vấn, chỉ đọc — và bỏ những PR không còn mở. Hỏi không được thì
     giữ như card nói: thiếu câu trả lời không phải bằng chứng PR đã đóng. */
  if (gh.token && open.length) {
    const byRepo = new Map<string, number[]>();
    for (const e of open) byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), e.pr!.number]);
    const live = new Map<string, string>();
    await Promise.all(
      [...byRepo].map(async ([repo, nums]) => {
        const got = await fetchPrsByNumber(gh.token, repo, nums).catch(() => ({}));
        for (const [n, pr] of Object.entries(got)) live.set(`${repo}#${n}`, pr.state);
      }),
    );
    for (let i = open.length - 1; i >= 0; i--) {
      const state = live.get(`${open[i].repo}#${open[i].pr!.number}`);
      if (state && state !== "OPEN") open.splice(i, 1);
    }
  }
  open.sort((a, b) => b.pr!.number - a.pr!.number);
  todo.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  /* Link từ card của module Nhánh (`?card=&repo=&base=`) hoặc nhập tay
     (`?repo=&head=&base=`) — dòng đó có thể không nằm trong hai nhóm trên
     (PR đã merge, nhánh cũ), nên dựng riêng. */
  let initial: PrEntry | null = null;
  const repo = one(sp.repo);
  const cardId = Number(one(sp.card)) || 0;
  const wantBase = one(sp.base);
  if (cardId) {
    const c = notes.find((n) => n.id === cardId);
    const s = c?.sides.find((x) => x.repo === repo) ?? c?.sides[0];
    if (c && s?.branch.trim()) {
      const bases = cardLadder(s.prs, [], gh.stages)
        .map((r) => r.branch)
        .filter(Boolean);
      const p = s.prs.find((x) => x.base === wantBase && x.state === "OPEN") ?? s.prs.find((x) => x.base === wantBase);
      initial = {
        cardId: c.id,
        issueKey: c.issueKey,
        title: c.title,
        repo: s.repo,
        branch: s.branch.trim(),
        bases,
        base: wantBase || bases[0] || firstEnv,
        pr: p ? { number: p.number, url: p.url, state: p.state } : null,
      };
    }
  } else if (repo && one(sp.head) && wantBase) {
    initial = { issueKey: "", title: "", repo, branch: one(sp.head), bases: [], base: wantBase, pr: null };
  }

  /* Repo của bảng Nhánh, rồi tới repo khai ở Code review mà bảng không quét
     (vd. viptalk-ios Classic) — soát PR được mà không phải bày nhánh của nó
     lên bảng. Repo khai ở Code review còn có bản clone để kiểm conflict. */
  const repos = [...gh.repos];
  for (const r of getReviewConfig().repos) {
    const name = r.githubRepo.trim();
    if (name && !repos.includes(name)) repos.push(name);
  }

  return (
    <ModuleGate id="pr">
      <PrGuide open={open} todo={todo} repos={repos} initial={initial} freshDays={FRESH_DAYS} />
    </ModuleGate>
  );
}
