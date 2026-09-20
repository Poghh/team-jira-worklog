import "server-only";

import {
  type EnvState,
  type PullRequest,
  type RemoteBranch,
  pickPr,
} from "./github-model";

const API = "https://api.github.com/graphql";
const REST = "https://api.github.com";

class GitHubError extends Error {}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      // GitHub rejects requests without one, and a named agent makes this app
      // identifiable in the org's audit log rather than anonymous traffic.
      "user-agent": "team-jira-worklog",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (res.status === 401)
    throw new GitHubError("Token GitHub không hợp lệ hoặc đã hết hạn");
  if (!res.ok)
    throw new GitHubError(
      `GitHub trả về ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );

  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string; type?: string }>;
  };
  if (json.errors?.length) {
    // A repo the token cannot see errors per-alias while the rest of the batch
    // succeeds. Surfacing that as a hard failure would let one stale entry in
    // the repo list block every other repo, so it is reported and skipped by
    // the caller instead.
    const fatal = json.errors.filter((e) => e.type !== "NOT_FOUND");
    if (fatal.length || !json.data)
      throw new GitHubError(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new GitHubError("GitHub không trả về dữ liệu");
  return json.data;
}

async function rest<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${REST}${path}`, {
    headers: {
      authorization: `bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "team-jira-worklog",
    },
    cache: "no-store",
  });
  if (res.status === 401)
    throw new GitHubError("Token GitHub không hợp lệ hoặc đã hết hạn");
  if (!res.ok) throw new GitHubError(`GitHub trả về ${res.status} cho ${path}`);
  return (await res.json()) as T;
}

/** The account the token belongs to — seeds the identity list on first setup. */
export async function fetchViewer(
  token: string,
): Promise<{ login: string; name: string; email: string; orgs: string[] }> {
  const data = await graphql<{
    viewer: {
      login: string;
      name: string | null;
      email: string | null;
      organizations: { nodes: Array<{ login: string }> };
    };
  }>(
    token,
    `
      query {
        viewer {
          login
          name
          email
          organizations(first: 50) {
            nodes {
              login
            }
          }
        }
      }
    `,
    {},
  );
  return {
    login: data.viewer.login,
    name: data.viewer.name ?? "",
    email: data.viewer.email ?? "",
    orgs: data.viewer.organizations.nodes.map((o) => o.login),
  };
}

/** Repos under an owner, most recently pushed first — the repo picker's list. */
export async function fetchRepos(
  token: string,
  owner: string,
): Promise<string[]> {
  const list = await rest<Array<{ full_name: string }>>(
    token,
    `/orgs/${encodeURIComponent(owner)}/repos?sort=pushed&per_page=100`,
  ).catch(async () =>
    // Not an org — a personal account keeps its repos under /users/:name.
    rest<Array<{ full_name: string }>>(
      token,
      `/users/${encodeURIComponent(owner)}/repos?sort=pushed&per_page=100`,
    ),
  );
  return list.map((r) => r.full_name);
}

const REF_FIELDS = `
  name
  target { ... on Commit {
    committedDate
    author { email user { login } }
  } }
  associatedPullRequests(first:10) {
    nodes { number url state isDraft baseRefName }
  }`;

interface RefNode {
  name: string;
  target: {
    committedDate?: string;
    author?: { email?: string | null; user?: { login?: string } | null };
  } | null;
  associatedPullRequests: {
    nodes: Array<{
      number: number;
      url: string;
      state: string;
      isDraft: boolean;
      baseRefName: string;
    }>;
  };
}

/**
 * Branches the user created or pushed to, from their own event feed.
 *
 * This is the only thing GitHub offers that answers "a branch *I* made". A ref
 * carries no creator, and the tip commit's author is a different question with
 * a different answer: branch off `develop`, push before writing anything, and
 * the tip belongs to whoever last touched `develop`. The event feed records the
 * actor, so it catches that branch on the first push.
 *
 * Bounded by GitHub to roughly the last 300 events (about three weeks of work
 * here), so it *adds* recent branches rather than replacing the author rules —
 * older work would fall off the board if this were the only signal.
 *
 * Returns keys shaped `owner/repo#branch`.
 */
export async function fetchPushedBranches(
  token: string,
  logins: string[],
): Promise<Set<string>> {
  const out = new Set<string>();

  for (const login of logins) {
    const who = login.trim();
    if (!who) continue;

    for (let page = 1; page <= 3; page++) {
      // A login that does not exist, or a feed the token cannot read, must not
      // fail the scan — the author rules still work without this.
      const events = await rest<
        Array<{
          type: string;
          repo?: { name?: string };
          payload?: { ref?: string | null; ref_type?: string };
        }>
      >(
        token,
        `/users/${encodeURIComponent(who)}/events?per_page=100&page=${page}`,
      ).catch(() => null);

      if (!events?.length) break;

      for (const e of events) {
        const repo = e.repo?.name;
        const raw = e.payload?.ref;
        if (!repo || !raw) continue;

        if (e.type === "CreateEvent" && e.payload?.ref_type === "branch")
          out.add(`${repo}#${raw}`);
        else if (e.type === "PushEvent")
          out.add(`${repo}#${raw.replace(/^refs\/heads\//, "")}`);
      }

      if (events.length < 100) break;
    }
  }

  return out;
}

/** Hard stop per repo, so a runaway repo cannot hang a scan. */
const MAX_REFS_PER_REPO = 1000;

/**
 * Every branch in each repo.
 *
 * Paginated to exhaustion rather than capped at the first page, because a cap
 * here does not degrade gracefully — it silently drops work and reads as "you
 * have no branches". Measured on this org: `viptalk-ios-x` has 149 branches of
 * which 33 are `ctalk/*`, and not one of those 33 falls in the 100 most
 * recently committed. A one-page fetch found none of the user's own work there
 * while reporting a perfectly successful scan.
 *
 * One repo at a time, since a cursor cannot be shared across aliased repos.
 * That costs a round trip per page, which is the right trade against being
 * quietly wrong.
 */
export async function fetchBranches(
  token: string,
  repos: string[],
): Promise<{
  branches: RemoteBranch[];
  skipped: string[];
  truncated: string[];
}> {
  const branches: RemoteBranch[] = [];
  const skipped: string[] = [];
  const truncated: string[] = [];

  for (const full of repos) {
    const [owner, name] = full.split("/");
    if (!owner || !name) {
      skipped.push(full);
      continue;
    }

    let cursor: string | null = null;
    let seen = 0;
    let alive = true;

    while (alive && seen < MAX_REFS_PER_REPO) {
      const data: {
        repository: {
          nameWithOwner: string;
          refs: {
            nodes: RefNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } = await graphql(
        token,
        `query($owner: String!, $name: String!, $after: String) {
           repository(owner: $owner, name: $name) {
             nameWithOwner
             refs(refPrefix: "refs/heads/", first: 100, after: $after,
                  orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
               nodes { ${REF_FIELDS} }
               pageInfo { hasNextPage endCursor }
             }
           }
         }`,
        { owner, name, after: cursor },
      );

      const repo = data.repository;
      if (!repo) {
        skipped.push(full);
        break;
      }

      for (const ref of repo.refs.nodes) {
        const prs: PullRequest[] = ref.associatedPullRequests.nodes.map(
          (p) => ({
            number: p.number,
            url: p.url,
            state: p.state,
            isDraft: p.isDraft,
            baseRefName: p.baseRefName,
          }),
        );
        branches.push({
          repo: repo.nameWithOwner,
          name: ref.name,
          committedAt: ref.target?.committedDate
            ? Math.floor(new Date(ref.target.committedDate).getTime() / 1000)
            : 0,
          login: ref.target?.author?.user?.login ?? "",
          email: ref.target?.author?.email ?? "",
          prs,
          pr: pickPr(prs),
        });
      }

      seen += repo.refs.nodes.length;
      alive = repo.refs.pageInfo.hasNextPage;
      cursor = repo.refs.pageInfo.endCursor;
    }

    // Reported rather than swallowed: a scan that stopped early must say so,
    // which is the whole lesson of the bug this pagination replaced.
    if (alive && seen >= MAX_REFS_PER_REPO) truncated.push(full);
  }

  return { branches, skipped, truncated };
}

/**
 * Just the pull requests of branches the board already has cards for.
 *
 * The cheap half of a scan. {@link fetchBranches} walks every ref in the
 * repository a hundred at a time because it is looking for branches nobody has
 * a card for yet; this looks up a dozen refs by name and asks only what their
 * requests are. Nothing is discovered and nothing is measured, so it is cheap
 * enough to run on a timer while a full scan is not.
 *
 * A ref that no longer exists comes back absent rather than empty — a deleted
 * branch must not be reported as a branch whose requests all vanished, which
 * would clear a card's PR fields on the strength of a normal release.
 */
export async function fetchBranchPrs(
  token: string,
  items: Array<{ repo: string; branch: string }>,
): Promise<Map<string, PullRequest[]>> {
  const out = new Map<string, PullRequest[]>();
  if (!items.length) return out;

  const byRepo = new Map<string, string[]>();
  for (const it of items) {
    if (!byRepo.has(it.repo)) byRepo.set(it.repo, []);
    byRepo.get(it.repo)!.push(it.branch);
  }

  for (const [repo, branchNames] of byRepo) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) continue;

    const chunkSize = 20;
    for (let i = 0; i < branchNames.length; i += chunkSize) {
      const chunk = branchNames.slice(i, i + chunkSize);
      const vars: Record<string, unknown> = { owner, name };
      const decls = ["$owner: String!", "$name: String!"];
      const fields = chunk.map((branch, bi) => {
        vars[`h${bi}`] = `refs/heads/${branch}`;
        decls.push(`$h${bi}: String!`);
        return `b${bi}: ref(qualifiedName: $h${bi}) {
                  associatedPullRequests(first: 10) {
                    nodes { number url state isDraft baseRefName }
                  }
                }`;
      });

      const data = await graphql<{
        repository: Record<
          string,
          {
            associatedPullRequests: {
              nodes: Array<{
                number: number;
                url: string;
                state: string;
                isDraft: boolean;
                baseRefName: string;
              }>;
            };
          } | null
        > | null;
      }>(
        token,
        `query(${decls.join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join("\n")} } }`,
        vars,
      );

      chunk.forEach((branch, bi) => {
        const ref = data.repository?.[`b${bi}`];
        if (!ref) return;
        out.set(
          `${repo}#${branch}`,
          ref.associatedPullRequests.nodes.map((pr) => ({
            number: pr.number,
            url: pr.url,
            state: pr.state,
            isDraft: pr.isDraft,
            baseRefName: pr.baseRefName,
          })),
        );
      });
    }
  }

  return out;
}

/**
 * How far each branch is from each environment.
 *
 * Answers "where has this code actually got to", which is not the same question
 * as "what happened to its PR" — this org has a PR closed without merging whose
 * commits are nonetheless sitting in `ctalk/develop`, and a branch whose PR
 * merged weeks ago but which has since grown six commits that are in no
 * environment at all. Only containment gets both of those right.
 *
 * One GraphQL request per (repo, chunk of branches), with every environment
 * aliased in — comparing serially would be branches × environments round trips
 * for something read on every scan.
 */
export async function fetchEnvState(
  token: string,
  items: Array<{ repo: string; branch: string }>,
  envs: Array<{ branch: string }>,
): Promise<Record<string, EnvState>> {
  const out: Record<string, EnvState> = {};
  if (!envs.length || !items.length) return out;

  // Grouped by repo because the environment refs are per-repository: the same
  // `develop` is a different branch in a different repo.
  const byRepo = new Map<string, string[]>();
  for (const it of items) {
    if (!byRepo.has(it.repo)) byRepo.set(it.repo, []);
    byRepo.get(it.repo)!.push(it.branch);
  }

  for (const [repo, branchNames] of byRepo) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) continue;

    const chunkSize = 8;
    for (let i = 0; i < branchNames.length; i += chunkSize) {
      const chunk = branchNames.slice(i, i + chunkSize);
      const vars: Record<string, unknown> = { owner, name };
      const decls = ["$owner: String!", "$name: String!"];
      const fields: string[] = [];

      chunk.forEach((branch, bi) => {
        vars[`h${bi}`] = branch;
        decls.push(`$h${bi}: String!`);
        envs.forEach((env, ei) => {
          // `ref` is null when the environment has no branch here — android-x
          // has no `ctalk/develop` — and that stays null rather than becoming a
          // spurious "has not arrived".
          fields.push(
            `b${bi}e${ei}: ref(qualifiedName: "refs/heads/${env.branch.replace(/"/g, "")}") {
               compare(headRef: $h${bi}) { aheadBy }
             }`,
          );
        });
      });

      const data = await graphql<
        Record<string, unknown> & {
          repository: Record<
            string,
            { compare: { aheadBy: number } | null } | null
          >;
        }
      >(
        token,
        `query(${decls.join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join("\n")} } }`,
        vars,
      );

      chunk.forEach((branch, bi) => {
        const state: EnvState = {};
        envs.forEach((env, ei) => {
          const cell = data.repository?.[`b${bi}e${ei}`];
          state[env.branch] = {
            ahead: cell?.compare ? cell.compare.aheadBy : null,
          };
        });
        out[`${repo}#${branch}`] = state;
      });
    }
  }

  return out;
}

/** A merged pull request, reduced to what decides whether its work reached an environment. */
export interface MergedPr {
  number: number;
  headRefName: string;
  mergedAt: string;
  mergeCommit: string;
}

/**
 * Recently merged pull requests in a repo, newest first.
 *
 * Read wholesale and matched to Jira keys locally rather than searched per key:
 * the search API costs a request per key and answers with the same rows this
 * one query already returns.
 */
export async function fetchMergedPrs(
  token: string,
  repo: string,
  pages = 2,
): Promise<MergedPr[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return [];

  const out: MergedPr[] = [];
  let cursor: string | null = null;

  for (let i = 0; i < pages; i++) {
    const data: {
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            headRefName: string;
            mergedAt: string | null;
            mergeCommit: { oid: string } | null;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await graphql(
      token,
      `
        query ($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              states: MERGED
              first: 100
              after: $after
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              nodes {
                number
                headRefName
                mergedAt
                mergeCommit {
                  oid
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { owner, name, after: cursor },
    );

    const prs = data.repository?.pullRequests;
    if (!prs) break;
    for (const n of prs.nodes) {
      if (n.mergedAt && n.mergeCommit) {
        out.push({
          number: n.number,
          headRefName: n.headRefName,
          mergedAt: n.mergedAt,
          mergeCommit: n.mergeCommit.oid,
        });
      }
    }
    if (!prs.pageInfo.hasNextPage) break;
    cursor = prs.pageInfo.endCursor;
  }

  return out;
}

/**
 * Whether each commit is contained in each environment.
 *
 * The same `compare` used for branches, aimed at a merge commit instead. That
 * is what makes the content answer cheap: a merge commit is in an environment
 * or it is not, and no patches need reading to find out.
 */
export async function fetchShaContainment(
  token: string,
  repo: string,
  shas: string[],
  envs: Array<{ branch: string }>,
): Promise<Record<string, Record<string, boolean>>> {
  const out: Record<string, Record<string, boolean>> = {};
  const [owner, name] = repo.split("/");
  if (!owner || !name || !shas.length || !envs.length) return out;

  const chunkSize = 8;
  for (let i = 0; i < shas.length; i += chunkSize) {
    const chunk = shas.slice(i, i + chunkSize);
    const vars: Record<string, unknown> = { owner, name };
    const decls = ["$owner: String!", "$name: String!"];
    const fields: string[] = [];

    chunk.forEach((sha, si) => {
      vars[`s${si}`] = sha;
      decls.push(`$s${si}: String!`);
      envs.forEach((env, ei) => {
        fields.push(
          `c${si}e${ei}: ref(qualifiedName: "refs/heads/${env.branch.replace(/"/g, "")}") {
             compare(headRef: $s${si}) { aheadBy }
           }`,
        );
      });
    });

    const data = await graphql<{
      repository: Record<
        string,
        { compare: { aheadBy: number } | null } | null
      >;
    }>(
      token,
      `query(${decls.join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join("\n")} } }`,
      vars,
    );

    chunk.forEach((sha, si) => {
      const per: Record<string, boolean> = {};
      envs.forEach((env, ei) => {
        const cell = data.repository?.[`c${si}e${ei}`];
        per[env.branch] = cell?.compare ? cell.compare.aheadBy === 0 : false;
      });
      out[sha] = per;
    });
  }

  return out;
}

/**
 * A pull request looked up by number, with what it merged and where from.
 *
 * `headRefName` is how the board can say "your work went in through
 * resolve_VTL-286_develop" rather than guessing at why the SHAs differ.
 */
export interface PinnedPr extends PullRequest {
  headRefName: string;
  mergeCommit: string | null;
  /** ISO timestamp, '' when the request never merged. */
  mergedAt: string;
}

/**
 * Pull requests fetched by number, whatever branch they belong to.
 *
 * Needed because a pinned pull request often is *not* one of its card's branch
 * associations. This team merges through a resolve branch: the work on
 * `ctalk/bugfix/VTL-286_VTL-610` reached `ctalk/develop` via #1322, whose head
 * is `ctalk/task/resolve_VTL-286_VTL-610_ctalk_develop`. GitHub links #1322 to
 * the resolve branch only, so looking for it among the feature branch's own
 * pull requests finds nothing and the pin is silently discarded.
 */
export async function fetchPrsByNumber(
  token: string,
  repo: string,
  numbers: number[],
): Promise<Record<number, PinnedPr>> {
  const out: Record<number, PinnedPr> = {};
  const [owner, name] = repo.split("/");
  const wanted = [
    ...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0)),
  ];
  if (!owner || !name || !wanted.length) return out;

  const chunkSize = 20;
  for (let i = 0; i < wanted.length; i += chunkSize) {
    const chunk = wanted.slice(i, i + chunkSize);
    const fields = chunk
      .map(
        (n, k) =>
          `p${k}: pullRequest(number: ${n}) { number url state isDraft baseRefName headRefName mergedAt mergeCommit { oid } }`,
      )
      .join("\n");

    const data = await graphql<{
      repository: Record<
        string,
        {
          number: number;
          url: string;
          state: string;
          isDraft: boolean;
          baseRefName: string;
          headRefName: string;
          mergedAt: string | null;
          mergeCommit: { oid: string } | null;
        } | null
      > | null;
    }>(
      token,
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) { ${fields} }
      }`,
      { owner, name },
    ).catch(() => null);

    chunk.forEach((n, k) => {
      const pr = data?.repository?.[`p${k}`];
      if (pr) {
        out[n] = {
          number: pr.number,
          url: pr.url,
          state: pr.state,
          isDraft: pr.isDraft,
          baseRefName: pr.baseRefName,
          headRefName: pr.headRefName,
          mergedAt: pr.mergedAt ?? "",
          mergeCommit: pr.mergeCommit?.oid ?? null,
        };
      }
    });
  }

  return out;
}

/** One successful run of the build workflow, and what it built. */
export interface BuildRun {
  /** Commit it built. */
  sha: string;
  /** When the run started, epoch seconds. */
  startedAt: number;
}

/**
 * Successful runs of the build workflow on one branch, newest first.
 *
 * REST rather than GraphQL: the v4 schema exposes check suites, not workflow
 * runs, and a check suite does not carry the run's start time — which is the
 * only thing that ties a run to the App Store Connect build it produced.
 */
/**
 * Lines that mean "this workflow packages the app itself".
 *
 * Measured against the twelve active workflows of the iOS repo: matching on
 * mentions of fastlane or `.ipa` leaves three candidates, because `release.yml`
 * attaches the artefact and `unit_tests.yml` runs fastlane for tests. What
 * separates the build from both is that it *produces* the archive rather than
 * referring to one.
 */
const PACKAGES_APP =
  /fastlane\s+deploy|xcodebuild\s+.*archive|exportArchive|out\/[\w.${}-]*\.ipa/im;

/** A workflow that only delegates — `release.yml` calling `build.yml`. */
const DELEGATES = /uses:\s*\.\/\.github\/workflows\//;

/**
 * The workflow that produces the installable build, found by reading the repo.
 *
 * There is no conventional filename to guess — `build.yml` is this team's
 * choice, not a GitHub default — and no field in the API says which workflow
 * ships something. But the YAML does say it, and reading it is decisive where
 * counting runs was not: filtering by "has runs on an environment branch"
 * matched eight of the twelve, `sonarqube.yml` more often than the build, while
 * the rule above matches exactly one.
 *
 * `null` when no workflow matches or more than one does. The caller then asks,
 * rather than picking the first and being quietly wrong.
 */
export async function detectBuildWorkflow(
  token: string,
  repo: string,
): Promise<string | null> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;

  const body = await rest<{
    workflows?: Array<{ path?: string; state?: string }>;
  }>(token, `/repos/${owner}/${name}/actions/workflows?per_page=100`);

  const paths = (body.workflows ?? [])
    .filter((w) => w.state === "active" && w.path)
    .map((w) => w.path!);

  const hits: string[] = [];
  for (const path of paths) {
    // The JSON contents endpoint rather than the raw media type, so this goes
    // through the shared helper that carries the user-agent and turns an
    // expired token into a spoken error instead of an empty answer.
    let file: { content?: string; encoding?: string };
    try {
      file = await rest(token, `/repos/${owner}/${name}/contents/${path}`);
    } catch {
      continue;
    }
    if (file.encoding !== "base64" || !file.content) continue;
    const yaml = Buffer.from(file.content, "base64").toString("utf8");
    if (PACKAGES_APP.test(yaml) && !DELEGATES.test(yaml))
      hits.push(path.replace(/^\.github\/workflows\//, ""));
  }

  return hits.length === 1 ? hits[0] : null;
}

export async function fetchBuildRuns(
  token: string,
  repo: string,
  workflow: string,
  branch: string,
  limit = 20,
): Promise<BuildRun[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !workflow || !branch) return [];

  // Through the shared helper, not a hand-rolled fetch: it is the one that
  // sends the user-agent GitHub asks for and turns a 401 into "token hết hạn"
  // rather than an empty result. Swallowing the failure here made an expired
  // token look like "no builds" on this one path and like an error everywhere
  // else. The caller already catches.
  const body = await rest<{
    workflow_runs?: Array<{
      head_sha?: string;
      head_branch?: string;
      run_started_at?: string;
    }>;
  }>(
    token,
    `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
      `?branch=${encodeURIComponent(branch)}&status=success&per_page=${Math.min(limit, 100)}`,
  );

  return (body.workflow_runs ?? [])
    .map((r) => ({
      sha: r.head_sha ?? "",
      startedAt: Math.floor(new Date(r.run_started_at ?? 0).getTime() / 1000),
    }))
    .filter((r) => r.sha && r.startedAt > 0)
    .sort((a, b) => b.startedAt - a.startedAt);
}
