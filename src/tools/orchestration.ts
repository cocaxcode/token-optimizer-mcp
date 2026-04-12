// Orchestration MCP tools — Phase 4.23-4.28
// mcp_usage_stats, mcp_cost_report, optimization_status,
// mcp_prune_suggest, mcp_prune_apply, mcp_prune_rollback, mcp_prune_clear

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import { text, error } from '../lib/response.js'
import { getUsageStats, getCostReport } from '../services/stats.js'
import {
  probeSerena,
  probeRtk,
  probeMcpPruning,
  probePromptCaching,
  checkSerenaHealth,
} from '../orchestration/detector.js'
import { measureCurrentSchemaBytes } from '../orchestration/schema-measurer.js'
import { buildSuggestions } from '../orchestration/advisor.js'
import {
  generateFromHistory,
  applyAllowlist,
  rollback,
  clearAllowlist,
} from '../cli/prune-mcp.js'
import type { OptimizationStatus } from '../lib/types.js'

type DB = Database.Database

export function registerOrchestrationTools(server: McpServer, db: DB): void {
  // ── mcp_usage_stats ──
  server.tool(
    'mcp_usage_stats',
    'Estadisticas de uso de tokens por herramienta y fuente en un periodo.',
    {
      days: z.number().int().positive().max(365).optional().describe('Dias a analizar (default: 7)'),
    },
    async ({ days }) => {
      try {
        const stats = getUsageStats(db, days ?? 7)
        const lines = [
          `Uso en los ultimos ${stats.period_days} dia(s):`,
          '',
          `Total: ${stats.total_tokens} tokens, ${stats.total_events} eventos`,
          '',
          'Por fuente:',
        ]
        if (stats.by_source.length === 0) {
          lines.push('  (sin datos)')
        } else {
          for (const row of stats.by_source) {
            lines.push(`  ${row.source}: ${row.tokens} tokens, ${row.count} llamadas`)
          }
        }
        lines.push('')
        lines.push('Top herramientas:')
        if (stats.by_tool.length === 0) {
          lines.push('  (sin datos)')
        } else {
          for (const row of stats.by_tool.slice(0, 10)) {
            lines.push(`  ${row.tool_name}: ${row.tokens} tokens, ${row.count} llamadas`)
          }
        }
        return text(lines.join('\n'))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── mcp_cost_report ──
  server.tool(
    'mcp_cost_report',
    'Reporte de coste estimado con rango Sonnet-Opus y disclaimer honesto.',
    {
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe('Dias a analizar (default: 7)'),
    },
    async ({ days }) => {
      try {
        const cost = getCostReport(db, days ?? 7)
        const lines = [
          `Reporte de coste (${cost.period_days} dia(s)):`,
          '',
          `Tokens totales: ${cost.total_tokens}`,
          `Rango estimado: $${cost.estimated_cost_usd_min.toFixed(4)} (Sonnet) - $${cost.estimated_cost_usd_max.toFixed(4)} (Opus)`,
          '',
          `Nota: ${cost.disclaimer}`,
        ]
        return text(lines.join('\n'))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── optimization_status ──
  server.tool(
    'optimization_status',
    'Estado de las optimizaciones detectadas: serena, RTK, MCP pruning, prompt caching, schema size.',
    {},
    async () => {
      try {
        const serena = probeSerena()
        const rtk = probeRtk()
        const pruning = probeMcpPruning()
        const pcProbe = probePromptCaching()
        void pcProbe
        const schema = measureCurrentSchemaBytes()
        // Always include prompt_caching with explicit estimation_method per measurement-honesty spec
        const status: OptimizationStatus = {
          serena,
          rtk,
          mcp_pruning: pruning,
          prompt_caching: {
            active_by_default: true,
            savings_tokens: null,
            estimation_method: 'unknown',
            note: 'Revisa tu factura Anthropic para confirmar el ahorro real',
          },
          schema_bytes: {
            tool_schema_bytes: schema.tool_schema_bytes,
            measurement_method: schema.measurement_method,
          },
        }
        const serenaHealth = serena.present ? checkSerenaHealth() : []
        const suggestions = buildSuggestions(status)
        return text(JSON.stringify({ status, serena_health: serenaHealth, suggestions }, null, 2))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── mcp_prune_suggest ──
  server.tool(
    'mcp_prune_suggest',
    'Genera un allowlist de MCPs basandose en el historial (NO modifica archivos).',
    {
      days: z
        .number()
        .int()
        .positive()
        .max(365)
        .optional()
        .describe('Dias de historial a analizar (default: 14)'),
    },
    async ({ days }) => {
      try {
        const proposal = generateFromHistory({ days: days ?? 14 })
        return text(JSON.stringify(proposal, null, 2))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── mcp_prune_apply ──
  server.tool(
    'mcp_prune_apply',
    'Aplica un allowlist de MCPs escribiendo en .claude/settings.local.json. Requiere confirm:true.',
    {
      allowlist: z.array(z.string()).describe('Nombres de servidores MCP a permitir'),
      confirm: z.boolean().describe('Debe ser true para confirmar la escritura'),
    },
    async ({ allowlist, confirm }) => {
      try {
        if (confirm !== true) {
          return error(
            'Operacion destructiva: requiere confirm:true. Revisa el allowlist antes de aplicar.',
          )
        }
        const schema = measureCurrentSchemaBytes()
        const registered = new Set(schema.mcp_servers)
        if (registered.size > 0) {
          const invalid = allowlist.filter((s) => !registered.has(s))
          if (invalid.length > 0) {
            return error(
              `Allowlist contiene MCPs no registrados en settings: ${invalid.join(', ')}`,
            )
          }
        }
        const applied = applyAllowlist(allowlist, { source: 'mcp' })
        return text(
          `Allowlist aplicado.\n  settings: ${applied.settings_path}\n  backup:   ${applied.backup_path}`,
        )
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── mcp_prune_rollback ──
  server.tool(
    'mcp_prune_rollback',
    'Restaura el backup mas reciente de settings.local.json. Requiere confirm:true.',
    {
      confirm: z.boolean(),
      to: z.string().optional().describe('Timestamp opcional del backup a restaurar'),
    },
    async ({ confirm, to }) => {
      try {
        if (confirm !== true) {
          return error('Operacion destructiva: requiere confirm:true.')
        }
        const result = rollback(to !== undefined ? { to } : {})
        if (!result.restored) return error('No hay backups disponibles.')
        return text(`Restaurado desde ${result.from}`)
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── mcp_prune_clear ──
  server.tool(
    'mcp_prune_clear',
    'Elimina el allowlist de settings.local.json (crea backup). Requiere confirm:true.',
    {
      confirm: z.boolean(),
    },
    async ({ confirm }) => {
      try {
        if (confirm !== true) {
          return error('Operacion destructiva: requiere confirm:true.')
        }
        const result = clearAllowlist()
        return text(
          result.cleared ? `Allowlist eliminado (backup: ${result.backup_path})` : 'Nada que eliminar',
        )
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
