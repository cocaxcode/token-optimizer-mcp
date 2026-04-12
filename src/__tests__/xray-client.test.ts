import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { postToXray, getSessionTokens } from '../services/xray-client.js'

describe('postToXray', () => {
  beforeEach(() => {
    delete process.env.XRAY_URL
  })

  afterEach(() => {
    delete process.env.XRAY_URL
  })

  it('returns false when XRAY_URL is not set', async () => {
    const fetchMock = vi.fn()
    const result = await postToXray(
      { event: 'test' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )
    expect(result).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends POST with event payload when URL is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    process.env.XRAY_URL = 'http://localhost:9999'
    const result = await postToXray(
      { tool_name: 'Read' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )
    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toContain('/hooks/token-optimizer')
    expect(call[1]).toMatchObject({ method: 'POST' })
    const body = JSON.parse(call[1].body as string) as { source: string; event: unknown }
    expect(body.source).toBe('token-optimizer-mcp')
    expect(body.event).toEqual({ tool_name: 'Read' })
  })

  it('returns false on network error (fire-and-forget)', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await postToXray(
      { event: 'x' },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    )
    expect(result).toBe(false)
  })

  it('accepts xrayUrl override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    const result = await postToXray(
      { event: 'x' },
      {
        xrayUrl: 'http://custom:8080',
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    )
    expect(result).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toContain('http://custom:8080')
  })
})

describe('getSessionTokens', () => {
  beforeEach(() => {
    delete process.env.XRAY_URL
  })

  afterEach(() => {
    delete process.env.XRAY_URL
  })

  it('returns null when XRAY_URL is unset', async () => {
    const result = await getSessionTokens('sess-1')
    expect(result).toBeNull()
  })

  it('returns a ContextMeasurement when xray responds ok', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tokens: 100_000, limit: 200_000 }),
    })
    const result = await getSessionTokens('sess-1', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).not.toBeNull()
    expect(result?.tokens).toBe(100_000)
    expect(result?.estimation_method).toBe('measured_exact')
    expect(result?.percent).toBeCloseTo(0.5)
  })

  it('returns null on non-ok response', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    const result = await getSessionTokens('sess-1', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('returns null on network error', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const fetchMock = vi.fn().mockRejectedValue(new Error('timeout'))
    const result = await getSessionTokens('sess-1', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('uses DEFAULT_LIMIT when xray omits limit', async () => {
    process.env.XRAY_URL = 'http://localhost:9999'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tokens: 5000 }),
    })
    const result = await getSessionTokens('sess-1', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result?.limit).toBe(200_000)
  })
})
