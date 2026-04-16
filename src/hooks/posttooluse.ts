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
import { shadowMeasureSerena } from '../services/serena-shadow.js'
import path from 'node:path'

// Serena tools that read a single file and support shadow measurement
const SERENA_SHADOW_TOOLS = new Set([
  'mcp__serena__find_symbol',
  'mcp__serena__get_symbols_overview',
])

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

// Returns character count of the tool response (JS string .length = UTF-16 code units,
// not bytes). Named *Chars* to avoid confusion with byte-level measurements.
function extractOutputChars(response: unknown): number {
  if (response == null) return 0
  if (typeof response === 'string') return response.length
  try {
    return JSON.stringify(response).length
  } catch {
    return 0
  }
}

// Priority-ordered field names to extract a meaningful preview per tool type
const PREVIEW_FIELDS = ['command', 'file_path', 'pattern', 'relative_path', 'name_path', 'path']

function extractCommandPreview(_toolName: string, input: unknown): string | undefined {
  if (input == null || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  for (const field of PREVIEW_FIELDS) {
    const val = obj[field]
    if (typeof val === 'string' && val.trim()) {
      const raw = val.trim()
      return raw.length > 100 ? raw.slice(0, 100) + '…' : raw
    }
  }
  return undefined
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
  const outputChars = extractOutputChars(parsed.tool_response)

  let source: EventSource = classifySource(toolName, parsed.tool_input)
  let estimationMethod = tagEstimationMethod(source)

  // Extract command preview early so it can be stored in the DB (picked up by xray watcher)
  const commandPreview = extractCommandPreview(toolName, parsed.tool_input)

  // Build the event first; we may upgrade `source` to 'rtk' below if the
  // PreToolUse hook left an rtk rewrite mark for this exact Bash command.
  const event: ToolEvent = {
    session_id: sessionId,
    tool_name: toolName,
    source,
    output_bytes: outputChars,
    tokens_estimated: estimateTokensFast(outputChars),
    tokens_actual: null,
    duration_ms: parsed.duration_ms ?? Date.now() - start,
    estimation_method: estimationMethod,
    created_at: new Date().toISOString(),
    command_preview: commandPreview ?? null,
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

    // Shadow measurement: if this is a Serena read tool with a relative_path,
    // measure how many tokens were saved vs reading the full file.
    // Updates estimation_method so reports reflect Serena's actual contribution.
    const cfg = loadConfig(opts.home)
    if (SERENA_SHADOW_TOOLS.has(toolName) && cfg.shadow_measurement.serena) {
      try {
        const input = parsed.tool_input as Record<string, unknown> | undefined
        const relPath = typeof input?.relative_path === 'string' ? input.relative_path : null
        if (relPath) {
          const projectDir = opts.projectDir ?? resolveProjectDir()
          const absPath = path.resolve(projectDir, relPath)
          const shadow = shadowMeasureSerena(
            { file_path: absPath, tokens_estimated: event.tokens_estimated, tool_name: toolName },
            true,
          )
          if (shadow) {
            event.tokens_estimated = shadow.output_tokens
            event.estimation_method = shadow.estimation_method
            event.shadow_delta_tokens = shadow.delta_tokens
          }
        }
      } catch {
        // Shadow errors never block — continue with original estimation
      }
    }

    // Log Serena symbol touches for SessionStart:compact re-injection
    if (SERENA_SHADOW_TOOLS.has(toolName)) {
      try {
        const input = parsed.tool_input as Record<string, unknown> | undefined
        const relPath = typeof input?.relative_path === 'string' ? input.relative_path : null
        if (relPath) {
          const namePath = typeof input?.name_path === 'string' ? input.name_path : null
          queries.insertSerenaTouch(sessionId, toolName, relPath, namePath)
        }
      } catch {
        // Never block on logging
      }
    }

    const queue = new AnalyticsQueue(db)
    queue.enqueue(event)
    queue.flush()

    // Phase 4.H — throttled coach surfacing
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
      project_name: projDir.split(/[\\\/]/).filter(Boolean).pop() ?? 'unknown',
      project_hash: projectHash(projDir),
    }
    void postToXray(enriched).catch(() => { /* swallow */ })
  } catch {
    void postToXray(event as unknown as Record<string, unknown>).catch(() => { /* swallow */ })
  }

  return { event, additionalContext }
}
