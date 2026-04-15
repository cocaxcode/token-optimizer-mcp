// Regression test for the Phase 1.2 schema simplification migration.
//
// Bug: dropping input_hash/tool_input_summary/content from `tool_calls` without a
// migration left existing DBs with NOT NULL constraints. New inserts failed silently
// (droppedEvents counter grew), and reports showed zero recent activity.
//
// This test creates a legacy-shaped DB, opens it via getDb, and verifies:
//   1. Legacy columns are removed.
//   2. FTS5 triggers are removed.
//   3. Historical rows are preserved.
//   4. New inserts with the current schema succeed.

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { closeDb, getDb } from '../db/connection.js'
import { buildQueries } from '../db/queries.js'
import { makeEvent } from './helpers.js'

describe('legacy schema migration', () => {
  const cleanups: (() => void)[] = []

  afterEach(() => {
    closeDb()
    while (cleanups.length) cleanups.pop()?.()
  })

  async function createLegacyDb(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'tompx-migration-'))
    const dbPath = path.join(dir, 'analytics.db')
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    const legacy = new Database(dbPath)
    legacy.pragma('journal_mode = WAL')
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_hash TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tool_calls (
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
      CREATE VIRTUAL TABLE events_fts USING fts5(content, tool_name, source);
      CREATE TRIGGER tool_calls_ai AFTER INSERT ON tool_calls BEGIN
        INSERT INTO events_fts(rowid, content, tool_name, source)
        VALUES (new.id, new.content, new.tool_name, new.source);
      END;
      CREATE TRIGGER tool_calls_ad AFTER DELETE ON tool_calls BEGIN
        INSERT INTO events_fts(events_fts, rowid, content, tool_name, source)
        VALUES('delete', old.id, old.content, old.tool_name, old.source);
      END;
    `)
    legacy
      .prepare(`INSERT INTO sessions (id, project_hash) VALUES (?, ?)`)
      .run('sess-legacy', 'h1')
    legacy
      .prepare(
        `INSERT INTO tool_calls (session_id, tool_name, source, input_hash, tool_input_summary, output_bytes, tokens_estimated, tokens_actual, duration_ms, content, estimation_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'sess-legacy',
        'Read',
        'builtin',
        'legacy-hash',
        '{}',
        100,
        27,
        null,
        5,
        'legacy content',
        'measured_exact',
        '2026-04-01T00:00:00.000Z',
      )
    legacy.close()
    return dbPath
  }

  it('strips legacy columns, keeps historical rows, and allows new inserts', async () => {
    const dbPath = await createLegacyDb()

    const db = getDb(dbPath)

    const cols = (db.prepare(`PRAGMA table_info('tool_calls')`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort()
    expect(cols).not.toContain('input_hash')
    expect(cols).not.toContain('tool_input_summary')
    expect(cols).not.toContain('content')
    expect(cols).toContain('tool_name')
    expect(cols).toContain('source')

    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='tool_calls'`)
      .all() as Array<{ name: string }>
    expect(triggers).toHaveLength(0)

    const legacyRow = db
      .prepare(`SELECT tool_name, source, tokens_estimated FROM tool_calls WHERE id = 1`)
      .get() as { tool_name: string; source: string; tokens_estimated: number }
    expect(legacyRow).toEqual({ tool_name: 'Read', source: 'builtin', tokens_estimated: 27 })

    const queries = buildQueries(db)
    queries.insertSession('sess-new', 'h2')
    queries.insertToolCall(
      makeEvent({
        session_id: 'sess-new',
        tool_name: 'Bash',
        source: 'builtin',
        tokens_estimated: 42,
      }),
    )
    const total = db.prepare(`SELECT COUNT(*) as c FROM tool_calls`).get() as { c: number }
    expect(total.c).toBe(2)
  })

  it('is a no-op on fresh DBs that already match the new schema', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tompx-migration-fresh-'))
    const dbPath = path.join(dir, 'analytics.db')
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    const db = getDb(dbPath)
    const cols = (db.prepare(`PRAGMA table_info('tool_calls')`).all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).not.toContain('input_hash')

    const queries = buildQueries(db)
    queries.insertSession('sess-fresh', 'h3')
    queries.insertToolCall(
      makeEvent({
        session_id: 'sess-fresh',
        tool_name: 'Edit',
        source: 'builtin',
        tokens_estimated: 10,
      }),
    )
    const total = db.prepare(`SELECT COUNT(*) as c FROM tool_calls`).get() as { c: number }
    expect(total.c).toBe(1)
  })
})
