// Status CLI — Phase 4.13
// Prints install detection, storage DB, events today, tokens by source, active budget.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb } from '../db/connection.js'
import { resolveProjectDir, resolveAnalyticsDbPath, projectHash } from '../lib/paths.js'
import { getUsageStats, getActiveBudgetSummary } from '../services/stats.js'

export interface StatusOptions {
  home?: string
  cwd?: string
  print?: (msg: string) => void
}

export function runStatus(_args: string[] = [], opts: StatusOptions = {}): number {
  const print = opts.print ?? ((m: string) => console.error(m))
  const home = opts.home ?? os.homedir()
  const cwd = opts.cwd ?? process.cwd()
  const settingsPath = path.join(home, '.claude', 'settings.json')

  const installed = (() => {
    try {
      if (!fs.existsSync(settingsPath)) return false
      const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
      const mcp = (json.mcpServers ?? {}) as Record<string, unknown>
      return 'token-optimizer' in mcp
    } catch {
      return false
    }
  })()

  const projectDir = resolveProjectDir(cwd)
  const dbPath = resolveAnalyticsDbPath(projectDir)

  let eventsToday = 0
  let tokensBySource: Array<{ source: string; tokens: number }> = []
  let budgetLine = 'sin presupuesto activo'

  if (fs.existsSync(dbPath)) {
    try {
      const db = getDb(dbPath)
      const usage = getUsageStats(db, 1)
      eventsToday = usage.total_events
      tokensBySource = usage.by_source.map((r) => ({ source: r.source, tokens: r.tokens }))
      const budget = getActiveBudgetSummary(db, 'default', projectHash(projectDir))
      if (budget.active) {
        const pct = (budget.percent_used * 100).toFixed(1)
        budgetLine = `gastado=${budget.spent} restante=${budget.remaining} uso=${pct}% modo=${budget.mode}`
      }
    } catch {
      // swallow
    }
  }

  const lines: string[] = []
  lines.push('token-optimizer-mcp status')
  lines.push('')
  lines.push(`Instalado:          ${installed ? '✓' : '✗'} (${settingsPath})`)
  lines.push(`Storage DB:         ${dbPath}${fs.existsSync(dbPath) ? '' : ' (no existe aun)'}`)
  lines.push(`Eventos hoy:        ${eventsToday}`)
  lines.push(
    `Tokens por fuente:  ${
      tokensBySource.length > 0
        ? tokensBySource.map((s) => `${s.source}=${s.tokens}`).join(', ')
        : '(sin datos)'
    }`,
  )
  lines.push(`Presupuesto:        ${budgetLine}`)

  print(lines.join('\n'))
  return 0
}
