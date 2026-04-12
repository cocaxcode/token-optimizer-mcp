// RTK event reader with 3-strategy fallback — Phase 4.5
// Strategy 1: read ~/.rtk/tracking.db directly (measurement_method: estimated_rtk_db)
// Strategy 2: parse [rtk: filtered N tokens] markers in tool_calls.content
// Strategy 3: heuristic multiplier on filtered_count

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { EstimationMethod } from '../lib/types.js'

const RTK_FALLBACK_RATIO = 0.7
const RTK_MARKER_RE = /\[rtk: filtered (\d+) tokens\]/i

export interface RtkEvent {
  tool_name: 'Bash'
  command: string
  filtered_tokens: number
  created_at: string
  strategy: 'rtk_db' | 'rtk_marker' | 'rtk_fallback'
  estimation_method: EstimationMethod
}

function defaultRtkDbPath(home: string = os.homedir()): string {
  return path.join(home, '.rtk', 'tracking.db')
}

/**
 * Strategy 1: try to open rtk.db directly in read-only mode.
 * Returns null if the file is missing or the schema is not readable.
 */
export function importFromRtkDb(dbPath?: string): RtkEvent[] | null {
  const p = dbPath ?? defaultRtkDbPath()
  if (!fs.existsSync(p)) return null
  let db: Database.Database | null = null
  try {
    db = new Database(p, { fileMustExist: true, readonly: true })
    // The schema of RTK's tracking.db is not formally documented; we probe
    // common column names and bail out gracefully if unavailable.
    const rows = db
      .prepare(
        `SELECT tool_name, command, filtered_tokens, created_at
         FROM tracking
         ORDER BY created_at DESC
         LIMIT 1000`,
      )
      .all() as Array<{
      tool_name: string
      command: string
      filtered_tokens: number
      created_at: string
    }>
    return rows.map((r) => ({
      tool_name: 'Bash' as const,
      command: r.command ?? '',
      filtered_tokens: r.filtered_tokens ?? 0,
      created_at: r.created_at,
      strategy: 'rtk_db' as const,
      estimation_method: 'estimated_rtk_db' as EstimationMethod,
    }))
  } catch {
    return null
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        // swallow
      }
    }
  }
}

/**
 * Strategy 2: parse `[rtk: filtered N tokens]` from an existing content string.
 * Returns the parsed token count or null if no marker present.
 */
export function extractMarkerFromContent(content: string | null): number | null {
  if (!content) return null
  const match = RTK_MARKER_RE.exec(content)
  if (!match) return null
  const parsed = parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Strategy 3: apply a heuristic multiplier to a filtered count when we
 * have no authoritative source.
 */
export function applyFallback(filteredCount: number): number {
  if (!Number.isFinite(filteredCount) || filteredCount < 0) return 0
  return Math.round(filteredCount * RTK_FALLBACK_RATIO)
}

export interface RtkImportSummary {
  strategy: 'rtk_db' | 'rtk_marker' | 'rtk_fallback' | 'none'
  events_found: number
  total_tokens_saved: number
}

export function summarizeImport(events: RtkEvent[] | null): RtkImportSummary {
  if (!events || events.length === 0) {
    return { strategy: 'none', events_found: 0, total_tokens_saved: 0 }
  }
  const strategy = events[0].strategy
  const total = events.reduce((sum, e) => sum + (e.filtered_tokens ?? 0), 0)
  return {
    strategy,
    events_found: events.length,
    total_tokens_saved: total,
  }
}
