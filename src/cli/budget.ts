// Budget CLI — Phase 4.15
// Thin wrapper delegating to BudgetManager. Subcommands: set / get / clear.

import { getDb } from '../db/connection.js'
import {
  resolveProjectDir,
  resolveAnalyticsDbPath,
  projectHash,
} from '../lib/paths.js'
import { BudgetManager } from '../services/budget-manager.js'
import type { BudgetScope } from '../lib/types.js'

export interface BudgetCliOptions {
  cwd?: string
  print?: (msg: string) => void
}

export function runBudgetCli(args: string[] = [], opts: BudgetCliOptions = {}): number {
  const print = opts.print ?? ((m: string) => console.error(m))
  const cwd = opts.cwd ?? process.cwd()
  const projectDir = resolveProjectDir(cwd)
  const dbPath = resolveAnalyticsDbPath(projectDir)

  const db = getDb(dbPath)
  const mgr = new BudgetManager(db)
  const hash = projectHash(projectDir)

  const sub = args[0]

  if (sub === 'set') {
    const scope = args[1] as BudgetScope | undefined
    const limitRaw = args[2]
    const limit = limitRaw ? parseInt(limitRaw, 10) : NaN
    if ((scope !== 'session' && scope !== 'project') || !Number.isFinite(limit)) {
      print('Uso: token-optimizer-mcp budget set <session|project> <limit_tokens>')
      return 1
    }
    const scopeKey = scope === 'session' ? 'default' : hash
    try {
      const budget = mgr.setBudget({
        scope,
        scope_key: scopeKey,
        limit_tokens: limit,
      })
      print(
        `Presupuesto guardado: ${budget.scope}=${budget.scope_key} limit=${budget.limit_tokens} mode=${budget.mode}`,
      )
      return 0
    } catch (e) {
      print(`Error: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
  }

  if (sub === 'get') {
    const status = mgr.checkBudget('default', hash)
    if (!status.active) {
      print('Sin presupuesto activo')
      return 0
    }
    const pct = (status.percent_used * 100).toFixed(1)
    print(
      `gastado=${status.spent} restante=${status.remaining} uso=${pct}% modo=${status.mode ?? 'n/a'}`,
    )
    return 0
  }

  if (sub === 'clear') {
    const scope = args[1] as BudgetScope | undefined
    if (scope !== 'session' && scope !== 'project') {
      print('Uso: token-optimizer-mcp budget clear <session|project>')
      return 1
    }
    const scopeKey = scope === 'session' ? 'default' : hash
    const removed = mgr.clearBudget(scope, scopeKey)
    print(removed ? `Eliminado (${scope})` : 'No habia presupuesto para este scope')
    return 0
  }

  print('Uso: token-optimizer-mcp budget <set|get|clear> [args]')
  return 1
}
