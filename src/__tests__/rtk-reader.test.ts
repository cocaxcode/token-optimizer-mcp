import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import {
  importFromRtkDb,
  extractMarkerFromContent,
  applyFallback,
  summarizeImport,
} from '../services/rtk-reader.js'

describe('extractMarkerFromContent', () => {
  it('returns null on null input', () => {
    expect(extractMarkerFromContent(null)).toBeNull()
  })

  it('parses the marker token count', () => {
    expect(extractMarkerFromContent('blah blah [rtk: filtered 1234 tokens] etc')).toBe(1234)
  })

  it('returns null when no marker present', () => {
    expect(extractMarkerFromContent('no marker here')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(extractMarkerFromContent('[RTK: filtered 50 tokens]')).toBe(50)
  })
})

describe('applyFallback', () => {
  it('applies 0.7 ratio', () => {
    expect(applyFallback(100)).toBe(70)
    expect(applyFallback(1000)).toBe(700)
  })

  it('returns 0 for invalid input', () => {
    expect(applyFallback(-5)).toBe(0)
    expect(applyFallback(NaN)).toBe(0)
  })
})

describe('importFromRtkDb', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tompx-rtk-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null when rtk.db is missing', () => {
    const result = importFromRtkDb(path.join(tempDir, 'missing.db'))
    expect(result).toBeNull()
  })

  it('imports events from a seeded rtk.db fixture', () => {
    const dbPath = path.join(tempDir, 'tracking.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE tracking (
        tool_name TEXT,
        command TEXT,
        filtered_tokens INTEGER,
        created_at TEXT
      );
      INSERT INTO tracking VALUES ('Bash', 'npm test', 500, '2026-04-01T00:00:00Z');
      INSERT INTO tracking VALUES ('Bash', 'npm build', 1200, '2026-04-01T00:05:00Z');
    `)
    db.close()

    const result = importFromRtkDb(dbPath)
    expect(result).not.toBeNull()
    expect(result).toHaveLength(2)
    expect(result![0].estimation_method).toBe('estimated_rtk_db')
    expect(result![0].strategy).toBe('rtk_db')
    expect(result!.map((e) => e.filtered_tokens).sort((a, b) => a - b)).toEqual([500, 1200])
  })

  it('returns null gracefully if rtk.db schema is unreadable', () => {
    const dbPath = path.join(tempDir, 'tracking.db')
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE other (x INTEGER);`)
    db.close()
    const result = importFromRtkDb(dbPath)
    expect(result).toBeNull()
  })
})

describe('summarizeImport', () => {
  it('returns none on empty/null', () => {
    expect(summarizeImport(null)).toEqual({
      strategy: 'none',
      events_found: 0,
      total_tokens_saved: 0,
    })
    expect(summarizeImport([])).toEqual({
      strategy: 'none',
      events_found: 0,
      total_tokens_saved: 0,
    })
  })

  it('sums filtered_tokens across events', () => {
    const summary = summarizeImport([
      {
        tool_name: 'Bash',
        command: 'npm test',
        filtered_tokens: 100,
        created_at: '2026-01-01',
        strategy: 'rtk_db',
        estimation_method: 'estimated_rtk_db',
      },
      {
        tool_name: 'Bash',
        command: 'npm build',
        filtered_tokens: 200,
        created_at: '2026-01-02',
        strategy: 'rtk_db',
        estimation_method: 'estimated_rtk_db',
      },
    ])
    expect(summary.strategy).toBe('rtk_db')
    expect(summary.events_found).toBe(2)
    expect(summary.total_tokens_saved).toBe(300)
  })
})
