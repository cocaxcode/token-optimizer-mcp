import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  SessionRetriever,
} from '../services/session-retriever.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'

describe('SessionRetriever', () => {
  let retriever: SessionRetriever

  beforeEach(() => {
    closeDb()
    const db = getDb(':memory:')
    retriever = new SessionRetriever(db)
  })

  afterEach(() => {
    closeDb()
  })

  describe('getRecentFileReads', () => {
    it('returns events with file-related tool names', () => {
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
        makeEvent({
          session_id: 'sess-1',
          tool_name: 'Edit',
        }),
      ])
      const reads = retriever.getRecentFileReads('sess-1', 5)
      expect(reads.length).toBe(2)
      const toolNames = reads.map((r) => r.tool_name).sort()
      expect(toolNames).toEqual(['Edit', 'Read'])
      expect(reads[0]).toHaveProperty('created_at')
      expect(reads[0]).toHaveProperty('tokens_estimated')
    })
  })

  describe('getRecentBashCommands', () => {
    it('returns only Bash events', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({
          session_id: 'sess-1',
          tool_name: 'Bash',
        }),
        makeEvent({
          session_id: 'sess-1',
          tool_name: 'Read',
        }),
      ])
      const cmds = retriever.getRecentBashCommands('sess-1', 5)
      expect(cmds.length).toBe(1)
      expect(cmds[0].tool_name).toBe('Bash')
      expect(cmds[0]).toHaveProperty('created_at')
      expect(cmds[0]).toHaveProperty('tokens_estimated')
    })
  })
})
