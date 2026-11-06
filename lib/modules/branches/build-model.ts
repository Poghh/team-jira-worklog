import { extractIssueKeys } from "./github-model";
import { type CardBuild, type StageConfig, envSteps } from "./model";

export type { CardBuild };

/**
 * Working out what a published build actually contains.
 *
 * Pure, so the rule can be tested against real timings without a token.
 *
 * App Store Connect is the authority on what exists: it holds the build QC
 * installs. What it does not hold is a commit — a build number is all that ties
 * a build back to the code in it, and that number is a wall-clock stamp taken
 * when the build started.
 *
 * Two things about that stamp cost a rewrite to learn:
 *
 *  - **It is not always UTC.** A GitHub runner stamps UTC; a machine in the
 *    office stamps +07. Reading every stamp as UTC put a local build seven
 *    hours into the future, so nothing merged that day counted as shipped.
 *  - **Not every build comes from CI.** Builds get archived from Xcode and
 *    uploaded by hand — that is what the team's publish script is for. Matching
 *    a build to a workflow run and discarding the ones that fail to match threw
 *    away exactly those builds, and with them every card they carried.
 *
 * So the instant is anchored on `uploadedDate`, which is absolute, and a run is
 * consulted only to sharpen the answer when one exists.
 */

/** A build QC can install, and when its contents were frozen. */
export interface EnvBuild {
  /** Environment branch it represents. */
  branch: string;
  /** Build number as App Store Connect shows it. */
  build: string;
  /** Commit it built. '' when the build did not come from a run we can see. */
  sha: string;
  /**
   * When the build's contents were frozen, epoch seconds. Work merged before
   * this is in the build; work merged after it is not.
   */
  at: number;
  /**
   * The "What to Test" note, as the publish script wrote it. '' when the build
   * has not been published to testers yet — the note is written at publish time.
   */
  notes: string;
  /**
   * Apple's word on whether testers can install it: `IN_BETA_TESTING` once
   * released, `READY_FOR_BETA_SUBMISSION` while merely uploaded. Stated rather
   * than inferred from whether a note exists.
   */
  externalState: string;
}

/**
 * How long after a build starts its artefact reaches Apple.
 *
 * Measured at 15–25 minutes across this project's builds. The window has to
 * stay under an hour: resolving a stamp's time zone means finding the whole
 * hour offset that lands it inside this window, and a window of an hour or more
 * could admit two neighbouring offsets.
 */
const UPLOAD_LAG = 55 * 60;

/**
 * Assumed build duration when the stamp cannot be resolved at all.
 *
 * Deliberately longer than any real build. The error it can make is to call a
 * build older than it is, which understates what shipped — the safe direction,
 * because the cost of the other one is telling QC to test something that is not
 * there.
 */
const ASSUMED_BUILD = 60 * 60;

/** A build number read as a naive wall clock, in seconds. 0 if it is not one. */
export function parseBuildNumber(build: string): number {
  const m = build.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return 0;
  const [, y, mo, d, h, mi, se] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/**
 * The instant a stamp was taken, by finding the time zone it was written in.
 *
 * The stamp precedes the upload by less than an hour, and time zones are whole
 * hours apart at the offsets in play, so exactly one offset can put the stamp
 * inside that window. Returns 0 when none does — a stamp that is not a
 * timestamp, or a build slow enough that the window cannot be trusted.
 */
export function resolveStamp(build: string, uploadedAt: number): number {
  const naive = parseBuildNumber(build);
  if (!naive || !uploadedAt) return 0;
  for (let offset = -12; offset <= 14; offset++) {
    const at = naive - offset * 3600;
    if (at <= uploadedAt && uploadedAt - at <= UPLOAD_LAG) return at;
  }
  return 0;
}

/**
 * Every build the environment has, newest first, each with the moment its
 * contents were frozen.
 *
 * Nothing is dropped. A build with no run behind it is still a build somebody
 * can install, and the whole point of reading this channel is to know what QC
 * can get their hands on.
 */
export function joinBuilds(
  branch: string,
  runs: Array<{ sha: string; startedAt: number }>,
  builds: Array<{ version: string; uploadedAt: number }>,
): EnvBuild[] {
  const newestFirst = [...runs].sort((a, b) => b.startedAt - a.startedAt);

  const out: EnvBuild[] = [];
  for (const b of builds) {
    if (!b.uploadedAt) continue;

    // A run that started shortly before the upload is the one that produced it,
    // and it knows the commit — the only exact answer available.
    const run = newestFirst.find(
      (r) =>
        r.startedAt <= b.uploadedAt && b.uploadedAt - r.startedAt <= UPLOAD_LAG,
    );
    const stamp = resolveStamp(b.version, b.uploadedAt);

    out.push({
      branch,
      build: b.version,
      sha: run?.sha ?? "",
      at: run?.startedAt || stamp || b.uploadedAt - ASSUMED_BUILD,
      // Filled in by the caller for the one build it reports; fetching it for
      // every build in the list would be a request each.
      notes: "",
      externalState: "",
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Environments whose newest build is one the user has not been told about.
 *
 * Per environment, not per card. A build is a fact about a branch; which cards
 * it carries is an inference the board no longer makes, so the news it reports
 * is the fact.
 */
export function newBuilds(
  current: Map<string, EnvBuild>,
  seen: Record<string, string>,
): EnvBuild[] {
  const out: EnvBuild[] = [];
  for (const [branch, build] of current) {
    if (seen[branch] === build.build) continue;
    out.push(build);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Reads the stored `{envBranch: buildNumber}` blob. Bad input means "nothing seen". */
export function parseSeenBuilds(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, b] of Object.entries(v)) {
      const build = String(b).trim();
      if (k.trim() && build) out[k.trim()] = build;
    }
    return out;
  } catch {
    return {};
  }
}

/** Stable JSON, so an unchanged check compares equal. */
export function serializeSeenBuilds(map: Record<string, string>): string {
  const keys = Object.keys(map).sort();
  if (!keys.length) return "";
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, map[k]])));
}

/**
 * Which cards a build carries, according to the build itself.
 *
 * The "What to Test" note is written by whoever published the build and names
 * the tickets in it — `- CTalk: VT-17252, VT-523, VT-525`. That is a statement,
 * not a deduction, which is what makes it usable where the earlier attempts
 * were not: App Store Connect knows nothing about branches, and matching by
 * time could only ever guess.
 *
 * A note may also be prose with no keys in it ("Sync code master (hotfix)"), or
 * missing entirely. Both come back empty rather than wrong.
 */
export function buildCarries(build: EnvBuild, projectKeys: string[]): string[] {
  return build.notes ? extractIssueKeys(build.notes, projectKeys) : [];
}

/**
 * FR nào một đoạn chữ gọi tên, chuẩn hoá về `FR5`.
 *
 * Mã task không phải thứ duy nhất đi vào ghi chú "What to Test". Dòng ghi chú
 * dựng từ `taskId || description` của bảng release, nên một việc chưa có ticket
 * Jira vẫn ra được ghi chú — bằng chính tên FR của nó. Khi đó phép đọc chỉ tìm
 * `VT-123` không thấy gì, và card của việc đó không bao giờ được gắn bản build.
 *
 * FR là thứ **cả hai bên đều viết ra**: ghi chú viết `FR5`, còn tên nhánh viết
 * `ctalk/feature/VT-2583_FR5_delete_system_notice`. Nên đây là chỗ nối, không
 * phải phép đoán theo thời gian mà module này đã bỏ.
 *
 * Mọi cách đánh vần đều về một dạng, vì đo trên dữ liệu thật thì chúng khác
 * nhau ở từng chỗ viết: nhánh có `FR-4` lẫn `FR5`, tag SDK có `FR4.1`,
 * `FR5.1`, `FR5.2` — và `.1/.2` là **lần phát hành** của cùng một FR, không
 * phải FR khác, nên phần sau dấu chấm bị bỏ đi. `FR` trơ trọi không số thì
 * không phải tên của gì cả: không có số thì không nối được về nhánh nào.
 *
 * Chữ ngay trước `FR` không được là chữ cái — `…xfr4` không phải FR — nhưng số
 * thì được: tag thật viết liền `ctalkvt2583FR5.1`.
 */
export function frTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^A-Za-z])FR[-_. ]?(\d+)/gi)) {
    const token = `FR${m[2]}`;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** Mọi FR một card tự nhận: tên nhánh của mọi nửa, và tiêu đề. */
function cardFrTokens(card: {
  title: string;
  sides: Array<{ branch: string }>;
}): string[] {
  return frTokens([card.title, ...card.sides.map((s) => s.branch)].join(" "));
}

/**
 * Card nào bản build này chở, theo đúng lời ghi chú của chính nó.
 *
 * Hai đường, vì ghi chú viết bằng hai thứ tiếng:
 *
 *  - **mã task** — khớp đúng chuỗi với `issueKeys` của card. Đây là đường cũ và
 *    không đổi gì;
 *  - **tên FR** — {@link frTokens}, cho những việc chưa có ticket Jira.
 *
 * Đường FR có thêm một điều kiện mà đường mã task không cần: **FR đó chỉ đúng
 * một card nhận**. Số FR được đếm trong phạm vi một Epic, nên hai Epic đều có
 * thể có `FR5`; ghi chú chỉ viết `FR5` thì không có gì trong đó nói là Epic
 * nào. Gắn bừa một bản build cho card sai là nói với QC rằng có thứ để test mà
 * thật ra không có — đúng cái sai mà cả module này được viết để tránh — nên khi
 * một FR bị nhiều card nhận thì nó bị bỏ, y như trước khi có đường này.
 */
export function cardsInBuild<
  T extends {
    id: number;
    issueKeys: string[];
    title: string;
    sides: Array<{ branch: string }>;
  },
>(cards: readonly T[], build: EnvBuild, projectKeys: string[]): T[] {
  if (!build.notes.trim()) return [];
  const keys = new Set(buildCarries(build, projectKeys));
  const frs = new Set(frTokens(build.notes));
  if (!keys.size && !frs.size) return [];

  /** FR → card nào nhận nó. Nhiều hơn một là không ai được nhận. */
  const owners = new Map<string, number[]>();
  if (frs.size)
    for (const c of cards)
      for (const token of cardFrTokens(c)) {
        if (!frs.has(token)) continue;
        const had = owners.get(token) ?? [];
        if (!had.includes(c.id)) owners.set(token, [...had, c.id]);
      }
  const byFr = new Set(
    [...owners.values()].flatMap((ids) => (ids.length === 1 ? ids : [])),
  );

  return cards.filter(
    (c) => c.issueKeys.some((k) => keys.has(k)) || byFr.has(c.id),
  );
}

/**
 * Record a build against its own environment, forward only.
 *
 * Per environment rather than per card: a `ctalk/develop` build appearing does
 * not erase the fact that the work is already in an `integration` build, and
 * the single field this replaced did exactly that — whichever build was newest
 * won and the rest was gone. Within one environment a newer build does still
 * replace an older one, because that is the same fact restated.
 *
 * Forward only in both directions. A number typed in by hand is a deliberate
 * act — it exists precisely because a build shipped without saying what was in
 * it — so a later scan finding an older build must not overwrite it.
 */
export function mergeCardBuild(
  list: CardBuild[],
  found: { branch: string; build: string; at: number },
): CardBuild[] | null {
  const at = list.findIndex((b) => b.branch === found.branch);
  const had = at < 0 ? null : list[at];
  if (had?.build === found.build) return null;
  // A hand-typed entry carries no date; anything measured supersedes it.
  if (had && had.at && had.at >= found.at) return null;

  const next = { branch: found.branch, build: found.build, at: found.at };
  const out = at < 0 ? [...list, next] : list.map((b, i) => (i === at ? next : b));
  return sortCardBuilds(out);
}

/** By environment branch, so the same set always serializes the same way. */
function sortCardBuilds(list: CardBuild[]): CardBuild[] {
  return [...list].sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
}


export function serializeCardBuilds(list: CardBuild[]): string {
  return list.length ? JSON.stringify(sortCardBuilds(list)) : "";
}

/**
 * Read the stored list, falling back to the card's single build fields.
 *
 * The fallback is what every card looks like before this column existed, and
 * what a card hand-edited by an older build of the app keeps — so no rescan is
 * needed before a build shows up again.
 */
export function parseCardBuilds(
  raw: string,
  card: { build: string; buildBranch: string; buildAt: number },
): CardBuild[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      const out = v.flatMap((x) => {
        const o = x as Record<string, unknown>;
        return typeof o?.build === "string" && o.build
          ? [
              {
                branch: String(o.branch ?? ""),
                build: o.build,
                at: typeof o.at === "number" ? o.at : 0,
              },
            ]
          : [];
      });
      if (out.length) return sortCardBuilds(out);
    }
  } catch {
    /* fall through to the single-build fields */
  }
  return card.build
    ? [{ branch: card.buildBranch, build: card.build, at: card.buildAt }]
    : [];
}

/**
 * The one build the card's flat fields hold: the newest of the list.
 *
 * Those fields still drive the "built but not tested" warning and the tooltip,
 * both of which want a single build to name, and keeping them derived means
 * they can never drift from the list beside them.
 */
export function newestCardBuild(list: CardBuild[]): {
  build: string;
  buildBranch: string;
  buildAt: number;
} {
  const best = list.reduce<CardBuild | null>(
    (acc, b) => (!acc || b.at > acc.at ? b : acc),
    null,
  );
  return best
    ? { build: best.build, buildBranch: best.branch, buildAt: best.at }
    : { build: "", buildBranch: "", buildAt: 0 };
}
