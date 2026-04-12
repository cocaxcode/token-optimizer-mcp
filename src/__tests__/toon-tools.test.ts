import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestClient, type TestContext } from './helpers.js'
import { _internal } from '../tools/toon.js'

interface ToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

describe('toon internal helpers', () => {
  it('compactEncode + compactDecode round-trips primitives', () => {
    for (const v of [null, true, false, 0, 1, 1.5, 'hello', '']) {
      const encoded = _internal.compactEncode(v)
      const decoded = _internal.compactDecode(encoded)
      expect(decoded).toEqual(v)
    }
  })

  it('round-trips objects and arrays', () => {
    const cases: unknown[] = [
      {},
      [],
      { a: 1, b: 'two', c: true },
      [1, 2, 3],
      { nested: { deep: { value: [1, 2, 3] } } },
      { list: [{ x: 1 }, { x: 2 }] },
      { unicode: 'café', emoji: '🚀' },
    ]
    for (const c of cases) {
      const encoded = _internal.compactEncode(c)
      const decoded = _internal.compactDecode(encoded)
      expect(decoded).toEqual(c)
    }
  })

  it('round-trips 100 random JSON fixtures byte-identically', () => {
    for (let i = 0; i < 100; i++) {
      const fixture = {
        id: i,
        label: `item-${i}`,
        tags: Array.from({ length: i % 5 }, (_, j) => `tag-${j}`),
        meta: { timestamp: Date.now(), flag: i % 2 === 0 },
      }
      const encoded = _internal.compactEncode(fixture)
      const decoded = _internal.compactDecode(encoded)
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(fixture))
    }
  })

  it('throws Spanish message on circular references', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    expect(() => _internal.compactEncode(obj)).toThrow(/circular/i)
  })

  it('throws Spanish message on invalid TOON input', () => {
    expect(() => _internal.compactDecode('{invalid')).toThrow(/TOON invalido/)
  })
})

describe('toon MCP tools', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestClient()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  it('lists both toon_encode and toon_decode', async () => {
    const tools = await ctx.client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('toon_encode')
    expect(names).toContain('toon_decode')
  })

  it('toon_encode returns compact JSON', async () => {
    const result = (await ctx.client.callTool({
      name: 'toon_encode',
      arguments: { data: { foo: 'bar', n: 42 } },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe('{"foo":"bar","n":42}')
  })

  it('toon_decode parses back to JSON', async () => {
    const result = (await ctx.client.callTool({
      name: 'toon_decode',
      arguments: { toon: '{"foo":"bar","n":42}' },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(parsed).toEqual({ foo: 'bar', n: 42 })
  })

  it('toon_decode returns error on malformed input', async () => {
    const result = (await ctx.client.callTool({
      name: 'toon_decode',
      arguments: { toon: '{not json' },
    })) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('TOON invalido')
  })
})
