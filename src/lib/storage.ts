// Storage dir initialization — Phase 1.5
// Creates .token-optimizer/ and appends to .gitignore idempotently

import fs from 'node:fs'
import path from 'node:path'
import { resolveStorageDir } from './paths.js'

const GITIGNORE_ENTRIES = ['.token-optimizer/', '.serena/']

function ensureGitignoreEntries(projectDir: string): void {
  const gitDir = path.join(projectDir, '.git')
  if (!fs.existsSync(gitDir)) return

  const gitignorePath = path.join(projectDir, '.gitignore')
  let current = ''
  if (fs.existsSync(gitignorePath)) {
    current = fs.readFileSync(gitignorePath, 'utf8')
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim())
  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => fs.existsSync(path.join(projectDir, entry)) && !lines.includes(entry),
  )
  if (missing.length === 0) return
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  fs.appendFileSync(gitignorePath, `${prefix}${missing.join('\n')}\n`)
}

export function ensureStorageDir(projectDir: string): string {
  const storageDir = resolveStorageDir(projectDir)
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true })
  }
  ensureGitignoreEntries(projectDir)
  return storageDir
}
