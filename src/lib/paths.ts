// Path helpers — Phase 1.4
// Cross-platform project dir resolution, storage dir, transcript path

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'

const IS_WINDOWS = process.platform === 'win32'

export function normalizePath(p: string): string {
  const resolved = path.resolve(p)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

export function resolveProjectDir(cwd: string = process.cwd()): string {
  let current = path.resolve(cwd)
  const initial = current
  // Walk up looking for .git or package.json; fall back to cwd if not found
  while (true) {
    if (
      fs.existsSync(path.join(current, '.git')) ||
      fs.existsSync(path.join(current, 'package.json'))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return initial
    current = parent
  }
}

export function resolveStorageDir(projectDir: string): string {
  return path.join(projectDir, '.token-optimizer')
}

export function resolveAnalyticsDbPath(projectDir: string): string {
  return path.join(resolveStorageDir(projectDir), 'analytics.db')
}

export function resolveGlobalDir(): string {
  return path.join(os.homedir(), '.token-optimizer')
}

export function projectHash(projectDir: string): string {
  return crypto.createHash('sha256').update(normalizePath(projectDir)).digest('hex').slice(0, 16)
}

/**
 * Resolve the Claude Code transcript JSONL path for a given project + session.
 * Claude Code stores transcripts under `~/.claude/projects/{project-key}/{sessionId}.jsonl`
 * where project-key replaces path separators (/, \, :) with dashes.
 */
export function resolveTranscriptPath(projectDir: string, sessionId: string): string {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  const projectKey = path.resolve(projectDir).replace(/[:\\/]/g, '-')
  return path.join(claudeDir, projectKey, `${sessionId}.jsonl`)
}
