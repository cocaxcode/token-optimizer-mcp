import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runSessionStartHook } from '../hooks/sessionstart.js'
import { closeDb, getDb } from '../db/connection.js'
import { buildQueries } from '../db/queries.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { projectHash } from '../lib/paths.js'

describe('runSessionStartHook', () => {
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

  it('emits empty stdout for startup matcher', async () => {
    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'startup' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).toBe('')
  })

  it('emits empty stdout for resume matcher', async () => {
    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'resume' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).toBe('')
  })

  it('emits markdown payload for compact matcher', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Read',
      }),
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Bash',
      }),
    ])
    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).toContain('## Presupuesto')
    expect(md).toContain('## Archivos recientes')
  })

  it('handles malformed stdin gracefully', async () => {
    const md = await runSessionStartHook({
      stdin: '{not json',
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).toBe('')
  })

  it('handles empty stdin gracefully', async () => {
    const md = await runSessionStartHook({
      stdin: '',
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).toBe('')
  })

  it('injects serena symbols section when touches exist for the session', async () => {
    const db = getDb(':memory:')
    const queries = buildQueries(db)
    queries.insertSerenaTouch('sess-1', 'mcp__serena__find_symbol', 'src/lib/types.ts', 'ToolEvent')
    queries.insertSerenaTouch('sess-1', 'mcp__serena__get_symbols_overview', 'src/db/queries.ts', null)

    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).toContain('## Símbolos Serena recientes')
    expect(md).toContain('src/lib/types.ts')
    expect(md).toContain('ToolEvent')
    expect(md).toContain('src/db/queries.ts')
  })

  it('does not inject serena section when no touches exist', async () => {
    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).not.toContain('Símbolos Serena')
  })

  it('does not inject serena section for touches in other sessions', async () => {
    const db = getDb(':memory:')
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`).run(
      'sess-other',
      PROJECT_HASH,
    )
    const queries = buildQueries(db)
    queries.insertSerenaTouch('sess-other', 'mcp__serena__find_symbol', 'src/other.ts', null)

    const md = await runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
      coachEnabled: false,
    })
    expect(md).not.toContain('src/other.ts')
  })
})
