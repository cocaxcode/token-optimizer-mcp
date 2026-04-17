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

  describe('Bash wrapped in rtk', () => {
    it('reclassifies Bash as rtk when command starts with "rtk "', () => {
      expect(classifySource('Bash', { command: 'rtk git status' })).toBe('rtk')
      expect(classifySource('Bash', { command: 'rtk cargo build' })).toBe('rtk')
      expect(classifySource('Bash', { command: 'rtk vitest run' })).toBe('rtk')
    })

    it('tolerates leading whitespace and env vars', () => {
      expect(classifySource('Bash', { command: '  rtk ls src/' })).toBe('rtk')
      expect(classifySource('Bash', { command: 'NO_COLOR=1 rtk git log' })).toBe('rtk')
      expect(classifySource('Bash', { command: 'FOO=bar BAR=baz rtk tsc' })).toBe('rtk')
    })

    it('keeps Bash as builtin when command does not start with rtk', () => {
      expect(classifySource('Bash', { command: 'git status' })).toBe('builtin')
      expect(classifySource('Bash', { command: 'echo rtk is cool' })).toBe('builtin')
      expect(classifySource('Bash', { command: 'cat rtk.log' })).toBe('builtin')
      expect(classifySource('Bash', { command: '/path/to/rtk-like' })).toBe('builtin')
    })

    it('keeps Bash as builtin when tool_input is missing or malformed', () => {
      expect(classifySource('Bash')).toBe('builtin')
      expect(classifySource('Bash', null)).toBe('builtin')
      expect(classifySource('Bash', {})).toBe('builtin')
      expect(classifySource('Bash', { command: 123 })).toBe('builtin')
    })

    it('does not reclassify non-Bash builtins even with a matching command field', () => {
      expect(classifySource('Read', { command: 'rtk git status' })).toBe('builtin')
      expect(classifySource('Grep', { command: 'rtk ls' })).toBe('builtin')
    })
  })
})

describe('tagEstimationMethod', () => {
  it('estimated_heuristic for own / builtin / mcp / xray (chars x 0.27)', () => {
    expect(tagEstimationMethod('own')).toBe('estimated_heuristic')
    expect(tagEstimationMethod('builtin')).toBe('estimated_heuristic')
    expect(tagEstimationMethod('mcp')).toBe('estimated_heuristic')
    expect(tagEstimationMethod('xray')).toBe('estimated_heuristic')
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
      q.enqueue(makeEvent({ tool_name: `Tool${i}` }))
    }
    expect(q.size()).toBe(1000)
    expect(q.droppedEvents).toBe(50)
  })

  it('flush persists in batched transaction (atomic)', () => {
    const db = getDb(':memory:')
    const q = new AnalyticsQueue(db)
    for (let i = 0; i < 20; i++) {
      q.enqueue(makeEvent({ tool_name: `Tool${i}` }))
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
      q.enqueue(makeEvent({ tool_name: `Tool${i}` }))
    }
    const queries = buildQueries(db)
    const dropped = queries.getMeta('dropped_events')
    // upsertMetaCounter inserts '1' on first hit and increments; we dropped 10 times
    expect(dropped).not.toBeNull()
    expect(Number(dropped)).toBeGreaterThanOrEqual(1)
  })
})
