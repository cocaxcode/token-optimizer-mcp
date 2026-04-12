import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BudgetManager } from '../services/budget-manager.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'

describe('BudgetManager', () => {
  let manager: BudgetManager

  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`).run(
      'sess-1',
      'proj-hash-1',
    )
    manager = new BudgetManager(db)
  })

  afterEach(() => {
    closeDb()
  })

  describe('setBudget validation', () => {
    it('accepts valid input', () => {
      const budget = manager.setBudget({
        scope: 'session',
        scope_key: 'sess-1',
        limit_tokens: 50_000,
        mode: 'warn',
      })
      expect(budget.limit_tokens).toBe(50_000)
      expect(budget.mode).toBe('warn')
    })

    it('rejects non-integer limit', () => {
      expect(() =>
        manager.setBudget({
          scope: 'session',
          scope_key: 'sess-1',
          limit_tokens: 100.5,
        }),
      ).toThrow(/entero/)
    })

    it('rejects zero or negative limit', () => {
      expect(() =>
        manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 0 }),
      ).toThrow(/mayor que 0/)
      expect(() =>
        manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: -1 }),
      ).toThrow(/mayor que 0/)
    })

    it('rejects limit above ceiling', () => {
      expect(() =>
        manager.setBudget({
          scope: 'session',
          scope_key: 'sess-1',
          limit_tokens: 10_000_001,
        }),
      ).toThrow(/exceder/)
    })

    it('defaults mode to warn', () => {
      const budget = manager.setBudget({
        scope: 'session',
        scope_key: 'sess-1',
        limit_tokens: 1000,
      })
      expect(budget.mode).toBe('warn')
    })

    it('upserts on conflict (same scope+key)', () => {
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000 })
      const updated = manager.setBudget({
        scope: 'session',
        scope_key: 'sess-1',
        limit_tokens: 2000,
        mode: 'block',
      })
      expect(updated.limit_tokens).toBe(2000)
      expect(updated.mode).toBe('block')
    })
  })

  describe('getActiveBudget precedence', () => {
    it('returns null when no budget set', () => {
      expect(manager.getActiveBudget('sess-1', 'proj-hash-1')).toBeNull()
    })

    it('returns session budget when only session is set', () => {
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000 })
      const active = manager.getActiveBudget('sess-1', 'proj-hash-1')
      expect(active?.scope).toBe('session')
    })

    it('returns project budget when only project is set', () => {
      manager.setBudget({ scope: 'project', scope_key: 'proj-hash-1', limit_tokens: 5000 })
      const active = manager.getActiveBudget('sess-1', 'proj-hash-1')
      expect(active?.scope).toBe('project')
    })

    it('session budget wins over project budget', () => {
      manager.setBudget({ scope: 'project', scope_key: 'proj-hash-1', limit_tokens: 5000 })
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000 })
      const active = manager.getActiveBudget('sess-1', 'proj-hash-1')
      expect(active?.scope).toBe('session')
      expect(active?.limit_tokens).toBe(1000)
    })
  })

  describe('checkBudget + computeSpent', () => {
    it('inactive when no budget', () => {
      const status = manager.checkBudget('sess-1', 'proj-hash-1')
      expect(status.active).toBe(false)
      expect(status.spent).toBe(0)
      expect(status.remaining).toBe(0)
    })

    it('spent = 0 when budget is fresh', () => {
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000 })
      const status = manager.checkBudget('sess-1', 'proj-hash-1')
      expect(status.active).toBe(true)
      expect(status.spent).toBe(0)
      expect(status.remaining).toBe(1000)
      expect(status.percent_used).toBe(0)
    })

    it('spent accumulates from tool_calls', () => {
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000 })
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-1', tokens_estimated: 100 }),
        makeEvent({ session_id: 'sess-1', tokens_estimated: 150, input_hash: 'h2' }),
      ])
      const status = manager.checkBudget('sess-1', 'proj-hash-1')
      expect(status.spent).toBe(250)
      expect(status.remaining).toBe(750)
      expect(status.percent_used).toBeCloseTo(0.25)
    })

    it('project-scope spent joins on sessions.project_hash', () => {
      manager.setBudget({ scope: 'project', scope_key: 'proj-hash-1', limit_tokens: 1000 })
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-1', tokens_estimated: 300 }),
      ])
      const status = manager.checkBudget('sess-1', 'proj-hash-1')
      expect(status.spent).toBe(300)
      expect(status.remaining).toBe(700)
    })

    it('remaining clamps to 0 when over-limit', () => {
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 100 })
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-1', tokens_estimated: 500 })])
      const status = manager.checkBudget('sess-1', 'proj-hash-1')
      expect(status.spent).toBe(500)
      expect(status.remaining).toBe(0)
    })
  })

  describe('clearBudget', () => {
    it('returns true when budget existed', () => {
      manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 1000 })
      expect(manager.clearBudget('session', 'sess-1')).toBe(true)
      expect(manager.getActiveBudget('sess-1', 'proj-hash-1')).toBeNull()
    })

    it('returns false when budget did not exist', () => {
      expect(manager.clearBudget('session', 'ghost')).toBe(false)
    })
  })

  describe('getBudgetReport', () => {
    it('groups by tool and source', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-1', tool_name: 'Read', source: 'builtin', tokens_estimated: 100 }),
        makeEvent({ session_id: 'sess-1', tool_name: 'Read', source: 'builtin', tokens_estimated: 50, input_hash: 'h2' }),
        makeEvent({ session_id: 'sess-1', tool_name: 'Bash', source: 'builtin', tokens_estimated: 200, input_hash: 'h3' }),
      ])
      const report = manager.getBudgetReport('1970-01-01')
      expect(report.by_tool.length).toBe(2)
      const bash = report.by_tool.find((r) => r.tool_name === 'Bash')
      expect(bash?.tokens).toBe(200)
      const read = report.by_tool.find((r) => r.tool_name === 'Read')
      expect(read?.tokens).toBe(150)
      expect(report.by_source.length).toBe(1)
      expect(report.by_source[0].source).toBe('builtin')
      expect(report.by_source[0].tokens).toBe(350)
    })
  })
})
