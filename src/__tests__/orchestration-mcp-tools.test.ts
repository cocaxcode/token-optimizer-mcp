import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestClient, type TestContext } from './helpers.js'

interface ToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

describe('orchestration MCP tools', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestClient()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  it('lists all 7 orchestration tools', async () => {
    const tools = await ctx.client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('mcp_usage_stats')
    expect(names).toContain('mcp_cost_report')
    expect(names).toContain('optimization_status')
    expect(names).toContain('mcp_prune_suggest')
    expect(names).toContain('mcp_prune_apply')
    expect(names).toContain('mcp_prune_rollback')
    expect(names).toContain('mcp_prune_clear')
  })

  it('mcp_usage_stats returns empty-state text on fresh DB', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_usage_stats',
      arguments: { days: 7 },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Por fuente')
  })

  it('mcp_cost_report returns zero cost on empty DB', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_cost_report',
      arguments: {},
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Tokens totales: 0')
    expect(result.content[0].text).toContain('factura Anthropic')
  })

  it('optimization_status always includes prompt_caching with estimation_method=unknown', async () => {
    const result = (await ctx.client.callTool({
      name: 'optimization_status',
      arguments: {},
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text) as {
      status: {
        prompt_caching: { active_by_default: boolean; estimation_method: string; note: string }
      }
    }
    expect(payload.status.prompt_caching.active_by_default).toBe(true)
    expect(payload.status.prompt_caching.estimation_method).toBe('unknown')
    expect(payload.status.prompt_caching.note).toContain('factura Anthropic')
  })

  it('optimization_status includes serena, rtk, mcp_pruning, schema_bytes', async () => {
    const result = (await ctx.client.callTool({
      name: 'optimization_status',
      arguments: {},
    })) as ToolResult
    const payload = JSON.parse(result.content[0].text) as {
      status: Record<string, unknown>
      suggestions: string[]
    }
    expect(payload.status).toHaveProperty('serena')
    expect(payload.status).toHaveProperty('rtk')
    expect(payload.status).toHaveProperty('mcp_pruning')
    expect(payload.status).toHaveProperty('schema_bytes')
    expect(Array.isArray(payload.suggestions)).toBe(true)
  })

  it('mcp_prune_suggest returns a proposal JSON', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_prune_suggest',
      arguments: { days: 14 },
    })) as ToolResult
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0].text) as {
      proposed_allowlist: string[]
      inactive_servers: string[]
      analysis_days: number
    }
    expect(Array.isArray(payload.proposed_allowlist)).toBe(true)
    expect(Array.isArray(payload.inactive_servers)).toBe(true)
    expect(payload.analysis_days).toBe(14)
  })

  it('mcp_prune_apply rejects without confirm=true', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_prune_apply',
      arguments: { allowlist: ['some-mcp'], confirm: false },
    })) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('confirm:true')
  })

  it('mcp_prune_apply rejects when neither allowlist nor exclude is provided', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_prune_apply',
      arguments: { confirm: true },
    })) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('exactamente uno')
  })

  it('mcp_prune_apply rejects when both allowlist and exclude are provided', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_prune_apply',
      arguments: { allowlist: ['a'], exclude: ['b'], confirm: true },
    })) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('exactamente uno')
  })

  it('mcp_prune_rollback rejects without confirm', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_prune_rollback',
      arguments: { confirm: false },
    })) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('confirm:true')
  })

  it('mcp_prune_clear rejects without confirm', async () => {
    const result = (await ctx.client.callTool({
      name: 'mcp_prune_clear',
      arguments: { confirm: false },
    })) as ToolResult
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('confirm:true')
  })
})
