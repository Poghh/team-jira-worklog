import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%s','now'))`;

/**
 * Key/value settings. Jira and Gemini credentials live here, seeded once from
 * .env.local on first run so they can be changed in the UI without a restart.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * Title prefixes such as [Mobile] or [Support]. `position` drives the order the
 * chips render in; the order a user *clicks* them is what composes the title and
 * is not stored here.
 */
export const prefixes = sqliteTable(
  "prefixes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [uniqueIndex("prefixes_label_idx").on(t.label)],
);

/**
 * A task composed locally but not yet pushed to Jira. Once created it is deleted
 * — Jira is the source of truth from that point on, so nothing here mirrors it.
 */
export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  idea: text("idea").notNull().default(""),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  dod: text("dod").notNull().default(""),
  /** JSON array of prefix labels, in composition order. */
  prefixes: text("prefixes").notNull().default("[]"),
  issueTypeId: text("issue_type_id"),
  parentKey: text("parent_key"),
  sprintId: integer("sprint_id"),
  storyPoints: integer("story_points"),
  /** YYYY-MM-DD, kept so a draft resumes with the schedule it was given. */
  startDate: text("start_date"),
  dueDate: text("due_date"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * Reusable task templates for work that repeats every sprint.
 *
 * Separate from `drafts` because the lifecycles differ: a draft is one specific
 * task-in-progress and is deleted the moment it becomes a Jira issue, while a
 * template is applied over and over and must survive.
 */
export const taskTemplates = sqliteTable("task_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  dod: text("dod").notNull().default(""),
  /** JSON array of prefix labels, in composition order. */
  prefixes: text("prefixes").notNull().default("[]"),
  issueTypeId: text("issue_type_id"),
  storyPoints: integer("story_points"),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * Days the user was away, so the "short hours" figure reflects reality.
 *
 * Local only — Jira has no concept of the user's leave, and the team tracks it
 * elsewhere. This exists purely so the board stops reporting a day as short when
 * there was never eight hours to log.
 */
export const daysOff = sqliteTable("days_off", {
  /** Local date, YYYY-MM-DD. */
  date: text("date").primaryKey(),
  /** 'full' | 'morning' | 'afternoon' */
  kind: text("kind").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

/** Saved JQL, including the built-in presets shown on the search screen. */
export const jqlPresets = sqliteTable("jql_presets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  jql: text("jql").notNull(),
  builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
});

/** Daily-report templates. Exactly one row has `isDefault` set. */
export const reportTemplates = sqliteTable("report_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  body: text("body").notNull(),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
});

/**
 * Field ids and issue types discovered from Jira's createmeta. Cached because
 * they change rarely, but never hardcoded — ids differ per instance and per
 * project style. `scope` is the project key so a second project cannot collide.
 */
export const jiraMetaCache = sqliteTable(
  "jira_meta_cache",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    fetchedAt: integer("fetched_at").notNull().default(now),
  },
  (t) => [uniqueIndex("jira_meta_scope_key_idx").on(t.scope, t.key)],
);

/**
 * Reports already generated, kept so a past day can be reopened without
 * re-deriving it. The worklogs themselves are never copied — they stay in Jira.
 */
export const reportHistory = sqliteTable(
  "report_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Local date the report covers, as YYYY-MM-DD. */
    reportDate: text("report_date").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("report_history_date_idx").on(t.reportDate)],
);

/**
 * Which optional modules the user has switched on. A missing row means off.
 * Kept in its own table rather than a settings key so a module can grow its own
 * per-row state later (an `enabled_at` already rides along for "new since…").
 */
export const moduleState = sqliteTable("module_state", {
  moduleId: text("module_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  enabledAt: integer("enabled_at"),
});

/**
 * `progress` module — one report per member per day. Split into report + items
 * so a report reads as a unit and its feature lines keep the order they were
 * written in. Items cascade-delete with their report.
 */
export const progressReports = sqliteTable("progress_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  member: text("member").notNull().default(""),
  /** Local date the report covers, YYYY-MM-DD. */
  reportDate: text("report_date").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const progressItems = sqliteTable(
  "progress_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reportId: integer("report_id")
      .notNull()
      .references(() => progressReports.id, { onDelete: "cascade" }),
    /** Leading tag such as `FR`, rendered before the feature title. */
    prefix: text("prefix").notNull().default(""),
    feature: text("feature").notNull().default(""),
    /** Free-form progress values: `100%`, `8/11`, `Todo`, … */
    document: text("document").notNull().default(""),
    implement: text("implement").notNull().default(""),
    fix: text("fix").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("progress_items_report_idx").on(t.reportId)],
);

/**
 * `ios-publish` module — a line per submit attempt, so the page can show what
 * was pushed and when. The build binary itself lives in App Store Connect; this
 * only records the action taken against it.
 */
export const iosPublishLog = sqliteTable("ios_publish_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appName: text("app_name").notNull(),
  buildNumber: text("build_number").notNull(),
  groupName: text("group_name").notNull().default(""),
  /** externalBuildState/processingState summary at the time. */
  state: text("state").notNull().default(""),
  ok: integer("ok", { mode: "boolean" }).notNull().default(false),
  message: text("message").notNull().default(""),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * `releases` module — one row per task being tracked toward production. Which
 * environment a task has reached is a plain field the user moves by hand; there
 * is no live deployment feed. Ported from the task-tracking tool.
 */
export const releaseTasks = sqliteTable("release_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Jira key or free text, e.g. KAN-812. */
  taskId: text("task_id").notNull().default(""),
  description: text("description").notNull().default(""),
  branchName: text("branch_name").notNull().default(""),
  /** JSON array of subtask lines. */
  subTasks: text("sub_tasks").notNull().default("[]"),
  product: text("product").notNull().default(""),
  team: text("team").notNull().default(""),
  environment: text("environment").notNull().default(""),
  buildStatus: text("build_status").notNull().default(""),
  /** Marks a task with no code branch of its own (e.g. a version-only rebuild). */
  noBranch: integer("no_branch", { mode: "boolean" }).notNull().default(false),
  /** Optional id of another release task this one is derived from (e.g. the SDK task). */
  refId: integer("ref_id"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * `branches` module — one card per thing being worked on: which branch it lives
 * on, and whatever about it must not be forgotten.
 *
 * `issueKey` ties a card to a Jira issue so the task board can show it inline
 * and nothing has to be typed twice; it is empty for work with no ticket, which
 * is why the uniqueness rule on it is partial (see the raw DDL). `title` is a
 * snapshot of the summary rather than a live read — the board must render
 * without waiting on Jira, and a card outlives the issue it was copied from.
 */
export const taskNotes = sqliteTable(
  "task_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * The card's primary Jira key, and what the unique index enforces — one
     * card per ticket. '' for work with no ticket.
     */
    issueKey: text("issue_key").notNull().default(""),
    /**
     * Every ticket this card covers, as a JSON array, primary key first.
     *
     * One branch here routinely fixes two tickets
     * (`ctalk/bugfix/VTL-286_VTL-610`), and keeping only the first left the
     * second with no card. '' means "just the primary key".
     */
    issueKeys: text("issue_keys").notNull().default(""),
    title: text("title").notNull().default(""),
    branch: text("branch").notNull().default(""),
    /** Which column the card sits in — a name from the module's stage config. */
    stage: text("stage").notNull().default(""),
    /** Free text. A line starting with `-` renders as a bullet. */
    body: text("body").notNull().default(""),
    /** `owner/name` when the branch was found on GitHub, '' when typed by hand. */
    repo: text("repo").notNull().default(""),
    /** Latest PR for the branch, as GitHub last reported it. */
    prNumber: integer("pr_number"),
    prUrl: text("pr_url").notNull().default(""),
    /** OPEN | CLOSED | MERGED | DRAFT, or '' when the branch has no PR. */
    prState: text("pr_state").notNull().default(""),
    /**
     * The branch that PR is aimed at.
     *
     * Stored because it is what puts a card in a "chờ merge" column, and a
     * column the user cannot see the reason for is a column they distrust.
     */
    prBase: text("pr_base").notNull().default(""),
    /**
     * JSON list of every request the branch has, one per branch it targets.
     *
     * The four fields above stay: they are the *one* request that decides the
     * card's column and the one a pin names. This is the rest of them, kept
     * only so the card can show where the work went at each step.
     */
    prs: text("prs").notNull().default(""),
    /**
     * JSON list of one entry per repository the fix touches.
     *
     * The GitHub columns above are the *first* of these, derived on write. They
     * stay because everything outside this board reads them — the task board's
     * branch popover, the branch link, the pairing editor — and a fix in one
     * repository, which is most of them, has exactly one side.
     */
    sides: text("sides").notNull().default(""),
    /** Tip commit time from GitHub — how stale the branch is. */
    branchUpdatedAt: integer("branch_updated_at"),
    /**
     * JSON: env branch → commits the tip has that the env does not. 0 means
     * arrived, null means that env has no branch in this repo.
     */
    envState: text("env_state").notNull().default(""),
    /** Head branch of the pull request that carried the work in, when it was
     * not this card's own branch — usually a `resolve_*` branch. */
    landedVia: text("landed_via").notNull().default(""),
    /**
     * Set when a scan looked for this branch and GitHub no longer had it —
     * normally because the work shipped and the branch was deleted on release.
     */
    branchGone: integer("branch_gone", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * The user corrected the GitHub link by hand. A scan may still refresh the
     * PR and environment data, but must not re-point the card at a different
     * branch or repo — that correction was the whole reason the field exists.
     */
    githubPinned: integer("github_pinned", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Commits sitting in the local clone that the server has not seen. */
    localAhead: integer("local_ahead").notNull().default(0),
    /** The branch exists only on this machine — never pushed. */
    localOnly: integer("local_only", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Which clone the local branch was read from — this machine has four. */
    localPath: text("local_path").notNull().default(""),
    /**
     * Where this card's ticket lives, when the derived link would be wrong.
     *
     * The board builds `{jiraBaseUrl}/browse/{issueKey}` by default, which
     * breaks on the two shapes this board actually holds: a key from a project
     * the app is not pointed at, and a hand-written key that is not a key at
     * all ("VT-365 REFS: VT-17252").
     */
    jiraUrl: text("jira_url").notNull().default(""),
    /**
     * JSON `{issueKey: url}` — one override per ticket the card covers.
     *
     * A card naming two tickets routinely names them in two different Jira
     * projects, and `jira_url` could only ever speak for the first. Kept
     * alongside it rather than replacing it so rows written before this still
     * open the link they were given.
     */
    jiraUrls: text("jira_urls").notNull().default(""),
    /**
     * Build number this card's work shipped in, e.g. `20260904113038`.
     *
     * Written from the build's own "What to Test" note, which names the tickets
     * it carries — the only account of a build's contents that is stated rather
     * than inferred. Typed by hand when a build went out without that note.
     */
    build: text("build").notNull().default(""),
    /** Environment that build belongs to, for showing it next to the number. */
    buildBranch: text("build_branch").notNull().default(""),
    /** When the build's contents were frozen, so a newer build can win. */
    buildAt: integer("build_at").notNull().default(0),
    /**
     * JSON list of one build per environment.
     *
     * The three fields above are the newest entry of this list, derived on
     * every write. They stay because the warning and the tooltip each want a
     * single build to name, and deriving them means they cannot drift.
     */
    builds: text("builds").notNull().default(""),
    /** When a GitHub scan last wrote to this card. Null for hand-made cards. */
    syncedAt: integer("synced_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("task_notes_stage_idx").on(t.stage)],
);

/**
 * `sdk-release` module — one row per attempt to release the iOS SDK.
 *
 * Written before the process exists and updated by reaping rather than by the
 * process itself: the build outlives the request that started it, and often the
 * dev server too, so nothing in this app can be relied on to be listening when
 * it ends. `state` is therefore reconstructed from the pid, the boot time and a
 * status file — see `lib/modules/sdk-release/runner.ts`.
 */
export const sdkReleaseRun = sqliteTable(
  "sdk_release_run",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The string handed to `swift run release --version`. */
    version: text("version").notNull().default(""),
    /** Branch the SDK repo was standing on — the tool reads HEAD, not a flag. */
    branch: text("branch").notNull().default(""),
    commitSha: text("commit_sha").notNull().default(""),
    suffix: text("suffix").notNull().default(""),
    ordinal: integer("ordinal").notNull().default(0),
    /** `--local-only`: builds in full, mocks GitHub, still commits locally. */
    localOnly: integer("local_only", { mode: "boolean" }).notNull().default(false),
    /** running | ok | failed | cancelled | lost — `RunState` in the model. */
    state: text("state").notNull().default("running"),
    pid: integer("pid").notNull().default(0),
    /** Process group, so cancelling takes `swift → cargo → rustc` down whole. */
    pgid: integer("pgid").notNull().default(0),
    logPath: text("log_path").notNull().default(""),
    exitCode: integer("exit_code"),
    /** Furthest phase seen in the log — decides what "cancel" means right now. */
    phase: text("phase").notNull().default(""),
    message: text("message").notNull().default(""),
    /**
     * What the remote actually shows afterwards, as JSON.
     *
     * The exit code is not the question the user has. A run can exit non-zero
     * having already pushed, and a `lost` run may have done anything at all —
     * so the outcome is checked against GitHub rather than inferred.
     */
    verified: text("verified").notNull().default(""),
    /** `origin/main` of the swift repo when the run started — the watcher's baseline. */
    mainSha: text("main_sha").notNull().default(""),
    /** Boot time when the row was written; see the raw DDL for why. */
    bootAt: integer("boot_at").notNull().default(0),
    startedAt: integer("started_at").notNull().default(now),
    endedAt: integer("ended_at"),
  },
  (t) => [index("sdk_release_run_state_idx").on(t.state)],
);

export type Setting = typeof settings.$inferSelect;
export type Prefix = typeof prefixes.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type TaskTemplate = typeof taskTemplates.$inferSelect;
export type DayOff = typeof daysOff.$inferSelect;
export type JqlPreset = typeof jqlPresets.$inferSelect;
export type ReportTemplate = typeof reportTemplates.$inferSelect;
export type ModuleState = typeof moduleState.$inferSelect;
export type ProgressReport = typeof progressReports.$inferSelect;
export type ProgressItem = typeof progressItems.$inferSelect;
export type IosPublishLog = typeof iosPublishLog.$inferSelect;
export type ReleaseTask = typeof releaseTasks.$inferSelect;
export type TaskNote = typeof taskNotes.$inferSelect;
export type SdkReleaseRun = typeof sdkReleaseRun.$inferSelect;
