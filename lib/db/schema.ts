import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
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

/**
 * `code-review` module — one row per thing under review: a pull request, or a
 * set of documents. Rounds hang off it (one per "Review" / "Review tiếp"), and
 * findings hang off rounds.
 */
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 'pr' | 'doc' */
    kind: text("kind").notNull().default("pr"),
    /** Repo preset id from the module config; '' for a doc reviewed without code. */
    repoId: text("repo_id").notNull().default(""),
    title: text("title").notNull().default(""),
    /** GitHub PR number; null for a manual base/head pair or a doc. */
    prNumber: integer("pr_number"),
    baseRef: text("base_ref").notNull().default(""),
    headRef: text("head_ref").notNull().default(""),
    author: text("author").notNull().default(""),
    url: text("url").notNull().default(""),
    /** Free-text note from the reviewer, passed to Claude as extra context. */
    note: text("note").notNull().default(""),
    /** 'open' | 'archived' */
    status: text("status").notNull().default("open"),
    /** When the reviewer last opened the GitHub discussion — "new replies" are after this. */
    seenAt: integer("seen_at"),
    /** JSON: PRs in other repos reviewed alongside this one (SDK ↔ iOS). */
    links: text("links").notNull().default("[]"),
    /** JSON {handle, honorific}: how comments address the author; '' = default. */
    addressee: text("addressee").notNull().default(""),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("review_items_status_idx").on(t.status)],
);

export const reviewRounds = sqliteTable(
  "review_rounds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id").notNull(),
    round: integer("round").notNull().default(1),
    /** queued | preparing | running | done | failed | cancelled | lost */
    state: text("state").notNull().default("queued"),
    baseSha: text("base_sha").notNull().default(""),
    headSha: text("head_sha").notNull().default(""),
    /** Head reviewed by the previous round — the start of the incremental diff. */
    prevHeadSha: text("prev_head_sha").notNull().default(""),
    /** JSON: [{name, role, path}] — the PDFs for a doc round. */
    docs: text("docs").notNull().default("[]"),
    pid: integer("pid").notNull().default(0),
    workdir: text("workdir").notNull().default(""),
    logPath: text("log_path").notNull().default(""),
    /** 'approve' | 'request_changes' | 'comment' | '' */
    verdict: text("verdict").notNull().default(""),
    /** The general comment, ready to paste — editable by the reviewer. */
    summary: text("summary").notNull().default(""),
    message: text("message").notNull().default(""),
    /** What the Claude run reported it cost, USD — informational. */
    costUsd: real("cost_usd").notNull().default(0),
    /** Claude Code session id — `--resume` target for the follow-up chat. */
    sessionId: text("session_id").notNull().default(""),
    /** JSON: the linked PRs as this round saw them — shas, worktree, diff file. */
    links: text("links").notNull().default("[]"),
    bootAt: integer("boot_at").notNull().default(0),
    createdAt: integer("created_at").notNull().default(now),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("review_rounds_item_idx").on(t.itemId),
    index("review_rounds_state_idx").on(t.state),
  ],
);

export const reviewFindings = sqliteTable(
  "review_findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roundId: integer("round_id").notNull(),
    itemId: integer("item_id").notNull(),
    /** The finding this one continues from an earlier round, if any. */
    prevId: integer("prev_id"),
    file: text("file").notNull().default(""),
    line: integer("line"),
    endLine: integer("end_line"),
    /** Where in a document — section / page — for doc findings. */
    location: text("location").notNull().default(""),
    /** blocker | major | minor | nit */
    severity: text("severity").notNull().default("minor"),
    /** Code: free category. Doc: missing | wrong | unreasonable | mismatch. */
    category: text("category").notNull().default(""),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    /** Code lines around the finding, captured at the reviewed sha. */
    snippet: text("snippet").notNull().default(""),
    snippetStart: integer("snippet_start").notNull().default(0),
    /** Whether GitHub would accept an inline comment on this line. */
    inDiff: integer("in_diff", { mode: "boolean" }).notNull().default(false),
    /** new | carried */
    origin: text("origin").notNull().default("new"),
    /** open | fixed | partial | not_fixed | dismissed */
    status: text("status").notNull().default("open"),
    /** Claude's note on how an earlier finding was (not) addressed. */
    followNote: text("follow_note").notNull().default(""),
    /** GitHub comment this finding was posted as (review or issue comment). */
    ghCommentId: integer("gh_comment_id"),
    ghUrl: text("gh_url").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("review_findings_round_idx").on(t.roundId),
    index("review_findings_item_idx").on(t.itemId),
  ],
);

/** A turn in the reviewer ↔ Claude conversation about one round. */
export const reviewMessages = sqliteTable(
  "review_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roundId: integer("round_id").notNull(),
    /** 'user' | 'assistant' */
    role: text("role").notNull().default("user"),
    body: text("body").notNull().default(""),
    /** JSON: review changes Claude proposes; applied only on the reviewer's click. */
    changes: text("changes").notNull().default(""),
    /** running | done | failed | cancelled | lost (assistant turns) */
    state: text("state").notNull().default("done"),
    applied: integer("applied", { mode: "boolean" }).notNull().default(false),
    pid: integer("pid").notNull().default(0),
    workdir: text("workdir").notNull().default(""),
    logPath: text("log_path").notNull().default(""),
    message: text("message").notNull().default(""),
    costUsd: real("cost_usd").notNull().default(0),
    bootAt: integer("boot_at").notNull().default(0),
    createdAt: integer("created_at").notNull().default(now),
    endedAt: integer("ended_at"),
  },
  (t) => [index("review_messages_round_idx").on(t.roundId)],
);

export type ReviewItem = typeof reviewItems.$inferSelect;
export type ReviewRound = typeof reviewRounds.$inferSelect;
export type ReviewFinding = typeof reviewFindings.$inferSelect;
