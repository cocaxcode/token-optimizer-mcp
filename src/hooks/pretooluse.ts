// PreToolUse hook entry — Phase 2.6
// ONLY acts on Bash tool. NEVER sets updatedInput (anthropics/claude-code#36843)
// Decision tree: passthrough / warn (additionalContext) / block (decision:block)

import fs from 'node:fs'
import { getDb } from '../db/connection.js'
import { BudgetManager } from '../services/budget-manager.js'
import { estimateTokensFast } from '../lib/token-estimator.js'
import {
  resolveProjectDir,
  resolveAnalyticsDbPath,
  projectHash,
} from '../lib/paths.js'
import { ensureStorageDir } from '../lib/storage.js'

export interface PreToolUseInput {
  session_id?: string
  tool_name?: string
  tool_input?: {
    command?: string
    [key: string]: unknown
  }
}

export interface PreToolUseDecision {
  decision?: 'block'
  reason?: string
  additionalContext?: string
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export interface RunPreToolUseOptions {
  stdin?: string
  dbPath?: string
  projectDir?: string
  writeStdout?: boolean
}

export function runPreToolUseHook(
  opts: RunPreToolUseOptions = {},
): PreToolUseDecision {
  const raw = opts.stdin ?? readStdinSync()
  const passthrough: PreToolUseDecision = {}

  let parsed: PreToolUseInput
  try {
    parsed = raw ? (JSON.parse(raw) as PreToolUseInput) : {}
  } catch {
    if (opts.writeStdout !== false) {
      process.stdout.write(JSON.stringify(passthrough))
    }
    return passthrough
  }

  // Only gate on Bash calls
  if (parsed.tool_name !== 'Bash') {
    if (opts.writeStdout !== false) {
      process.stdout.write(JSON.stringify(passthrough))
    }
    return passthrough
  }

  const command = parsed.tool_input?.command ?? ''
  const estimatedCost = estimateTokensFast(command)
  const sessionId = parsed.session_id ?? 'default'

  let decision: PreToolUseDecision = passthrough

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
    const manager = new BudgetManager(db)
    const status = manager.checkBudget(sessionId, projectHash(projectDir))

    if (!status.active) {
      decision = passthrough
    } else {
      const wouldSpend = status.spent + estimatedCost
      const wouldExceed = wouldSpend > status.spent + status.remaining
      if (!wouldExceed) {
        decision = passthrough
      } else if (status.mode === 'warn') {
        decision = {
          additionalContext: `⚠️ Presupuesto excedido: ${status.spent}+${estimatedCost} tokens > limite. Considera /compact o reducir alcance.`,
        }
        const active = manager.getActiveBudget(sessionId, projectHash(projectDir))
        if (active) manager.recordBudgetEvent(active.id, 'warn', estimatedCost)
      } else {
        decision = {
          decision: 'block',
          reason: `Presupuesto excedido (modo block): ${status.spent}+${estimatedCost} tokens > limite. Ejecuta budget_set para ajustar o /compact para liberar contexto.`,
        }
        const active = manager.getActiveBudget(sessionId, projectHash(projectDir))
        if (active) manager.recordBudgetEvent(active.id, 'block', estimatedCost)
      }
    }
  } catch {
    // Hook must never block due to persistence errors
    decision = passthrough
  }

  if (opts.writeStdout !== false) {
    process.stdout.write(JSON.stringify(decision))
  }
  return decision
}
