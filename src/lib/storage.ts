// Gitignore management — appends .serena/ to .gitignore idempotently.
// The MCP no longer creates a per-project .token-optimizer/ dir: all storage
// is global under ~/.token-optimizer/ (analytics.db, config.json).

import fs from 'node:fs'
import path from 'node:path'

const GITIGNORE_ENTRIES = ['.serena/']

export function ensureGitignore(projectDir: string): void {
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
