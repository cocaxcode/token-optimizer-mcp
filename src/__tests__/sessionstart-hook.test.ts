import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runSessionStartHook } from '../hooks/sessionstart.js'
import { closeDb, getDb } from '../db/connection.js'
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

  it('emits empty stdout for startup matcher', () => {
    const md = runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'startup' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(md).toBe('')
  })

  it('emits empty stdout for resume matcher', () => {
    const md = runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'resume' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(md).toBe('')
  })

  it('emits markdown payload for compact matcher', () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input_summary: JSON.stringify({ path: '/foo.ts' }),
      }),
      makeEvent({
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input_summary: JSON.stringify({ command: 'npm test' }),
        input_hash: 'h2',
      }),
    ])
    const md = runSessionStartHook({
      stdin: JSON.stringify({ session_id: 'sess-1', matcher: 'compact' }),
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(md).toContain('## Presupuesto')
    expect(md).toContain('## Archivos recientes')
    expect(md).toContain('/foo.ts')
  })

  it('handles malformed stdin gracefully', () => {
    const md = runSessionStartHook({
      stdin: '{not json',
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(md).toBe('')
  })

  it('handles empty stdin gracefully', () => {
    const md = runSessionStartHook({
      stdin: '',
      dbPath: ':memory:',
      projectDir: PROJECT_DIR,
      writeStdout: false,
    })
    expect(md).toBe('')
  })
})
