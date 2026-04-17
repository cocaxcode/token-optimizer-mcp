#!/usr/bin/env node
// Rellena retrospectivamente la columna shadow_delta_tokens de las filas de
// source=serena que tengan command_preview con un relative_path válido.
//
// Por qué existe: el cable de shadow measurement de serena sólo se ejecuta
// cuando el flag `shadow_measurement.serena = true` está activo. Si el flag
// llevaba tiempo en false (por defecto), las filas históricas tienen
// shadow_delta_tokens a NULL aunque el path del archivo sí se guardó en
// command_preview.
//
// Estrategia: para cada fila candidata, intenta resolver el path contra
// varias bases (proyecto, CWD, $HOME). Si el archivo existe hoy en disco,
// calcula fullFileTokens = ceil(file.size * 0.27) y rellena
// shadow_delta_tokens = max(0, fullFileTokens - tokens_estimated).
//
// Limitación honesta: si el archivo cambió de tamaño o fue borrado desde la
// call original, la medida es aproximada. Es mejor que NULL (factor 5× fijo)
// pero menos precisa que el shadow en vivo.
//
// Uso:
//   node scripts/backfill-serena-shadow.mjs [options]
//
// Options:
//   --dry-run             No escribe en ninguna DB; sólo muestra qué se haría.
//   --db <path>           Ruta a analytics.db (default: ~/.token-optimizer/analytics.db).
//   --bases <d1,d2,...>   Directorios donde buscar archivos. Default: CWD + HOME.
//   --xray-db <path>      Ruta a la DB mirror de xray (default: ~/.xray/data.db).
//                         Si existe y tiene la columna shadow_delta_tokens
//                         (requiere xray schema v6+), también propaga el backfill
//                         a la mirror usando input_hash como key. Si no, avisa.
//   --skip-xray           No tocar la DB de xray aunque exista.
//   --verbose             Log línea a línea.
//
// Ejemplo:
//   node scripts/backfill-serena-shadow.mjs --bases C:/cocaxcode --dry-run

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const CHARS_PER_TOKEN = 0.27

function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, bases: [], db: null, xrayDb: null, skipXray: false, resyncXrayAll: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--verbose') args.verbose = true
    else if (a === '--db') args.db = argv[++i]
    else if (a === '--xray-db') args.xrayDb = argv[++i]
    else if (a === '--skip-xray') args.skipXray = true
    else if (a === '--resync-xray-all') args.resyncXrayAll = true
    else if (a === '--bases') args.bases = String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--help' || a === '-h') {
      console.log(`backfill-serena-shadow — rellena shadow_delta_tokens retrospectivo

Uso: node scripts/backfill-serena-shadow.mjs [options]

Options:
  --dry-run             No escribe en la DB; sólo muestra qué se haría.
  --db <path>           Ruta a analytics.db (default: ~/.token-optimizer/analytics.db).
  --bases <d1,d2,...>   Directorios donde buscar archivos. Default: CWD + HOME.
  --verbose             Log línea a línea.
  -h, --help            Muestra esta ayuda.`)
      process.exit(0)
    }
  }
  if (!args.bases.length) args.bases = [process.cwd(), os.homedir()]
  if (!args.db) args.db = path.join(os.homedir(), '.token-optimizer', 'analytics.db')
  if (!args.xrayDb) args.xrayDb = path.join(os.homedir(), '.xray', 'data.db')
  return args
}

/**
 * Propaga los shadow_delta_tokens actualizados en token-optimizer a la DB
 * mirror de xray. La tabla optimization_events de xray guarda el id original
 * de token-optimizer en la columna `input_hash` (como string), por eso
 * cruzamos por ese campo.
 */
function syncXrayMirror(xrayDbPath, sourceUpdatesMap, dryRun, verbose) {
  if (!fs.existsSync(xrayDbPath)) {
    console.log(`Xray:     DB no existe en ${xrayDbPath} — skip sync`)
    return
  }
  const xdb = new Database(xrayDbPath, { readonly: dryRun, fileMustExist: true })
  try {
    const cols = xdb.prepare("PRAGMA table_info('optimization_events')").all().map((c) => c.name)
    if (!cols.includes('shadow_delta_tokens')) {
      console.log('')
      console.log('Xray:     ⚠ La DB de xray NO tiene la columna shadow_delta_tokens.')
      console.log('          Reinicia el servidor de xray para aplicar la migración schema v6,')
      console.log('          luego vuelve a ejecutar este script con --skip-xray=false.')
      return
    }

    const updateStmt = dryRun ? null : xdb.prepare(`
      UPDATE optimization_events
      SET shadow_delta_tokens = ?
      WHERE input_hash = ?
    `)

    let mirrored = 0
    let notFound = 0
    const doTxn = dryRun ? (cb) => cb() : xdb.transaction((cb) => cb())
    doTxn(() => {
      for (const [sourceId, delta] of sourceUpdatesMap) {
        const check = xdb.prepare('SELECT id FROM optimization_events WHERE input_hash = ?').get(String(sourceId))
        if (!check) {
          notFound++
          continue
        }
        if (!dryRun) updateStmt.run(delta, String(sourceId))
        mirrored++
        if (verbose) console.log(`  Xray sync: source_id=${sourceId} → delta=${delta}`)
      }
    })

    console.log('')
    console.log('=== Xray mirror ===')
    console.log(`DB:                 ${xrayDbPath}`)
    console.log(`Filas sincronizadas:${mirrored}`)
    console.log(`No encontradas en mirror: ${notFound}`)
  } finally {
    xdb.close()
  }
}

function resolveFileSize(relPath, bases) {
  for (const base of bases) {
    try {
      const abs = path.resolve(base, relPath)
      const stat = fs.statSync(abs)
      if (stat.isFile()) return { size: stat.size, path: abs }
    } catch { /* path no existe en esta base */ }
  }
  return null
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(args.db)) {
    console.error(`ERROR: DB no encontrada en ${args.db}`)
    process.exit(1)
  }

  console.log(`DB:       ${args.db}`)
  console.log(`Bases:    ${args.bases.join(', ')}`)
  console.log(`Modo:     ${args.dryRun ? 'DRY RUN (no escribe)' : 'WRITE'}`)
  console.log('')

  const db = new Database(args.db, { readonly: args.dryRun, fileMustExist: true })

  try {
    const candidates = db.prepare(`
      SELECT id, tool_name, tokens_estimated, command_preview
      FROM tool_calls
      WHERE source = 'serena'
        AND shadow_delta_tokens IS NULL
        AND tokens_estimated > 0
        AND command_preview IS NOT NULL
        AND command_preview != ''
    `).all()

    console.log(`Candidatos: ${candidates.length}`)
    if (candidates.length === 0) {
      console.log('Nada que hacer. Sal.')
      return
    }

    const updateStmt = args.dryRun ? null : db.prepare(`
      UPDATE tool_calls
      SET shadow_delta_tokens = ?,
          estimation_method = 'estimated_serena_metadata'
      WHERE id = ?
    `)

    let updated = 0
    let skippedNoFile = 0
    let skippedShrunk = 0
    let totalSaved = 0
    const sourceUpdates = new Map() // row.id -> delta (para propagar a xray)

    const doTxn = args.dryRun
      ? (cb) => cb()
      : db.transaction((cb) => cb())

    doTxn(() => {
      for (const row of candidates) {
        const resolved = resolveFileSize(row.command_preview, args.bases)
        if (!resolved) {
          skippedNoFile++
          if (args.verbose) console.log(`  SKIP (sin archivo): ${row.command_preview}`)
          continue
        }
        const fullFileTokens = Math.ceil(resolved.size * CHARS_PER_TOKEN)
        const delta = fullFileTokens - row.tokens_estimated
        if (delta <= 0) {
          skippedShrunk++
          if (args.verbose) console.log(`  SKIP (archivo encogió): ${row.command_preview}`)
          continue
        }
        if (!args.dryRun) updateStmt.run(delta, row.id)
        updated++
        totalSaved += delta
        sourceUpdates.set(row.id, delta)
        if (args.verbose) {
          console.log(`  OK id=${row.id} ${row.command_preview} → +${delta} tok (factor ${(fullFileTokens/row.tokens_estimated).toFixed(2)}x)`)
        }
      }
    })

    console.log('')
    console.log('=== Resumen (token-optimizer) ===')
    console.log(`Actualizados:       ${updated}`)
    console.log(`Sin archivo:        ${skippedNoFile}`)
    console.log(`Archivo encogió:    ${skippedShrunk}`)
    console.log(`Total tokens ahorrados (retrospectivo): ${totalSaved.toLocaleString()}`)
    if (args.dryRun) {
      console.log('')
      console.log('DRY RUN — nada escrito. Vuelve a ejecutar sin --dry-run para aplicar.')
    }

    // Propagar a la mirror de xray para que OptimizationView vea los factores.
    // --resync-xray-all fuerza el sync tomando TODAS las filas de source con
    // shadow_delta_tokens ya poblado (útil si se corrió el backfill antes de
    // añadir la columna shadow_delta_tokens a xray).
    if (!args.skipXray) {
      let toPropagate = sourceUpdates
      if (args.resyncXrayAll) {
        toPropagate = new Map()
        const all = db.prepare(`
          SELECT id, shadow_delta_tokens
          FROM tool_calls
          WHERE source = 'serena'
            AND shadow_delta_tokens IS NOT NULL
            AND shadow_delta_tokens > 0
        `).all()
        for (const r of all) toPropagate.set(r.id, r.shadow_delta_tokens)
        console.log('')
        console.log(`--resync-xray-all: ${toPropagate.size} filas de serena con shadow a propagar.`)
      }
      if (toPropagate.size > 0) {
        syncXrayMirror(args.xrayDb, toPropagate, args.dryRun, args.verbose)
      }
    }
  } finally {
    db.close()
  }
}

main()
