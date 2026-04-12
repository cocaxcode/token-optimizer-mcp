// Budget MCP tools — Phase 2.4
// budget_set, budget_check, budget_report

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import { BudgetManager } from '../services/budget-manager.js'
import { text, error } from '../lib/response.js'

type DB = Database.Database

const DAY_MS = 86_400_000

function sinceForPeriod(period: 'session' | 'day' | 'week' | 'month'): string {
  const now = Date.now()
  switch (period) {
    case 'day':
      return new Date(now - DAY_MS).toISOString()
    case 'week':
      return new Date(now - 7 * DAY_MS).toISOString()
    case 'month':
      return new Date(now - 30 * DAY_MS).toISOString()
    case 'session':
    default:
      return '1970-01-01T00:00:00.000Z'
  }
}

export function registerBudgetTools(server: McpServer, db: DB): void {
  const manager = new BudgetManager(db)

  // ── budget_set ──
  server.tool(
    'budget_set',
    'Define o actualiza un presupuesto de tokens. Precedencia: session > project. Modo warn avisa al exceder.',
    {
      scope: z.enum(['session', 'project']).describe('Ambito del presupuesto'),
      scope_key: z.string().min(1).describe('Clave del scope (sessionId o projectHash)'),
      limit_tokens: z
        .number()
        .int()
        .positive()
        .max(10_000_000)
        .describe('Limite en tokens (1..10_000_000)'),
    },
    async ({ scope, scope_key, limit_tokens }) => {
      try {
        const budget = manager.setBudget({ scope, scope_key, limit_tokens })
        return text(
          [
            'Presupuesto guardado:',
            '',
            `  scope:        ${budget.scope}`,
            `  scope_key:    ${budget.scope_key}`,
            `  limit_tokens: ${budget.limit_tokens}`,
            `  mode:         ${budget.mode}`,
          ].join('\n'),
        )
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── budget_check ──
  server.tool(
    'budget_check',
    'Consulta el estado del presupuesto activo (gasto actual, restante y porcentaje).',
    {
      session_id: z.string().optional().describe('ID de sesion (default: "default")'),
      project_hash: z
        .string()
        .optional()
        .describe('Hash del proyecto para fallback a scope project'),
    },
    async ({ session_id, project_hash }) => {
      try {
        const status = manager.checkBudget(session_id ?? 'default', project_hash ?? null)
        if (!status.active) {
          return text('Sin presupuesto activo para la sesion/proyecto actual.')
        }
        const percent = (status.percent_used * 100).toFixed(1)
        return text(
          [
            'Estado del presupuesto:',
            '',
            `  gastado:  ${status.spent} tokens`,
            `  restante: ${status.remaining} tokens`,
            `  uso:      ${percent}%`,
            `  modo:     ${status.mode ?? 'n/a'}`,
          ].join('\n'),
        )
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── budget_report ──
  server.tool(
    'budget_report',
    'Muestra el consumo de tokens agrupado por herramienta y por fuente durante un periodo.',
    {
      period: z
        .enum(['session', 'day', 'week', 'month'])
        .optional()
        .describe('Periodo del reporte (default: day)'),
    },
    async ({ period }) => {
      try {
        const since = sinceForPeriod(period ?? 'day')
        const report = manager.getBudgetReport(since)
        const lines = [`Reporte de consumo (desde ${report.period_since}):`, '']
        lines.push('Por herramienta:')
        if (report.by_tool.length === 0) {
          lines.push('  (sin datos)')
        } else {
          for (const row of report.by_tool) {
            lines.push(`  ${row.tool_name}: ${row.count} llamadas, ${row.tokens} tokens`)
          }
        }
        lines.push('')
        lines.push('Por fuente:')
        if (report.by_source.length === 0) {
          lines.push('  (sin datos)')
        } else {
          for (const row of report.by_source) {
            lines.push(`  ${row.source}: ${row.count} llamadas, ${row.tokens} tokens`)
          }
        }
        return text(lines.join('\n'))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
