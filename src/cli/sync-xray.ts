// sync-xray CLI — Sends historical analytics data to xray
// Reads all .token-optimizer/analytics.db files and POSTs events to xray.

import fs from 'node:fs'
import path from 'node:path'
import { resolveXrayUrl } from './config.js'

interface ToolCallRow {
  session_id: string
  tool_name: string
  source: string
  output_bytes: number
  tokens_estimated: number
  tokens_actual: number | null
  duration_ms: number | null
  estimation_method: string
  created_at: string
}

async function findAnalyticsDbs(rootDir: string): Promise<Array<{ dbPath: string; projectDir: string; projectName: string }>> {
  const results: Array<{ dbPath: string; projectDir: string; projectName: string }> = []

  // Check root dir
  const rootDb = path.join(rootDir, '.token-optimizer', 'analytics.db')
  if (fs.existsSync(rootDb)) {
    results.push({ dbPath: rootDb, projectDir: rootDir, projectName: path.basename(rootDir) })
  }

  // Check projects/ subdirectories
  const projectsDir = path.join(rootDir, 'projects')
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dbPath = path.join(projectsDir, entry.name, '.token-optimizer', 'analytics.db')
      if (fs.existsSync(dbPath)) {
        results.push({
          dbPath,
          projectDir: path.join(projectsDir, entry.name),
          projectName: entry.name,
        })
      }
    }
  }

  return results
}

export async function runSyncXray(args: string[]): Promise<number> {
  const print = (m: string) => console.error(m)

  const xrayUrl = resolveXrayUrl()
  if (!xrayUrl) {
    print('Error: XRAY_URL no configurado.')
    print('Ejecuta: npx @cocaxcode/token-optimizer-mcp config set xray_url http://localhost:3333')
    return 1
  }

  // Determine root dir
  const rootDir = args.find(a => !a.startsWith('--')) ?? process.cwd()

  print(`Buscando analytics.db en ${rootDir}...`)
  const dbs = await findAnalyticsDbs(rootDir)

  if (dbs.length === 0) {
    print('No se encontraron bases de datos de token-optimizer.')
    return 1
  }

  print(`Encontradas ${dbs.length} base(s) de datos:`)
  for (const db of dbs) {
    print(`  - ${db.projectName}: ${db.dbPath}`)
  }

  let totalSent = 0
  let totalSkipped = 0

  for (const dbInfo of dbs) {
    print(`\nSincronizando ${dbInfo.projectName}...`)

    // Dynamic import to avoid loading better-sqlite3 if not needed
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbInfo.dbPath, { readonly: true })

    const rows = db.prepare(`
      SELECT session_id, tool_name, source, output_bytes, tokens_estimated,
             tokens_actual, duration_ms, estimation_method, created_at
      FROM tool_calls
      ORDER BY created_at ASC
    `).all() as ToolCallRow[]

    db.close()

    print(`  ${rows.length} eventos en la DB`)

    // Send in batches of 50 to avoid overwhelming xray
    const BATCH_SIZE = 50
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const promises = batch.map(async (row) => {
        const event = {
          session_id: row.session_id,
          tool_name: row.tool_name,
          source: row.source,
          output_bytes: row.output_bytes,
          tokens_estimated: row.tokens_estimated,
          tokens_actual: row.tokens_actual,
          duration_ms: row.duration_ms,
          estimation_method: row.estimation_method,
          created_at: row.created_at,
          project_path: dbInfo.projectDir,
          project_name: dbInfo.projectName,
        }

        try {
          const res = await fetch(`${xrayUrl}/hooks/token-optimizer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'token-optimizer-mcp', version: 'sync', event }),
            signal: AbortSignal.timeout(5000),
          })
          if (res.ok) return true
          return false
        } catch {
          return false
        }
      })

      const results = await Promise.all(promises)
      const sent = results.filter(Boolean).length
      totalSent += sent
      totalSkipped += results.length - sent
    }

    print(`  Enviados: ${rows.length} eventos`)
  }

  print(`\nSincronizacion completa:`)
  print(`  Enviados: ${totalSent}`)
  if (totalSkipped > 0) print(`  Fallidos: ${totalSkipped}`)
  print(`  Dashboard: ${xrayUrl}`)

  return 0
}
