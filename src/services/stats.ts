// Shared stats service — Phase 4.4
// Read-only aggregates used by CLI and MCP tools.

import type Database from 'better-sqlite3'
import { buildQueries, type ToolCountRow, type SourceCountRow } from '../db/queries.js'
import { BudgetManager } from './budget-manager.js'
import type { BudgetStatus } from '../lib/types.js'

type DB = Database.Database

const DAY_MS = 86_400_000
// Pricing April 2026 — input tokens (tool output → model input)
// Haiku 4.5: $1/$5, Sonnet 4.6: $3/$15, Opus 4.6: $5/$25 per MTok (input/output)
// token-optimizer tracks tool output (= model input), so we use input pricing.
const HAIKU_INPUT_PER_MTOK = 1
const SONNET_INPUT_PER_MTOK = 3
const OPUS_INPUT_PER_MTOK = 5

function sinceDays(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

export interface UsageStats {
  period_days: number
  period_since: string
  by_tool: ToolCountRow[]
  by_source: SourceCountRow[]
  total_tokens: number
  total_events: number
}

export interface CostReport {
  period_days: number
  total_tokens: number
  estimated_cost_usd_haiku: number
  estimated_cost_usd_sonnet: number
  estimated_cost_usd_opus: number
  /** @deprecated Use estimated_cost_usd_haiku */
  estimated_cost_usd_min: number
  /** @deprecated Use estimated_cost_usd_opus */
  estimated_cost_usd_max: number
  by_source: SourceCountRow[]
  disclaimer: string
}

export interface SavingsToday {
  date: string
  by_source: SourceCountRow[]
  total_tokens: number
  note: string
}

export function getUsageStats(db: DB, days = 7): UsageStats {
  const queries = buildQueries(db)
  const since = sinceDays(days)
  const byTool = queries.countToolCallsByTool(since)
  const bySource = queries.countToolCallsBySource(since)
  const totalTokens = bySource.reduce((sum, r) => sum + r.tokens, 0)
  const totalEvents = bySource.reduce((sum, r) => sum + r.count, 0)
  return {
    period_days: days,
    period_since: since,
    by_tool: byTool,
    by_source: bySource,
    total_tokens: totalTokens,
    total_events: totalEvents,
  }
}

export function getCostReport(db: DB, days = 7): CostReport {
  const usage = getUsageStats(db, days)
  const mtok = usage.total_tokens / 1_000_000
  const haiku = Number((mtok * HAIKU_INPUT_PER_MTOK).toFixed(4))
  const sonnet = Number((mtok * SONNET_INPUT_PER_MTOK).toFixed(4))
  const opus = Number((mtok * OPUS_INPUT_PER_MTOK).toFixed(4))
  return {
    period_days: days,
    total_tokens: usage.total_tokens,
    estimated_cost_usd_haiku: haiku,
    estimated_cost_usd_sonnet: sonnet,
    estimated_cost_usd_opus: opus,
    estimated_cost_usd_min: haiku,
    estimated_cost_usd_max: opus,
    by_source: usage.by_source,
    disclaimer:
      'Coste estimado de tokens de herramientas (input al modelo). Haiku $1, Sonnet $3, Opus $5 por MTok. Revisa tu factura Anthropic para el coste real.',
  }
}

export function getActiveBudgetSummary(
  db: DB,
  sessionId: string,
  projectHash: string | null,
): BudgetStatus {
  const mgr = new BudgetManager(db)
  return mgr.checkBudget(sessionId, projectHash)
}

export function getSavingsToday(db: DB): SavingsToday {
  const queries = buildQueries(db)
  const since = sinceDays(1)
  const bySource = queries.countToolCallsBySource(since)
  const total = bySource.reduce((sum, r) => sum + r.tokens, 0)
  return {
    date: new Date().toISOString().slice(0, 10),
    by_source: bySource,
    total_tokens: total,
    note: 'Ahorros por fuente no medidos directamente; revisa el reporte para el split Medido/Estimado.',
  }
}
