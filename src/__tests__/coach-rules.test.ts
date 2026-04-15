import { describe, it, expect } from 'vitest'
import { DETECTION_RULES } from '../coach/rules.js'
import { runRules } from '../coach/detector.js'
import type { EventContext, ToolEvent } from '../lib/types.js'
import { makeEvent } from './helpers.js'

function buildCtx(overrides: Partial<EventContext> = {}): EventContext {
  return {
    session_id: 'test',
    events: [],
    session_token_total: null,
    session_token_method: 'unknown',
    session_token_limit: 200_000,
    active_model: null,
    ...overrides,
  }
}

function makeEvents(count: number, tool: string, overrides: Partial<ToolEvent> = {}): ToolEvent[] {
  return Array.from({ length: count }, (_) =>
    makeEvent({
      tool_name: tool,
      ...overrides,
    }),
  )
}

describe('DETECTION_RULES registry', () => {
  it('exports at least 11 rules', () => {
    expect(DETECTION_RULES.length).toBeGreaterThanOrEqual(11)
  })

  it('every rule has unique id and tip_ids', () => {
    const ids = new Set<string>()
    for (const rule of DETECTION_RULES) {
      expect(ids.has(rule.id)).toBe(false)
      ids.add(rule.id)
      expect(Array.isArray(rule.tip_ids)).toBe(true)
      expect(typeof rule.run).toBe('function')
    }
  })
})

describe('detect-context-threshold', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-context-threshold')!

  it('returns null below 50%', () => {
    const hit = rule.run(
      buildCtx({
        session_token_total: 50_000,
        session_token_method: 'measured_exact',
      }),
    )
    expect(hit).toBeNull()
  })

  it('returns info severity at 50-75%', () => {
    const hit = rule.run(
      buildCtx({
        session_token_total: 130_000,
        session_token_method: 'measured_exact',
      }),
    )
    expect(hit?.severity).toBe('info')
  })

  it('returns warn severity at 75-90%', () => {
    const hit = rule.run(
      buildCtx({
        session_token_total: 160_000,
        session_token_method: 'measured_exact',
      }),
    )
    expect(hit?.severity).toBe('warn')
  })

  it('returns critical severity at 90%+', () => {
    const hit = rule.run(
      buildCtx({
        session_token_total: 185_000,
        session_token_method: 'measured_exact',
      }),
    )
    expect(hit?.severity).toBe('critical')
  })

  it('propagates estimation_method from context', () => {
    const hit = rule.run(
      buildCtx({
        session_token_total: 160_000,
        session_token_method: 'estimated_cumulative',
      }),
    )
    expect(hit?.estimation_method).toBe('estimated_cumulative')
  })
})

describe('detect-long-reasoning-no-code', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-long-reasoning-no-code')!

  it('fires with 10+ events and no edits', () => {
    const hit = rule.run(buildCtx({ events: makeEvents(10, 'Read') }))
    expect(hit).not.toBeNull()
    expect(hit?.tip_ids).toContain('use-opusplan')
  })

  it('does not fire when there is at least one edit', () => {
    const events = makeEvents(9, 'Read')
    events.push(makeEvent({ tool_name: 'Edit' }))
    expect(rule.run(buildCtx({ events }))).toBeNull()
  })

  it('does not fire with fewer than 10 events', () => {
    expect(rule.run(buildCtx({ events: makeEvents(5, 'Read') }))).toBeNull()
  })
})

describe('detect-repeated-searches', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-repeated-searches')!

  it('fires with 3+ Grep/Glob in window', () => {
    const hit = rule.run(
      buildCtx({
        events: [
          makeEvent({ tool_name: 'Grep' }),
          makeEvent({ tool_name: 'Glob' }),
          makeEvent({ tool_name: 'Grep' }),
        ],
      }),
    )
    expect(hit).not.toBeNull()
  })

  it('does not fire with only 2 searches', () => {
    const hit = rule.run(
      buildCtx({
        events: [
          makeEvent({ tool_name: 'Grep' }),
          makeEvent({ tool_name: 'Grep' }),
        ],
      }),
    )
    expect(hit).toBeNull()
  })
})

describe('detect-huge-file-reads', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-huge-file-reads')!

  it('fires on Read >50k tokens', () => {
    const hit = rule.run(
      buildCtx({
        events: [makeEvent({ tool_name: 'Read', tokens_estimated: 60_000 })],
      }),
    )
    expect(hit).not.toBeNull()
    expect(hit?.severity).toBe('warn')
  })

  it('does not fire on Read <=50k tokens', () => {
    const hit = rule.run(
      buildCtx({
        events: [makeEvent({ tool_name: 'Read', tokens_estimated: 30_000 })],
      }),
    )
    expect(hit).toBeNull()
  })
})

describe('detect-many-bash-commands', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-many-bash-commands')!

  it('fires on 11+ Bash in window', () => {
    const hit = rule.run(buildCtx({ events: makeEvents(11, 'Bash') }))
    expect(hit).not.toBeNull()
  })

  it('does not fire on <=10 Bash', () => {
    expect(rule.run(buildCtx({ events: makeEvents(10, 'Bash') }))).toBeNull()
  })
})

describe('detect-opus-for-simple-task', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-opus-for-simple-task')!

  it('fires when Opus is doing heavy edit+bash work', () => {
    const events = [
      ...makeEvents(4, 'Edit'),
      ...makeEvents(3, 'Bash'),
    ]
    const hit = rule.run(buildCtx({ active_model: 'claude-opus-4-6', events }))
    expect(hit).not.toBeNull()
    expect(hit?.evidence).toContain('Opus ejecutando trabajo mecanico')
    expect(hit?.tip_ids).toContain('default-to-sonnet')
  })

  it('does not fire when Opus is used for Q&A (no edits, no bash)', () => {
    const hit = rule.run(
      buildCtx({
        active_model: 'claude-opus-4-6',
        events: makeEvents(10, 'Read'),
      }),
    )
    expect(hit).toBeNull()
  })

  it('does not fire below 6 edits+bash combined', () => {
    const events = [
      ...makeEvents(3, 'Edit'),
      ...makeEvents(2, 'Bash'),
    ]
    const hit = rule.run(buildCtx({ active_model: 'claude-opus-4-6', events }))
    expect(hit).toBeNull()
  })

  it('does not fire without active_model', () => {
    const events = [...makeEvents(4, 'Edit'), ...makeEvents(3, 'Bash')]
    const hit = rule.run(buildCtx({ events }))
    expect(hit).toBeNull()
  })

  it('does not fire on Sonnet', () => {
    const events = [...makeEvents(4, 'Edit'), ...makeEvents(3, 'Bash')]
    const hit = rule.run(buildCtx({ active_model: 'claude-sonnet-4-6', events }))
    expect(hit).toBeNull()
  })
})

describe('detect-clear-opportunity', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-clear-opportunity')!

  it('fires on low overlap between recent and prior windows', () => {
    const recent = Array.from({ length: 20 }, (_) =>
      makeEvent({ tool_name: 'Read' }),
    )
    const prior = Array.from({ length: 20 }, (_) =>
      makeEvent({ tool_name: 'Bash' }),
    )
    const hit = rule.run(buildCtx({ events: [...recent, ...prior] }))
    expect(hit).not.toBeNull()
  })

  it('does not fire with high overlap', () => {
    const allSame = Array.from({ length: 40 }, (_) =>
      makeEvent({ tool_name: 'Read' }),
    )
    expect(rule.run(buildCtx({ events: allSame }))).toBeNull()
  })
})

describe('runRules orchestrator', () => {
  it('collects hits from multiple rules and sorts by severity', () => {
    const ctx = buildCtx({
      session_token_total: 185_000, // critical
      session_token_method: 'measured_exact',
      events: makeEvents(11, 'Bash'), // info
    })
    const hits = runRules(ctx)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0].severity).toBe('critical')
  })

  it('does not dedupe by tip_id, only by rule_id', () => {
    const ctx = buildCtx({
      session_token_total: 160_000,
      session_token_method: 'measured_exact',
    })
    const hits = runRules(ctx)
    const ruleIds = hits.map((h) => h.rule_id)
    const unique = new Set(ruleIds)
    expect(ruleIds.length).toBe(unique.size)
  })

  it('tolerates stub rules that always return null', () => {
    // Call with empty context — stub rules return null gracefully
    const hits = runRules(buildCtx())
    expect(Array.isArray(hits)).toBe(true)
  })
})

// ── detect-read-over-serena ──
describe('detect-read-over-serena', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-read-over-serena')!

  it('exists in the registry', () => {
    expect(rule).toBeDefined()
    expect(rule.tip_ids).toContain('prefer-serena-reads')
  })

  it('fires with 3+ Read calls >2k tokens', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(3, 'Read', { tokens_estimated: 3_000 }),
      }),
    )
    expect(hit).not.toBeNull()
    expect(hit!.rule_id).toBe('detect-read-over-serena')
    expect(hit!.tip_ids).toContain('prefer-serena-reads')
    expect(hit!.severity).toBe('info')
    expect(hit!.evidence).toContain('3 lecturas Read')
    expect(hit!.evidence).toContain('9000')
    expect(hit!.evidence).toContain('6300') // 70% of 9000
  })

  it('does not fire with <3 Read calls', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(2, 'Read', { tokens_estimated: 5_000 }),
      }),
    )
    expect(hit).toBeNull()
  })

  it('does not fire if tokens <=2k', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(5, 'Read', { tokens_estimated: 500 }),
      }),
    )
    expect(hit).toBeNull()
  })

  it('returns warn severity with 6+ reads', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(6, 'Read', { tokens_estimated: 4_000 }),
      }),
    )
    expect(hit).not.toBeNull()
    expect(hit!.severity).toBe('warn')
  })

  it('does not count non-Read tools', () => {
    const events = [
      ...makeEvents(2, 'Read', { tokens_estimated: 3_000 }),
      ...makeEvents(5, 'Grep', { tokens_estimated: 5_000 }),
      ...makeEvents(3, 'Edit', { tokens_estimated: 4_000 }),
    ]
    const hit = rule.run(buildCtx({ events }))
    expect(hit).toBeNull() // only 2 Read calls, below threshold
  })

  it('propagates estimation_method from context', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(3, 'Read', { tokens_estimated: 3_000 }),
        session_token_method: 'estimated_cumulative',
      }),
    )
    expect(hit).not.toBeNull()
    expect(hit!.estimation_method).toBe('estimated_cumulative')
  })
})

describe('detect-serena-read-cascade', () => {
  const rule = DETECTION_RULES.find((r) => r.id === 'detect-serena-read-cascade')!

  it('is registered', () => {
    expect(rule).toBeDefined()
  })

  it('fires with >=5 find_symbol calls and no overview in last 15', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(5, 'mcp__serena__find_symbol'),
      }),
    )
    expect(hit).not.toBeNull()
    expect(hit!.rule_id).toBe('detect-serena-read-cascade')
    expect(hit!.severity).toBe('info')
  })

  it('does not fire with <5 find_symbol calls', () => {
    const hit = rule.run(
      buildCtx({
        events: makeEvents(4, 'mcp__serena__find_symbol'),
      }),
    )
    expect(hit).toBeNull()
  })

  it('does not fire when get_symbols_overview is present in window', () => {
    const events = [
      ...makeEvents(5, 'mcp__serena__find_symbol'),
      makeEvent({ tool_name: 'mcp__serena__get_symbols_overview' }),
    ]
    const hit = rule.run(buildCtx({ events }))
    expect(hit).toBeNull()
  })

  it('only looks at last 15 events', () => {
    // 10 old find_symbol outside window + 2 new find_symbol inside window
    const events = [
      ...makeEvents(2, 'mcp__serena__find_symbol'),
      ...makeEvents(13, 'Bash'), // fill up the window after the 2 find_symbol
    ]
    const hit = rule.run(buildCtx({ events }))
    expect(hit).toBeNull() // only 2 find_symbol in first 15 slots
  })
})
