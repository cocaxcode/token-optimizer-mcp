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


/**
 * Caché in-memory del snapshot de la tracking.db de RTK. TTL corto porque RTK
 * escribe en su DB en cada ejecución: si mantenemos el snapshot vivo mucho
 * tiempo, perdemos eventos recientes. 30 s es un compromiso entre no reabrir
 * SQLite por cada call a Bash y tener datos razonablemente frescos.
 */
const RTK_DB_CACHE_TTL_MS = 30_000
let rtkDbCache: { events: RtkEvent[] | null; loadedAt: number } | null = null

export function resetRtkDbCache(): void {
  rtkDbCache = null
}

function getCachedRtkEvents(dbPath?: string): RtkEvent[] | null {
  const now = Date.now()
  if (rtkDbCache && now - rtkDbCache.loadedAt < RTK_DB_CACHE_TTL_MS) {
    return rtkDbCache.events
  }
  const events = importFromRtkDb(dbPath)
  rtkDbCache = { events, loadedAt: now }
  return events
}

function safeStringifyResponse(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

export interface RtkDeltaMeasurement {
  delta: number
  method: 'estimated_rtk_marker' | 'estimated_rtk_db' | 'estimated_rtk_fallback'
}

export interface MeasureRtkDeltaOptions {
  /** Tool response completo del PostToolUse (puede ser string u objeto JSON) */
  toolResponse?: unknown
  /** El comando tal como Claude lo pidió (antes de la rewrite RTK). Se usa para matchear en tracking.db. */
  command?: string
  /** Tokens estimados del output ya filtrado por RTK. Base del fallback. */
  outputTokens: number
  /** Override del path a tracking.db de RTK. Si undefined, usa ~/.rtk/tracking.db. */
  rtkDbPath?: string | null
}

/**
 * Mide cuántos tokens RTK ahorró en este evento concreto, aplicando 3 estrategias
 * en cascada por precisión decreciente:
 *
 *   1. Marcador literal `[rtk: filtered N tokens]` en el output → delta exacto.
 *      Cero I/O extra. El más fiable cuando RTK lo emite.
 *
 *   2. Lookup en la tracking.db de RTK por comando literal → delta que RTK
 *      registró para esa ejecución. Requiere RTK instalado y schema estable.
 *      Cacheado en memoria con TTL de 30 s para no reabrir SQLite por call.
 *
 *   3. Fallback heurístico: `outputTokens × RTK_FALLBACK_RATIO (0.7)`.
 *      Siempre disponible. Asume que RTK cortó ~70 % de lo que habría entrado.
 *      Menos preciso, pero nunca retorna null.
 *
 * Devuelve { delta, method } con el `estimation_method` tag listo para
 * escribirse en `tool_calls.estimation_method`.
 */
export function measureRtkDelta(opts: MeasureRtkDeltaOptions): RtkDeltaMeasurement | null {
  // Strategy 1 — marker
  const content = safeStringifyResponse(opts.toolResponse)
  const markerDelta = extractMarkerFromContent(content)
  if (markerDelta !== null && markerDelta > 0) {
    return { delta: markerDelta, method: 'estimated_rtk_marker' }
  }

  // Strategy 2 — tracking.db lookup
  if (opts.command && opts.command.trim().length > 0) {
    const events = getCachedRtkEvents(opts.rtkDbPath ?? undefined)
    if (events && events.length > 0) {
      const cmdNorm = opts.command.trim()
      const match = events.find((e) => (e.command ?? '').trim() === cmdNorm)
      if (match && match.filtered_tokens > 0) {
        return { delta: match.filtered_tokens, method: 'estimated_rtk_db' }
      }
    }
  }

  // Strategy 3 — fallback ratio
  const fallbackDelta = applyFallback(opts.outputTokens)
  if (fallbackDelta > 0) {
    return { delta: fallbackDelta, method: 'estimated_rtk_fallback' }
  }

  return null
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
