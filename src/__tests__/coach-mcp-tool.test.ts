import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestClient, type TestContext } from './helpers.js'

interface ToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

describe('coach_tips MCP tool', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestClient()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  it('coach_tips tool is registered', async () => {
    const tools = await ctx.client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('coach_tips')
  })

  it('returns JSON with required top-level fields (verbose)', async () => {
    const result = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: { session_id: 'sess-1', verbose: true },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(payload).toHaveProperty('current')
    expect(payload).toHaveProperty('known_tricks')
    expect(payload).toHaveProperty('context')
    expect(payload).toHaveProperty('reference_data')
    expect(payload).toHaveProperty('last_computed_at')
  })

  it('compact mode (default) omits known_tricks and reference_data', async () => {
    const result = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: { session_id: 'sess-1' },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>
    expect(payload).toHaveProperty('current')
    expect(payload).toHaveProperty('context')
    expect(payload).toHaveProperty('last_computed_at')
    expect(payload).not.toHaveProperty('known_tricks')
    expect(payload).not.toHaveProperty('reference_data')
  })

  it('verbose known_tricks includes 18+ tips', async () => {
    const result = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: { verbose: true },
    })) as ToolResult
    const payload = JSON.parse(result.content[0].text) as {
      known_tricks: Array<{ id: string }>
    }
    expect(payload.known_tricks.length).toBeGreaterThanOrEqual(18)
  })

  it('verbose reference_data has 5 rows tagged reference_measured', async () => {
    const result = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: { verbose: true },
    })) as ToolResult
    const payload = JSON.parse(result.content[0].text) as {
      reference_data: Array<{ estimation_method: string }>
    }
    expect(payload.reference_data.length).toBeGreaterThanOrEqual(5)
    for (const row of payload.reference_data) {
      expect(row.estimation_method).toBe('reference_measured')
    }
  })

  it('context measurement is always present with estimation_method', async () => {
    const result = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: { session_id: 'sess-1' },
    })) as ToolResult
    const payload = JSON.parse(result.content[0].text) as {
      context: { estimation_method: string; tokens: number; limit: number; percent: number }
    }
    expect(payload.context).toHaveProperty('estimation_method')
    expect(payload.context).toHaveProperty('tokens')
    expect(payload.context).toHaveProperty('limit')
    expect(payload.context).toHaveProperty('percent')
  })

  it('current is an array (possibly empty)', async () => {
    const result = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: {},
    })) as ToolResult
    const payload = JSON.parse(result.content[0].text) as { current: unknown[] }
    expect(Array.isArray(payload.current)).toBe(true)
  })
})
