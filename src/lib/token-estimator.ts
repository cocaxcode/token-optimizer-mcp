// Token estimation — Phase 1.6 + 1.10
// Fast heuristic (always) + sampled count_tokens API (opt-in via ANTHROPIC_API_KEY)

const API_URL = 'https://api.anthropic.com/v1/messages/count_tokens'
const DEFAULT_SAMPLE_RATE = 0.1
const DEFAULT_TIMEOUT_MS = 500
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const CHARS_PER_TOKEN = 0.27

export function estimateTokensFast(input: string | number | null | undefined): number {
  if (input == null) return 0
  if (typeof input === 'number') return Math.ceil(input * CHARS_PER_TOKEN)
  return Math.ceil(input.length * CHARS_PER_TOKEN)
}

export interface EstimateTokensActualOptions {
  /** Force sampling decision: true = always sample, false = never, undefined = random at SAMPLE_RATE */
  forceSample?: boolean
  sampleRate?: number
  timeoutMs?: number
  model?: string
  /** Injected for testing; defaults to global fetch */
  fetchImpl?: typeof fetch
}

export async function estimateTokensActual(
  text: string,
  opts: EstimateTokensActualOptions = {},
): Promise<number | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const rate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE
  const shouldSample = opts.forceSample ?? Math.random() < rate
  if (!shouldSample) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const fetchFn = opts.fetchImpl ?? fetch
  try {
    const res = await fetchFn(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        messages: [{ role: 'user', content: text }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as { input_tokens?: number }
    return typeof data.input_tokens === 'number' ? data.input_tokens : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
