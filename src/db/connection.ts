// getDb() singleton with WAL + FK — Phase 1.3

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { SCHEMA_SQL } from './schema.js'

type DB = Database.Database

let dbInstance: DB | null = null
let currentPath: string | null = null

/**
 * Migrate legacy tool_calls schema to the current simplified one.
 *
 * DBs created before Phase 1.2 had: input_hash TEXT NOT NULL, tool_input_summary TEXT, content TEXT,
 * plus FTS5 virtual table events_fts with AFTER INSERT/DELETE triggers referencing `content`.
 *
 * The current code no longer passes input_hash or content, so inserts on legacy DBs fail silently
 * with "NOT NULL constraint failed: tool_calls.input_hash" — data is lost, droppedEvents counter grows.
 *
 * This migration rebuilds tool_calls with the current schema, preserving historical rows.
 */
function migrateLegacyToolCallsSchema(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info('tool_calls')`).all() as Array<{ name: string }>
  if (cols.length === 0) return // table didn't exist yet, SCHEMA_SQL just created it clean
  const hasInputHash = cols.some((c) => c.name === 'input_hash')
  if (!hasInputHash) return // already migrated

  // Drop FTS5 triggers that reference `content` before we touch the table
  db.exec(`
    DROP TRIGGER IF EXISTS tool_calls_ai;
    DROP TRIGGER IF EXISTS tool_calls_ad;
    DROP TABLE IF EXISTS events_fts;
  `)

  // Rebuild tool_calls with the new schema. Wrap in a transaction for atomicity.
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE tool_calls_new (
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
      INSERT INTO tool_calls_new (
        id, session_id, tool_name, source, output_bytes,
        tokens_estimated, tokens_actual, duration_ms, estimation_method, created_at
      )
      SELECT id, session_id, tool_name, source, output_bytes,
             tokens_estimated, tokens_actual, duration_ms, estimation_method, created_at
      FROM tool_calls;
      DROP TABLE tool_calls;
      ALTER TABLE tool_calls_new RENAME TO tool_calls;
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_source ON tool_calls(source);
    `)
  })
  migrate()
}

/** Add shadow_delta_tokens column to existing DBs that were created before Sprint C. */
function migrateAddShadowDeltaTokens(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info('tool_calls')`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === 'shadow_delta_tokens')) return // already present
  db.exec(`ALTER TABLE tool_calls ADD COLUMN shadow_delta_tokens INTEGER`)
}

export function getDb(dbPath?: string): DB {
  const resolvedPath = dbPath ?? ':memory:'
  if (dbInstance && currentPath === resolvedPath) {
    return dbInstance
  }
  if (dbInstance && currentPath !== resolvedPath) {
    try {
      dbInstance.close()
    } catch {
      // swallow
    }
    dbInstance = null
  }
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  migrateLegacyToolCallsSchema(db)
  migrateAddShadowDeltaTokens(db)
  dbInstance = db
  currentPath = resolvedPath
  return db
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close()
    } catch {
      // swallow
    }
    dbInstance = null
    currentPath = null
  }
}
