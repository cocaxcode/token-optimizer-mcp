// Budget manager — Phase 2.1 + 2.3
// Precedence: session > project. Spent tokens computed from tool_calls since budget.created_at.

import type Database from 'better-sqlite3'
import type {
  Budget,
  BudgetScope,
  BudgetMode,
  BudgetStatus,
} from '../lib/types.js'
import { buildQueries, type Queries, type ToolCountRow, type SourceCountRow } from '../db/queries.js'

type DB = Database.Database

export interface SetBudgetInput {
  scope: BudgetScope
  scope_key: string
  limit_tokens: number
  mode?: BudgetMode
}

export interface BudgetReport {
  by_tool: ToolCountRow[]
  by_source: SourceCountRow[]
  period_since: string
}

const MAX_TOKENS = 1e7

export class BudgetManager {
  private queries: Queries

  constructor(db: DB) {
    this.queries = buildQueries(db)
  }

  setBudget(input: SetBudgetInput): Budget {
    if (!Number.isInteger(input.limit_tokens)) {
      throw new Error('limit_tokens debe ser un entero')
    }
    if (input.limit_tokens <= 0) {
      throw new Error('limit_tokens debe ser mayor que 0')
    }
    if (input.limit_tokens > MAX_TOKENS) {
      throw new Error(`limit_tokens no puede exceder ${MAX_TOKENS}`)
    }
    if (input.scope !== 'session' && input.scope !== 'project') {
      throw new Error(`scope invalido: ${String(input.scope)}`)
    }
    const mode: BudgetMode = input.mode ?? 'warn'
    if (mode !== 'warn' && mode !== 'block') {
      throw new Error(`mode invalido: ${String(mode)}`)
    }
    this.queries.upsertBudget(input.scope, input.scope_key, input.limit_tokens, mode)
    const budget = this.queries.getBudgetByScope(input.scope, input.scope_key)
    if (!budget) {
      throw new Error('no se pudo leer el budget recien creado')
    }
    return budget
  }

  /**
   * Resolve the active budget for a given session + project.
   * Returns the session-scoped budget if present, else the project-scoped one, else null.
   */
  getActiveBudget(sessionId: string, projectHash: string | null): Budget | null {
    const sessionBudget = this.queries.getBudgetByScope('session', sessionId)
    if (sessionBudget) return sessionBudget
    if (projectHash) {
      const projectBudget = this.queries.getBudgetByScope('project', projectHash)
      if (projectBudget) return projectBudget
    }
    return null
  }

  /** Compute spent tokens against a budget from tool_calls since the budget creation timestamp. */
  computeSpent(budget: Budget): number {
    if (budget.scope === 'session') {
      return this.queries.sumTokensBySessionSince(budget.scope_key, budget.created_at)
    }
    return this.queries.sumTokensByProjectSince(budget.scope_key, budget.created_at)
  }

  checkBudget(sessionId: string, projectHash: string | null): BudgetStatus {
    const active = this.getActiveBudget(sessionId, projectHash)
    if (!active) {
      return { active: false, spent: 0, remaining: 0, percent_used: 0, mode: null }
    }
    const spent = this.computeSpent(active)
    const remaining = Math.max(0, active.limit_tokens - spent)
    const percent = active.limit_tokens > 0 ? spent / active.limit_tokens : 0
    return {
      active: true,
      spent,
      remaining,
      percent_used: percent,
      mode: active.mode,
    }
  }

  clearBudget(scope: BudgetScope, scopeKey: string): boolean {
    return this.queries.deleteBudgetByScope(scope, scopeKey) > 0
  }

  getBudgetReport(since: string): BudgetReport {
    return {
      by_tool: this.queries.countToolCallsByTool(since),
      by_source: this.queries.countToolCallsBySource(since),
      period_since: since,
    }
  }

  recordBudgetEvent(
    budgetId: number,
    eventType: 'spend' | 'warn' | 'block' | 'reset',
    tokens: number | null,
  ): void {
    this.queries.insertBudgetEvent(budgetId, eventType, tokens)
  }
}
