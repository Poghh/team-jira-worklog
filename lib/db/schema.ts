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
export type SdkReleaseRun = typeof sdkReleaseRun.$inferSelect;
