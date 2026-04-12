import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestClient, type TestContext } from './helpers.js'

interface ToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

describe('budget MCP tools', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestClient()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  it('lists the 3 budget tools', async () => {
    const tools = await ctx.client.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    expect(names).toContain('budget_set')
    expect(names).toContain('budget_check')
    expect(names).toContain('budget_report')
  })

  it('budget_set creates a session budget', async () => {
    const result = (await ctx.client.callTool({
      name: 'budget_set',
      arguments: {
        scope: 'session',
        scope_key: 'sess-1',
        limit_tokens: 10_000,
        mode: 'warn',
      },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Presupuesto guardado')
    expect(result.content[0].text).toContain('limit_tokens: 10000')
  })

  it('budget_set rejects invalid limit via Zod', async () => {
    const result = (await ctx.client.callTool({
      name: 'budget_set',
      arguments: {
        scope: 'session',
        scope_key: 'sess-1',
        limit_tokens: -5,
      },
    })) as ToolResult
    expect(result.isError).toBe(true)
  })

  it('budget_check returns inactive when no budget set', async () => {
    const result = (await ctx.client.callTool({
      name: 'budget_check',
      arguments: { session_id: 'sess-1' },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Sin presupuesto activo')
  })

  it('budget_check reports active budget after budget_set', async () => {
    await ctx.client.callTool({
      name: 'budget_set',
      arguments: {
        scope: 'session',
        scope_key: 'sess-1',
        limit_tokens: 1000,
        mode: 'block',
      },
    })
    const result = (await ctx.client.callTool({
      name: 'budget_check',
      arguments: { session_id: 'sess-1' },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('gastado:')
    expect(result.content[0].text).toContain('modo:')
    expect(result.content[0].text).toContain('block')
  })

  it('budget_report returns a shape even with no data', async () => {
    const result = (await ctx.client.callTool({
      name: 'budget_report',
      arguments: { period: 'day' },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Por herramienta')
    expect(result.content[0].text).toContain('Por fuente')
  })

  it('budget_report accepts all period values', async () => {
    for (const period of ['session', 'day', 'week', 'month'] as const) {
      const result = (await ctx.client.callTool({
        name: 'budget_report',
        arguments: { period },
      })) as ToolResult
      expect(result.isError).toBeFalsy()
    }
  })
})
