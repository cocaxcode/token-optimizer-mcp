// Regression test for the PreToolUse → PostToolUse RTK correlation.
//
// Problem the feature solves:
//   Claude Code passes the ORIGINAL tool_input to PostToolUse even when the
//   PreToolUse hook mutated `updatedInput` to rewrite the command. So the
//   classifier in PostToolUse sees e.g. "git status" and marks the event as
//   source=builtin — even though the actual process that ran was
//   "rtk git status" and Claude read filtered output.
//
// Solution: PreToolUse writes a small mark row {session_id, command_hash} to
// the DB after a successful rtk rewrite. PostToolUse consumes the mark for
// matching Bash events and reclassifies them to source=rtk with
// estimation_method=measured_rtk_rewrite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { closeDb, getDb } from '../db/connection.js'
import { buildQueries } from '../db/queries.js'
import { runPostToolUseHook } from '../hooks/posttooluse.js'
import { hashCommand } from '../lib/command-hash.js'

describe('rtk rewrite PreToolUse ↔ PostToolUse correlation', () => {
  let cwd: string
  let dbPath: string

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'tompx-rtk-corr-'))
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"test"}')
    dbPath = path.join(cwd, 'analytics.db')
    closeDb()
  })

  afterEach(() => {
    closeDb()
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  function rowsBySource(source: string): number {
    const db = getDb(dbPath)
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM tool_calls WHERE source = ?`)
      .get(source) as { c: number }
    return row.c
  }

  function lastRow(): {
    source: string
    estimation_method: string | null
    tool_name: string
  } | null {
    const db = getDb(dbPath)
    return (
      (db
        .prepare(
          `SELECT source, estimation_method, tool_name FROM tool_calls ORDER BY id DESC LIMIT 1`,
        )
        .get() as
        | { source: string; estimation_method: string | null; tool_name: string }
        | undefined) ?? null
    )
  }

  it('reclassifies Bash event to source=rtk when PreToolUse stamped a mark', () => {
    const sessionId = 'sess-rtk-corr-1'
    const command = 'git status'

    // Simulate PreToolUse stamping a mark.
    const db = getDb(dbPath)
    const queries = buildQueries(db)
    queries.insertSession(sessionId, 'h1')
    queries.insertRtkRewrite(sessionId, hashCommand(command), 'rtk git status')

    // Now PostToolUse fires with the ORIGINAL tool_input (not the rewritten one).
    const stdin = JSON.stringify({
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command, description: 'test' },
      tool_response: { stdout: 'On branch master', stderr: '', interrupted: false },
      duration_ms: 42,
    })

    const { event } = runPostToolUseHook({
      stdin,
      dbPath,
      projectDir: cwd,
      writeStdout: false,
      coachEnabled: false,
    })

    expect(event).not.toBeNull()
    expect(event?.source).toBe('rtk')
    expect(event?.estimation_method).toBe('measured_rtk_rewrite')

    const last = lastRow()
    expect(last?.source).toBe('rtk')
    expect(last?.estimation_method).toBe('measured_rtk_rewrite')
    expect(rowsBySource('rtk')).toBe(1)
    expect(rowsBySource('builtin')).toBe(0)
  })

  it('does not reclassify when there is no mark (plain Bash stays builtin)', () => {
    const sessionId = 'sess-rtk-corr-2'
    const stdin = JSON.stringify({
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'echo hello', description: 'plain' },
      tool_response: { stdout: 'hello', stderr: '', interrupted: false },
      duration_ms: 5,
    })

    const { event } = runPostToolUseHook({
      stdin,
      dbPath,
      projectDir: cwd,
      writeStdout: false,
      coachEnabled: false,
    })

    expect(event?.source).toBe('builtin')
    expect(rowsBySource('rtk')).toBe(0)
    expect(rowsBySource('builtin')).toBe(1)
  })

  it('consumes the mark so a second event with the same hash stays builtin', () => {
    const sessionId = 'sess-rtk-corr-3'
    const command = 'ls /tmp'

    const db = getDb(dbPath)
    const queries = buildQueries(db)
    queries.insertSession(sessionId, 'h1')
    queries.insertRtkRewrite(sessionId, hashCommand(command), 'rtk ls /tmp')

    const stdin = JSON.stringify({
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command, description: 'first' },
      tool_response: { stdout: 'a\nb\nc', stderr: '', interrupted: false },
      duration_ms: 5,
    })

    // First call: mark is consumed, event becomes rtk.
    runPostToolUseHook({
      stdin,
      dbPath,
      projectDir: cwd,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(rowsBySource('rtk')).toBe(1)

    // Second call with the same command: no mark left, so it stays builtin.
    runPostToolUseHook({
      stdin,
      dbPath,
      projectDir: cwd,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(rowsBySource('rtk')).toBe(1)
    expect(rowsBySource('builtin')).toBe(1)
  })

  it('ignores marks older than the 60 s window', () => {
    const sessionId = 'sess-rtk-corr-4'
    const command = 'git log -5'

    // Insert a stale mark by writing directly with a past timestamp.
    const db = getDb(dbPath)
    const queries = buildQueries(db)
    queries.insertSession(sessionId, 'h1')
    db.prepare(
      `INSERT INTO rtk_rewrites (session_id, command_hash, rewritten_to, created_at)
       VALUES (?, ?, ?, datetime('now', '-120 seconds'))`,
    ).run(sessionId, hashCommand(command), 'rtk git log -5')

    const stdin = JSON.stringify({
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command, description: 'stale' },
      tool_response: { stdout: 'commit abc', stderr: '', interrupted: false },
      duration_ms: 5,
    })

    runPostToolUseHook({
      stdin,
      dbPath,
      projectDir: cwd,
      writeStdout: false,
      coachEnabled: false,
    })
    // Stale mark ignored: event is builtin, the stale row is still in the table
    // (it will be purged by the PreToolUse next time it runs).
    expect(rowsBySource('rtk')).toBe(0)
    expect(rowsBySource('builtin')).toBe(1)
  })
})
