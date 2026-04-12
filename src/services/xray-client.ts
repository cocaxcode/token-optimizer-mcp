// xray client — Phase 5.1
// Fire-and-forget POST for tool events + GET for session tokens (used by coach context meter).
// Silent on all failures: no stderr, no throw. Timeout 500ms for post, 300ms for get.

import type { ContextMeasurement } from '../lib/types.js'

const POST_TIMEOUT_MS = 500
const GET_TIMEOUT_MS = 300
const DEFAULT_LIMIT = 200_000

declare const __PKG_VERSION__: string
const VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.1.0'

export interface PostToXrayOptions {
  xrayUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Fire-and-forget POST of a tool event to an xray server.
 * Returns true if the request was attempted, false if skipped (no URL).
 * Any network/parse error is swallowed silently.
 */
export async function postToXray(
  event: Record<string, unknown>,
  opts: PostToXrayOptions = {},
): Promise<boolean> {
  const xrayUrl = opts.xrayUrl ?? process.env.XRAY_URL
  if (!xrayUrl) return false
  const fetchFn = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? POST_TIMEOUT_MS)
  try {
    await fetchFn(`${xrayUrl}/hooks/token-optimizer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'token-optimizer-mcp',
        version: VERSION,
        event,
      }),
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export interface GetSessionTokensOptions {
  xrayUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Read real token counts from xray for a given session.
 * Returns null on any failure or when XRAY_URL is unset.
 */
export async function getSessionTokens(
  sessionId: string,
  opts: GetSessionTokensOptions = {},
): Promise<ContextMeasurement | null> {
  const xrayUrl = opts.xrayUrl ?? process.env.XRAY_URL
  if (!xrayUrl) return null
  const fetchFn = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? GET_TIMEOUT_MS)
  try {
    const res = await fetchFn(
      `${xrayUrl}/sessions/${encodeURIComponent(sessionId)}/tokens`,
      { signal: controller.signal },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { tokens?: number; limit?: number }
    const tokens = data.tokens ?? 0
    const limit = data.limit ?? DEFAULT_LIMIT
    return {
      tokens,
      limit,
      percent: limit > 0 ? tokens / limit : 0,
      estimation_method: 'measured_exact',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
