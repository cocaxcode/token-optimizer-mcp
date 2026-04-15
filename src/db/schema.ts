// SQLite schema — Phase 1.2 (simplified: removed FTS5, input_hash, tool_input_summary, content)
// Covers: sessions, tool_calls, budgets, budget_events, optimization_snapshots, coach_surface_log, meta

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_hash TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL,
  output_bytes INTEGER NOT NULL,
  tokens_estimated INTEGER NOT NULL,
  tokens_actual INTEGER,
  duration_ms INTEGER,
  estimation_method TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_source ON tool_calls(source);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('session', 'project')),
  scope_key TEXT NOT NULL,
  limit_tokens INTEGER NOT NULL CHECK(limit_tokens > 0),
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL CHECK(mode IN ('warn')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope, scope_key)
);

CREATE TABLE IF NOT EXISTS budget_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('spend', 'warn', 'reset')),
  tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS optimization_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_surface_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  tip_id TEXT NOT NULL,
  surfaced_via TEXT NOT NULL,
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coach_surface_log_session
  ON coach_surface_log(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pending RTK rewrites. PreToolUse writes a row when it rewrites a Bash command
-- via rtk rewrite; PostToolUse consumes it to reclassify the event as source=rtk.
-- The PostToolUse hook only sees the ORIGINAL command (what Claude asked for),
-- not the command Claude Code actually executed after PreToolUse mutation. This
-- table bridges the gap so stats reflect the real RTK activity.
CREATE TABLE IF NOT EXISTS rtk_rewrites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  rewritten_to TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rtk_rewrites_lookup
  ON rtk_rewrites(session_id, command_hash, created_at DESC);
`
