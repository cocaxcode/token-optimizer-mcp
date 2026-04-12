import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { closeDb, getDb } from '../db/connection.js'
import {
  getUsageStats,
  getCostReport,
  getActiveBudgetSummary,
  getSavingsToday,
} from '../services/stats.js'
import { BudgetManager } from '../services/budget-manager.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'

describe('stats service', () => {
  beforeEach(() => {
    closeDb()
    getDb(':memory:')
  })

  afterEach(() => {
    closeDb()
  })

  it('getUsageStats returns zero totals on empty DB', () => {
    const db = getDb(':memory:')
    const usage = getUsageStats(db, 7)
    expect(usage.total_tokens).toBe(0)
    expect(usage.total_events).toBe(0)
    expect(usage.by_tool).toEqual([])
    expect(usage.by_source).toEqual([])
  })

  it('getUsageStats sums tokens and events', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [
      makeEvent({ tool_name: 'Read', source: 'builtin', tokens_estimated: 100 }),
      makeEvent({
        tool_name: 'Bash',
        source: 'builtin',
        tokens_estimated: 200,
        input_hash: 'h2',
      }),
      makeEvent({
        tool_name: 'mcp__serena__read',
        source: 'serena',
        tokens_estimated: 50,
        input_hash: 'h3',
      }),
    ])
    const usage = getUsageStats(db, 7)
    expect(usage.total_tokens).toBe(350)
    expect(usage.total_events).toBe(3)
    expect(usage.by_source.length).toBe(2) // builtin + serena
  })

  it('getCostReport returns a sonnet/opus band', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [
      makeEvent({ source: 'builtin', tokens_estimated: 1_000_000 }),
    ])
    const cost = getCostReport(db, 7)
    expect(cost.total_tokens).toBe(1_000_000)
    // Haiku: $1/MTok, Sonnet: $3/MTok, Opus: $5/MTok (input pricing April 2026)
    expect(cost.estimated_cost_usd_haiku).toBe(1)
    expect(cost.estimated_cost_usd_sonnet).toBe(3)
    expect(cost.estimated_cost_usd_opus).toBe(5)
    // Deprecated aliases
    expect(cost.estimated_cost_usd_min).toBe(1)
    expect(cost.estimated_cost_usd_max).toBe(5)
    expect(cost.disclaimer).toContain('factura Anthropic')
  })

  it('getActiveBudgetSummary delegates to BudgetManager', () => {
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`).run(
      'sess-1',
      'proj-1',
    )
    const mgr = new BudgetManager(db)
    mgr.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000, mode: 'warn' })
    const summary = getActiveBudgetSummary(db, 'sess-1', 'proj-1')
    expect(summary.active).toBe(true)
    expect(summary.mode).toBe('warn')
  })

  it('getSavingsToday returns day-scoped report with note', () => {
    const db = getDb(':memory:')
    const savings = getSavingsToday(db)
    expect(savings.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(savings.note).toContain('Medido')
  })
})
