// getDb() singleton with WAL + FK — Phase 1.3

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { SCHEMA_SQL } from './schema.js'

type DB = Database.Database

function migrateSchema(db: DB): void {
  const cols = (db.pragma('table_info(tool_calls)') as { name: string }[]).map(
    (c) => c.name,
  )
  if (!cols.includes('tool_input_summary')) {
    db.exec('ALTER TABLE tool_calls ADD COLUMN tool_input_summary TEXT')
  }
}

let dbInstance: DB | null = null
let currentPath: string | null = null

export function getDb(dbPath?: string): DB {
  const resolvedPath = dbPath ?? ':memory:'
  if (dbInstance && currentPath === resolvedPath) {
    return dbInstance
  }
  if (dbInstance && currentPath !== resolvedPath) {
    try {
      dbInstance.close()
    } catch {
      // swallow
    }
    dbInstance = null
  }
  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  // Migracion: agregar columnas que no existian en versiones anteriores
  migrateSchema(db)
  dbInstance = db
  currentPath = resolvedPath
  return db
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close()
    } catch {
      // swallow
    }
    dbInstance = null
    currentPath = null
  }
}
