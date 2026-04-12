import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { estimateTokensFast, estimateTokensActual } from '../lib/token-estimator.js'

describe('estimateTokensFast', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokensFast('')).toBe(0)
    expect(estimateTokensFast(null)).toBe(0)
    expect(estimateTokensFast(undefined)).toBe(0)
  })

  it('uses ceil(length * 0.27) heuristic', () => {
    expect(estimateTokensFast('a'.repeat(100))).toBe(27)
    expect(estimateTokensFast('a'.repeat(1000))).toBe(270)
  })

  it('handles small strings correctly (ceil)', () => {
    expect(estimateTokensFast('abc')).toBe(1) // ceil(0.81) = 1
    expect(estimateTokensFast('abcd')).toBe(2) // ceil(1.08) = 2
  })

  it('is monotonic with length', () => {
    const a = estimateTokensFast('a'.repeat(10))
    const b = estimateTokensFast('a'.repeat(100))
    const c = estimateTokensFast('a'.repeat(1000))
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })
})

describe('estimateTokensActual', () => {
  let originalKey: string | undefined

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  })

  it('returns null when ANTHROPIC_API_KEY is absent', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const result = await estimateTokensActual('hello', { forceSample: true })
    expect(result).toBe(null)
  })

  it('returns null when not sampling', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const fetchMock = vi.fn()
    const result = await estimateTokensActual('hello', {
      forceSample: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toBe(null)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns input_tokens on successful API call', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ input_tokens: 42 }),
    })
    const result = await estimateTokensActual('hello world', {
      forceSample: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toBe(42)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null on non-ok response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    })
    const result = await estimateTokensActual('hello', {
      forceSample: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toBe(null)
  })

  it('returns null on fetch error', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await estimateTokensActual('hello', {
      forceSample: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toBe(null)
  })

  it('samples approximately at configured rate', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    let called = 0
    const fetchMock = vi.fn().mockImplementation(async () => {
      called++
      return { ok: true, json: async () => ({ input_tokens: 1 }) }
    })
    const runs = 500
    for (let i = 0; i < runs; i++) {
      await estimateTokensActual('x', {
        sampleRate: 0.2,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    }
    // Expect ~20% ± wide tolerance (probabilistic test)
    expect(called).toBeGreaterThan(runs * 0.08)
    expect(called).toBeLessThan(runs * 0.32)
  })
})
