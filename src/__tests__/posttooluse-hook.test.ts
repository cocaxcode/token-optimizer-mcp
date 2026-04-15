import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runPostToolUseHook } from '../hooks/posttooluse.js'
import { closeDb, getDb } from '../db/connection.js'
import { buildQueries } from '../db/queries.js'

describe('runPostToolUseHook', () => {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdoutBuffer: string

  beforeEach(() => {
    closeDb()
    getDb(':memory:')
    stdoutBuffer = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = originalWrite
    closeDb()
  })

  it('writes {} to stdout when no coach hint fires', () => {
    runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 's1',
        tool_name: 'Read',
        tool_input: { path: '/foo' },
        tool_response: 'hello',
      }),
      dbPath: ':memory:',
      projectDir: process.cwd(),
      coachEnabled: false,
    })
    expect(stdoutBuffer).toBe('{}')
  })

  it('returns a ToolEvent with correct fields', () => {
    const result = runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'file1\nfile2\n',
      }),
      dbPath: ':memory:',
      projectDir: process.cwd(),
      coachEnabled: false,
    })
    expect(result.event).not.toBeNull()
    expect(result.event?.tool_name).toBe('Bash')
    expect(result.event?.source).toBe('builtin')
    expect(result.event?.estimation_method).toBe('measured_exact')
    expect(result.event?.tokens_estimated).toBeGreaterThan(0)
  })

  it('persists the event to the DB', () => {
    runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 's1',
        tool_name: 'Read',
        tool_input: { path: '/foo' },
        tool_response: 'content',
      }),
      dbPath: ':memory:',
      projectDir: process.cwd(),
      coachEnabled: false,
    })
    const db = getDb(':memory:')
    const queries = buildQueries(db)
    const rows = queries.countToolCallsByTool('1970-01-01')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].tool_name).toBe('Read')
  })

  it('handles malformed stdin gracefully', () => {
    const result = runPostToolUseHook({
      stdin: '{not valid json',
      dbPath: ':memory:',
      projectDir: process.cwd(),
      coachEnabled: false,
    })
    expect(result.event).toBeNull()
    expect(stdoutBuffer).toBe('{}')
  })

  it('completes within reasonable latency budget', () => {
    const iterations = 50
    const durations: number[] = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      runPostToolUseHook({
        stdin: JSON.stringify({
          session_id: 's1',
          tool_name: 'Read',
          tool_input: { path: `/f${i}` },
          tool_response: 'small',
        }),
        dbPath: ':memory:',
        projectDir: process.cwd(),
        writeStdout: false,
        coachEnabled: false,
      })
      durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95)]
    // Generous budget — real hook target is ≤10ms but tests include initialization overhead.
    // Verifies the hook is fast enough that timing regressions will be caught.
    expect(p95).toBeLessThan(50)
  })

  it('never throws when stdin is empty', () => {
    expect(() =>
      runPostToolUseHook({
        stdin: '',
        dbPath: ':memory:',
        projectDir: process.cwd(),
        coachEnabled: false,
      }),
    ).not.toThrow()
  })

  it('classifies own tools correctly', () => {
    const result = runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 's1',
        tool_name: 'budget_set',
        tool_input: {},
        tool_response: 'ok',
      }),
      dbPath: ':memory:',
      projectDir: process.cwd(),
      writeStdout: false,
      coachEnabled: false,
    })
    expect(result.event?.source).toBe('own')
  })

  // Guard-rail: even with vi.useFakeTimers this must not require real wall clock
  it('duration_ms is a non-negative number', () => {
    vi.useRealTimers()
    const result = runPostToolUseHook({
      stdin: JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_response: 'x' }),
      dbPath: ':memory:',
      projectDir: process.cwd(),
      writeStdout: false,
      coachEnabled: false,
    })
    expect(result.event?.duration_ms).not.toBeNull()
    expect(result.event?.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
