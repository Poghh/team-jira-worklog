import "server-only";

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "app.db");

/**
 * Tables are created here rather than through drizzle-kit migrations: this is a
 * single-user local app, and a migration folder would be ceremony without
 * payoff. Every statement is IF NOT EXISTS so this is safe to run on every boot.
 */
const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS prefixes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS prefixes_label_idx ON prefixes (label);

CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  idea          TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  dod           TEXT NOT NULL DEFAULT '',
  prefixes      TEXT NOT NULL DEFAULT '[]',
  issue_type_id TEXT,
  parent_key    TEXT,
  sprint_id     INTEGER,
  story_points  INTEGER,
  start_date    TEXT,
  due_date      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS task_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  dod           TEXT NOT NULL DEFAULT '',
  prefixes      TEXT NOT NULL DEFAULT '[]',
  issue_type_id TEXT,
  story_points  INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS days_off (
  date       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS jql_presets (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  jql      TEXT NOT NULL,
  builtin  INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS report_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jira_meta_cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS jira_meta_scope_key_idx ON jira_meta_cache (scope, key);

CREATE TABLE IF NOT EXISTS report_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS report_history_date_idx ON report_history (report_date);

CREATE TABLE IF NOT EXISTS module_state (
  module_id  TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS progress_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member      TEXT NOT NULL DEFAULT '',
  report_date TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS progress_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES progress_reports(id) ON DELETE CASCADE,
  prefix     TEXT NOT NULL DEFAULT '',
  feature    TEXT NOT NULL DEFAULT '',
  document   TEXT NOT NULL DEFAULT '',
  implement  TEXT NOT NULL DEFAULT '',
  fix        TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS progress_items_report_idx ON progress_items (report_id);

CREATE TABLE IF NOT EXISTS ios_publish_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name     TEXT NOT NULL,
  build_number TEXT NOT NULL,
  group_name   TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT '',
  ok           INTEGER NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS release_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  branch_name  TEXT NOT NULL DEFAULT '',
  sub_tasks    TEXT NOT NULL DEFAULT '[]',
  product      TEXT NOT NULL DEFAULT '',
  team         TEXT NOT NULL DEFAULT '',
  environment  TEXT NOT NULL DEFAULT '',
  build_status TEXT NOT NULL DEFAULT '',
  no_branch    INTEGER NOT NULL DEFAULT 0,
  ref_id       INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
`;

/**
 * Adds a column to an existing table when it is missing. `CREATE TABLE IF NOT
 * EXISTS` never alters a table that already exists, so a new column on an old
 * table needs this. Idempotent — checked against the live schema each boot.
 */
function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  ddl: string,
) {
  const cols = (
    sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
  if (cols.includes(column)) return;

  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (error) {
    // `next build` collects page data across several worker processes, each
    // opening this database at once. They all read the same "column missing"
    // and all try to add it; the losers get "duplicate column name", which
    // means the column now exists — exactly the goal.
    if (!/duplicate column name/i.test(String(error))) throw error;
  }
}

function open() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(CREATE_TABLES);
  ensureColumn(
    sqlite,
    "release_tasks",
    "no_branch",
    "no_branch INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(sqlite, "release_tasks", "ref_id", "ref_id INTEGER");
  ensureColumn(sqlite, "drafts", "start_date", "start_date TEXT");
  ensureColumn(sqlite, "drafts", "due_date", "due_date TEXT");
  return drizzle(sqlite, { schema });
}

/**
 * Next's dev server re-evaluates modules on every hot reload, which would leak a
 * new SQLite handle each time. Stash the instance on globalThis so reloads reuse
 * one connection.
 */
const globalForDb = globalThis as unknown as {
  __jiraLogworkDb?: ReturnType<typeof open>;
};

export const db = globalForDb.__jiraLogworkDb ?? open();

if (process.env.NODE_ENV !== "production") globalForDb.__jiraLogworkDb = db;

export { schema };
