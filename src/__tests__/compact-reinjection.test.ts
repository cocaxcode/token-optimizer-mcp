import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionRetriever, renderReinjectionMarkdown } from '../services/session-retriever.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { BudgetManager } from '../services/budget-manager.js'

describe('buildReinjectionPayload', () => {
  beforeEach(() => {
    closeDb()
    getDb(':memory:')
  })

  afterEach(() => {
    closeDb()
  })

  it('emits 4 sections when data exists', () => {
    const db = getDb(':memory:')
    const mgr = new BudgetManager(db)
    mgr.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10_000, mode: 'warn' })
    seedAnalyticsDb(db, [
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input_summary: JSON.stringify({ path: '/a.ts' }),
      }),
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input_summary: JSON.stringify({ command: 'npm test' }),
        input_hash: 'h2',
      }),
    ])
    const retriever = new SessionRetriever(db)
    const payload = retriever.buildReinjectionPayload('sess-1', null, 2000)
    const md = renderReinjectionMarkdown(payload)
    expect(md).toContain('## Presupuesto')
    expect(md).toContain('## Archivos recientes')
    expect(md).toContain('## Comandos recientes')
    expect(md).toContain('## Contexto relevante')
    expect(payload.truncated).toBe(false)
    expect(payload.dropped_count).toBe(0)
  })

  it('stays under token cap with 50-event fixture', () => {
    const db = getDb(':memory:')
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent({
        session_id: 'sess-1',
        tool_name: i % 3 === 0 ? 'Bash' : 'Read',
        tool_input_summary: JSON.stringify({ path: `/file-${i}.ts`, command: `cmd-${i}` }),
        content: `content snippet ${i}`,
        input_hash: `h${i}`,
        tokens_estimated: 10,
      }),
    )
    seedAnalyticsDb(db, events)
    const retriever = new SessionRetriever(db)
    const payload = retriever.buildReinjectionPayload('sess-1', null, 2000)
    expect(payload.tokens_estimated).toBeLessThanOrEqual(2000)
  })

  it('drops low-priority sections when fixture exceeds cap', () => {
    const db = getDb(':memory:')
    const hugeContent = 'x'.repeat(5000)
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input_summary: JSON.stringify({ path: `/very/long/path/to/file-${i}.ts` }),
        content: hugeContent,
        input_hash: `h${i}`,
        tokens_estimated: 1500,
      }),
    )
    seedAnalyticsDb(db, events)
    const retriever = new SessionRetriever(db)
    const payload = retriever.buildReinjectionPayload('sess-1', null, 100)
    expect(payload.truncated).toBe(true)
    expect(payload.dropped_count).toBeGreaterThan(0)
    const md = renderReinjectionMarkdown(payload)
    expect(md).toContain('secciones omitidas por limite')
  })

  it('benchmark p95 <=200ms with 1000 events', () => {
    const db = getDb(':memory:')
    const events = Array.from({ length: 1000 }, (_, i) =>
      makeEvent({
        session_id: 'sess-1',
        tool_name: i % 4 === 0 ? 'Bash' : 'Read',
        tool_input_summary: JSON.stringify({
          path: `/file-${i}.ts`,
          command: `cmd ${i}`,
        }),
        content: `some content ${i} with enough text to be interesting`,
        input_hash: `h${i}`,
        tokens_estimated: 20 + (i % 30),
      }),
    )
    seedAnalyticsDb(db, events)
    const retriever = new SessionRetriever(db)

    const runs = 20
    const durations: number[] = []
    for (let i = 0; i < runs; i++) {
      const start = performance.now()
      retriever.buildReinjectionPayload('sess-1', null, 2000)
      durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95)]
    expect(p95).toBeLessThan(200)
  })

  it('emits "sin presupuesto activo" when no budget set', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-1' })])
    const retriever = new SessionRetriever(db)
    const payload = retriever.buildReinjectionPayload('sess-1', null, 2000)
    const md = renderReinjectionMarkdown(payload)
    expect(md).toContain('sin presupuesto activo')
  })
})
