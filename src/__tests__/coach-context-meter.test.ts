import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { measureContextSize } from '../coach/context-meter.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'

describe('measureContextSize', () => {
  beforeEach(() => {
    closeDb()
    delete process.env.XRAY_URL
  })

  afterEach(() => {
    closeDb()
    delete process.env.XRAY_URL
  })

  it('returns unknown when no sources are available', async () => {
    const result = await measureContextSize('sess-1')
    expect(result.estimation_method).toBe('unknown')
    expect(result.tokens).toBe(0)
  })

  it('cumulative fallback uses DB events plus baseline', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [
      makeEvent({ session_id: 'sess-1', tokens_estimated: 1000 }),
      makeEvent({ session_id: 'sess-1', tokens_estimated: 2000 }),
    ])
    const result = await measureContextSize('sess-1', { db })
    expect(result.estimation_method).toBe('estimated_cumulative')
    // 3000 event tokens + 15000 baseline
    expect(result.tokens).toBe(18_000)
    expect(result.limit).toBe(200_000)
    expect(result.percent).toBeCloseTo(18_000 / 200_000)
  })

  it('xray path wins when XRAY_URL is set and fetch succeeds', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const db = getDb(':memory:')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tokens: 75_000, limit: 200_000 }),
    })
    const result = await measureContextSize('sess-1', {
      db,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result.estimation_method).toBe('measured_exact')
    expect(result.tokens).toBe(75_000)
    expect(result.percent).toBeCloseTo(0.375)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to cumulative when xray returns non-ok', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [makeEvent({ session_id: 'sess-1', tokens_estimated: 500 })])
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const result = await measureContextSize('sess-1', {
      db,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result.estimation_method).toBe('estimated_cumulative')
  })

  it('cumulative uses 1M limit when activeModel contains opus', async () => {
    const db = getDb(':memory:')
    seedAnalyticsDb(db, [
      makeEvent({ session_id: 'sess-1', tokens_estimated: 1000 }),
    ])
    const result = await measureContextSize('sess-1', { db, activeModel: 'claude-opus-4-6[1m]' })
    expect(result.limit).toBe(1_000_000)
    expect(result.percent).toBeCloseTo(16_000 / 1_000_000)
  })

  it('falls back when xray fetch throws (network error)', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const db = getDb(':memory:')
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await measureContextSize('sess-1', {
      db,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result.estimation_method).toBe('estimated_cumulative')
  })
})
