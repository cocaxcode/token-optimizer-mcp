// Coach CLI — Phase 4.50
// Subcommands: status | list | explain <tip_id> | reset

import fs from 'node:fs'
import { KNOWLEDGE_BASE } from '../coach/knowledge-base.js'
import { runRules } from '../coach/detector.js'
import { measureContextSize } from '../coach/context-meter.js'
import { clearSurfaceLog } from '../coach/surface.js'
import { getDb } from '../db/connection.js'
import { resolveProjectDir, resolveAnalyticsDbPath } from '../lib/paths.js'
import { buildQueries } from '../db/queries.js'
import type { EventContext, ToolEvent } from '../lib/types.js'

export interface CoachCliOptions {
  cwd?: string
  print?: (msg: string) => void
}

export async function runCoachCli(
  args: string[] = [],
  opts: CoachCliOptions = {},
): Promise<number> {
  const print = opts.print ?? ((m: string) => console.error(m))
  const cwd = opts.cwd ?? process.cwd()
  const sub = args[0] ?? 'status'

  if (sub === 'list') {
    print(`Knowledge base (${KNOWLEDGE_BASE.length} tips):`)
    for (const tip of KNOWLEDGE_BASE) {
      print(`  • ${tip.id.padEnd(32)} ${tip.title}`)
    }
    return 0
  }

  if (sub === 'explain') {
    const tipId = args[1]
    if (!tipId) {
      print('Uso: token-optimizer-mcp coach explain <tip_id>')
      return 1
    }
    const tip = KNOWLEDGE_BASE.find((t) => t.id === tipId)
    if (!tip) {
      print(`Tip no encontrado: ${tipId}`)
      return 1
    }
    print(tip.title)
    print('')
    print(tip.description)
    print('')
    print(`Como usarlo: ${tip.how_to_invoke}`)
    print(`Cuando:      ${tip.when_applicable}`)
    print(`Ahorro:      ${tip.savings_estimate}`)
    print(`Fuente:      ${tip.savings_source} · verificado: ${tip.verified_at}`)
    return 0
  }

  if (sub === 'reset') {
    const projectDir = resolveProjectDir(cwd)
    const dbPath = resolveAnalyticsDbPath(projectDir)
    if (!fs.existsSync(dbPath)) {
      print('Sin DB; nada que resetear.')
      return 0
    }
    const db = getDb(dbPath)
    const deleted = clearSurfaceLog(db)
    print(`Log de coach reseteado (${deleted} entradas eliminadas)`)
    return 0
  }

  // Default: status
  const projectDir = resolveProjectDir(cwd)
  const dbPath = resolveAnalyticsDbPath(projectDir)
  if (!fs.existsSync(dbPath)) {
    print('Coach status: sin datos. Ejecuta el hook posttooluse al menos una vez.')
    return 0
  }
  const db = getDb(dbPath)
  const contextOpts: {
    db: typeof db
    projectDir?: string
  } = { db }
  if (projectDir) contextOpts.projectDir = projectDir
  const context = await measureContextSize('default', contextOpts)

  const queries = buildQueries(db)
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const rawRows = queries.getToolCallsSince(since) as ToolEvent[]
  const ctx: EventContext = {
    session_id: 'default',
    events: rawRows.slice(0, 100),
    session_token_total: context.tokens,
    session_token_method: context.estimation_method,
    session_token_limit: context.limit,
    active_model: null,
  }
  const hits = runRules(ctx)

  print('token-optimizer-mcp coach status')
  print('')
  print(
    `Contexto: ${(context.percent * 100).toFixed(1)}% (${context.tokens}/${context.limit} tokens, ${context.estimation_method})`,
  )
  print(`Tips activos: ${hits.length}`)
  if (hits.length === 0) {
    print('  (sin tips disparados en este momento)')
  } else {
    for (const h of hits) {
      print(`  [${h.severity}] ${h.rule_id}: ${h.evidence}`)
    }
  }
  return 0
}
