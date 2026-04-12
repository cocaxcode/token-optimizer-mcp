// Storage dir initialization — Phase 1.5
// Creates .token-optimizer/ and appends to .gitignore idempotently

import fs from 'node:fs'
import path from 'node:path'
import { resolveStorageDir } from './paths.js'

const GITIGNORE_ENTRY = '.token-optimizer/'

export function ensureStorageDir(projectDir: string): string {
  const storageDir = resolveStorageDir(projectDir)
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true })
  }
  // Only touch .gitignore when this is a git repo
  const gitDir = path.join(projectDir, '.git')
  if (!fs.existsSync(gitDir)) {
    return storageDir
  }
  const gitignorePath = path.join(projectDir, '.gitignore')
  let current = ''
  if (fs.existsSync(gitignorePath)) {
    current = fs.readFileSync(gitignorePath, 'utf8')
  }
  const alreadyPresent = current
    .split(/\r?\n/)
    .some((line) => line.trim() === GITIGNORE_ENTRY)
  if (!alreadyPresent) {
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(gitignorePath, `${prefix}${GITIGNORE_ENTRY}\n`)
  }
  return storageDir
}
