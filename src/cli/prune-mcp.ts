// prune-mcp CLI + service — Phase 4.16-4.22
// Generate allowlist from history, apply/rollback/clear, compute impact.
// Writes to .claude/settings.local.json (NOT settings.json).

import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/connection.js'
import { resolveProjectDir, resolveAnalyticsDbPath } from '../lib/paths.js'
import { measureCurrentSchemaBytes } from '../orchestration/schema-measurer.js'

const MCP_TOOL_RE = /^mcp__([^_]+(?:_[^_]+)*?)__/

function extractServerFromToolName(toolName: string): string | null {
  const m = MCP_TOOL_RE.exec(toolName)
  return m ? m[1] : null
}

export function settingsLocalPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.local.json')
}

function readJsonSafe(p: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeJson(p: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

export interface GeneratedAllowlist {
  proposed_allowlist: string[]
  inactive_servers: string[]
  analysis_days: number
  total_mcp_events: number
  server_counts: Record<string, number>
}

export interface GenerateOptions {
  cwd?: string
  days?: number
  home?: string
}

export function generateFromHistory(opts: GenerateOptions = {}): GeneratedAllowlist {
  const cwd = opts.cwd ?? process.cwd()
  const days = opts.days ?? 14
  const projectDir = resolveProjectDir(cwd)
  const dbPath = resolveAnalyticsDbPath(projectDir)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const serverCounts: Record<string, number> = {}
  if (fs.existsSync(dbPath)) {
    const db = getDb(dbPath)
    const rows = db
      .prepare(
        `SELECT tool_name, COUNT(*) as count
         FROM tool_calls
         WHERE created_at >= ? AND tool_name LIKE 'mcp__%'
         GROUP BY tool_name`,
      )
      .all(since) as Array<{ tool_name: string; count: number }>
    for (const row of rows) {
      const server = extractServerFromToolName(row.tool_name)
      if (server) {
        serverCounts[server] = (serverCounts[server] ?? 0) + row.count
      }
    }
  }

  const schema = measureCurrentSchemaBytes({ cwd, home: opts.home })
  const registered = new Set(schema.mcp_servers)
  const used = new Set(Object.keys(serverCounts))
  const inactive = [...registered].filter((s) => !used.has(s))

  return {
    proposed_allowlist: [...used],
    inactive_servers: inactive,
    analysis_days: days,
    total_mcp_events: Object.values(serverCounts).reduce((a, b) => a + b, 0),
    server_counts: serverCounts,
  }
}

export interface ApplyOptions {
  cwd?: string
  source?: 'cli' | 'mcp'
}

export interface ApplyResult {
  settings_path: string
  backup_path: string
}

function timestampForBackup(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function insertSnapshot(cwd: string, method: string, details: Record<string, unknown>): void {
  try {
    const projectDir = resolveProjectDir(cwd)
    const dbPath = resolveAnalyticsDbPath(projectDir)
    if (!fs.existsSync(dbPath)) return
    const db = getDb(dbPath)
    db.prepare(`INSERT INTO optimization_snapshots (method, details) VALUES (?, ?)`).run(
      method,
      JSON.stringify(details),
    )
  } catch {
    // swallow
  }
}

export function applyAllowlist(allowlist: string[], opts: ApplyOptions = {}): ApplyResult {
  const cwd = opts.cwd ?? process.cwd()
  const source = opts.source ?? 'cli'
  const settingsPath = settingsLocalPath(cwd)
  const backupPath = `${settingsPath}.backup-${timestampForBackup()}`

  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, backupPath)
  } else {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.writeFileSync(backupPath, '{}')
  }

  const current = readJsonSafe(settingsPath)
  current.enabledMcpjsonServers = allowlist
  writeJson(settingsPath, current)

  insertSnapshot(cwd, source === 'mcp' ? 'allowlist_generated_via_mcp' : 'allowlist_generated', {
    allowlist,
    target: settingsPath,
    backup: backupPath,
  })

  return { settings_path: settingsPath, backup_path: backupPath }
}

export interface RollbackOptions {
  cwd?: string
  to?: string
}

export interface RollbackResult {
  restored: boolean
  from: string | null
}

export function rollback(opts: RollbackOptions = {}): RollbackResult {
  const cwd = opts.cwd ?? process.cwd()
  const settingsPath = settingsLocalPath(cwd)
  const dir = path.dirname(settingsPath)
  if (!fs.existsSync(dir)) return { restored: false, from: null }

  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('settings.local.json.backup-'))
    .sort()
  if (backups.length === 0) return { restored: false, from: null }

  const target = opts.to ? backups.find((b) => b.includes(opts.to!)) : backups[backups.length - 1]
  if (!target) return { restored: false, from: null }

  const backupPath = path.join(dir, target)
  fs.copyFileSync(backupPath, settingsPath)

  insertSnapshot(cwd, 'rollback', { from: backupPath, to: settingsPath })
  return { restored: true, from: backupPath }
}

export function clearAllowlist(opts: { cwd?: string } = {}): { cleared: boolean; backup_path: string | null } {
  const cwd = opts.cwd ?? process.cwd()
  const settingsPath = settingsLocalPath(cwd)
  if (!fs.existsSync(settingsPath)) return { cleared: false, backup_path: null }

  const backupPath = `${settingsPath}.backup-${timestampForBackup()}`
  fs.copyFileSync(settingsPath, backupPath)

  const json = readJsonSafe(settingsPath)
  delete json.enabledMcpjsonServers
  writeJson(settingsPath, json)

  insertSnapshot(cwd, 'allowlist_cleared', { backup: backupPath })
  return { cleared: true, backup_path: backupPath }
}

export interface ImpactResult {
  before_avg: number | null
  after_avg: number | null
  delta: number | null
  percent: number | null
  snapshot_at: string | null
}

export function impact(opts: { cwd?: string } = {}): ImpactResult {
  const cwd = opts.cwd ?? process.cwd()
  const projectDir = resolveProjectDir(cwd)
  const dbPath = resolveAnalyticsDbPath(projectDir)
  if (!fs.existsSync(dbPath)) {
    return { before_avg: null, after_avg: null, delta: null, percent: null, snapshot_at: null }
  }
  const db = getDb(dbPath)
  const snapshot = db
    .prepare(
      `SELECT created_at FROM optimization_snapshots
       WHERE method LIKE 'allowlist_%'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { created_at: string } | undefined
  if (!snapshot) {
    return { before_avg: null, after_avg: null, delta: null, percent: null, snapshot_at: null }
  }

  const before = db
    .prepare(
      `SELECT AVG(tokens_estimated) as avg FROM (
         SELECT tokens_estimated FROM tool_calls WHERE created_at < ? ORDER BY created_at DESC LIMIT 100
       )`,
    )
    .get(snapshot.created_at) as { avg: number | null }
  const after = db
    .prepare(
      `SELECT AVG(tokens_estimated) as avg FROM (
         SELECT tokens_estimated FROM tool_calls WHERE created_at >= ? ORDER BY created_at ASC LIMIT 100
       )`,
    )
    .get(snapshot.created_at) as { avg: number | null }

  const beforeAvg = before.avg
  const afterAvg = after.avg
  const delta = beforeAvg !== null && afterAvg !== null ? afterAvg - beforeAvg : null
  const percent =
    beforeAvg !== null && beforeAvg > 0 && afterAvg !== null
      ? (afterAvg - beforeAvg) / beforeAvg
      : null

  return {
    before_avg: beforeAvg,
    after_avg: afterAvg,
    delta,
    percent,
    snapshot_at: snapshot.created_at,
  }
}

export interface PruneMcpCliOptions {
  cwd?: string
  print?: (msg: string) => void
}

export function runPruneMcp(args: string[] = [], opts: PruneMcpCliOptions = {}): number {
  const print = opts.print ?? ((m: string) => console.error(m))
  const cwd = opts.cwd ?? process.cwd()

  if (args.includes('--generate-from-history')) {
    const daysFlag = args.find((a) => a.startsWith('--days='))
    const days = daysFlag ? parseInt(daysFlag.split('=')[1], 10) : 14
    const result = generateFromHistory({ cwd, days })
    print(`Propuesta de allowlist (${days} dias de historial):`)
    print(`  Usados:    ${result.proposed_allowlist.join(', ') || '(ninguno)'}`)
    print(`  Inactivos: ${result.inactive_servers.join(', ') || '(ninguno)'}`)
    print(`  Eventos MCP totales: ${result.total_mcp_events}`)
    return 0
  }

  if (args.includes('--apply')) {
    const generated = generateFromHistory({ cwd })
    if (generated.proposed_allowlist.length === 0) {
      print('No hay MCPs activos en el historial. Nada que aplicar.')
      return 1
    }
    const applied = applyAllowlist(generated.proposed_allowlist, { cwd })
    print(`Allowlist aplicado a ${applied.settings_path}`)
    print(`Backup: ${applied.backup_path}`)
    return 0
  }

  if (args.includes('--rollback')) {
    const toFlag = args.find((a) => a.startsWith('--to='))
    const to = toFlag ? toFlag.split('=')[1] : undefined
    const result = rollback({ cwd, to })
    if (result.restored) {
      print(`Restaurado desde ${result.from}`)
      return 0
    }
    print('No hay backups disponibles.')
    return 1
  }

  if (args.includes('--clear')) {
    const result = clearAllowlist({ cwd })
    print(result.cleared ? `Allowlist eliminado (backup: ${result.backup_path})` : 'Nada que eliminar')
    return 0
  }

  if (args.includes('--impact')) {
    const result = impact({ cwd })
    if (result.snapshot_at === null) {
      print('No hay snapshots de allowlist todavia.')
      return 0
    }
    print(`Snapshot mas reciente: ${result.snapshot_at}`)
    print(`Promedio tokens/evento antes: ${result.before_avg?.toFixed(1) ?? 'n/a'}`)
    print(`Promedio tokens/evento despues: ${result.after_avg?.toFixed(1) ?? 'n/a'}`)
    if (result.percent !== null) {
      print(`Delta: ${(result.percent * 100).toFixed(1)}%`)
    }
    return 0
  }

  // Default: list registered MCPs with estimated cost
  const schema = measureCurrentSchemaBytes({ cwd })
  print(`MCPs registrados (${schema.mcp_servers.length}):`)
  for (const s of schema.mcp_servers) {
    print(`  ${s}`)
  }
  print(`Coste estimado (heuristica): ~${schema.tool_schema_tokens} tokens`)
  print('')
  print('Flags:')
  print('  --generate-from-history [--days N]   Propone allowlist (read-only)')
  print('  --apply                               Aplica el allowlist generado')
  print('  --rollback [--to TIMESTAMP]           Restaura el ultimo backup')
  print('  --clear                               Elimina allowlist actual')
  print('  --impact                              Compara antes/despues del ultimo snapshot')
  return 0
}
