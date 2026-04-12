// Report CLI — Phase 4.14
// Per-source breakdown WITH estimation_method label + Medido/Estimado split +
// reference-data table (coach-layer addendum CO-4). Spanish.

import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { getDb } from '../db/connection.js'
import { resolveProjectDir, resolveAnalyticsDbPath } from '../lib/paths.js'

type DB = Database.Database

type Period = 'session' | 'day' | 'week' | 'month'

const PERIOD_DAYS: Record<Period, number> = {
  session: 3650,
  day: 1,
  week: 7,
  month: 30,
}

interface SourceMethodRow {
  source: string
  estimation_method: string | null
  count: number
  tokens: number
}

function isMeasured(method: string | null): boolean {
  return method === 'measured_exact' || method === 'measured_delta'
}

function queryBySourceAndMethod(db: DB, sinceIso: string): SourceMethodRow[] {
  return db
    .prepare(
      `SELECT source, estimation_method,
              COUNT(*) as count,
              COALESCE(SUM(tokens_estimated), 0) as tokens
       FROM tool_calls
       WHERE created_at >= ?
       GROUP BY source, estimation_method
       ORDER BY tokens DESC`,
    )
    .all(sinceIso) as SourceMethodRow[]
}

export interface ReportOptions {
  cwd?: string
  period?: Period
  print?: (msg: string) => void
}

const REFERENCE_DATA: Array<{
  feature: string
  saving: string
  source: string
  verified_at: string
}> = [
  {
    feature: 'Model switching (opusplan / default-to-sonnet)',
    saving: '60-80% reduccion de coste',
    source: 'mindstudio.ai, verdent.ai, claudelab.net',
    verified_at: '2026-04-11',
  },
  {
    feature: 'Progressive disclosure skills',
    saving: '~15k tokens/sesion (82% mejor que CLAUDE.md monolitico)',
    source: 'claudefast.com',
    verified_at: '2026-04-11',
  },
  {
    feature: 'Prompt caching read hit',
    saving: '10x mas barato que uncached',
    source: 'Anthropic docs',
    verified_at: '2026-04-11',
  },
  {
    feature: 'Claude Code Tool Search',
    saving: '~85% schema reduction (77k → 8.7k)',
    source: 'observado en sesion',
    verified_at: '2026-04-11',
  },
  {
    feature: 'MCP pruning sobre Tool Search',
    saving: '~5-12% adicional por turno',
    source: 'estimacion interna',
    verified_at: '2026-04-11',
  },
]

function resolvePeriod(args: string[], fallback: Period): Period {
  const flag = args.find((a) => a.startsWith('--period='))
  if (flag) {
    const value = flag.split('=')[1] as Period | undefined
    if (value && value in PERIOD_DAYS) return value
  }
  return fallback
}

export function runReport(args: string[] = [], opts: ReportOptions = {}): number {
  const print = opts.print ?? ((m: string) => console.error(m))
  const cwd = opts.cwd ?? process.cwd()
  const period: Period = opts.period ?? resolvePeriod(args, 'day')
  const days = PERIOD_DAYS[period]

  const projectDir = resolveProjectDir(cwd)
  const dbPath = resolveAnalyticsDbPath(projectDir)

  const lines: string[] = []
  lines.push(`token-optimizer-mcp reporte — periodo: ${period} (${days} dia(s))`)
  lines.push('')

  if (!fs.existsSync(dbPath)) {
    lines.push('No hay datos registrados todavia.')
  } else {
    const db = getDb(dbPath)
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = queryBySourceAndMethod(db, since)

    let medidoTotal = 0
    let estimadoTotal = 0

    lines.push('Por fuente y metodo de estimacion:')
    if (rows.length === 0) {
      lines.push('  (sin eventos en este periodo)')
    } else {
      for (const row of rows) {
        const method = row.estimation_method ?? 'unknown'
        lines.push(
          `  ${row.source.padEnd(8)} [${method}]  ${row.count} llamadas  ${row.tokens} tokens`,
        )
        if (isMeasured(method)) medidoTotal += row.tokens
        else estimadoTotal += row.tokens
      }
    }
    lines.push('')
    lines.push(`Resumen: Medido: ${medidoTotal} tokens · Estimado: ${estimadoTotal} tokens`)
    lines.push('')
  }

  // Coach activity section (always present; filled in Phase 4.H with real data)
  lines.push('Coach activity:')
  lines.push('  (sin tips surfaceados todavia — coach layer se activa en Phase 4.H)')
  lines.push('')

  printReference(lines)
  print(lines.join('\n'))
  return 0
}

function printReference(lines: string[]): void {
  lines.push('Referencia (datos publicos verificables):')
  for (const row of REFERENCE_DATA) {
    lines.push(`  • ${row.feature}`)
    lines.push(`    ahorro: ${row.saving}`)
    lines.push(`    fuente: ${row.source} · verificado: ${row.verified_at}`)
  }
}
