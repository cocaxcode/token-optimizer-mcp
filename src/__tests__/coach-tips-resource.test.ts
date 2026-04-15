import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestClient, type TestContext } from './helpers.js'
import { COACH_TIPS_URI } from '../resources/coach-tips.js'

interface ResourceContent {
  uri: string
  mimeType?: string
  text?: string
}

interface ReadResourceResult {
  contents: ResourceContent[]
}

describe('token-optimizer://coach/tips resource', () => {
  let ctx: TestContext

  beforeEach(async () => {
    ctx = await createTestClient()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  it('is listed in the resources catalog', async () => {
    const resources = await ctx.client.listResources()
    const uris = resources.resources.map((r) => r.uri)
    expect(uris).toContain(COACH_TIPS_URI)
  })

  it('returns a JSON payload with the expected top-level fields', async () => {
    const result = (await ctx.client.readResource({
      uri: COACH_TIPS_URI,
    })) as ReadResourceResult

    expect(result.contents.length).toBe(1)
    const content = result.contents[0]
    expect(content.uri).toBe(COACH_TIPS_URI)
    expect(content.mimeType).toBe('application/json')
    expect(content.text).toBeDefined()

    const payload = JSON.parse(content.text ?? '{}') as Record<string, unknown>
    expect(payload).toHaveProperty('current')
    expect(payload).toHaveProperty('known_tricks')
    expect(payload).toHaveProperty('context')
    expect(payload).toHaveProperty('reference_data')
    expect(payload).toHaveProperty('stale_reference_count')
    expect(payload).toHaveProperty('last_computed_at')
  })

  it('known_tricks contains at least 18 tips (mirror of coach_tips tool)', async () => {
    const result = (await ctx.client.readResource({
      uri: COACH_TIPS_URI,
    })) as ReadResourceResult
    const payload = JSON.parse(result.contents[0].text ?? '{}') as {
      known_tricks: unknown[]
    }
    expect(payload.known_tricks.length).toBeGreaterThanOrEqual(18)
  })

  it('matches the coach_tips tool payload shape for known_tricks', async () => {
    const toolResult = (await ctx.client.callTool({
      name: 'coach_tips',
      arguments: { verbose: true },
    })) as { content: Array<{ text: string }> }
    const toolPayload = JSON.parse(toolResult.content[0].text) as {
      known_tricks: Array<{ id: string }>
    }

    const resourceResult = (await ctx.client.readResource({
      uri: COACH_TIPS_URI,
    })) as ReadResourceResult
    const resourcePayload = JSON.parse(
      resourceResult.contents[0].text ?? '{}',
    ) as { known_tricks: Array<{ id: string }> }

    const toolIds = toolPayload.known_tricks.map((t) => t.id).sort()
    const resourceIds = resourcePayload.known_tricks.map((t) => t.id).sort()
    expect(resourceIds).toEqual(toolIds)
  })
})
