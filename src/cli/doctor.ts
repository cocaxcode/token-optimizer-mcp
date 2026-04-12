// Doctor CLI — Phase 4.12
// Runs all detection probes + schema-measurer + advisor and prints a Spanish report.
// Always exits 0.

import {
  probeSerena,
  probeRtk,
  probeMcpPruning,
  probePromptCaching,
  checkSerenaHealth,
} from '../orchestration/detector.js'
import { measureCurrentSchemaBytes } from '../orchestration/schema-measurer.js'
import { buildSuggestions } from '../orchestration/advisor.js'
import type { OptimizationStatus } from '../lib/types.js'

export interface DoctorOptions {
  home?: string
  cwd?: string
  print?: (msg: string) => void
}

function symbol(present: boolean): string {
  return present ? '✓' : '✗'
}

export function runDoctor(_args: string[] = [], opts: DoctorOptions = {}): number {
  const print = opts.print ?? ((m: string) => console.error(m))
  const paths = { home: opts.home, cwd: opts.cwd }

  const serena = probeSerena(paths)
  const rtk = probeRtk(paths)
  const pruning = probeMcpPruning(paths)
  const promptCaching = probePromptCaching()
  const schema = measureCurrentSchemaBytes(paths)

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

  const lines: string[] = []
  lines.push('token-optimizer-mcp doctor')
  lines.push('')
  lines.push(
    `[serena]        ${symbol(status.serena.present)} conf=${status.serena.confidence.toFixed(2)}  signals: ${status.serena.signals.join(', ') || '(ninguno)'}`,
  )
  if (serena.present) {
    const healthWarnings = checkSerenaHealth(paths)
    for (const w of healthWarnings) {
      lines.push(`  ⚠ ${w.message} — ${w.fix}`)
    }
  }
  lines.push(
    `[rtk]           ${symbol(status.rtk.present)} conf=${status.rtk.confidence.toFixed(2)}  signals: ${status.rtk.signals.join(', ') || '(ninguno)'}`,
  )
  lines.push(
    `[mcp-pruning]   ${symbol(status.mcp_pruning.present)} conf=${status.mcp_pruning.confidence.toFixed(2)}  signals: ${status.mcp_pruning.signals.join(', ') || '(ninguno)'}`,
  )
  lines.push(
    `[prompt-cache]  ~ activo por defecto en Claude Code — ${promptCaching.details.note as string}`,
  )
  lines.push(
    `[schema-size]   ~${schema.tool_schema_tokens} tokens / ${schema.tool_schema_bytes} bytes (${schema.measurement_method}) — ${schema.mcp_servers.length} MCP server(s): ${schema.mcp_servers.join(', ') || '(ninguno)'}`,
  )

  const suggestions = buildSuggestions(status, paths)
  if (suggestions.length > 0) {
    lines.push('')
    lines.push('Sugerencias:')
    for (const s of suggestions) {
      lines.push('')
      lines.push(s)
    }
  }

  print(lines.join('\n'))
  return 0
}
