import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runSessionStartHook } from '../hooks/sessionstart.js'
import { buildCoachSectionMarkdown } from '../coach/session-section.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { projectHash } from '../lib/paths.js'

describe('coach sessionstart section', () => {
  const PROJECT_DIR = process.cwd()
  const PROJECT_HASH = projectHash(PROJECT_DIR)

  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`).run(
      'sess-coach',
      PROJECT_HASH,
    )
  })

  afterEach(() => {
    closeDb()
  })

  it('appends coach section to compact payload when rules fire', async () => {
    const db = getDb(':memory:')
    // 12 Bash events → triggers detect-many-bash-commands
    const bashEvents = Array.from({ length: 12 }, () =>
      makeEvent({
        session_id: 'sess-coach',
        tool_name: 'Bash',
        tokens_estimated: 500,
      }),
    )
    seedAnalyticsDb(db, bashEvents)

    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-coach', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: true,
      coachMaxTips: 3,
    })

    expect(md).toContain('## Presupuesto')
    expect(md).toContain('## Tips del coach')
    expect(md).toMatch(/RTK/i) // install-rtk tip title mentions RTK
    expect(md).toContain('Porqué:')
    expect(md).toContain('Fuente:')
  })

  it('omits coach section when no rules fire', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-coach', tool_name: 'Read' })])

    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-coach', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: true,
    })

    expect(md).toContain('## Presupuesto')
    expect(md).not.toContain('## Tips del coach')
  })

  it('skips coach section when coachEnabled=false', async () => {
    const db = getDb(':memory:')
    const bashEvents = Array.from({ length: 12 }, () =>
      makeEvent({ session_id: 'sess-coach', tool_name: 'Bash' }),
    )
    seedAnalyticsDb(db, bashEvents)

    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-coach', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })

    expect(md).not.toContain('## Tips del coach')
  })

  it('builder returns null markdown when runRules yields nothing', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-coach', tool_name: 'Read' })])

    const result = await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-coach',
      projectDir: PROJECT_DIR,
    })

    expect(result.markdown).toBeNull()
    expect(result.hits).toEqual([])
  })

  it('builder writes to coach_surface_log when surfacing hits', async () => {
    const db = getDb(':memory:')
    const bashEvents = Array.from({ length: 12 }, () =>
      makeEvent({ session_id: 'sess-coach', tool_name: 'Bash' }),
    )
    seedAnalyticsDb(db, bashEvents)

    const result = await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-coach',
      projectDir: PROJECT_DIR,
      maxTips: 3,
    })

    expect(result.markdown).not.toBeNull()
    expect(result.hits.length).toBeGreaterThan(0)

    const rows = db
      .prepare(
        `SELECT rule_id, tip_id, surfaced_via FROM coach_surface_log WHERE session_id = ?`,
      )
      .all('sess-coach') as Array<{ rule_id: string; tip_id: string; surfaced_via: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.surfaced_via === 'sessionstart')).toBe(true)
    expect(rows.some((r) => r.rule_id === 'detect-many-bash-commands')).toBe(true)
  })

  it('dedupes on second call within window', async () => {
    const db = getDb(':memory:')
    const bashEvents = Array.from({ length: 12 }, () =>
      makeEvent({ session_id: 'sess-coach', tool_name: 'Bash' }),
    )
    seedAnalyticsDb(db, bashEvents)

    const first = await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-coach',
      projectDir: PROJECT_DIR,
      dedupeWindowSeconds: 300,
    })
    const second = await buildCoachSectionMarkdown({
      db,
      sessionId: 'sess-coach',
      projectDir: PROJECT_DIR,
      dedupeWindowSeconds: 300,
    })

    expect(first.hits.length).toBeGreaterThan(0)
    // All hits from first call already logged within window → second yields empty
    expect(second.hits.length).toBe(0)
    expect(second.markdown).toBeNull()
  })
})
