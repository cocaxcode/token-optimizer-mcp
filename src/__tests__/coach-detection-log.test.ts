// Coach detection-log instrumentation tests.
// Verifies the opt-in flag captures every rule hit considered by the
// surfacing pipeline, tagged with its outcome (surfaced / deduped /
// filtered_severity / filtered_throttle), and writes nothing when off.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runSessionStartHook } from '../hooks/sessionstart.js'
import { runPostToolUseHook } from '../hooks/posttooluse.js'
import {
  buildCoachSectionMarkdown,
  buildCoachHintSync,
} from '../coach/session-section.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { projectHash } from '../lib/paths.js'

interface DetectionRow {
  rule_id: string
  severity: string
  via_attempted: string
  outcome: string
}

function readDetections(
  db: ReturnType<typeof getDb>,
  sessionId: string,
): DetectionRow[] {
  return db
    .prepare(
      `SELECT rule_id, severity, via_attempted, outcome
       FROM coach_detection_log
       WHERE session_id = ?
       ORDER BY id ASC`,
    )
    .all(sessionId) as DetectionRow[]
}

describe('coach detection-log instrumentation', () => {
  const PROJECT_DIR = process.cwd()
  const PROJECT_HASH = projectHash(PROJECT_DIR)
  const originalWrite = process.stdout.write.bind(process.stdout)

  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`).run(
      'sess-detlog',
      PROJECT_HASH,
    )
    process.stdout.write = (() => true) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = originalWrite
    closeDb()
  })

  it('writes nothing when detectionLogEnabled is off (default)', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 12 }, () =>
        makeEvent({ session_id: 'sess-detlog', tool_name: 'Bash' }),
      ),
    )

    await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-detlog',
      projectDir: PROJECT_DIR,
      maxTips: 3,
      // detectionLogEnabled omitted → off
    })

    expect(readDetections(db, 'sess-detlog')).toHaveLength(0)
  })

  it('logs surfaced outcomes from sessionstart when flag is on', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 12 }, () =>
        makeEvent({ session_id: 'sess-detlog', tool_name: 'Bash' }),
      ),
    )

    const result = await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-detlog',
      projectDir: PROJECT_DIR,
      maxTips: 3,
      detectionLogEnabled: true,
    })

    expect(result.markdown).not.toBeNull()
    const rows = readDetections(db, 'sess-detlog')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.via_attempted === 'sessionstart')).toBe(true)
    expect(rows.some((r) => r.outcome === 'surfaced')).toBe(true)
  })

  it('logs deduped outcome on second sessionstart call within window', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 12 }, () =>
        makeEvent({ session_id: 'sess-detlog', tool_name: 'Bash' }),
      ),
    )

    await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-detlog',
      projectDir: PROJECT_DIR,
      maxTips: 3,
      dedupeWindowSeconds: 600,
      detectionLogEnabled: true,
    })
    await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-detlog',
      projectDir: PROJECT_DIR,
      maxTips: 3,
      dedupeWindowSeconds: 600,
      detectionLogEnabled: true,
    })

    const rows = readDetections(db, 'sess-detlog')
    expect(rows.some((r) => r.outcome === 'surfaced')).toBe(true)
    expect(rows.some((r) => r.outcome === 'deduped')).toBe(true)
  })

  it('logs filtered_severity from posttooluse hint when info < warn min', () => {
    const db = getDb(':memory:')
    // 12 Bash events → detect-many-bash-commands fires with info severity.
    seedAnalyticsDb(
      db,
      Array.from({ length: 12 }, () =>
        makeEvent({ session_id: 'sess-detlog', tool_name: 'Bash' }),
      ),
    )

    buildCoachHintSync({
      db,
      sessionId: 'sess-detlog',
      minSeverity: 'warn',
      detectionLogEnabled: true,
    })

    const rows = readDetections(db, 'sess-detlog')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.via_attempted === 'posttooluse')).toBe(true)
    expect(rows.some((r) => r.outcome === 'filtered_severity')).toBe(true)
  })

  it('logs surfaced outcome from posttooluse hint when warn rule fires', () => {
    const db = getDb(':memory:')
    // 6 huge Reads → detect-huge-file-reads fires with warn severity.
    seedAnalyticsDb(
      db,
      Array.from({ length: 6 }, () =>
        makeEvent({
          session_id: 'sess-detlog',
          tool_name: 'Read',
          tokens_estimated: 60_000,
        }),
      ),
    )

    const hint = buildCoachHintSync({
      db,
      sessionId: 'sess-detlog',
      minSeverity: 'warn',
      detectionLogEnabled: true,
    })

    expect(hint.text).not.toBeNull()
    const rows = readDetections(db, 'sess-detlog')
    expect(rows.some((r) => r.outcome === 'surfaced')).toBe(true)
  })

  it('logs filtered_throttle from posttooluse hook when throttle gate suppresses', () => {
    const db = getDb(':memory:')
    // Seed 11 huge Read events. After the 12th call inside the hook, count=12
    // and throttle=20 → gate suppresses surfacing. detect-huge-file-reads
    // would still fire because the seeded events have huge tokens.
    seedAnalyticsDb(
      db,
      Array.from({ length: 11 }, () =>
        makeEvent({
          session_id: 'sess-detlog',
          tool_name: 'Read',
          tokens_estimated: 60_000,
        }),
      ),
    )

    runPostToolUseHook({
      stdin: JSON.stringify({
        session_id: 'sess-detlog',
        tool_name: 'Read',
        tool_input: { file_path: '/x' },
        tool_response: 'a'.repeat(240_000),
      }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      coachEnabled: true,
      coachThrottle: 20,
      coachDetectionLogEnabled: true,
    })

    const rows = readDetections(db, 'sess-detlog')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.outcome === 'filtered_throttle')).toBe(true)
    expect(rows.every((r) => r.via_attempted === 'posttooluse')).toBe(true)
  })

  it('writes nothing from sessionstart hook when flag is off', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 12 }, () =>
        makeEvent({ session_id: 'sess-detlog', tool_name: 'Bash' }),
      ),
    )

    await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-detlog', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: true,
      coachDetectionLogEnabled: false,
    })

    expect(readDetections(db, 'sess-detlog')).toHaveLength(0)
  })

  it('writes from sessionstart hook when flag is on', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(
      db,
      Array.from({ length: 12 }, () =>
        makeEvent({ session_id: 'sess-detlog', tool_name: 'Bash' }),
      ),
    )

    await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-detlog', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: true,
      coachDetectionLogEnabled: true,
    })

    const rows = readDetections(db, 'sess-detlog')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.via_attempted === 'sessionstart')).toBe(true)
  })
})
