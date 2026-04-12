import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  SessionRetriever,
  sanitizeFts5Query,
} from '../services/session-retriever.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'

describe('sanitizeFts5Query', () => {
  it('returns empty for empty input', () => {
    expect(sanitizeFts5Query('')).toBe('')
    expect(sanitizeFts5Query('   ')).toBe('')
  })

  it('wraps terms in double quotes', () => {
    expect(sanitizeFts5Query('fix auth bug')).toBe('"fix" "auth" "bug"')
  })

  it('strips special operators (parens, star, caret, colon, bang)', () => {
    // Each special char becomes a space, so terms are split on it
    expect(sanitizeFts5Query('NEAR(foo, bar)')).toBe('"NEAR" "foo" "bar"')
    expect(sanitizeFts5Query('foo* ^bar')).toBe('"foo" "bar"')
    expect(sanitizeFts5Query('fix: auth!')).toBe('"fix" "auth"')
  })

  it('strips double quotes from inside terms', () => {
    expect(sanitizeFts5Query('"foo" "bar"')).toBe('"foo" "bar"')
    expect(sanitizeFts5Query('he"llo')).toBe('"he" "llo"')
  })

  it('handles unicode letters', () => {
    expect(sanitizeFts5Query('café niño')).toBe('"café" "niño"')
  })
})

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

  describe('searchFts5', () => {
    it('returns empty for empty query', () => {
      expect(retriever.searchFts5('')).toEqual([])
    })

    it('returns empty for query with only special chars', () => {
      expect(retriever.searchFts5('()*^:')).toEqual([])
    })

    it('finds events by content', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-1', content: 'authentication middleware bug fix' }),
        makeEvent({
          session_id: 'sess-1',
          content: 'unrelated garbage text',
          input_hash: 'h2',
        }),
      ])
      const results = retriever.searchFts5('authentication bug', 10, { session_id: 'sess-1' })
      expect(results.length).toBe(1)
      expect(results[0].content).toContain('authentication')
    })

    it('clamps limit to valid range', () => {
      const db = getDb(':memory:')
      const events = Array.from({ length: 20 }, (_, i) =>
        makeEvent({
          session_id: 'sess-1',
          content: `needle match ${i}`,
          input_hash: `h${i}`,
        }),
      )
      seedAnalyticsDb(db, events)
      const results = retriever.searchFts5('needle', 100, { session_id: 'sess-1' })
      expect(results.length).toBeLessThanOrEqual(50)
    })

    it('scopes by session_id when provided', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-a', content: 'keyword alpha', input_hash: 'ha' }),
        makeEvent({ session_id: 'sess-b', content: 'keyword beta', input_hash: 'hb' }),
      ])
      const resultsA = retriever.searchFts5('keyword', 10, { session_id: 'sess-a' })
      expect(resultsA.length).toBe(1)
      expect(resultsA[0].content).toContain('alpha')
    })

    it('searches across all sessions when scope is empty', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-a', content: 'global term alpha', input_hash: 'ha' }),
        makeEvent({ session_id: 'sess-b', content: 'global term beta', input_hash: 'hb' }),
      ])
      const results = retriever.searchFts5('global', 10, {})
      expect(results.length).toBe(2)
    })

    it('does not throw on queries that survived as valid but have no matches', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-1', content: 'hello world' })])
      expect(() => retriever.searchFts5('nonexistent', 10)).not.toThrow()
      expect(retriever.searchFts5('nonexistent', 10, { session_id: 'sess-1' })).toEqual([])
    })
  })

  describe('getRecentFileReads', () => {
    it('returns events with file-related tool names', () => {
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
          tool_input_summary: JSON.stringify({ command: 'ls' }),
          input_hash: 'h2',
        }),
        makeEvent({
          session_id: 'sess-1',
          tool_name: 'Edit',
          tool_input_summary: JSON.stringify({ file_path: '/bar.ts' }),
          input_hash: 'h3',
        }),
      ])
      const reads = retriever.getRecentFileReads('sess-1', 5)
      expect(reads.length).toBe(2)
      const paths = reads.map((r) => r.path).sort()
      expect(paths).toEqual(['/bar.ts', '/foo.ts'])
    })

    it('handles missing tool_input_summary gracefully', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({ session_id: 'sess-1', tool_name: 'Read', tool_input_summary: null }),
      ])
      const reads = retriever.getRecentFileReads('sess-1', 5)
      expect(reads.length).toBe(1)
      expect(reads[0].path).toBe('')
    })
  })

  describe('getRecentBashCommands', () => {
    it('returns only Bash events with command parsed', () => {
      const db = getDb(':memory:')
      seedAnalyticsDb(db, [
        makeEvent({
          session_id: 'sess-1',
          tool_name: 'Bash',
          tool_input_summary: JSON.stringify({ command: 'npm test' }),
        }),
        makeEvent({
          session_id: 'sess-1',
          tool_name: 'Read',
          tool_input_summary: JSON.stringify({ path: '/foo' }),
          input_hash: 'h2',
        }),
      ])
      const cmds = retriever.getRecentBashCommands('sess-1', 5)
      expect(cmds.length).toBe(1)
      expect(cmds[0].command).toBe('npm test')
    })
  })
})
