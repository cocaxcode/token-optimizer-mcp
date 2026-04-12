// SQLite schema — Phase 1.2
// Covers: sessions, tool_calls (with estimation_method), budgets, budget_events,
// optimization_snapshots, coach_surface_log, meta, events_fts (FTS5 external content)

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
  input_hash TEXT NOT NULL,
  tool_input_summary TEXT,
  output_bytes INTEGER NOT NULL,
  tokens_estimated INTEGER NOT NULL,
  tokens_actual INTEGER,
  duration_ms INTEGER,
  content TEXT,
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
  mode TEXT NOT NULL CHECK(mode IN ('warn', 'block')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope, scope_key)
);

CREATE TABLE IF NOT EXISTS budget_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('spend', 'warn', 'block', 'reset')),
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

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content,
  tool_name,
  source UNINDEXED,
  content='tool_calls',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS tool_calls_ai AFTER INSERT ON tool_calls BEGIN
  INSERT INTO events_fts(rowid, content, tool_name, source)
  VALUES (new.id, new.content, new.tool_name, new.source);
END;

CREATE TRIGGER IF NOT EXISTS tool_calls_ad AFTER DELETE ON tool_calls BEGIN
  INSERT INTO events_fts(events_fts, rowid, content, tool_name, source)
  VALUES('delete', old.id, old.content, old.tool_name, old.source);
END;
`
