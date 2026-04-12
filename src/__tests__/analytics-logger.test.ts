import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AnalyticsQueue,
  classifySource,
  tagEstimationMethod,
} from '../services/analytics-logger.js'
import { closeDb, getDb } from '../db/connection.js'
import { buildQueries } from '../db/queries.js'
import { makeEvent } from './helpers.js'

describe('classifySource', () => {
  it('tags our own tools', () => {
    expect(classifySource('budget_set')).toBe('own')
    expect(classifySource('coach_tips')).toBe('own')
    expect(classifySource('mcp_prune_apply')).toBe('own')
    expect(classifySource('toon_encode')).toBe('own')
    expect(classifySource('session_search')).toBe('own')
  })

  it('tags built-in Claude Code tools', () => {
    expect(classifySource('Read')).toBe('builtin')
    expect(classifySource('Bash')).toBe('builtin')
    expect(classifySource('Grep')).toBe('builtin')
    expect(classifySource('Task')).toBe('builtin')
  })

  it('tags serena / rtk / xray by substring', () => {
    expect(classifySource('mcp__serena__read_file')).toBe('serena')
    expect(classifySource('rtk_filter')).toBe('rtk')
    expect(classifySource('xray_session_get')).toBe('xray')
  })

  it('tags other MCP tools as mcp', () => {
    expect(classifySource('mcp__logbook__note')).toBe('mcp')
    expect(classifySource('mcp__database__query')).toBe('mcp')
  })
})

describe('tagEstimationMethod', () => {
  it('measured_exact for own / builtin / mcp / xray', () => {
    expect(tagEstimationMethod('own')).toBe('measured_exact')
    expect(tagEstimationMethod('builtin')).toBe('measured_exact')
    expect(tagEstimationMethod('mcp')).toBe('measured_exact')
    expect(tagEstimationMethod('xray')).toBe('measured_exact')
  })

  it('serena shadow vs fallback', () => {
    expect(tagEstimationMethod('serena', { hasShadow: true })).toBe('estimated_serena_shadow')
    expect(tagEstimationMethod('serena')).toBe('estimated_serena_fallback')
  })

  it('rtk db vs marker vs fallback', () => {
    expect(tagEstimationMethod('rtk', { hasRtkDb: true })).toBe('estimated_rtk_db')
    expect(tagEstimationMethod('rtk', { hasMarker: true })).toBe('estimated_rtk_marker')
    expect(tagEstimationMethod('rtk')).toBe('estimated_rtk_fallback')
  })
})

describe('AnalyticsQueue', () => {
  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    // seed a session so FK succeeds on flush
    db.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`).run('test-session')
  })

  afterEach(() => {
    closeDb()
  })

  it('enqueue + flush writes events to DB', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    q.enqueue(makeEvent({ tool_name: 'Read' }))
    q.enqueue(makeEvent({ tool_name: 'Bash' }))
    const flushed = q.flush()
    expect(flushed).toBe(2)
    expect(q.size()).toBe(0)
    const queries = buildQueries(db)
    const rows = queries.countToolCallsByTool('1970-01-01')
    const names = rows.map((r) => r.tool_name).sort()
    expect(names).toEqual(['Bash', 'Read'])
  })

  it('flush on empty queue returns 0', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    expect(q.flush()).toBe(0)
  })

  it('enqueue enforces max queue size by dropping oldest', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    // MAX_QUEUE_SIZE = 1000
    for (let i = 0; i < 1050; i++) {
      q.enqueue(makeEvent({ input_hash: `h${i}` }))
    }
    expect(q.size()).toBe(1000)
    expect(q.droppedEvents).toBe(50)
  })

  it('flush persists in batched transaction (atomic)', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    for (let i = 0; i < 20; i++) {
      q.enqueue(makeEvent({ input_hash: `h${i}` }))
    }
    const flushed = q.flush()
    expect(flushed).toBe(20)
    const queries = buildQueries(db)
    const rows = queries.countToolCallsByTool('1970-01-01')
    const total = rows.reduce((sum, r) => sum + r.count, 0)
    expect(total).toBe(20)
  })

  it('estimation_method column is populated from the event', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    q.enqueue(
      makeEvent({
        source: 'serena',
        estimation_method: 'estimated_serena_shadow',
        tool_name: 'mcp__serena__read_file',
      }),
    )
    q.flush()
    const row = db.prepare(`SELECT estimation_method, source FROM tool_calls LIMIT 1`).get() as {
      estimation_method: string
      source: string
    }
    expect(row.estimation_method).toBe('estimated_serena_shadow')
    expect(row.source).toBe('serena')
  })

  it('dropped_events counter is incremented in meta', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    for (let i = 0; i < 1010; i++) {
      q.enqueue(makeEvent({ input_hash: `h${i}` }))
    }
    const queries = buildQueries(db)
    const dropped = queries.getMeta('dropped_events')
    // upsertMetaCounter inserts '1' on first hit and increments; we dropped 10 times
    expect(dropped).not.toBeNull()
    expect(Number(dropped)).toBeGreaterThanOrEqual(1)
  })
})
