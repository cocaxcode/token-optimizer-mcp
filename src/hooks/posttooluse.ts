// PostToolUse hook entry — Phase 1.11
// MUST NOT set updatedMCPToolOutput for built-in tools (anthropics/claude-code#36843)
// Target p95 latency: ≤10ms on synthetic fixture

import crypto from 'node:crypto'
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

const CONTENT_MAX = 4096
const INPUT_SUMMARY_MAX = 512

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function extractContent(response: unknown): string {
  if (response == null) return ''
  if (typeof response === 'string') return response
  try {
    return JSON.stringify(response)
  } catch {
    return ''
  }
}

function extractInputSummary(input: unknown): string | null {
  if (input == null) return null
  try {
    return JSON.stringify(input).slice(0, INPUT_SUMMARY_MAX)
  } catch {
    return null
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
  const content = extractContent(parsed.tool_response)
  const inputHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(parsed.tool_input ?? {}))
    .digest('hex')
    .slice(0, 16)

  const source = classifySource(toolName)
  const estimationMethod = tagEstimationMethod(source)

  const event: ToolEvent = {
    session_id: sessionId,
    tool_name: toolName,
    source,
    input_hash: inputHash,
    tool_input_summary: extractInputSummary(parsed.tool_input),
    output_bytes: content.length,
    tokens_estimated: estimateTokensFast(content),
    tokens_actual: null,
    duration_ms: parsed.duration_ms ?? Date.now() - start,
    content: content.slice(0, CONTENT_MAX),
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
  void postToXray(event as unknown as Record<string, unknown>).catch(() => {
    /* swallow */
  })

  return event
}
