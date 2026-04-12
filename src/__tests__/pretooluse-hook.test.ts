import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runPreToolUseHook } from '../hooks/pretooluse.js'
import { closeDb, getDb } from '../db/connection.js'
import { BudgetManager } from '../services/budget-manager.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { projectHash } from '../lib/paths.js'

describe('runPreToolUseHook', () => {
  const PROJECT_DIR = process.cwd()
  const PROJECT_HASH = projectHash(PROJECT_DIR)

  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`).run(
      'sess-1',
      PROJECT_HASH,
    )
  })

  afterEach(() => {
    closeDb()
  })

  function hookInput(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      ...overrides,
    })
  }

  it('passthrough for non-Bash tools', () => {
    const decision = runPreToolUseHook({
      stdin: hookInput({ tool_name: 'Read', tool_input: { path: '/foo' } }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision).toEqual({})
  })

  it('passthrough when no active budget', () => {
    const decision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision).toEqual({})
  })

  it('passthrough when budget active but under limit', () => {
    const db = getDb(':memory:')
    const manager = new BudgetManager(db)
    manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10_000, mode: 'block' })
    const decision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision).toEqual({})
  })

  it('warn mode returns additionalContext when exceeding', () => {
    const db = getDb(':memory:')
    const manager = new BudgetManager(db)
    manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10, mode: 'warn' })
    seedAnalyticsDb(db, [
      makeEvent({ session_id: 'sess-1', tokens_estimated: 15 }),
    ])
    const decision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision.additionalContext).toBeDefined()
    expect(decision.additionalContext).toContain('Presupuesto')
    expect(decision.decision).toBeUndefined()
  })

  it('block mode returns decision:block when exceeding', () => {
    const db = getDb(':memory:')
    const manager = new BudgetManager(db)
    manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10, mode: 'block' })
    seedAnalyticsDb(db, [
      makeEvent({ session_id: 'sess-1', tokens_estimated: 15 }),
    ])
    const decision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision.decision).toBe('block')
    expect(decision.reason).toContain('Presupuesto')
  })

  it('never sets updatedInput when RTK is not available', () => {
    // When RTK is explicitly disabled (rtkPath: null), updatedInput must NEVER appear
    const db = getDb(':memory:')
    const manager = new BudgetManager(db)
    manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10, mode: 'warn' })
    seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-1', tokens_estimated: 100 })])

    const passthroughDecision = runPreToolUseHook({
      stdin: hookInput({ tool_name: 'Read' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: null,
    })
    expect(passthroughDecision).not.toHaveProperty('updatedInput')

    const warnDecision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: null,
    })
    expect(warnDecision).not.toHaveProperty('updatedInput')

    const blockedMgr = new BudgetManager(db)
    blockedMgr.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10, mode: 'block' })
    const blockDecision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: null,
    })
    expect(blockDecision).not.toHaveProperty('updatedInput')
  })

  it('budget block wins over RTK rewrite (no updatedInput on block)', () => {
    const db = getDb(':memory:')
    const manager = new BudgetManager(db)
    manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10, mode: 'block' })
    seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-1', tokens_estimated: 100 })])
    // Even with a valid RTK path, block should prevent rewrite
    const decision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: process.execPath, // fake "rtk" (would fail anyway, but proves block runs first)
    })
    expect(decision.decision).toBe('block')
    expect(decision).not.toHaveProperty('updatedInput')
  })

  it('handles malformed stdin gracefully', () => {
    const decision = runPreToolUseHook({
      stdin: '{not json',
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision).toEqual({})
  })

  it('handles missing tool_input gracefully', () => {
    const decision = runPreToolUseHook({
      stdin: JSON.stringify({ session_id: 'sess-1', tool_name: 'Bash' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision).toEqual({})
  })

  it('writes decision JSON to stdout when writeStdout=true', () => {
    const originalWrite = process.stdout.write.bind(process.stdout)
    let captured = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stdout.write
    try {
      runPreToolUseHook({
        stdin: hookInput({ tool_name: 'Read' }),
        dbPath: ':memory:',
        projectDir: PROJECT_DIR,
      })
    } finally {
      process.stdout.write = originalWrite
    }
    expect(captured).toBe('{}')
  })
})
