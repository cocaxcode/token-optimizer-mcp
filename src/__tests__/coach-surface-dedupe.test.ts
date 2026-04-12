import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkDedupe, logSurface, surfaceWithDedupe, clearSurfaceLog } from '../coach/surface.js'
import { closeDb, getDb } from '../db/connection.js'
import type { DetectionHit } from '../lib/types.js'

describe('coach surface dedupe', () => {
  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`).run('sess-1')
  })

  afterEach(() => {
    closeDb()
  })

  const sampleHit = (): DetectionHit => ({
    rule_id: 'detect-context-threshold',
    tip_ids: ['use-compact-long-session'],
    severity: 'warn',
    evidence: 'test',
    estimation_method: 'measured_exact',
  })

  it('checkDedupe returns false when log is empty', () => {
    const db = getDb(':memory:')
    expect(checkDedupe(db, 'sess-1', 'detect-context-threshold', 'use-compact-long-session', 60)).toBe(
      false,
    )
  })

  it('logSurface inserts one row per tip_id', () => {
    const db = getDb(':memory:')
    const hit: DetectionHit = {
      rule_id: 'detect-opus-for-simple-task',
      tip_ids: ['default-to-sonnet', 'use-haiku-for-simple'],
      severity: 'info',
      evidence: 'test',
      estimation_method: 'measured_exact',
    }
    logSurface(db, 'sess-1', hit, 'mcp')
    const rows = db
      .prepare(`SELECT COUNT(*) as count FROM coach_surface_log WHERE session_id = ?`)
      .get('sess-1') as { count: number }
    expect(rows.count).toBe(2)
  })

  it('checkDedupe returns true within the window', () => {
    const db = getDb(':memory:')
    logSurface(db, 'sess-1', sampleHit(), 'mcp')
    expect(
      checkDedupe(db, 'sess-1', 'detect-context-threshold', 'use-compact-long-session', 60),
    ).toBe(true)
  })

  it('surfaceWithDedupe skips hits that are deduped', () => {
    const db = getDb(':memory:')
    // First surface — should log
    const first = surfaceWithDedupe(db, 'sess-1', [sampleHit()], 'posttooluse', 60)
    expect(first.length).toBe(1)
    // Second surface within window — should be deduped
    const second = surfaceWithDedupe(db, 'sess-1', [sampleHit()], 'posttooluse', 60)
    expect(second.length).toBe(0)
  })

  it('surfaceWithDedupe writes via label correctly', () => {
    const db = getDb(':memory:')
    surfaceWithDedupe(db, 'sess-1', [sampleHit()], 'sessionstart', 60)
    const row = db
      .prepare(`SELECT surfaced_via, severity FROM coach_surface_log WHERE session_id = ?`)
      .get('sess-1') as { surfaced_via: string; severity: string }
    expect(row.surfaced_via).toBe('sessionstart')
    expect(row.severity).toBe('warn')
  })

  it('clearSurfaceLog deletes rows for a session', () => {
    const db = getDb(':memory:')
    logSurface(db, 'sess-1', sampleHit(), 'mcp')
    const deleted = clearSurfaceLog(db, 'sess-1')
    expect(deleted).toBe(1)
    expect(
      checkDedupe(db, 'sess-1', 'detect-context-threshold', 'use-compact-long-session', 60),
    ).toBe(false)
  })

  it('clearSurfaceLog without session_id deletes all', () => {
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`).run('sess-2')
    logSurface(db, 'sess-1', sampleHit(), 'mcp')
    logSurface(db, 'sess-2', sampleHit(), 'mcp')
    expect(clearSurfaceLog(db)).toBe(2)
  })
})
