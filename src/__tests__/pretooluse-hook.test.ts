import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runPreToolUseHook } from '../hooks/pretooluse.js'
import { closeDb, getDb } from '../db/connection.js'
import { BudgetManager } from '../services/budget-manager.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { projectHash } from '../lib/paths.js'

vi.mock('../lib/rtk-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rtk-bridge.js')>()
  return {
    ...actual,
    findRtkBinary: vi.fn(() => null),
    rtkRewrite: vi.fn(() => null),
  }
})

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
      rtkPath: null,
    })
    expect(decision).toEqual({})
  })

  it('passthrough when budget active but under limit', () => {
    const db = getDb(':memory:')
    const manager = new BudgetManager(db)
    manager.setBudget({ scope: 'session', scope_key: 'sess-1', limit_tokens: 10_000, mode: 'warn' })
    const decision = runPreToolUseHook({
      stdin: hookInput(),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: null,
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
      rtkPath: null,
    })
    expect(decision).toEqual({})
  })

  it('does not set updatedInput when RTK binary is not found', () => {
    // findRtkBinary is mocked to return null at the top of this file
    const decision = runPreToolUseHook({
      stdin: hookInput({ tool_input: { command: 'git status' } }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(decision.updatedInput).toBeUndefined()
    expect(decision.permissionDecision).toBeUndefined()
  })

  it('does not set updatedInput when rtkPath is explicitly null', () => {
    const decision = runPreToolUseHook({
      stdin: hookInput({ tool_input: { command: 'ls -la' } }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: null,
    })
    expect(decision.updatedInput).toBeUndefined()
  })

  it('rewrites command via RTK and produces no double space (slice fix)', async () => {
    // Mock rtkRewrite to return a successful rewrite for 'git status'
    const { rtkRewrite } = await import('../lib/rtk-bridge.js')
    vi.mocked(rtkRewrite).mockReturnValueOnce({
      rewritten: 'rtk git status',
      exitCode: 3,
      success: true,
    })

    const FAKE_RTK = '/c/tools/rtk/rtk.exe'
    const decision = runPreToolUseHook({
      stdin: hookInput({ tool_input: { command: 'git status' } }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      rtkPath: FAKE_RTK,
    })

    expect(decision.updatedInput).toBeDefined()
    expect(decision.permissionDecision).toBe('allow')

    const cmd = decision.updatedInput!.command
    // Hook uses rewritten command as-is ("rtk <args>") — rtk is on npm PATH
    expect(cmd).toBe('rtk git status')
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
