// PreToolUse hook entry — Phase 2.6 + v0.2.0 RTK bridge
// Acts on Bash tool: budget warn check first, then RTK rewrite if available.
// Sets updatedInput ONLY when RTK rewrites successfully (exit 0 or 3).

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
import { findRtkBinary, rtkRewrite } from '../lib/rtk-bridge.js'

export interface PreToolUseInput {
  session_id?: string
  tool_name?: string
  tool_input?: {
    command?: string
    [key: string]: unknown
  }
}

export interface PreToolUseDecision {
  additionalContext?: string
  updatedInput?: { command: string }
  permissionDecision?: string
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string
    permissionDecision?: string
    updatedInput?: { command: string }
  }
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
  /** Override RTK binary path for testing; null = disable RTK */
  rtkPath?: string | null
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

  // Only act on Bash calls
  if (parsed.tool_name !== 'Bash') {
    if (opts.writeStdout !== false) {
      process.stdout.write(JSON.stringify(passthrough))
    }
    return passthrough
  }

  const command = parsed.tool_input?.command ?? ''
  const estimatedCost = estimateTokensFast(command)
  const sessionId = parsed.session_id ?? 'default'

  const decision: PreToolUseDecision = {}

  // ── Step 1: Budget check ──
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

    if (status.active) {
      const wouldExceed = status.spent + estimatedCost > status.spent + status.remaining
      if (wouldExceed) {
        decision.additionalContext = `⚠️ Presupuesto excedido: ${status.spent}+${estimatedCost} tokens > limite. Considera /compact o reducir alcance.`
        const active = manager.getActiveBudget(sessionId, projectHash(projectDir))
        if (active) manager.recordBudgetEvent(active.id, 'warn', estimatedCost)
      }
    }
  } catch {
    // Budget errors never block — continue to RTK
  }

  // ── Step 2: RTK rewrite (if available) ──
  try {
    const rtkPath =
      opts.rtkPath !== undefined ? opts.rtkPath : findRtkBinary()
    if (rtkPath && command.trim()) {
      const result = rtkRewrite(command, rtkPath)
      if (result) {
        if ((result.exitCode === 0 || result.exitCode === 3) && result.rewritten) {
          // Exit 0: rewrite + auto-allow
          // Exit 3: rewrite + ask — but Claude Code needs permissionDecision
          //   to honor updatedInput, so we always set "allow"
          decision.updatedInput = { command: result.rewritten }
          decision.permissionDecision = 'allow'
        }
        // Exit 1 (no rewrite) or 2 (deny): passthrough, no updatedInput
      }
    }
  } catch {
    // RTK errors never block — continue without rewrite
  }

  if (opts.writeStdout !== false) {
    // Claude Code expects hookSpecificOutput wrapper for PreToolUse
    const output: HookOutput = {}
    if (decision.updatedInput || decision.permissionDecision) {
      output.hookSpecificOutput = {
        hookEventName: 'PreToolUse',
        ...(decision.permissionDecision && { permissionDecision: decision.permissionDecision }),
        ...(decision.updatedInput && { updatedInput: decision.updatedInput }),
      }
    }
    if (decision.additionalContext) {
      output.additionalContext = decision.additionalContext
    }
    process.stdout.write(JSON.stringify(
      Object.keys(output).length > 0 ? output : {},
    ))
  }
  return decision
}
