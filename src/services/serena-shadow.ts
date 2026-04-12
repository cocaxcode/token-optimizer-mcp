// Serena shadow measurement — Phase 4.6
// Opt-in: when enabled, compare the serena event output against the full file
// size to estimate the token delta that symbolic-read saved.
// Note: without tool_input_summary, shadow measurement requires explicit path.

import fs from 'node:fs'
import type { EstimationMethod } from '../lib/types.js'
import { normalizePath } from '../lib/paths.js'

const CHARS_PER_TOKEN = 0.27

export interface ShadowCandidate {
  tool_name: string
  tokens_estimated: number
  /** Explicit file path for measurement (required since tool_input_summary was removed) */
  file_path?: string
}

export interface ShadowMeasurement {
  delta_tokens: number
  full_file_tokens: number
  output_tokens: number
  estimation_method: EstimationMethod
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
  if (!event.file_path) return null
  try {
    const abs = normalizePath(event.file_path)
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
