// Coach section builder for SessionStart:compact re-injection — Phase 4.H
// Runs detection rules, picks top N hits by severity, surfaces via dedupe,
// and renders a markdown section appended to the re-injection payload.

import type Database from 'better-sqlite3'
import type {
  DetectionHit,
  DetectionSeverity,
  EventContext,
  ToolEvent,
} from '../lib/types.js'
import { KNOWLEDGE_BASE } from './knowledge-base.js'
import { runRules } from './detector.js'
import { measureContextSize, measureContextSizeFromDbSync } from './context-meter.js'
import { surfaceWithDedupe, type SurfacedVia } from './surface.js'
import { buildQueries } from '../db/queries.js'

type DB = Database.Database

const SEVERITY_EMOJI: Record<DetectionSeverity, string> = {
  critical: '🔥',
  warn: '⚠️',
  info: '💡',
}

const SEVERITY_RANK: Record<DetectionSeverity, number> = {
  info: 0,
  warn: 1,
  critical: 2,
}

export interface BuildCoachSectionOptions {
  db: DB
  sessionId: string
  projectDir?: string
  activeModel?: string
  maxTips?: number
  dedupeWindowSeconds?: number
  via?: SurfacedVia
}

export interface CoachSectionResult {
  markdown: string | null
  hits: DetectionHit[]
}

export async function buildCoachSectionMarkdown(
  opts: BuildCoachSectionOptions,
): Promise<CoachSectionResult> {
  const { db, sessionId } = opts
  const maxTips = opts.maxTips ?? 3
  const dedupeWindow = opts.dedupeWindowSeconds ?? 60
  const via: SurfacedVia = opts.via ?? 'sessionstart'

  const contextOpts: Parameters<typeof measureContextSize>[1] = { db }
  if (opts.projectDir !== undefined) contextOpts.projectDir = opts.projectDir
  if (opts.activeModel !== undefined) contextOpts.activeModel = opts.activeModel
  const context = await measureContextSize(sessionId, contextOpts)

  const queries = buildQueries(db)
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const rawRows = queries.getToolCallsSince(since) as ToolEvent[]
  const events = rawRows.slice(0, 100)

  const ctx: EventContext = {
    session_id: sessionId,
    events,
    session_token_total: context.tokens,
    session_token_method: context.estimation_method,
    session_token_limit: context.limit,
    active_model: opts.activeModel ?? null,
  }

  // runRules already dedupes by rule_id and sorts by severity ascending
  const hits = runRules(ctx)
  if (hits.length === 0) return { markdown: null, hits: [] }

  const top = hits.slice(0, maxTips)
  const surfaced = surfaceWithDedupe(db, sessionId, top, via, dedupeWindow)
  if (surfaced.length === 0) return { markdown: null, hits: [] }

  const lines: string[] = ['## Tips del coach']
  for (const hit of surfaced) {
    const primaryTipId = hit.tip_ids[0]
    const tip = KNOWLEDGE_BASE.find((t) => t.id === primaryTipId)
    if (!tip) continue
    const emoji = SEVERITY_EMOJI[hit.severity] ?? '•'
    lines.push('')
    lines.push(`${emoji} **${tip.title}**`)
    lines.push(`- Cómo usarlo: \`${tip.how_to_invoke}\``)
    lines.push(`- Porqué: ${hit.evidence}`)
    lines.push(`- Fuente: ${hit.estimation_method}`)
  }

  return { markdown: lines.join('\n'), hits: surfaced }
}

export interface BuildCoachHintSyncOptions {
  db: DB
  sessionId: string
  activeModel?: string
  dedupeWindowSeconds?: number
  minSeverity?: DetectionSeverity
  via?: SurfacedVia
}

export interface CoachHintResult {
  text: string | null
  hit: DetectionHit | null
}

/**
 * Synchronous single-tip hint for PostToolUse throttled surfacing.
 * Uses only the DB context meter (no async transcript/xray) to stay
 * under the 5ms hot-path budget. Returns null if no rule fires at or
 * above `minSeverity` (default 'warn') or if dedupe suppresses the hit.
 */
export function buildCoachHintSync(
  opts: BuildCoachHintSyncOptions,
): CoachHintResult {
  const { db, sessionId } = opts
  const dedupeWindow = opts.dedupeWindowSeconds ?? 60
  const minSeverity = opts.minSeverity ?? 'warn'
  const via: SurfacedVia = opts.via ?? 'posttooluse'

  const context = measureContextSizeFromDbSync(db, sessionId, opts.activeModel)

  const queries = buildQueries(db)
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const rawRows = queries.getToolCallsSince(since) as ToolEvent[]
  const events = rawRows.slice(0, 100)

  const ctx: EventContext = {
    session_id: sessionId,
    events,
    session_token_total: context.tokens,
    session_token_method: context.estimation_method,
    session_token_limit: context.limit,
    active_model: opts.activeModel ?? null,
  }

  const hits = runRules(ctx)
  if (hits.length === 0) return { text: null, hit: null }

  const minRank = SEVERITY_RANK[minSeverity]
  const eligible = hits.filter((h) => SEVERITY_RANK[h.severity] >= minRank)
  if (eligible.length === 0) return { text: null, hit: null }

  // runRules already sorts by severity ascending (critical first). Take the highest.
  eligible.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const top = eligible.slice(0, 1)
  const surfaced = surfaceWithDedupe(db, sessionId, top, via, dedupeWindow)
  if (surfaced.length === 0) return { text: null, hit: null }

  const hit = surfaced[0]
  const primaryTipId = hit.tip_ids[0]
  const tip = KNOWLEDGE_BASE.find((t) => t.id === primaryTipId)
  if (!tip) return { text: null, hit: null }

  const emoji = SEVERITY_EMOJI[hit.severity] ?? '•'
  const text = `${emoji} Coach: **${tip.title}** — ${hit.evidence}. Cómo: \`${tip.how_to_invoke}\` (fuente: ${hit.estimation_method})`
  return { text, hit }
}
