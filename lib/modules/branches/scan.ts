import "server-only";

import { getIssueStatuses } from "@/lib/jira/issues";

import { getGitHubConfig, getStages } from "./config";
import {
  type CardBuild,
  type CardSide,
  type StageConfig,
  cleanupStep,
  envBranchNames,
  envSteps,
  orderSides,
  withLocalState,
} from "./model";
import {
  prBaseBranches,
  cardSide,
  type EnvState,
  type PlanRow,
  type PullRequest,
  type RemoteBranch,
  advanceStage,
  extractIssueKey,
  extractIssueKeys,
  isRevertBranch,
  mineBy,
  asPullRequest,
  cardStage,
  mergeCardPrs,
  parseEnvState,
  pickPr,
  prStateTag,
  prsForCard,
  serializeCardPrs,
  settleSides,
  serializeCardSides,
  stageFor,
  titleFromBranch,
  cardIsEmpty,
  dropCards,
  keysAfterRename,
} from "./github-model";
import {
  fetchBranchPrs,
  fetchBranches,
  type BaseState,
  fetchBaseBranch,
  fetchBaseStates,
  fetchEnvState,
  fetchMergedPrs,
  type PinnedPr,
  fetchPrsByNumber,
  fetchPushedBranches,
  fetchShaContainment,
} from "./github";
import {
  type LocalScan,
  localIndex,
  mergeBaseSha,
  readLocalBranches,
} from "./local";
import {
  applyGitHubBranch,
  deleteTaskNotes,
  listTaskNotes,
  markBranchesGone,
} from "./store";

/**
 * The stored form of a measured position.
 *
 * One function for both the write and the freshness check. They used to
 * normalise differently — the write collapsed an empty map to '' while the
 * check compared against '{}' — so a card with no environment data was
 * rewritten on every single scan and the button never reported "nothing new".
 */
function envJson(envs: EnvState): string {
  return Object.keys(envs).length ? JSON.stringify(envs) : "";
}

/** A card left pointing at a branch that no longer exists. */
export interface GoneCard {
  id: number;
  issueKey: string;
  title: string;
  branch: string;
  repo: string;
  stage: string;
  /** Note lines the user wrote — what would be lost by clearing the card. */
  bodyLines: number;
  prUrl: string;
  prState: string;
}

/** Một card đã lưu, kể lại dưới dạng {@link GoneCard}. */
function goneCard(c: {
  id: number;
  issueKey: string;
  title: string;
  branch: string;
  repo: string;
  stage: string;
  body: string;
  prUrl: string;
  sides: Array<{ prs: Array<{ state: string }> }>;
}): GoneCard {
  return {
    id: c.id,
    issueKey: c.issueKey,
    title: c.title,
    branch: c.branch,
    repo: c.repo,
    stage: c.stage,
    bodyLines: c.body.split("\n").filter((l) => l.trim()).length,
    prUrl: c.prUrl,
    prState: c.sides[0]?.prs[0]?.state ?? "",
  };
}

export interface ScanResult {
  rows: PlanRow[];
  /** Every branch fetched, before filtering — the denominator for the rest. */
  scanned: number;
  /** Branches that matched the identity rules. */
  mine: number;
  /** How many branches each rule claimed — so a wrong setting is visible, not guessed at. */
  mineBy: Record<string, number>;
  /**
   * Card cũ đang đứng trên một nhánh môi trường — dọn được, giống `gone`.
   *
   * Tách khỏi `gone` vì lý do khác hẳn: nhánh vẫn còn, chỉ là nó chưa bao giờ
   * đáng có card.
   */
  envCards: GoneCard[];
  /**
   * Mã Jira bị nhiều nhánh cùng đánh vần ra — card tách theo tên nhánh.
   *
   * Nêu ra vì đúng chuyện này từng làm mất một nhánh **không một lời nào**:
   * FR thua cuộc "tip mới nhất" biến khỏi kế hoạch, không hàng xung đột, không
   * dòng báo cáo. Người dùng mất gần một ngày mới truy ra.
   */
  splitKeys: string[];
  /**
   * Nhánh bị bỏ vì chính cấu hình cột gọi nó là môi trường.
   *
   * Nêu ra chứ không lặng lẽ bỏ: một nhánh biến mất khỏi kết quả quét mà không
   * ai nói lý do thì không phân biệt được với một nhánh app đọc hụt.
   */
  envSkipped: string[];
  /** Mine, but naming no configured project key — the usual cause of an empty scan. */
  unmatched: number;
  /** Branch names behind `unmatched`, capped, so the cause is visible not inferred. */
  unmatchedSamples: string[];
  /** Repos in the list that could not be read — renamed, deleted, or not visible. */
  skipped: string[];
  /** Repos with more branches than the per-repo ceiling — a scan that stopped early says so. */
  truncated: string[];
  /** Branches found only in a local clone, never pushed. */
  localOnly: number;
  /** Branches on the server that the local clone is ahead of. */
  localAheadOf: number;
  /** Configured paths that could not be read, with the reason. */
  badPaths: Array<{ path: string; why: string }>;
  /**
   * Branches carrying unpushed commits that no card ended up tracking.
   *
   * A ticket worked in two repos gets one card, so the loser's branch — and
   * whatever is sitting unpushed on it — would otherwise vanish silently. Two
   * branches here hold 47 and 43 unpushed commits between them; saying nothing
   * about that would be the worst kind of quiet.
   */
  localHidden: Array<{ repo: string; branch: string; ahead: number }>;
  /**
   * Cards whose branch GitHub no longer has.
   *
   * Normal, not broken: this team deletes branches on release, so this is the
   * list of work that shipped. Reported separately from the plan because the
   * only sensible action is the opposite one — clear the card, not update it.
   */
  gone: GoneCard[];
  /**
   * Card nhánh đã biến mất ở cả GitHub lẫn clone, và không mang gì để mất —
   * phép quét gỡ hẳn chứ không mời dọn. Xem chỗ dựng danh sách này.
   */
  dropped: GoneCard[];
}

/**
 * Reads GitHub and works out what it would change, without changing anything.
 *
 * Split from {@link applyPlan} because the interesting failure here is not a
 * network error but a misconfiguration — a missing project key, an identity
 * that matches nothing — and those produce a *successful* scan with a wrong
 * plan. Showing the plan first turns that from a mess to undo into a list to
 * read.
 */
export async function scanGitHub(): Promise<ScanResult> {
  const cfg = getGitHubConfig();
  const token = cfg.token;
  if (!token) {
    throw new Error(
      "Chưa có token GitHub — dán vào ô ở tab GitHub của module này.",
    );
  }
  if (!cfg.repos.length) throw new Error("Chưa chọn repo nào để quét");

  const { logins } = cfg.identity;
  if (!logins.length) {
    // Without this the scan succeeds and finds nothing, which reads like "you
    // have no branches" rather than "you have not said who you are".
    throw new Error(
      // Nút "Dò từ token" không còn: tab GitHub tự đọc login từ token khi mở.
      // Tới được đây nghĩa là chính việc đọc đó hỏng — thường là token sai hoặc
      // hết hạn — nên câu nhắc phải chỉ vào token, không chỉ vào một cái nút.
      "Chưa khai báo danh tính GitHub — mở tab GitHub, kiểm tra token còn dùng được không",
    );
  }

  /**
   * Ba việc không cần kết quả của nhau, nên cùng khởi động một lúc.
   *
   * Đo trên lần quét thật: 22.0s tổng, 19.2s nằm trong request, tức mức song
   * song 0.9x — mọi thứ nối đuôi nhau và máy ngồi chờ GitHub 87% thời gian.
   * Danh sách nhánh tốn 6.6s, event feed 3.2s, mà event feed hỏi
   * `/users/<login>/events` chứ không hỏi gì về nhánh; đọc clone thì không
   * chạm GitHub chút nào.
   *
   * Khởi động sớm rồi `await` ở đúng chỗ dùng, không đảo thứ tự **gộp** dữ
   * liệu: bản của server vẫn thắng bản dưới máy ở mọi thứ cả hai cùng biết,
   * y như trước.
   */
  const branchesP = fetchBranches(token, cfg.repos);
  const localP: Promise<LocalScan> = cfg.localPaths.length
    ? readLocalBranches(cfg.localPaths).catch(
        () => ({ branches: [], bad: [] }) as LocalScan,
      )
    : Promise.resolve({ branches: [], bad: [] } as LocalScan);
  // Best-effort: event feed hỏng thì mất mấy nhánh mới, không mất cả lần quét.
  const pushedP = cfg.useEvents
    ? fetchPushedBranches(token, logins).catch(() => new Set<string>())
    : Promise.resolve(new Set<string>());

  const [{ branches, skipped, truncated }, local] = await Promise.all([
    branchesP,
    localP,
  ]);

  // The same scan as a lookup, for sides that never pass through `best` — see
  // the carried-through branch far below.
  const localState = localIndex(local);

  // Cards pointing at a branch that is no longer on GitHub.
  //
  // Scoped to repos this scan actually read: a card from a repo since removed
  // from the list, or from a repo that failed, has not been shown to be gone —
  // only unlooked-for. Reporting those would invite deleting cards over a typo
  // in the repo list.
  const readRepos = new Set(cfg.repos.filter((r) => !skipped.includes(r)));
  const liveBranches = new Set(branches.map((b) => `${b.repo}#${b.name}`));

  // Clones this scan actually opened, and every branch found in them. A
  // never-pushed branch lives nowhere but a clone, so the clone is the only
  // place that can report it deleted — skipping those cards entirely, as this
  // used to, left them on the board forever after the branch was thrown away.
  const readPaths = new Set(
    local.branches
      .map((b) => b.path)
      .concat(
        cfg.localPaths.filter((p) => !local.bad.some((x) => x.path === p)),
      ),
  );
  const localSeen = new Set(local.branches.map((b) => `${b.repo}#${b.name}`));

  /** Whether one repository's branch is provably gone, not merely unlooked-for. */
  const sideGone = (s: {
    repo: string;
    branch: string;
    localOnly: boolean;
    localPath: string;
  }) => {
    const key = `${s.repo}#${s.branch.trim()}`;
    if (!s.repo || !s.branch.trim()) return false;
    // Never pushed: judged against the clone it came from, and only when that
    // clone was readable this time round.
    if (s.localOnly)
      return (
        Boolean(s.localPath) &&
        readPaths.has(s.localPath) &&
        !localSeen.has(key)
      );
    return readRepos.has(s.repo) && !liveBranches.has(key);
  };

  /**
   * Repo có ít nhất một clone đọc được lần này.
   *
   * Thiếu nó thì "không thấy nhánh dưới máy" là câu trả lời của một câu hỏi
   * chưa từng được hỏi — và câu trả lời đó đang được dùng để **xoá card**.
   */
  const localRepos = new Set(local.branches.map((b) => b.repo));

  /**
   * Nhánh biến mất ở **cả hai nơi**: GitHub không có, mà clone dưới máy cũng
   * không có — và cả hai đều thật sự được kiểm lần quét này.
   *
   * Chặt hơn {@link sideGone} một bậc, có chủ ý. `sideGone` chỉ hỏi GitHub, đủ
   * để gạch tên nhánh và mời người dùng dọn; nhưng xoá card thì không được
   * phép nhầm, mà xoá nhánh trên remote rồi giữ lại dưới máy là chuyện thường
   * ngày của việc đang làm dở.
   */
  const sideVanished = (s: {
    repo: string;
    branch: string;
    localOnly: boolean;
    localPath: string;
  }) => {
    if (!s.repo || !s.branch.trim()) return false;
    // Nhánh chưa từng push: clone là nhân chứng duy nhất, nên hỏi GitHub thêm
    // một lần nữa cũng không biết gì hơn.
    if (s.localOnly) return sideGone(s);
    const key = `${s.repo}#${s.branch.trim()}`;
    return (
      readRepos.has(s.repo) &&
      !liveBranches.has(key) &&
      localRepos.has(s.repo) &&
      !localSeen.has(key)
    );
  };

  /** Xem {@link settleSides} — phép kiểm "mất nhánh" là của lần quét này. */
  const settle = <T extends CardSide>(sides: T[]): T[] =>
    settleSides(sides, sideGone);

  const watched = new Set(cfg.repos);
  // An index, not a membership set: the loop below needs the branch itself, and
  // scanning the array for it turned a few hundred local branches against a few
  // hundred remote ones into a hundred thousand string comparisons.
  const onServer = new Map(branches.map((b) => [`${b.repo}#${b.name}`, b]));
  let localOnlyCount = 0;
  let localAheadCount = 0;

  for (const lb of local.branches) {
    if (!watched.has(lb.repo)) continue;

    const remote = onServer.get(`${lb.repo}#${lb.name}`);
    if (remote) {
      remote.local = { ahead: lb.ahead, onlyLocal: false, path: lb.path };
      if (lb.ahead > 0) localAheadCount++;
      continue;
    }

    // Never pushed: no pull request, no environment position to ask GitHub for.
    // It still deserves a card — that is the whole point of reading the clone.
    localOnlyCount++;
    branches.push({
      repo: lb.repo,
      name: lb.name,
      committedAt: lb.committedAt,
      login: "",
      email: "",
      prs: [],
      pr: null,
      // `lb.onlyLocal` rather than a hardcoded true: a branch whose upstream
      // was deleted still records one, and calling that "never pushed" both
      // mislabels it and hides it from the deleted-branch check below.
      local: { ahead: lb.ahead, onlyLocal: lb.onlyLocal, path: lb.path },
    });
  }

  // Pull requests the user pinned by hand, fetched by number.
  //
  // A pinned request is often not one of its branch's own associations — this
  // team merges through a resolve branch, so the work on a feature branch
  // reaches an environment via a pull request GitHub links to a *different*
  // branch entirely. Looked up directly and folded into the branch's list, so
  // `pickPr` can honour the pin instead of silently falling back to whatever
  // the branch happens to own.
  const allCards = listTaskNotes();

  // Nhánh do chính người dùng tạo hoặc push — đã khởi động từ đầu hàm.
  const pushed = await pushedP;

  /**
   * Pull request, hỏi riêng và chỉ cho nhánh cần.
   *
   * `fetchBranches` không còn kéo theo PR của từng ref: đo thẳng trên repo
   * lớn, cùng 100 nhánh thì kèm PR mất 3.2–3.7s còn bỏ PR chỉ 0.98s — truy
   * vấn lồng ấy là 70% thời gian liệt kê nhánh. Mà repo này có 149 nhánh
   * trong khi người dùng có ba.
   *
   * Hai nhóm cần PR, và chỉ hai nhóm:
   *
   * - nhánh sắp lên card — tức nhánh một luật sở hữu nào đó nhận;
   * - nhánh mà một card đang trỏ vào, kể cả của đồng nghiệp, vì vòng cập
   *   nhật card phía dưới duyệt `branches` chứ không duyệt `mine`.
   *
   * Điền tại chỗ vào chính các `RemoteBranch` ấy, nên mọi chỗ đọc
   * `branch.prs` / `branch.pr` phía dưới không phải đổi một dòng nào.
   */
  {
    const want = new Set<string>();
    for (const b of branches)
      if (b.local?.onlyLocal || mineBy(b, cfg.identity, pushed))
        want.add(`${b.repo}#${b.name}`);
    for (const c of allCards)
      for (const side of c.sides)
        if (side.repo && side.branch.trim())
          want.add(`${side.repo}#${side.branch.trim()}`);

    const items = branches
      .filter((b) => want.has(`${b.repo}#${b.name}`))
      .map((b) => ({ repo: b.repo, branch: b.name }));

    if (items.length) {
      const got = await fetchBranchPrs(token, items).catch(
        () => new Map<string, PullRequest[]>(),
      );
      for (const b of branches) {
        const prs = got.get(`${b.repo}#${b.name}`);
        if (!prs) continue;
        b.prs = prs;
        b.pr = pickPr(prs);
      }
    }
  }
  /**
   * Requests the user pinned, per repository.
   *
   * There used to be a card-level pin beside these, holding one number for the
   * whole card. It could not survive a card spanning two repositories — one
   * number cannot name a request in each — and everything it did is now done
   * by the per-side pins, which say which repository and which environment.
   *
   * Fetched so their state stays live: the number is the user's decision,
   * whether it is open or merged is still GitHub's.
   */
  const pinnedPrs = new Map<string, number[]>();
  const add = (repo: string, n: number) =>
    pinnedPrs.set(repo, [...(pinnedPrs.get(repo) ?? []), n]);
  for (const c of allCards)
    for (const side of c.sides)
      for (const p of side.prs)
        if (p.pinned && p.number) add(side.repo, p.number);

  /** Every pinned request GitHub could be asked about, by number. */
  const livePins = new Map<number, PullRequest>();

  /** `repo#branch` → the pull requests pinned onto that particular branch. */
  const pinnedOn = new Map<string, number[]>();
  for (const c of allCards)
    for (const side of c.sides) {
      if (!side.repo || !side.branch.trim()) continue;
      const k = `${side.repo}#${side.branch.trim()}`;
      for (const p of side.prs)
        if (p.pinned && p.number)
          pinnedOn.set(k, [...(pinnedOn.get(k) ?? []), p.number]);
    }

  /** `repo#issueKey` → merge commit, head branch and merge time, pinned by hand. */
  const pinnedMerge = new Map<
    string,
    { sha: string; head: string; at: number }
  >();

  for (const [repo, numbers] of pinnedPrs) {
    const found = await fetchPrsByNumber(token, repo, numbers).catch(
      () => ({}) as Record<number, PinnedPr>,
    );
    for (const pr of Object.values(found)) livePins.set(pr.number, pr);
    // Onto the branch that pinned it, and no other. Pushing every pinned
    // request onto every branch of the repo — which is what this did — made one
    // card's open request look like a request on all of them, so an untouched
    // branch with no pull request at all was filed under the environment that
    // someone else's request happened to target.
    for (const b of branches) {
      if (b.repo !== repo) continue;
      for (const n of pinnedOn.get(`${b.repo}#${b.name}`) ?? []) {
        const pr = found[n];
        if (pr && !b.prs.some((x) => x.number === n)) b.prs.push(pr);
      }
    }
    for (const c of allCards) {
      if (!c.issueKey) continue;
      const pin = c.sides
        .filter((side) => side.repo === repo)
        .flatMap((side) => side.prs.filter((p) => p.pinned && p.number))[0];
      if (!pin) continue;
      const hit = found[pin.number];
      if (hit?.mergeCommit)
        pinnedMerge.set(`${repo}#${c.issueKey}`, {
          sha: hit.mergeCommit,
          head: hit.headRefName ?? "",
          at: Math.floor(new Date(hit.mergedAt ?? 0).getTime() / 1000) || 0,
        });
    }
  }

  /**
   * Nhánh môi trường, lấy thẳng từ cấu hình cột.
   *
   * Một nhánh mà cột nào đó đặt tên là môi trường thì nó là **đích đến**, không
   * phải việc của ai — nó không bao giờ được thành card, dù luật danh tính có
   * nhận nó.
   *
   * Thiếu bước này, `ctalk/develop` đã lên board thành một card `no-ticket`:
   * feed sự kiện coi nó là của người dùng vì họ **merge một PR vào nó qua giao
   * diện GitHub**, và GitHub ghi cú dời đầu nhánh ấy thành một PushEvent mang
   * tên họ — dù commit đầu nhánh là của người khác. Luật `push` được kiểm trước
   * luật tác giả nên không có gì cản lại. Điều đó đúng với mọi nhánh sống lâu
   * mà người dùng từng merge vào: `develop`, `staging`, `main` của repo wrapper.
   *
   * Đọc từ cấu hình chứ không từ một danh sách tên đoán sẵn: cột nào đang là
   * môi trường thì chính người dùng đã khai rồi.
   */
  const envBranches = envBranchNames(cfg.stages);
  const envSkipped: string[] = [];

  const byRule: Record<string, number> = {};
  const mine = branches.filter((b) => {
    // A branch sitting in a clone on this machine is the user's by construction;
    // the identity rules exist to filter the server's shared view, not this one.
    const how = b.local?.onlyLocal ? "local" : mineBy(b, cfg.identity, pushed);
    if (!how) return false;

    // Cổng môi trường đặt **sau** luật danh tính, không phải trước: đặt trước
    // thì báo cáo kể tên cả những nhánh môi trường chẳng luật nào nhận — quét
    // thật cho ra 6 cái, trong khi chỉ 1 cái thật sự sắp thành card. Ở đây danh
    // sách chỉ chứa thứ đã bị chặn thật.
    if (envBranches.has(b.name.trim())) {
      const id = `${b.repo}#${b.name}`;
      if (!envSkipped.includes(id)) envSkipped.push(id);
      return false;
    }

    byRule[how] = (byRule[how] ?? 0) + 1;
    return true;
  });

  /**
   * Nhánh đích của một PR do chính người dùng mở cũng là việc của người dùng.
   *
   * Luật thứ tư, và là luật duy nhất bắt được ca thật này: nhánh
   * `ctalk/feature/VT-2323_…` do người dùng tạo ra, nhưng
   *
   * - tác giả commit mới nhất là đồng nghiệp — nhánh chưa có commit riêng nào
   *   nên "commit mới nhất" chính là commit mới nhất của `master`;
   * - feed sự kiện chỉ với tới được 21 ngày vì trần 300 event của GitHub, và
   *   lần tạo nhánh nằm ngoài cửa sổ đó;
   * - so với `master` nó **+0 commit**, nên cả luật "tôi có commit trên nhánh"
   *   cũng trượt.
   *
   * Thứ duy nhất còn nói đúng là: PR #1757 nhắm vào nó, và PR ấy nằm trên
   * nhánh của người dùng. Dữ liệu đã có sẵn trong `baseRefName`, chỉ là chưa
   * ai hỏi tới.
   *
   * Phạm vi hẹp có chủ ý — chỉ nhánh đích của PR **trên nhánh của mình**, chứ
   * không phải mọi nhánh của đồng nghiệp. Và cổng môi trường vẫn phải áp:
   * thiếu nó thì mọi PR nhắm vào `ctalk/develop` sẽ đẻ ra một card cho chính
   * nhánh môi trường ấy.
   */
  {
    const wanted = new Set(prBaseBranches(mine, envBranches));
    const extra = branches.filter((b) => wanted.has(`${b.repo}#${b.name}`));
    if (extra.length) {
      // Nhánh này chưa được hỏi PR ở vòng trên — lúc đó chưa ai biết nó sẽ
      // được nhận. Một request nữa, chỉ cho đúng mấy nhánh này.
      const got = await fetchBranchPrs(
        token,
        extra.map((b) => ({ repo: b.repo, branch: b.name })),
      ).catch(() => new Map<string, PullRequest[]>());
      for (const b of extra) {
        const prs = got.get(`${b.repo}#${b.name}`);
        if (prs) {
          b.prs = prs;
          b.pr = pickPr(prs);
        }
        byRule.prbase = (byRule.prbase ?? 0) + 1;
        mine.push(b);
      }
    }
  }

  // Newest tip wins when several branches name the same ticket: a ticket
  // reopened on a fresh branch is the common case, and the stale branch is
  // exactly the one not worth putting on the board.
  // Indexed by *every* key a card claims: a branch fixing two tickets must find
  // the same card whichever of them the scan looks up.
  /**
   * A grouping key for a branch that names no ticket.
   *
   * The module is branches and notes; the Jira link is the secondary thing. A
   * branch with no ticket in its name is still a branch somebody is working
   * on, so it gets a card — it just gets one keyed by itself.
   *
   * `⑂` can never begin a Jira key, so the two kinds of key cannot collide,
   * and everything downstream keeps treating the key as an opaque string. What
   * changes is only what gets *stored*: `issue_key` stays empty for these,
   * which is what the partial unique index and `saveTaskNote` already expect.
   */
  const branchKey = (repo: string, name: string) => `⑂${repo}#${name}`;
  const isBranchKey = (k: string) => k.startsWith("⑂");

  const byKey = new Map<string, (typeof allCards)[number]>();
  for (const c of allCards)
    for (const k of c.issueKeys) if (!byKey.has(k)) byKey.set(k, c);
  // Ticketless cards are found by the branch they point at, since they have no
  // key to be found by. Without this every scan would mint a second card for
  // the same branch.
  for (const c of allCards)
    if (!c.issueKey)
      for (const side of c.sides)
        if (side.repo && side.branch.trim())
          byKey.set(branchKey(side.repo, side.branch.trim()), c);

  /**
   * `issueKey` → `repo` → the branch of that repository.
   *
   * Per repository, not one branch per ticket. A fix here often spans the Rust
   * SDK and the iOS app, and keeping only the newest-tip branch meant the other
   * repository's work — merged requests included — never appeared on the board
   * at all. Nine of fifty-one tickets are in that shape.
   */
  const best = new Map<string, Map<string, RemoteBranch>>();
  const putBest = (key: string, b: RemoteBranch) => {
    const byRepo = best.get(key) ?? new Map<string, RemoteBranch>();
    byRepo.set(b.repo, b);
    best.set(key, byRepo);
  };
  /** Every side of a ticket, in no particular order yet. */
  const sidesOf = (key: string) => [...(best.get(key)?.values() ?? [])];
  // Keys the user has corrected by hand. Newest-tip-wins is a guess, and a
  // guess must not outrank an answer someone typed in deliberately.
  const pinnedHit = new Set<string>();
  const unmatchedSamples: string[] = [];
  let unmatched = 0;

  /** Every key a chosen branch names, so a card can carry all of them. */
  const keysOf = new Map<string, string[]>();

  /**
   * The keys a card should end up with: its own, plus anything new the branch
   * names. Never fewer.
   *
   * A scan must not drop a ticket somebody typed in. The branch name is only
   * one way a card learns which tickets it covers — a second ticket fixed by
   * the same pull request often is not in the branch name at all, and replacing
   * the list wiped it on the very next scan.
   */
  const mergedKeys = (
    card: { issueKeys: string[] } | null,
    fromBranch: string[],
  ): string[] => {
    const out = [...(card?.issueKeys ?? [])];
    for (const k of fromBranch) if (!out.includes(k)) out.push(k);
    return out;
  };

  /**
   * Mã nào đang bị **nhiều tên nhánh khác nhau** cùng đánh vần ra.
   *
   * Một Epic nhiều FR là chuyện thường ở đây, và các nhánh của nó đều mang mã
   * Epic: `VT-2583_FR-4_change_password…` và `VT-2583_FR5_delete_system_notice`
   * cùng cho ra `VT-2583`. Gom theo mã thì hai FR tranh nhau một chỗ, "tip mới
   * nhất thắng", và FR thua **biến mất khỏi bảng mà không để lại dấu vết nào**
   * — không hàng xung đột, không dòng nào trong báo cáo quét.
   *
   * Khi một mã bị tranh như vậy, định danh card chuyển sang **tên nhánh**. Đếm
   * theo tên chứ không theo `repo#tên`: cùng một tên nhánh tồn tại ở cả hai
   * repo — đo trên bảng thật, cả `…FR-4…` lẫn `…FR5…` đều có ở ios và sdk — nên
   * gom theo tên cho ra đúng hai card, mỗi card hai nửa, thay vì bốn card lẻ.
   */
  const namesPerKey = new Map<string, Set<string>>();
  for (const b of mine)
    for (const k of extractIssueKeys(b.name, cfg.projectKeys)) {
      const set = namesPerKey.get(k) ?? new Set<string>();
      set.add(b.name);
      namesPerKey.set(k, set);
    }
  /** Mã bị tranh thì card mang tên nhánh; mã chỉ một nhánh thì vẫn mang mã. */
  const contested = (k: string) => (namesPerKey.get(k)?.size ?? 0) > 1;
  const sharedKey = (name: string) => `⑂${name}`;
  /** Nhánh bị dời sang khoá-theo-tên, để báo cáo nói ra chứ không im lặng. */
  const splitKeys: string[] = [];

  for (const b of mine) {
    const all = extractIssueKeys(b.name, cfg.projectKeys);
    // Still counted and still listed — "no ticket in the name" is worth
    // reporting — but no longer a reason to drop the branch on the floor.
    if (!all.length) {
      unmatched++;
      if (unmatchedSamples.length < 8) unmatchedSamples.push(b.name);
    }
    const primary = all[0];
    if (primary && contested(primary) && !splitKeys.includes(primary))
      splitKeys.push(primary);
    const key = primary
      ? contested(primary)
        ? sharedKey(b.name)
        : primary
      : branchKey(b.repo, b.name);
    const card = byKey.get(key);
    if (
      card?.githubPinned &&
      card.repo === b.repo &&
      card.branch.trim() === b.name
    ) {
      putBest(key, b);
      keysOf.set(key, all);
      pinnedHit.add(`${key}#${b.repo}`);
      continue;
    }
    // A pin settles which branch of *that repository* is the card's; the other
    // repository still picks its own by newest tip.
    if (pinnedHit.has(`${key}#${b.repo}`)) continue;

    /**
     * Nhánh GitHub vẫn còn thì thắng nhánh GitHub không còn, trước khi xét tip.
     *
     * "Tip mới nhất thắng" một mình là sai với cách team này merge: việc đi qua
     * một nhánh resolve, nhánh resolve merge xong thì bị xoá trên remote, còn
     * clone dưới máy vẫn giữ nó với một upstream đã chết — nên nó **không** phải
     * `onlyLocal`, mà tip lại mới hơn nhánh gốc.
     *
     * Đo trên card VT-526: phép quét thay `ctalk/bugfix/VT-526` (còn trên
     * GitHub, `master...` cho ahead=0) bằng `ctalk/bugfix/resolve_vt-526_staging`
     * (compare trả 404). Mất ref thì không so được gì, mọi ô containment thành
     * `null`, và card đang ở `đã build staging` bị đẩy **lùi** về
     * `đã merge staging` thay vì về `done`.
     *
     * Hỏi `onServer` chứ không hỏi `local.onlyLocal`: map đó dựng từ những gì
     * GitHub thật sự trả về, trước khi nhánh dưới clone được nhập vào, nên nó là
     * câu trả lời đúng cho "GitHub còn nhánh này không".
     */
    const live = (x: RemoteBranch) => onServer.has(`${x.repo}#${x.name}`);
    const prev = best.get(key)?.get(b.repo);
    const better = !prev
      ? true
      : live(b) !== live(prev)
        ? live(b)
        : b.committedAt > prev.committedAt;
    if (better) {
      putBest(key, b);
      keysOf.set(key, all);
    }
  }

  const stages = getStages();
  const stageNames = stages.map((s) => s.name);

  // Branches a card already claims. One branch, one card: without this a
  // branch whose name yields a Jira key gets a *second*, auto-created card
  // whenever the card that owns it is keyed something else — which happens the
  // moment the user renames a card's key, exactly as it does when they pin one.
  // Pinning is not the point; already pointing at the branch is.
  // Every side, not just the first. A card's SDK branch is claimed just as
  // firmly as its iOS one, and counting only the first meant the other
  // repository's branch looked ownerless — so the scan created a second card
  // for it, keyed off whatever ticket the branch name happened to spell.
  const claimedBranches = new Set(
    allCards.flatMap((c) =>
      c.sides
        .filter((side) => side.repo && side.branch.trim())
        .map((side) => `${side.repo}#${side.branch.trim()}`),
    ),
  );

  for (const [key, byRepo] of [...best]) {
    const card = byKey.get(key);
    if (card) continue;
    // Only drop the side when no card of its own is waiting for it — an
    // existing card must keep being updated even if another card shares its
    // branch. A ticket left with no sides at all drops out entirely.
    for (const [repo, b] of [...byRepo])
      if (claimedBranches.has(`${b.repo}#${b.name}`)) byRepo.delete(repo);
    if (!byRepo.size) best.delete(key);
  }

  /**
   * Keys a card already owns through the name of a branch it points at.
   *
   * A card is identified by its ticket, which is not always the ticket its
   * branch spells: this board has `VT-853` on `ctalk/bugfix/VTL-286_VTL-610`.
   * Matching by key can never connect the two, so the second repository's
   * branch looked ownerless and the scan minted a card for it. These keys are
   * left out of `keys` and picked up further down, where cards are matched by
   * branch name instead — which keeps the card's own ticket list untouched.
   */
  const ownedByBranch = new Map<string, (typeof allCards)[number]>();
  for (const c of allCards)
    for (const side of c.sides)
      for (const k of extractIssueKeys(side.branch, cfg.projectKeys))
        if (!byKey.has(k) && !ownedByBranch.has(k)) ownedByBranch.set(k, c);

  const keys = [...best.keys()].filter((k) => !ownedByBranch.has(k));
  // Titles for cards about to be created. Best-effort: a Jira outage should
  // degrade the card to a bare key, not fail the whole scan.
  const realKeys = keys.filter((k) => !isBranchKey(k));
  const summaries = realKeys.length
    ? await getIssueStatuses(realKeys).catch(
        () => ({}) as Record<string, { summary: string }>,
      )
    : {};

  // Environment containment, for the branches that made the cut only — asking
  // it of all 149 refs would be most of a scan's cost spent on other people's
  // work.
  const envs = envSteps(stages);
  // Pinned branches join the measurement list even when no key pointed at them.
  const pinnedTargets = allCards
    .filter((c) => c.githubPinned && c.repo && c.branch.trim())
    .map((c) => ({ repo: c.repo, branch: c.branch.trim() }));
  const measure = [
    ...keys.flatMap((k) =>
      sidesOf(k)
        .filter((b) => !b.local?.onlyLocal)
        .map((b) => ({ repo: b.repo, branch: b.name })),
    ),
    // Every branch a card already points at, in every repository. Cards
    // matched by branch name rather than by key never appear in `keys` — the
    // card is `VT-853`, its branch spells `VTL-286` — so leaving these out
    // meant those cards' environments were simply never measured.
    ...allCards.flatMap((c) =>
      c.sides
        .filter((side) => side.repo && side.branch.trim())
        .map((side) => ({ repo: side.repo, branch: side.branch.trim() })),
    ),
    // And the other repository's branch of such a card, which no card stores
    // yet on the scan that first finds it.
    ...[...ownedByBranch.keys()].flatMap((k) =>
      sidesOf(k).map((b) => ({ repo: b.repo, branch: b.name })),
    ),
    ...pinnedTargets,
  ].filter(
    (t, i, all) =>
      all.findIndex((o) => o.repo === t.repo && o.branch === t.branch) === i,
  );

  /**
   * Đo thêm trunk mà cột cuối hỏi về, ngoài các môi trường.
   *
   * Không đi qua `envSteps` vì cột cuối là `reach: "gone"`, không phải
   * `merged` — nó cố ý nằm ngoài thang môi trường vẽ trên card, mà vẫn cần
   * đúng phép đo containment đó. Xem {@link reachedTrunk}.
   */
  const trunk = cleanupStep(stages)?.branch.trim();
  const measured =
    trunk && !envs.some((e) => e.branch === trunk)
      ? [...envs, { branch: trunk }]
      : envs;

  /**
   * Ba phép đo cuối khởi động cùng lúc.
   *
   * Vị trí so với môi trường, độ tụt so với nhánh gốc, và "nội dung đã vào
   * bằng đường khác" đều chỉ cần `measure` / `best` / `keys` — có đủ từ trên
   * này. Chúng không cần kết quả của nhau, mà trước đây xếp hàng chờ nhau:
   * đo được 2.0s + 2.1s + 2.9s nối đuôi.
   *
   * Trong từng nhánh thì vẫn nối tiếp ở chỗ buộc phải thế — phần lấp chỗ
   * trống bằng sha điểm rẽ cần `baseState` của vòng trên nó.
   */
  const envStateP = fetchEnvState(token, measure, measured).catch(
    () => ({}) as Record<string, EnvState>,
  );

  /**
   * Mỗi nhánh đang dựng trên bản `master` của lúc nào.
   *
   * `master` chứ không phải môi trường đầu: nó là nhánh phát hành, chạy chậm,
   * nên "tụt bao nhiêu" là con số đọc được — đo trên repo này ra 0, 11, 62,
   * 174. Cùng những nhánh ấy so với `ctalk/develop` ra 127, 137, 301, 501, vì
   * môi trường nhận hàng trăm commit một tuần.
   *
   * Chỉ hỏi cho nhánh đã lọt vào `measure` — đúng những nhánh sẽ lên card.
   */
  const baseState: Record<string, BaseState & { baseBranch: string }> = {};
  const baseByRepo = new Map<string, string>();
  const basesP = (async () => {
    {
      const byRepo = new Map<string, string[]>();
      for (const t of measure)
        byRepo.set(t.repo, [...(byRepo.get(t.repo) ?? []), t.branch]);
      // Mỗi repo một luồng: hỏi nhánh gốc rồi đo theo nó là hai bước nối tiếp
      // trong cùng một repo, nhưng hai repo không chờ nhau. `baseState` khoá
      // theo `repo#branch` nên không có chỗ nào đụng nhau.
      await Promise.all(
        [...byRepo].map(async ([repo, list]) => {
          const base = await fetchBaseBranch(token, repo).catch(() => "");
          if (!base) return;
          baseByRepo.set(repo, base);
          const got = await fetchBaseStates(token, repo, base, list).catch(
            () => ({}) as Record<string, BaseState>,
          );
          for (const [branch, v] of Object.entries(got))
            baseState[`${repo}#${branch}`] = { ...v, baseBranch: base };
        }),
      );
    }

    /**
     * Nhánh chưa push: hỏi cùng câu hỏi, nhưng hỏi theo **sha điểm rẽ nhánh**.
     *
     * Vòng trên hỏi `compare/master...<tên nhánh>`, và GitHub không có nhánh chưa
     * push nên nó trả 404 — card im lặng về chuyện rebase đúng lúc câu hỏi đáng
     * giá nhất. Điểm rẽ nhánh thì khác: nó là một commit đã nằm trên `master`,
     * nên hỏi theo sha vẫn ra đúng `behind_by` và đúng ngày.
     *
     * Sha đọc từ clone — {@link mergeBaseSha}, chỉ đọc — còn con số vẫn là của
     * GitHub. Nên clone fetch lần cuối lúc nào không ảnh hưởng tới kết quả, và
     * app vẫn giữ lời hứa không làm mới repo của người dùng.
     *
     * Chỉ lấp chỗ trống: nhánh nào vòng trên đã trả lời được thì không hỏi lại.
     */
    {
      const shaOf = new Map<string, string>();
      const byRepo = new Map<string, Set<string>>();
      for (const t of measure) {
        const key = `${t.repo}#${t.branch}`;
        if (baseState[key]) continue;
        const base = baseByRepo.get(t.repo);
        const lb = local.branches.find(
          (b) => b.repo === t.repo && b.name === t.branch,
        );
        if (!base || !lb) continue;
        const sha = await mergeBaseSha(lb.path, t.branch, base).catch(() => "");
        if (!sha) continue;
        shaOf.set(key, sha);
        byRepo.set(t.repo, (byRepo.get(t.repo) ?? new Set()).add(sha));
      }
      for (const [repo, shas] of byRepo) {
        const base = baseByRepo.get(repo)!;
        const got = await fetchBaseStates(token, repo, base, [...shas]).catch(
          () => ({}) as Record<string, BaseState>,
        );
        for (const [key, sha] of shaOf) {
          if (!key.startsWith(`${repo}#`)) continue;
          const v = got[sha];
          if (v) baseState[key] = { ...v, baseBranch: base };
        }
      }
    }
  })();

  // Content that reached an environment by another route.
  //
  // Comparing commit SHAs alone was wrong for this team: a resolve branch
  // merges the feature with conflicts fixed, so every commit is rewritten and
  // the original branch looks permanently behind. The merged pull request's
  // own merge commit is the thing to ask about instead — it is either in the
  // environment or it is not, and no patches need reading to find out.
  const landedP = landedByKey(
    token,
    keys,
    best,
    envs,
    cfg.projectKeys,
    pinnedMerge,
  ).catch(
    (): Record<
      string,
      { envs: Record<string, boolean>; via: string; at: number }
    > => ({}),
  );

  const [envState, landed] = await Promise.all([envStateP, landedP, basesP]);

  /** `repo#key` → the branch that carried the work in, when it detoured. */
  const via = new Map<string, string>();

  for (const key of keys) {
    for (const b of sidesOf(key)) {
      const state = envState[`${b.repo}#${b.name}`];
      const hit = landed[`${b.repo}#${key}`];
      if (!state || !hit) continue;
      let detoured = false;
      for (const env of envs) {
        const pos = state[env.branch];
        if (
          pos &&
          pos.ahead !== null &&
          pos.ahead > 0 &&
          hit.envs[env.branch]
        ) {
          pos.landed = true;
          detoured = true;
        }
      }
      if (detoured && hit.via) via.set(`${b.repo}#${key}`, hit.via);
    }
  }

  const rows: PlanRow[] = keys.map((groupKey) => {
    // The grouping key and the stored ticket are the same string for a branch
    // that names one, and deliberately different for a branch that does not.
    const issueKey = isBranchKey(groupKey) ? "" : groupKey;
    // Khoá theo nhánh thì `issue_key` để rỗng — DB có unique index trên cột đó,
    // nên hai card không thể cùng một mã chính. Nhưng `issueKeys` thì giữ, để
    // card vẫn link về ticket: một FR của Epic vẫn thuộc Epic đó.
    const cardKeys = isBranchKey(groupKey)
      ? (keysOf.get(groupKey) ?? [])
      : (keysOf.get(groupKey) ?? [groupKey]);
    const card = byKey.get(groupKey) ?? null;

    /**
     * One side per repository the ticket touches, each judged on its own.
     *
     * Judging them together was the old bug: a ticket whose SDK half was
     * merged a fortnight ago and whose iOS half is still being written would
     * take the column of whichever branch had the newer commit.
     */
    const byRepoBranchAll = new Map(
      branches.map((b) => [`${b.repo}#${b.name}`, b]),
    );
    /**
     * Repositories the scan found for this ticket, plus any the card pinned.
     *
     * A pinned side is not re-derived: the user said which branch of that
     * repository is the card's, and the scan pairs by newest tip, which is
     * exactly the guess they were correcting.
     */
    const seen = new Map(sidesOf(groupKey).map((b) => [b.repo, b]));
    for (const x of card?.sides ?? []) {
      if (!x.pinned) continue;
      const hit = byRepoBranchAll.get(`${x.repo}#${x.branch}`);
      if (hit) seen.set(x.repo, hit);
    }

    const computed = [...seen.values()].map((raw) => {
      const stored = card?.sides.find((x) => x.repo === raw.repo) ?? null;
      // A pinned card names its own pull request, for its own repository; the
      // scan reports on that one rather than re-deciding which request matters.
      // A side that pins a request names its own; the scan reports on that one
      // rather than re-deciding which of the branch's requests matters.
      const pinned = stored?.prs.find((p) => p.pinned && p.number)?.number;
      const branch = pinned ? { ...raw, pr: pickPr(raw.prs, pinned) } : raw;
      const envs = envState[`${branch.repo}#${branch.name}`] ?? {};
      const prs = mergeCardPrs(
        prsForCard(branch.prs),
        stored?.prs ?? [],
        livePins,
      );
      const target = stageFor(
        envs,
        branch.pr,
        stages,
        branch.prs,
        builtBranchesOf(card),
        branch.name,
      );
      const base = baseState[`${branch.repo}#${branch.name}`];
      const side = cardSide({
        repo: branch.repo,
        branch: branch.name,
        pinned: stored?.pinned,
        prs,
        envState: envJson(envs),
        landedVia: via.get(`${branch.repo}#${groupKey}`) ?? "",
        // The scan just read this branch, so it is there. Whether a card's
        // branch has gone is decided further down, per card.
        branchGone: false,
        localAhead: branch.local?.ahead ?? 0,
        localOnly: Boolean(branch.local?.onlyLocal),
        localPath: branch.local?.path ?? "",
        branchUpdatedAt: branch.committedAt || null,
        baseAt: base?.baseAt ?? null,
        behind: base?.behind ?? null,
        baseBranch: base?.baseBranch ?? "",
      });
      return { branch, envs, target, side };
    });

    /**
     * Lưu theo thứ tự repo trong cấu hình — một thứ tự, không phải hai.
     *
     * Ở đây từng có một lần sắp "nửa đi xa nhất trước" rồi `void computed[0]`
     * vứt kết quả đi, và ba file khác vẫn ghi chú mô tả thứ tự ấy như thể nó
     * còn hiệu lực. Cột của card do `cardStage` quyết — nó xét **mọi** nửa và
     * lấy nửa đi xa nhất — nên thứ tự lưu không cần nói gì về chuyện đó.
     */
    const ordered = orderSides(
      computed.map((c) => ({ ...c, repo: c.side.repo })),
      cfg.repos,
    );
    const head = ordered[0]!;
    const branch = head.branch;
    const sides = settle(ordered.map((c) => c.side));
    /**
     * Cột của card, từ đúng một hàm — {@link cardStage}.
     *
     * Chỗ này từng lấy `furthest.target`, tức là kết quả `stageFor` của nửa đi
     * xa nhất. Nhưng `stageFor` **bỏ qua** cột `reach: "gone"` — cố ý, vì cột
     * cuối không phải chuyện containment của một nhánh mà là chuyện của cả
     * card — nên cột cuối không bao giờ tới được đường này. Đo trên VT-526:
     * `cardStage` trả `done`, mà dòng kế hoạch vẫn nói "không đổi", và card
     * nằm lại ở `đã build staging` mãi.
     *
     * Đường branch-matched phía dưới vốn đã gọi `cardStage`, kèm hẳn một comment
     * nói rằng đường này cũng vậy. Giờ thì đúng.
     */
    const target = cardStage(sides, card?.builds ?? [], stages);
    const stage = card
      ? advanceStage(card.stage, target, stageNames, stages)
      : target;

    if (!card) {
      return {
        branch,
        issueKey,
        action: "create",
        noteId: null,
        issueKeys: cardKeys,
        currentBranch: "",
        currentStage: "",
        stage: stage || stageNames[0] || "",
        title:
          summaries[issueKey]?.summary ||
          titleFromBranch(branch.name, issueKey),
        envState: head.envs,
        landedVia: head.side.landedVia,
        sides,
      };
    }

    const sameBranch = card.branch.trim() === branch.name;
    // A pinned card that resolved to something else means the branch it was
    // pinned to is gone or renamed — never a silent re-point.
    const pinBroken =
      card.githubPinned && !pinnedHit.has(`${groupKey}#${card.repo}`);
    /**
     * Card đang trỏ vào nhánh đã biến mất ở cả GitHub lẫn clone — đổi tên nhánh.
     *
     * `conflict` sinh ra để bảo vệ một tên nhánh người dùng tự gõ khỏi bị đè.
     * Nhưng khi nhánh cũ **không còn tồn tại ở đâu cả**, cái được bảo vệ là một
     * cái tên trỏ vào hư không: card nằm im với dòng "nhánh đã xoá", nhánh mới
     * đứng chờ trong tab GitHub, và chẳng bên nào nói cho bên nào biết.
     *
     * Đo trên card 55: đổi `ctalk/bugfix/VT-3825_VT-3762` thành
     * `ctalk/bugfix/VT-3825` thì nhánh mới rơi vào `conflict`, còn card giữ
     * nguyên tên cũ — hai nửa của cùng một việc, không nửa nào sai, mà bảng
     * thì sai.
     *
     * Ghim vẫn là ngoại lệ: ghim là một quyết định tay, và quyết định tay chỉ
     * người gỡ được.
     */
    const renamed =
      !card.githubPinned &&
      card.sides.some((x) => x.repo && x.branch.trim()) &&
      card.sides.filter((x) => x.repo && x.branch.trim()).every(sideVanished);
    /**
     * Ticket của card sau lượt này.
     *
     * Đổi tên nhánh thì danh sách phải **theo nhánh mới**, không cộng dồn: tên
     * cũ `…VT-3825_VT-3762` dạy cho card cả hai mã, tên mới chỉ còn một, mà
     * card vẫn link hai ticket. Xem {@link keysAfterRename} — chỉ bỏ mã nào do
     * chính tên nhánh cũ sinh ra.
     */
    const nextKeys = renamed
      ? keysAfterRename(
          card.issueKeys,
          card.sides.flatMap((x) =>
            x.branch.trim() ? extractIssueKeys(x.branch, cfg.projectKeys) : [],
          ),
          cardKeys,
        )
      : mergedKeys(card, cardKeys);
    // Every measured field lives on a side now, so one comparison covers the
    // lot — including a request opened against the next environment, which
    // changes nothing else on the card and used to go unnoticed.
    const fresh =
      sameBranch &&
      card.repo === branch.repo &&
      serializeCardSides(card.sides) === serializeCardSides(sides) &&
      JSON.stringify(card.issueKeys) === JSON.stringify(nextKeys) &&
      !stage;

    return {
      branch,
      issueKey,
      action: fresh
        ? "match"
        : pinBroken || (card.branch.trim() && !sameBranch && !renamed)
          ? "conflict"
          : "fill",
      noteId: card.id,
      issueKeys: nextKeys,
      currentBranch: card.branch,
      currentStage: card.stage,
      stage,
      title: card.title,
      envState: head.envs,
      landedVia: head.side.landedVia,
      sides,
    };
  });

  /**
   * Card bị gỡ hẳn, không phải chỉ gạch tên.
   *
   * Ba điều kiện, và cả ba đều cần:
   *
   *  1. **mọi nửa biến mất ở cả hai nơi** — {@link sideVanished}, chứ không
   *     phải `sideGone` vốn chỉ hỏi GitHub. Xoá nhánh trên remote mà vẫn giữ
   *     dưới máy là trạng thái bình thường của việc đang làm dở.
   *  2. **không có gì để mất** — {@link cardIsEmpty}. Card có ghi chú, có bản
   *     build, có PR hay có ghim thì vẫn chỉ được gạch tên và mời dọn tay; cái
   *     mất đi ở đó không dựng lại được từ git.
   *  3. **không có nhánh nào đang thay chỗ nó** — nếu lần quét này tìm ra một
   *     nhánh mới cho chính card đó (đổi tên nhánh), card phải được trỏ lại chứ
   *     không phải bị xoá rồi dựng lại từ đầu: dựng lại là mất cột, mất lịch sử
   *     và mất chính những thứ điều kiện 2 đang giữ.
   */
  const repointed = new Set(
    rows.flatMap((r) => (r.noteId && r.action !== "match" ? [r.noteId] : [])),
  );
  const dropped: GoneCard[] = dropCards(allCards, sideVanished, repointed).map(
    goneCard,
  );
  const droppedIds = new Set(dropped.map((c) => c.id));

  const gone: GoneCard[] = allCards
    .filter((c) => {
      if (droppedIds.has(c.id)) return false;
      // Card đang được trỏ sang nhánh khác trong chính lần quét này thì không
      // phải "mất nhánh" — nhánh của nó vừa đổi tên. Để nó nằm trong danh sách
      // mời dọn là mời người dùng xoá đúng cái card vừa được chữa, bằng một nút
      // "Xoá 1 card này" đứng ngay trên dòng CẬP NHẬT của chính nó.
      if (repointed.has(c.id)) return false;
      // Every repository the fix touched, not only the first.
      //
      // This read `c.repo`/`c.branch` — the flat columns, which mirror the
      // first side — so a card whose iOS branch had been deleted was reported
      // as shipped while its SDK branch was still open and still being worked
      // on. The suggested action for this list is "clear the card", which is
      // the one action that half-finished work cannot afford.
      const owned = c.sides.filter((s) => s.repo && s.branch.trim());
      return owned.length > 0 && owned.every(sideGone);
    })
    .map(goneCard);

  // Pinned cards the key-matching above never reached.
  //
  // Pairing runs through the Jira key parsed out of a branch name, so a card
  // whose key is not that exact string is invisible to it — a card keyed
  // "VT-306" will never be found by a branch yielding "VTL-555". Matching on
  // the repo and branch it already names catches those, whether the user said
  // so by pinning a link or by renaming the key. Without it such a card simply
  // stops being updated, which is how it ends up looking like a stray beside a
  // freshly created duplicate. Searched across every branch, not just the ones
  // the identity rules claimed: pointing a card at a colleague's branch is a
  // legitimate thing to do.
  // Two sets because a card is now identified two ways. Keying this by
  // `issueKey` alone stopped working the moment ticketless cards existed: they
  // all share the empty string, so one of them in `rows` would have excluded
  // every other one from this loop.
  const claimed = new Set(
    rows.flatMap((r) => (r.issueKey ? [r.issueKey] : [])),
  );
  const claimedBranch = new Set(
    rows.map((r) => `${r.branch.repo}#${r.branch.name}`),
  );
  const byRepoBranch = new Map(branches.map((b) => [`${b.repo}#${b.name}`, b]));

  /**
   * Card cũ đang nằm trên một nhánh môi trường.
   *
   * Cổng ở `mine` phía trên chỉ chặn việc **tạo** card. Vòng này thì duyệt
   * `branches` chứ không duyệt `mine` — cố ý, để card trỏ vào nhánh của đồng
   * nghiệp vẫn được cập nhật — nên một card đã lỡ sinh ra trên `ctalk/develop`
   * vẫn được làm mới ở đây, và quét lại lần nào cũng thấy nó.
   *
   * Không lặng lẽ bỏ qua: bỏ qua thì card đứng im trên bảng với dữ liệu cũ dần,
   * tệ hơn là sai. Nó đi vào danh sách dọn được, cùng lối với {@link GoneCard}
   * — quyết định xoá vẫn là của người dùng, vì card có thể mang ghi chú.
   */
  const envCards: GoneCard[] = [];

  for (const card of allCards) {
    if (!card.repo || !card.branch.trim()) continue;
    const here = `${card.repo}#${card.branch.trim()}`;
    if (card.issueKey ? claimed.has(card.issueKey) : claimedBranch.has(here))
      continue;

    const found = byRepoBranch.get(`${card.repo}#${card.branch.trim()}`);
    if (!found) continue;

    if (envBranches.has(card.branch.trim())) {
      if (!envSkipped.includes(here)) envSkipped.push(here);
      envCards.push({
        id: card.id,
        issueKey: card.issueKey,
        title: card.title,
        branch: card.branch,
        repo: card.repo,
        stage: card.stage,
        bodyLines: card.body.split("\n").filter((l) => l.trim()).length,
        prUrl: card.prUrl,
        prState: card.sides[0]?.prs[0]?.state ?? "",
      });
      continue;
    }
    const pinned = card.sides
      .find((x) => x.repo === card.repo)
      ?.prs.find((p) => p.pinned && p.number)?.number;
    const branch = pinned ? { ...found, pr: pickPr(found.prs, pinned) } : found;

    const envs2 = envState[`${branch.repo}#${branch.name}`] ?? {};
    // A pinned card whose key its branch does not name — "VT-365" on a branch
    // reading VT-17252 — is never in `keys`, so the loop above has nothing for
    // it. Its own pinned request is the better source anyway: the user named
    // the pull request that carried this work, so that is when it landed.
    const target = stageFor(
      envs2,
      branch.pr,
      stages,
      branch.prs,
      builtBranchesOf(card),
      branch.name,
    );

    // Only this repository's side is re-measured here; the card's other sides
    // are carried through untouched. This branch of the scan exists for a card
    // whose key its branch does not name, so the loop above never saw it — and
    // it saw only the one branch the card points at.
    const mine: CardSide = {
      repo: branch.repo,
      branch: branch.name,
      prs: mergeCardPrs(
        prsForCard(branch.prs),
        card.sides.find((x) => x.repo === branch.repo)?.prs ?? [],
        livePins,
      ),
      envState: envJson(envs2),
      landedVia: via.get(`${branch.repo}#${card.issueKey}`) ?? "",
      branchGone: false,
      localAhead: branch.local?.ahead ?? 0,
      localOnly: Boolean(branch.local?.onlyLocal),
      localPath: branch.local?.path ?? "",
      branchUpdatedAt: branch.committedAt || null,
      baseAt: baseState[`${branch.repo}#${branch.name}`]?.baseAt ?? null,
      baseBranch: baseState[`${branch.repo}#${branch.name}`]?.baseBranch ?? "",
      behind: baseState[`${branch.repo}#${branch.name}`]?.behind ?? null,
    };
    /**
     * The card's other repositories, taken from the scan when it saw them.
     *
     * `best` is keyed by the ticket a *branch name* spells, which is how the
     * SDK half of this fix is found: the card is `VT-853`, its branch is
     * `ctalk/bugfix/VTL-286_VTL-610`, and the SDK branch of the same work is
     * filed under `VTL-286`. Falling back to what the card already stored
     * keeps a side the scan could not see this time.
     */
    const others = new Map<string, CardSide>();
    for (const x of card.sides) {
      if (x.repo === branch.repo) continue;
      // Carried through, but re-measured. Once a side is stored, its branch is
      // "claimed" and drops out of `best`, so nothing below would refresh it —
      // and it would keep the environment state it was first written with for
      // ever. `measure` above asks about every side of every card for exactly
      // this reason.
      const fresh = envState[`${x.repo}#${x.branch}`];
      // Local state is re-read here for the same reason `measure` re-reads the
      // environment: a claimed side never comes back through `best`, so
      // carrying it through untouched froze "chưa push" at whatever it was the
      // day the branch was first seen.
      const [withLocal] = withLocalState(
        [fresh ? { ...x, envState: envJson(fresh) } : x],
        localState,
      );
      others.set(x.repo, withLocal);
    }
    for (const k of extractIssueKeys(branch.name, cfg.projectKeys)) {
      for (const b of [...(best.get(k)?.values() ?? [])]) {
        if (b.repo === branch.repo) continue;
        const envs3 = envState[`${b.repo}#${b.name}`] ?? {};
        others.set(b.repo, {
          repo: b.repo,
          branch: b.name,
          prs: mergeCardPrs(
            prsForCard(b.prs),
            card.sides.find((x) => x.repo === b.repo)?.prs ?? [],
            livePins,
          ),
          envState: envJson(envs3),
          landedVia: via.get(`${b.repo}#${k}`) ?? "",
          branchGone: false,
          localAhead: b.local?.ahead ?? 0,
          localOnly: Boolean(b.local?.onlyLocal),
          localPath: b.local?.path ?? "",
          branchUpdatedAt: b.committedAt || null,
          baseAt: baseState[`${b.repo}#${b.name}`]?.baseAt ?? null,
          baseBranch: baseState[`${b.repo}#${b.name}`]?.baseBranch ?? "",
          behind: baseState[`${b.repo}#${b.name}`]?.behind ?? null,
        });
      }
    }

    // Least advanced first, same rule the key-matched rows use.
    const sides = settle(orderSides([mine, ...others.values()], cfg.repos));

    // One rule, one function — the same one the key-matched rows above, the
    // cheap refresh and the editor's save use.
    void target;
    const stage = advanceStage(
      card.stage,
      cardStage(sides, card.builds, stages),
      stageNames,
      stages,
    );
    const fresh =
      serializeCardSides(card.sides) === serializeCardSides(sides) && !stage;

    rows.push({
      branch,
      issueKey: card.issueKey,
      action: fresh ? "match" : "fill",
      noteId: card.id,
      issueKeys: card.issueKeys,
      currentBranch: card.branch,
      currentStage: card.stage,
      stage,
      title: card.title,
      envState: envs2,
      landedVia: mine.landedVia,
      sides,
    });
  }

  const shown = new Set(rows.map((r) => `${r.branch.repo}#${r.branch.name}`));
  const localHidden = branches
    .filter(
      (b) => (b.local?.ahead ?? 0) > 0 && !shown.has(`${b.repo}#${b.name}`),
    )
    .map((b) => ({ repo: b.repo, branch: b.name, ahead: b.local!.ahead }))
    .sort((a, b) => b.ahead - a.ahead);

  // Most recent branch first: the plan is read top-down and today's work is
  // what the user can actually verify at a glance.
  rows.sort((a, b) => b.branch.committedAt - a.branch.committedAt);

  return {
    rows,
    scanned: branches.length,
    mine: mine.length,
    mineBy: byRule,
    envSkipped,
    envCards,
    splitKeys,
    unmatched,
    unmatchedSamples,
    skipped,
    truncated,
    localOnly: localOnlyCount,
    localAheadOf: localAheadCount,
    badPaths: local.bad,
    localHidden,
    gone,
    dropped,
  };
}

/**
 * For each (repo, issue key): which environments already hold that key's work,
 * judged by the merge commit of the newest merged pull request naming it.
 *
 * A revert is disqualifying rather than merely ignored. Its merge commit sits
 * in the environment exactly like the original's, so skipping it would leave
 * the earlier merge saying "arrived" about code that has since been taken out.
 * When the newest merge for a key is a revert, the key is treated as not
 * landed at all.
 */
async function landedByKey(
  token: string,
  keys: string[],
  /** `issueKey` → `repo` → that repository's branch. */
  best: Map<string, Map<string, RemoteBranch>>,
  envs: StageConfig[],
  projectKeys: string[],
  /** `repo#key` → merge commit and head branch of a request pinned by hand. */
  pinnedMerge: Map<string, { sha: string; head: string; at: number }>,
): Promise<
  Record<string, { envs: Record<string, boolean>; via: string; at: number }>
> {
  const out: Record<
    string,
    { envs: Record<string, boolean>; via: string; at: number }
  > = {};
  if (!envs.length || !keys.length) return out;

  const repos = [
    ...new Set(keys.flatMap((k) => [...(best.get(k)?.keys() ?? [])])),
  ];

  /**
   * Mỗi repo một luồng.
   *
   * Trong một repo thì hai bước phải nối tiếp — biết PR nào đã merge rồi mới
   * hỏi được sha của nó đã nằm trong môi trường nào. Nhưng repo này không
   * biết gì về repo kia, và `out` khoá theo `repo#key` nên không đụng nhau.
   *
   * Đo trên lần quét thật: riêng "PR đã merge" tốn 3.6s, 23% cả lần quét.
   */
  await Promise.all(
    repos.map(async (repo) => {
      const prs = await fetchMergedPrs(token, repo).catch(() => []);
      if (!prs.length) return;

      // Newest merge per key wins, so a later revert displaces an earlier merge.
      const newest = new Map<string, (typeof prs)[number]>();
      for (const pr of prs) {
        const key = extractIssueKey(pr.headRefName, projectKeys);
        if (!key) continue;
        const prev = newest.get(key);
        if (!prev || pr.mergedAt > prev.mergedAt) newest.set(key, pr);
      }

      // A pinned pull request outranks everything worked out here, revert guard
      // included. The user looked at the repository and said "this is the merge
      // that carried it" — this function only ever guessed at that, and it can
      // guess wrong.
      const inRepo = keys.filter((k) => best.get(k)?.has(repo));
      const chosen = new Map<
        string,
        { sha: string; head: string; at: number }
      >();
      for (const k of inRepo) {
        const pinned = pinnedMerge.get(`${repo}#${k}`);
        if (pinned) chosen.set(k, pinned);
        else if (newest.has(k) && !isRevertBranch(newest.get(k)!.headRefName)) {
          const pr = newest.get(k)!;
          chosen.set(k, {
            sha: pr.mergeCommit,
            head: pr.headRefName,
            at: Math.floor(new Date(pr.mergedAt).getTime() / 1000) || 0,
          });
        }
      }
      const usable = [...chosen.keys()];
      if (!usable.length) return;

      const shas = [...new Set(usable.map((k) => chosen.get(k)!.sha))];
      const contained = await fetchShaContainment(
        token,
        repo,
        shas,
        envs,
      ).catch(() => ({}) as Record<string, Record<string, boolean>>);

      for (const key of usable) {
        const pick = chosen.get(key)!;
        const per = contained[pick.sha];
        // The head branch is only meaningful when it is not the card's own: a
        // branch merged under its own name did not take a detour, and saying it
        // did would invent a warning.
        if (per)
          out[`${repo}#${key}`] = {
            envs: per,
            via: pick.head === best.get(key)?.get(repo)?.name ? "" : pick.head,
            at: pick.at,
          };
      }
    }),
  );

  return out;
}

/**
 * Rows a one-click refresh may write without being read first.
 *
 * `conflict` is excluded: it overwrites a branch name typed by hand, which is
 * the one change here that destroys something, and destroying it silently on a
 * refresh button would be indefensible.
 */
/** Environments a card has a recorded build for. */
function builtBranchesOf(card: { builds: CardBuild[] } | null): string[] {
  return card ? card.builds.flatMap((b) => (b.branch ? [b.branch] : [])) : [];
}

export function safeRows(rows: PlanRow[]): PlanRow[] {
  return rows.filter((r) => r.action === "create" || r.action === "fill");
}

/**
 * Writes the chosen rows. Returns how many cards were touched.
 *
 * Takes the rows back from the client rather than re-scanning so that what is
 * applied is exactly what was reviewed — a second scan could return different
 * data and quietly apply something nobody agreed to.
 */
export function applyPlan(
  rows: PlanRow[],
  goneIds: number[] = [],
  /**
   * Card phép quét gỡ hẳn: nhánh biến mất ở cả GitHub lẫn clone, card không
   * mang ghi chú / bản build / PR / ghim nào, và không có nhánh nào thay chỗ.
   * Xoá trước khi ghi, để một card sắp bị gỡ không kịp được viết lại.
   */
  dropIds: number[] = [],
): { written: number; markedGone: number; dropped: number } {
  const dropped = dropIds.length ? deleteTaskNotes(dropIds) : 0;
  const markedGone = markBranchesGone(goneIds);

  let n = 0;
  for (const row of rows) {
    if (row.action === "match") continue;
    applyGitHubBranch({
      id: row.noteId,
      issueKey: row.issueKey,
      issueKeys: row.issueKeys,
      title: row.title,
      // Every GitHub field now travels as a side; the store derives the flat
      // columns from the first, so the two can never disagree.
      sides: row.sides,
      stage: row.stage,
    });
    n++;
  }
  return { written: n, markedGone, dropped };
}
