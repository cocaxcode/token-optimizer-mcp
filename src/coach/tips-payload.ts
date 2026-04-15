// Shared payload builder for coach_tips MCP tool + token-optimizer://coach/tips
// resource. Keeps tool/resource outputs identical — Phase 4.H.

import type Database from 'better-sqlite3'
import type { ContextMeasurement, EventContext, ToolEvent, DetectionHit, CoachTip } from '../lib/types.js'
import { KNOWLEDGE_BASE } from './knowledge-base.js'
import { REFERENCE_DATA, getStaleRows } from './reference-data.js'
import { runRules } from './detector.js'
import { measureContextSize } from './context-meter.js'
import { buildQueries } from '../db/queries.js'

type DB = Database.Database

export interface CoachTipsPayload {
  current: DetectionHit[]
  known_tricks: readonly CoachTip[]
  context: ContextMeasurement
  reference_data: typeof REFERENCE_DATA
  stale_reference_count: number
  last_computed_at: string
}

export interface ComputeCoachTipsPayloadOptions {
  db: DB
  sessionId?: string
  projectDir?: string
  activeModel?: string
}

export async function computeCoachTipsPayload(
  opts: ComputeCoachTipsPayloadOptions,
): Promise<CoachTipsPayload> {
  const { db } = opts
  const sessionId = opts.sessionId ?? 'default'

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

  const hits = runRules(ctx)
  const staleTips = getStaleRows()

  return {
    current: hits,
    known_tricks: KNOWLEDGE_BASE,
    context,
    reference_data: REFERENCE_DATA,
    stale_reference_count: staleTips.length,
    last_computed_at: new Date().toISOString(),
  }
}
