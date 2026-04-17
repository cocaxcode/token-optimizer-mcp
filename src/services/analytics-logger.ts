// Async analytics queue + source classification — Phase 1.8 + 1.9
// Bounded FIFO (max 1000), batch flush in a single transaction, lock retry 3x with 5ms backoff

import type Database from 'better-sqlite3'
import type { ToolEvent, EventSource, EstimationMethod } from '../lib/types.js'
import { buildQueries, type Queries } from '../db/queries.js'

type DB = Database.Database

const MAX_QUEUE_SIZE = 1000
const MAX_RETRIES = 3
const RETRY_BACKOFF_MS = 5

const OWN_TOOL_PATTERNS = [
  /^budget_/,
  /^mcp_usage_stats/,
  /^mcp_cost_report/,
  /^optimization_status/,
  /^mcp_prune_/,
  /^coach_tips/,
  /^toon_/,
]

const BUILTIN_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'Task',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
  'NotebookEdit',
  'NotebookRead',
])

// Matches any Bash command whose first token is `rtk` (optionally preceded
// by env vars, `sudo`, or leading whitespace). Covers: `rtk git status`,
// `  rtk cargo build`, `FOO=1 rtk vitest`, `sudo rtk docker ps`.
const RTK_BASH_COMMAND = /^\s*(?:(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:sudo\s+)?)rtk(?:\s|$)/

function isRtkWrappedBash(toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== 'object') return false
  const command = (toolInput as { command?: unknown }).command
  if (typeof command !== 'string') return false
  return RTK_BASH_COMMAND.test(command)
}

export function classifySource(
  toolName: string,
  toolInput?: unknown,
): EventSource {
  if (OWN_TOOL_PATTERNS.some((re) => re.test(toolName))) return 'own'
  if (BUILTIN_TOOLS.has(toolName)) {
    // A Bash call that starts with `rtk ...` is RTK-filtered output, not a
    // raw builtin. The output bytes have already been reduced by RTK, so we
    // tag the event as `rtk` to give optimization credit to the filter.
    if (toolName === 'Bash' && isRtkWrappedBash(toolInput)) return 'rtk'
    return 'builtin'
  }
  if (toolName.includes('serena')) return 'serena'
  if (toolName.includes('rtk')) return 'rtk'
  if (toolName.includes('xray')) return 'xray'
  return 'mcp'
}

export interface EstimationHints {
  hasShadow?: boolean
  hasRtkDb?: boolean
  hasMarker?: boolean
}

export function tagEstimationMethod(
  source: EventSource,
  hints: EstimationHints = {},
): EstimationMethod {
  switch (source) {
    case 'own':
    case 'builtin':
    case 'mcp':
    case 'xray':
      // Los tokens de estos sources se calculan con heurística chars × 0.27
      // sobre el output de la tool. No es lo facturado por Anthropic — eso
      // requiere estimateTokensActual() vía count_tokens API, que no se
      // invoca desde el hot path hoy. El tag 'measured_exact' se reservará
      // para cuando se cableen medidas reales (transcript JSONL o count_tokens).
      return 'estimated_heuristic'
    case 'serena':
      if (hints.hasShadow) return 'estimated_serena_shadow'
      return 'estimated_serena_fallback'
    case 'rtk':
      if (hints.hasRtkDb) return 'estimated_rtk_db'
      if (hints.hasMarker) return 'estimated_rtk_marker'
      return 'estimated_rtk_fallback'
    default:
      return 'unknown'
  }
}

function sleepSync(ms: number): void {
  const target = Date.now() + ms
  // Busy-wait deliberately — the hook runs in a short-lived process and
  // we want a deterministic backoff without async overhead (≤5ms).
  while (Date.now() < target) {
    /* spin */
  }
}

function isLockError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? ''
  return msg.includes('SQLITE_BUSY') || msg.includes('SQLITE_LOCKED')
}

export class AnalyticsQueue {
  private queue: ToolEvent[] = []
  private queries: Queries
  public droppedEvents = 0
  private exitHookBound = false

  constructor(db: DB) {
    this.queries = buildQueries(db)
  }

  enqueue(event: ToolEvent): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift()
      this.droppedEvents++
      try {
        this.queries.upsertMetaCounter('dropped_events')
      } catch {
        // never block
      }
    }
    this.queue.push(event)
  }

  size(): number {
    return this.queue.length
  }

  flush(): number {
    if (this.queue.length === 0) return 0
    const batch = this.queue.slice()
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        this.queries.insertToolCallMany(batch)
        this.queue = []
        return batch.length
      } catch (err) {
        if (isLockError(err)) {
          sleepSync(RETRY_BACKOFF_MS)
          continue
        }
        this.queue = []
        this.droppedEvents += batch.length
        try {
          this.queries.upsertMetaCounter('dropped_events')
        } catch {
          // swallow
        }
        return 0
      }
    }
    // Exceeded retries on lock
    this.queue = []
    this.droppedEvents += batch.length
    try {
      this.queries.upsertMetaCounter('dropped_events')
    } catch {
      // swallow
    }
    return 0
  }

  onBeforeExit(): void {
    if (this.exitHookBound) return
    this.exitHookBound = true
    process.on('beforeExit', () => {
      try {
        this.flush()
      } catch {
        // swallow
      }
    })
  }
}
