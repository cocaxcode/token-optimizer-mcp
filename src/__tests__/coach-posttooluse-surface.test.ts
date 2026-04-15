import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runPostToolUseHook } from '../hooks/posttooluse.js'
import { buildCoachHintSync } from '../coach/session-section.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'

describe('PostToolUse coach throttled surfacing', () => {
  const PROJECT_DIR = process.cwd()
  let stdoutBuffer: string
  const originalWrite = process.stdout.write.bind(process.stdout)

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

  it('does not surface before the throttle boundary', () => {
    const db = getDb(':memory:')
    // Seed 11 Bash events — detect-many-bash-commands would fire if run,
    // but count (after this call) is 12 and throttle=20, so nothing surfaces.
    seedAnalyticsDb(
      db,
      Array.from({ length: 11 }, () =>
        makeEvent({ session_id: 'sess-post', tool_name: 'Bash' }),
      ),
    )
    const result = runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 'sess-post',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'out',
      }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      coachEnabled: true,
      coachThrottle: 20,
    })
    expect(result.additionalContext).toBeNull()
    expect(stdoutBuffer).toBe('{}')
  })

  it('surfaces a warn-level hint exactly at the throttle boundary', () => {
    const db = getDb(':memory:')
    // Seed 5 Read events with huge tokens to trigger detect-huge-file-reads (severity: warn)
    seedAnalyticsDb(
      db,
      Array.from({ length: 5 }, () =>
        makeEvent({
          session_id: 'sess-post',
          tool_name: 'Read',
          tokens_estimated: 60_000,
        }),
      ),
    )
    // After this call count becomes 6. Use throttle=6 to hit the boundary.
    const result = runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 'sess-post',
        tool_name: 'Read',
        tool_input: { file_path: '/x' },
        tool_response: 'a'.repeat(240_000), // ~60k tokens
      }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      coachEnabled: true,
      coachThrottle: 6,
      coachMinSeverity: 'warn',
    })
    expect(result.additionalContext).not.toBeNull()
    expect(result.additionalContext).toMatch(/Coach:/)
    // stdout should now be a valid JSON with additionalContext
    const parsed = JSON.parse(stdoutBuffer) as { additionalContext?: string }
    expect(parsed.additionalContext).toBeDefined()
    expect(parsed.additionalContext).toBe(result.additionalContext)
  })

  it('filters out info-severity hits when minSeverity is warn', () => {
    const db = getDb(':memory:')
    // Seed enough Bash events so detect-many-bash-commands fires (severity: info)
    seedAnalyticsDb(
      db,
      Array.from({ length: 11 }, () =>
        makeEvent({ session_id: 'sess-post', tool_name: 'Bash' }),
      ),
    )
    const result = runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 'sess-post',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'out',
      }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      coachEnabled: true,
      coachThrottle: 12,
      coachMinSeverity: 'warn',
    })
    // detect-many-bash-commands returns info, so with minSeverity=warn nothing surfaces
    expect(result.additionalContext).toBeNull()
    expect(stdoutBuffer).toBe('{}')
  })

  it('skips surfacing entirely when coachEnabled=false', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 5 }, () =>
        makeEvent({
          session_id: 'sess-post',
          tool_name: 'Read',
          tokens_estimated: 60_000,
        }),
      ),
    )
    const result = runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 'sess-post',
        tool_name: 'Read',
        tool_response: 'a'.repeat(240_000),
      }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      coachEnabled: false,
      coachThrottle: 6,
    })
    expect(result.additionalContext).toBeNull()
    expect(stdoutBuffer).toBe('{}')
  })

  it('dedupes within the window on repeated boundary hits', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 5 }, () =>
        makeEvent({
          session_id: 'sess-post',
          tool_name: 'Read',
          tokens_estimated: 60_000,
        }),
      ),
    )

    // First call — count becomes 6, throttle=6, fires
    const first = buildCoachHintSync({
      db,
      sessionId: 'sess-post',
      dedupeWindowSeconds: 300,
      minSeverity: 'warn',
    })
    expect(first.text).not.toBeNull()

    // Second call with same conditions — dedupe window swallows it
    const second = buildCoachHintSync({
      db,
      sessionId: 'sess-post',
      dedupeWindowSeconds: 300,
      minSeverity: 'warn',
    })
    expect(second.text).toBeNull()
  })

  it('keeps p95 overhead reasonable at the throttle boundary', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 30 }, () =>
        makeEvent({ session_id: 'sess-perf', tool_name: 'Read', tokens_estimated: 500 }),
      ),
    )

    const durations: number[] = []
    for (let i = 0; i < 40; i++) {
      const start = performance.now()
      runPostToolUseHook({
        stdin: JSON.stringify({
          session_id: 'sess-perf',
          tool_name: 'Read',
          tool_response: 'x',
        }),
        dbPath: ':memory:',
        projectDir: PROJECT_DIR,
        writeStdout: false,
        coachEnabled: true,
        coachThrottle: 5, // hits boundary every 5 events
        coachMinSeverity: 'warn',
      })
      durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95)]
    expect(p95).toBeLessThan(50)
  })
})
