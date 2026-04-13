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
import type { ToolEvent } from '../lib/types.js'

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
}

export function runPostToolUseHook(opts: RunPostToolUseOptions = {}): ToolEvent | null {
  const start = Date.now()
  if (opts.writeStdout !== false) {
    // Respond immediately so Claude Code is never blocked
    process.stdout.write('{}')
  }

  const raw = opts.stdin ?? readStdinSync()
  let parsed: PostToolUseInput
  try {
    parsed = raw ? (JSON.parse(raw) as PostToolUseInput) : {}
  } catch {
    return null
  }

  const sessionId = parsed.session_id ?? 'unknown'
  const toolName = parsed.tool_name ?? 'unknown'
  const outputBytes = extractOutputBytes(parsed.tool_response)

  const source = classifySource(toolName)
  const estimationMethod = tagEstimationMethod(source)

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
    const queue = new AnalyticsQueue(db)
    queue.enqueue(event)
    queue.flush()
  } catch {
    // Hook must never block — swallow any persistence error
  }

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

  return event
}
