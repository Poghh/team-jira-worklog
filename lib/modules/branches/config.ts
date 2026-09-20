import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { SETTING_KEYS, getSetting } from "@/lib/settings";
import { listApps } from "@/lib/modules/ios-publish/config";

import { parseSeenBuilds, serializeSeenBuilds } from "./build-model";
import {
  type GitHubConfig,
  type GitHubConfigView,
  type Identity,
} from "./github-model";
import { DEFAULT_STAGES, type StageConfig } from "./model";

/**
 * The board's columns, stored in the shared settings table under
 * `mod:branches:` so the module owns its keys without touching the core
 * SETTING_KEYS enum — same arrangement as `releases` and `ios-publish`.
 */
const PREFIX = "mod:branches:";
const K = {
  stages: `${PREFIX}stages`,
  stagesShape: `${PREFIX}stages_shape`,
  ghToken: `${PREFIX}gh_token`,
  ghRepos: `${PREFIX}gh_repos`,
  ghLogins: `${PREFIX}gh_logins`,
  ghUseEvents: `${PREFIX}gh_use_events`,
  ghLocalPaths: `${PREFIX}gh_local_paths`,
  ghRepoLabels: `${PREFIX}gh_repo_labels`,
  ghRepoColors: `${PREFIX}gh_repo_colors`,
  /** Workflow file that produces the installable build, e.g. `build.yml`. */
  ghBuildWorkflow: `${PREFIX}gh_build_workflow`,
  /** Repo those build runs live in, when it is not the repo being scanned. */
  ghBuildRepo: `${PREFIX}gh_build_repo`,
  /** `{envBranch: App Store Connect app name}` — where each build is published. */
  ghBuildApps: `${PREFIX}gh_build_apps`,
  /** `{envBranch: buildNumber}` — the last build announced for each environment. */
  ghSeenBuilds: `${PREFIX}gh_seen_builds`,
  /** Whether this team ships builds at all — the master switch for the lot. */
  ghBuildEnabled: `${PREFIX}gh_build_enabled`,
  /** Whether to watch the build channel in the background and announce it. */
  ghBuildNotify: `${PREFIX}gh_build_notify`,
} as const;

function getRaw(key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

/** Removes a row outright — used once, to retire the old core token key. */
function dropRaw(key: string) {
  db.delete(settings).where(eq(settings.key, key)).run();
}

function setRaw(key: string, value: string) {
  const stamp = Math.floor(Date.now() / 1000);
  db.insert(settings)
    .values({ key, value, updatedAt: stamp })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: stamp },
    })
    .run();
}

const EXPECTS = new Set(["", "prog", "test", "done"]);
const PHASES = new Set(["", "nopr", "open"]);
const REACHES = new Set(["queued", "merged", "built", "gone"]);

function parseStages(raw: string): StageConfig[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        name: String(s.name ?? "").trim(),
        // An unknown value means "no expectation" rather than a crash: this is
        // hand-editable JSON in a settings row.
        expects: (EXPECTS.has(String(s.expects))
          ? String(s.expects)
          : "") as StageConfig["expects"],
        branch: String(s.branch ?? "").trim(),
        phase: (PHASES.has(String(s.phase))
          ? String(s.phase)
          : "") as StageConfig["phase"],
        // `merged: true` is how the previous shape spelled it; read it so a
        // pipeline saved before the build step parses rather than silently
        // collapsing every environment to "queued".
        reach: (REACHES.has(String(s.reach))
          ? String(s.reach)
          : s.merged
            ? "merged"
            : "queued") as StageConfig["reach"],
      }))
      .filter((s) => s.name);
  } catch {
    return [];
  }
}

/**
 * Seeded once, then the user's edits win — including an emptied list, which is
 * why this checks for the key never having been written rather than for a
 * falsy value.
 */
export function getStages(): StageConfig[] {
  const raw = getRaw(K.stages);
  if (raw === undefined) {
    setRaw(K.stagesShape, SHAPES.join(" "));
    setRaw(K.stages, JSON.stringify(DEFAULT_STAGES));
    return DEFAULT_STAGES;
  }
  return migrate(parseStages(raw));
}

/**
 * The kinds of column this version of the board knows how to add, oldest
 * first, one token each.
 *
 * A set rather than a single version string. Every migration below is
 * insert-only and the user is free to delete what it added, so a marker that
 * meant "you are on version N" would put those columns back the moment
 * version N+1 shipped. A token that stays applied says the narrower, truer
 * thing: this pipeline has already been offered that column.
 */
const SHAPES = ["built-expects-test", "done-cleanup"] as const;

function appliedShapes(): Set<string> {
  return new Set((getRaw(K.stagesShape) ?? "").split(" ").filter(Boolean));
}

/**
 * Give an older pipeline the columns it predates, once each.
 *
 * Insert-only, deliberately. The board can tell that a saved pipeline predates
 * a column, but it cannot tell whether the settings on the columns that *are*
 * there were the user's decision or an old default — so it adds what is
 * missing and rewrites nothing. A user who then deletes the new columns keeps
 * them deleted: the marker is written either way.
 */
function migrate(stages: StageConfig[]): StageConfig[] {
  const applied = appliedShapes();
  if (SHAPES.every((t) => applied.has(t))) return stages;

  let out = stages;
  if (!applied.has("built-expects-test")) out = addBuildColumns(out);
  if (!applied.has("done-cleanup")) out = addDoneColumn(out);

  setRaw(K.stagesShape, SHAPES.join(" "));
  if (JSON.stringify(out) !== JSON.stringify(stages))
    setRaw(K.stages, JSON.stringify(out));
  return out;
}

/** One `đã build …` column per environment that has a merge column. */
function addBuildColumns(stages: StageConfig[]): StageConfig[] {
  const built = new Set(
    stages.filter((s) => s.reach === "built").map((s) => s.branch),
  );
  const out: StageConfig[] = [];
  for (const s of stages) {
    // Only a build makes a ticket testable, so only a build column may ask for
    // a test status. Left as it was, `đã merge integration` demanded one a
    // whole column before the build that would let anyone test — warning about
    // a ticket doing exactly the right thing. Corrected here rather than left
    // to the editor because it is this app's own earlier answer, not a choice
    // anybody made.
    out.push(
      s.branch && s.reach !== "built" && s.expects === "test"
        ? { ...s, expects: "prog" }
        : s,
    );
    if (s.reach !== "merged" || !s.branch || built.has(s.branch)) continue;
    built.add(s.branch);
    out.push({
      name: `đã build ${s.name.replace(/^đã merge /, "")}`,
      expects: "test",
      branch: s.branch,
      phase: "",
      reach: "built",
    });
  }
  return out;
}

/**
 * The terminal column, appended.
 *
 * Appended rather than inserted: it is the end of the pipeline by definition,
 * and where the user has put their own last column is not something to guess
 * at. An empty pipeline is left empty — that is a deliberate state the board
 * already respects, and a lone "done" column would be a strange thing to
 * conjure into it.
 */
function addDoneColumn(stages: StageConfig[]): StageConfig[] {
  if (!stages.length || stages.some((s) => s.reach === "gone" && !s.branch))
    return stages;
  const end = DEFAULT_STAGES.find((s) => s.reach === "gone");
  return end ? [...stages, end] : stages;
}

export function setStages(list: StageConfig[]) {
  const clean = list
    .map((s) => ({
      name: s.name.trim(),
      expects: (EXPECTS.has(s.expects)
        ? s.expects
        : "") as StageConfig["expects"],
      branch: s.branch.trim(),
      // A step with a branch is decided by containment, and the terminal step
      // by the branch being gone — a PR phase on either would be dead
      // configuration that still looks meaningful on screen.
      phase: (s.branch.trim() || s.reach === "gone"
        ? ""
        : PHASES.has(s.phase)
          ? s.phase
          : "") as StageConfig["phase"],
      // Only a step with a branch can be merged into or built from. The
      // terminal step is the exception: it has no branch precisely because
      // what it records is the branch being gone.
      reach: (s.branch.trim()
        ? s.reach
        : s.reach === "gone"
          ? "gone"
          : "queued") as StageConfig["reach"],
    }))
    .filter((s) => s.name);
  setRaw(K.stages, JSON.stringify(clean));
}

/* ------------------------------- GitHub ---------------------------------- */

/** A `{key: string}` settings blob, with blanks dropped. */
function readMap(raw: string | undefined): Record<string, string> {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      const t = String(val).trim();
      if (t) out[k] = t;
    }
    return out;
  } catch {
    return {};
  }
}

function getList(key: string): string[] {
  const raw = getRaw(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.map((v) => String(v).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/**
 * The token, owned by the module that is the only thing using it.
 *
 * It used to live in the core settings table, on the reasoning that every
 * credential should sit in one place or nobody rotates it. That reasoning did
 * not survive contact with the codebase: `ios-publish` keeps its App Store
 * Connect issuer, key id and `.p8` private key entirely in
 * `mod:ios-publish:profiles`, and the Settings screen has no App Store section
 * at all. So the one-place rule was already not the rule, and this token was
 * the exception pretending to be it.
 *
 * Read once, migrating whatever the old core key held — the value matters more
 * than where it used to be filed. `.env.local` remains the first-run seed, the
 * same one the core settings used.
 */
function readToken(): string {
  // Read as a raw row, not through `SETTING_KEYS`: the core key is gone from
  // that enum, and these lines are the only thing that still needs to know it
  // ever existed.
  const legacy = getRaw("github_token");
  const own = getRaw(K.ghToken);

  const value =
    own !== undefined
      ? own.trim()
      : (legacy ?? "").trim() || (process.env.GITHUB_TOKEN ?? "").trim();
  if (own === undefined) setRaw(K.ghToken, value);

  // Retired whenever it is still there and this module holds the value —
  // checked separately from the migration above, because a half-finished
  // upgrade can leave the row behind and a stale copy of a credential is worth
  // deleting whichever way it got left. An own key that is deliberately empty
  // is not overwritten and the old row is not resurrected.
  if (legacy !== undefined && value) dropRaw("github_token");
  return value;
}

/**
 * Which repository runs the build workflow.
 *
 * Falls back to whichever repo the user labelled `iOS`, because that is the one
 * that builds — the SDK has no build of its own. Not inferred from "has
 * workflow runs": the SDK repo has plenty, they are just lint and scanner runs.
 */
function readBuildRepo(): string {
  const own = (getRaw(K.ghBuildRepo) ?? "").trim();
  if (own) return own;
  const labels = readMap(getRaw(K.ghRepoLabels));
  return (
    Object.entries(labels).find(([, v]) => v.trim().toLowerCase() === "ios")?.[0] ??
    ""
  );
}

/**
 * The scan's settings.
 *
 * `projectKeys` is the app's own Jira project, full stop — there is no second
 * box for it any more.
 *
 * There used to be one, on the reasoning that a repository's branches can name
 * more projects than the board you work on. True here: `VT` and `VTL` both
 * appear. But the `VTL` branches all belong to another team's prefix and were
 * never this user's cards, and a branch that names no configured key still gets
 * a card now — it just gets one with no Jira link. So the box bought one thing,
 * and that thing stopped being worth a box.
 */
export function getGitHubConfig(): GitHubConfig {
  const stages = getStages();
  const fallback = (getSetting(SETTING_KEYS.jiraProjectKey) ?? "").trim();

  return {
    token: readToken(),
    stages,
    repos: getList(K.ghRepos),
    identity: {
      logins: getList(K.ghLogins),
    },
    projectKeys: fallback ? [fallback] : [],
    // Absent means never configured, which for a signal this useful should mean
    // on rather than off.
    useEvents: (getRaw(K.ghUseEvents) ?? "true") === "true",
    localPaths: getList(K.ghLocalPaths),
    repoColors: readMap(getRaw(K.ghRepoColors)),
    buildWorkflow: (getRaw(K.ghBuildWorkflow) ?? "").trim(),
    buildRepo: readBuildRepo(),
    buildApps: readMap(getRaw(K.ghBuildApps)),
    buildEnabled: readBuildEnabled(),
    buildNotify: readBuildEnabled() && readBuildNotify(readMap(getRaw(K.ghBuildApps))),
    repoLabels: readMap(getRaw(K.ghRepoLabels)),
  };
}

/**
 * Whether this board tracks builds at all.
 *
 * "Đã lên TestFlight" is the one part of this module written for a team that
 * ships a mobile app. A team using the board for branches and notes has no
 * workflow, no App Store Connect app and no build to wait for, and every box
 * about one is a question they cannot answer and a column they can never
 * reach. So the whole channel is switchable, and the notification below is a
 * setting *inside* it rather than beside it.
 *
 * Seeded from whether anything was ever configured, so an existing board keeps
 * working and a fresh one starts without it.
 */
function readBuildEnabled(): boolean {
  const raw = getRaw(K.ghBuildEnabled);
  if (raw !== undefined) return raw === "true";
  return (
    Boolean((getRaw(K.ghBuildWorkflow) ?? "").trim()) ||
    Object.keys(readMap(getRaw(K.ghBuildApps))).length > 0
  );
}

/**
 * Whether the build watcher runs, defaulting to whether there is a build
 * channel to watch.
 *
 * This module is not only for the team that ships an iOS app. A team using it
 * for branches alone has no App Store Connect app mapped to any environment,
 * so an always-on watcher would poll Apple twice an hour to be told, every
 * time, that there is nothing configured — and would put a notification
 * permission prompt in front of somebody who can never receive one.
 *
 * So the seed is derived rather than a flat `true`: configured build apps mean
 * the feature is wanted, none mean it is not. Once the user touches the switch
 * their answer is stored and wins, including turning it off on a team that
 * does publish builds.
 */
function readBuildNotify(buildApps: Record<string, string>): boolean {
  const raw = getRaw(K.ghBuildNotify);
  if (raw === undefined) return Object.keys(buildApps).length > 0;
  return raw === "true";
}

/**
 * The switch alone, for callers that need nothing else.
 *
 * The root layout mounts the watcher and has no other reason to parse the whole
 * GitHub config — half of which is lists it would throw away.
 */
export function getBuildNotify(): boolean {
  return readBuildEnabled() && readBuildNotify(readMap(getRaw(K.ghBuildApps)));
}

/** The master switch alone, for callers deciding whether to ask Apple anything. */
export function getBuildEnabled(): boolean {
  return readBuildEnabled();
}

/**
 * The config as the browser may see it — everything except the token.
 *
 * One builder rather than a hand-copied literal per call site: a new setting
 * added to {@link GitHubConfig} and forgotten in one of the copies was silently
 * absent on that screen, with nothing to fail.
 */
export function toConfigView(cfg: GitHubConfig): GitHubConfigView {
  const { token, stages, ...rest } = cfg;
  void stages;
  return {
    ...rest,
    hasToken: Boolean(token),
    // Names only, no credentials. The build-app box is free text — it has to
    // be, the name has to match App Store Connect exactly — so the screen
    // needs the list to say whether what was typed will actually resolve.
    ascApps: listApps().map((a) => a.name),
  };
}

/** Writes the settings this module's own screen owns. The token is not one of them. */
export function setGitHubConfig(input: {
  /**
   * Left out entirely when the screen is saving something else.
   *
   * The browser never receives the token — `toConfigView` sends `hasToken` and
   * nothing more — so a save that echoed back what the form held would write an
   * empty string over a working credential. `undefined` means "not editing it";
   * an empty string is a deliberate clear.
   */
  token?: string;
  repos: string[];
  identity: Identity;
  useEvents: boolean;
  localPaths: string[];
  repoLabels: Record<string, string>;
  repoColors: Record<string, string>;
  buildWorkflow: string;
  buildRepo: string;
  buildApps: Record<string, string>;
  buildEnabled: boolean;
  buildNotify: boolean;
}) {
  const clean = (xs: string[]) =>
    JSON.stringify([...new Set(xs.map((s) => s.trim()).filter(Boolean))]);

  if (input.token !== undefined) setRaw(K.ghToken, input.token.trim());

  setRaw(K.ghRepos, clean(input.repos));
  setRaw(K.ghLogins, clean(input.identity.logins));
  // Prefixes are the one list where case and the trailing slash matter, but a
  // stray space would silently match nothing.
  setRaw(K.ghUseEvents, input.useEvents ? "true" : "false");
  // Written either way, which is what turns the derived defaults above into a
  // stored answer the moment the user expresses one.
  setRaw(K.ghBuildEnabled, input.buildEnabled ? "true" : "false");
  setRaw(K.ghBuildNotify, input.buildNotify ? "true" : "false");
  setRaw(K.ghLocalPaths, clean(input.localPaths));
  setRaw(
    K.ghRepoColors,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(input.repoColors)
          .map(([k, v]) => [k, String(v).trim()])
          .filter(([, v]) => v),
      ),
    ),
  );
  setRaw(K.ghBuildWorkflow, input.buildWorkflow.trim());
  setRaw(K.ghBuildRepo, input.buildRepo.trim());
  setRaw(
    K.ghBuildApps,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(input.buildApps)
          .map(([k, v]) => [k.trim(), String(v).trim()])
          .filter(([k, v]) => k && v),
      ),
    ),
  );
  setRaw(
    K.ghRepoLabels,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(input.repoLabels)
          .map(([k, v]) => [k, String(v).trim()])
          .filter(([, v]) => v),
      ),
    ),
  );
}

/* ---------------------------- build channel ------------------------------ */

/**
 * The last build announced for each environment.
 *
 * Environment-level rather than per card. App Store Connect records nothing
 * about branches, so which cards a build carries is an inference the board no
 * longer makes; that a build exists for an environment is a fact, and this is
 * how it stops being announced twice.
 */
export function getSeenBuilds(): Record<string, string> {
  return parseSeenBuilds(getRaw(K.ghSeenBuilds) ?? "");
}

export function setSeenBuilds(map: Record<string, string>) {
  setRaw(K.ghSeenBuilds, serializeSeenBuilds(map));
}
