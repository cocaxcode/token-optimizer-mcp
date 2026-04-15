// PostToolUse hook entry — Phase 1.11
// MUST NOT set updatedMCPToolOutput for built-in tools (anthropics/claude-code#36843)
// Target p95 latency: ≤10ms on synthetic fixture

import fs from 'node:fs'
import { getDb } from '../db/connection.js'
import {
  AnalyticsQueue,
  classifySource,
  tagEstimationMethod,
} from '../services/analytics-logger.js'
import { estimateTokensFast } from '../lib/token-estimator.js'
import {
  resolveProjectDir,
  resolveAnalyticsDbPath,
  projectHash,
} from '../lib/paths.js'
import { ensureStorageDir } from '../lib/storage.js'
import { buildQueries } from '../db/queries.js'
import { postToXray } from '../services/xray-client.js'
import { buildCoachHintSync } from '../coach/session-section.js'
import { loadConfig } from '../cli/config.js'
import { hashCommand } from '../lib/command-hash.js'
import type { ToolEvent, DetectionSeverity, EventSource } from '../lib/types.js'

export interface PostToolUseInput {
  session_id?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  duration_ms?: number
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function extractOutputBytes(response: unknown): number {
  if (response == null) return 0
  if (typeof response === 'string') return response.length
  try {
    return JSON.stringify(response).length
  } catch {
    return 0
  }
}

export interface RunPostToolUseOptions {
  stdin?: string
  dbPath?: string
  projectDir?: string
  writeStdout?: boolean
  /** Override coach config for testing; undefined → loadConfig() */
  coachEnabled?: boolean
  coachThrottle?: number
  coachDedupeWindowSeconds?: number
  coachMinSeverity?: DetectionSeverity
  home?: string
}

export interface PostToolUseResult {
  event: ToolEvent | null
  additionalContext: string | null
}

export function runPostToolUseHook(
  opts: RunPostToolUseOptions = {},
): PostToolUseResult {
  const start = Date.now()

  const writeOutput = (additionalContext: string | null): void => {
    if (opts.writeStdout === false) return
    if (additionalContext) {
      process.stdout.write(JSON.stringify({ additionalContext }))
    } else {
      process.stdout.write('{}')
    }
  }

  const raw = opts.stdin ?? readStdinSync()
  let parsed: PostToolUseInput
  try {
    parsed = raw ? (JSON.parse(raw) as PostToolUseInput) : {}
  } catch {
    writeOutput(null)
    return { event: null, additionalContext: null }
  }

  const sessionId = parsed.session_id ?? 'unknown'
  const toolName = parsed.tool_name ?? 'unknown'
  const outputBytes = extractOutputBytes(parsed.tool_response)

  let source: EventSource = classifySource(toolName, parsed.tool_input)
  let estimationMethod = tagEstimationMethod(source)

  // Build the event first; we may upgrade `source` to 'rtk' below if the
  // PreToolUse hook left an rtk rewrite mark for this exact Bash command.
  const event: ToolEvent = {
    session_id: sessionId,
    tool_name: toolName,
    source,
    output_bytes: outputBytes,
    tokens_estimated: estimateTokensFast(outputBytes),
    tokens_actual: null,
    duration_ms: parsed.duration_ms ?? Date.now() - start,
    estimation_method: estimationMethod,
    created_at: new Date().toISOString(),
  }

  let additionalContext: string | null = null
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
    const queries = buildQueries(db)
    queries.insertSession(sessionId, projectHash(projectDir))

    // If PreToolUse rewrote this Bash via rtk, it left a mark we can consume
    // now to reclassify the event. Only applies to Bash calls — every other
    // tool skips the DB lookup entirely.
    if (toolName === 'Bash' && source === 'builtin') {
      const rawInput = parsed.tool_input as { command?: string } | undefined
      const command = rawInput?.command
      if (typeof command === 'string' && command.length > 0) {
        const rewritten = queries.consumeRtkRewrite(sessionId, hashCommand(command))
        if (rewritten) {
          source = 'rtk'
          estimationMethod = 'measured_rtk_rewrite'
          event.source = 'rtk'
          event.estimation_method = 'measured_rtk_rewrite'
        }
      }
    }

    const queue = new AnalyticsQueue(db)
    queue.enqueue(event)
    queue.flush()

    // Phase 4.H — throttled coach surfacing
    const cfg = loadConfig(opts.home)
    const coachEnabled =
      opts.coachEnabled ?? (cfg.coach.enabled && cfg.coach.auto_surface)
    if (coachEnabled) {
      const throttle = opts.coachThrottle ?? cfg.coach.posttooluse_throttle
      const count = queries.countToolCallsBySession(sessionId)
      if (throttle > 0 && count > 0 && count % throttle === 0) {
        const hintOpts: Parameters<typeof buildCoachHintSync>[0] = {
          db,
          sessionId,
          dedupeWindowSeconds:
            opts.coachDedupeWindowSeconds ?? cfg.coach.dedupe_window_seconds,
          minSeverity: opts.coachMinSeverity ?? 'warn',
          via: 'posttooluse',
        }
        const hint = buildCoachHintSync(hintOpts)
        if (hint.text) additionalContext = hint.text
      }
    }
  } catch {
    // Hook must never block — swallow any persistence error
  }

  writeOutput(additionalContext)

  // Fire-and-forget POST to xray if configured (silent on failure)
  // Enrich event with project context so xray can group by project
  try {
    const projDir = opts.projectDir ?? resolveProjectDir()
    const enriched: Record<string, unknown> = {
      ...event,
      project_path: projDir,
      project_name: projDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown',
      project_hash: projectHash(projDir),
    }
    void postToXray(enriched).catch(() => { /* swallow */ })
  } catch {
    void postToXray(event as unknown as Record<string, unknown>).catch(() => { /* swallow */ })
  }

  return { event, additionalContext }
}
