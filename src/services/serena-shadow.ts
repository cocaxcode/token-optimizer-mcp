// Serena shadow measurement — Phase 4.6
// Opt-in: when enabled, compare the serena event output against the full file
// size to estimate the token delta that symbolic-read saved.

import fs from 'node:fs'
import type { EstimationMethod } from '../lib/types.js'
import { normalizePath } from '../lib/paths.js'

const CHARS_PER_TOKEN = 0.27

export interface ShadowCandidate {
  tool_name: string
  tool_input_summary: string | null
  tokens_estimated: number
}

export interface ShadowMeasurement {
  delta_tokens: number
  full_file_tokens: number
  output_tokens: number
  estimation_method: EstimationMethod
}

function parsePath(summary: string | null): string | null {
  if (!summary) return null
  try {
    const parsed = JSON.parse(summary) as { path?: unknown; file_path?: unknown }
    const raw = parsed.path ?? parsed.file_path
    return typeof raw === 'string' ? raw : null
  } catch {
    return null
  }
}

/**
 * Measure the delta between the full file size (if serena had read the whole
 * file) and what was actually returned. Returns null when disabled or when
 * any filesystem error occurs. Target overhead: ≤1ms.
 */
export function shadowMeasureSerena(
  event: ShadowCandidate,
  enabled: boolean,
): ShadowMeasurement | null {
  if (!enabled) return null
  const rawPath = parsePath(event.tool_input_summary)
  if (!rawPath) return null
  try {
    const abs = normalizePath(rawPath)
    const stat = fs.statSync(abs)
    if (!stat.isFile()) return null
    const fullFileTokens = Math.ceil(stat.size * CHARS_PER_TOKEN)
    const delta = Math.max(0, fullFileTokens - event.tokens_estimated)
    return {
      delta_tokens: delta,
      full_file_tokens: fullFileTokens,
      output_tokens: event.tokens_estimated,
      estimation_method: 'estimated_serena_shadow',
    }
  } catch {
    return null
  }
}
