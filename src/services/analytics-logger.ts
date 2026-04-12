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
  /^session_search/,
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

export function classifySource(toolName: string): EventSource {
  if (OWN_TOOL_PATTERNS.some((re) => re.test(toolName))) return 'own'
  if (BUILTIN_TOOLS.has(toolName)) return 'builtin'
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
      return 'measured_exact'
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
