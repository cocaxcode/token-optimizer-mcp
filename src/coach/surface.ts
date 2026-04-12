// Surfacing dedupe + log writer — Phase 4.45
// Writes to coach_surface_log with session+rule+tip+via+severity.

import type Database from 'better-sqlite3'
import type { DetectionHit } from '../lib/types.js'

type DB = Database.Database

export type SurfacedVia = 'sessionstart' | 'posttooluse' | 'mcp' | 'cli'

/**
 * Returns true if this (session, rule, tip) was surfaced within the last
 * `windowSeconds` seconds. Used by the PostToolUse throttle path.
 */
export function checkDedupe(
  db: DB,
  sessionId: string,
  ruleId: string,
  tipId: string,
  windowSeconds: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM coach_surface_log
       WHERE session_id = ? AND rule_id = ? AND tip_id = ?
         AND created_at > datetime('now', ?)
       LIMIT 1`,
    )
    .get(sessionId, ruleId, tipId, `-${windowSeconds} seconds`) as unknown
  return row !== undefined && row !== null
}

export function logSurface(
  db: DB,
  sessionId: string,
  hit: DetectionHit,
  via: SurfacedVia,
): void {
  // Ensure session exists so FK succeeds
  db.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`).run(sessionId)
  const stmt = db.prepare(
    `INSERT INTO coach_surface_log (session_id, rule_id, tip_id, surfaced_via, severity)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const tipId of hit.tip_ids) {
    stmt.run(sessionId, hit.rule_id, tipId, via, hit.severity)
  }
}

/**
 * Log the list of hits under dedupe. A hit is considered "fresh" (to be
 * logged and returned to the caller) if at least one of its tip_ids was NOT
 * surfaced within `windowSeconds`. Returns only the surfaced hits.
 */
export function surfaceWithDedupe(
  db: DB,
  sessionId: string,
  hits: DetectionHit[],
  via: SurfacedVia,
  windowSeconds: number,
): DetectionHit[] {
  const surfaced: DetectionHit[] = []
  for (const hit of hits) {
    const anyFresh = hit.tip_ids.some(
      (tipId) => !checkDedupe(db, sessionId, hit.rule_id, tipId, windowSeconds),
    )
    if (anyFresh) {
      logSurface(db, sessionId, hit, via)
      surfaced.push(hit)
    }
  }
  return surfaced
}

export function clearSurfaceLog(db: DB, sessionId?: string): number {
  if (sessionId) {
    const info = db.prepare(`DELETE FROM coach_surface_log WHERE session_id = ?`).run(sessionId)
    return info.changes as number
  }
  const info = db.prepare(`DELETE FROM coach_surface_log`).run()
  return info.changes as number
}
