// SessionStart hook entry — Phase 3.5
// Only acts on matcher === 'compact'. Other matchers exit silently with empty stdout.

import fs from 'node:fs'
import { getDb } from '../db/connection.js'
import { SessionRetriever } from '../services/session-retriever.js'
import {
  resolveProjectDir,
  resolveAnalyticsDbPath,
  projectHash,
} from '../lib/paths.js'
import { ensureStorageDir } from '../lib/storage.js'
import { renderReinjectionMarkdown } from '../services/session-retriever.js'

export interface SessionStartInput {
  session_id?: string
  matcher?: 'startup' | 'resume' | 'compact' | string
}

export interface RunSessionStartOptions {
  stdin?: string
  dbPath?: string
  projectDir?: string
  writeStdout?: boolean
  budgetTokens?: number
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export function runSessionStartHook(opts: RunSessionStartOptions = {}): string {
  const raw = opts.stdin ?? readStdinSync()
  let parsed: SessionStartInput = {}
  try {
    parsed = raw ? (JSON.parse(raw) as SessionStartInput) : {}
  } catch {
    // swallow
  }

  // Only emit content on compact matcher; stay silent otherwise
  if (parsed.matcher !== 'compact') {
    if (opts.writeStdout !== false) {
      process.stdout.write('')
    }
    return ''
  }

  const sessionId = parsed.session_id ?? 'default'
  let markdown = ''
  try {
    const projectDir = opts.projectDir ?? resolveProjectDir()
    let dbPath: string
    if (opts.dbPath !== undefined) {
      dbPath = opts.dbPath
    } else {
      ensureStorageDir(projectDir)
      dbPath = resolveAnalyticsDbPath(projectDir)
    }
    const db = getDb(dbPath)
    const retriever = new SessionRetriever(db)
    const payload = retriever.buildReinjectionPayload(
      sessionId,
      projectHash(projectDir),
      opts.budgetTokens ?? 2000,
    )
    markdown = renderReinjectionMarkdown(payload)
  } catch {
    markdown = ''
  }

  if (opts.writeStdout !== false) {
    process.stdout.write(markdown)
  }
  return markdown
}
