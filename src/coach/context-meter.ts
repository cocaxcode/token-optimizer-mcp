// Context size meter with 3-source fallback — Phase 4.42
// (1) transcript JSONL → (2) xray HTTP → (3) cumulative DB estimate

import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { ContextMeasurement, EstimationMethod } from '../lib/types.js'
import { resolveTranscriptPath } from '../lib/paths.js'
import { buildQueries } from '../db/queries.js'
import { getSessionTokens } from '../services/xray-client.js'

type DB = Database.Database

const DEFAULT_LIMIT = 200_000
const OPUS_1M_LIMIT = 1_000_000
const BASELINE_TOKENS = 15_000

export interface ContextMeterOptions {
  projectDir?: string
  db?: DB
  fetchImpl?: typeof fetch
  activeModel?: string
}

export async function measureContextSize(
  sessionId: string,
  opts: ContextMeterOptions = {},
): Promise<ContextMeasurement> {
  // Strategy 1: transcript JSONL (measured_exact)
  if (opts.projectDir) {
    const transcript = readTranscript(opts.projectDir, sessionId)
    if (transcript) return transcript
  }

  // Strategy 2: xray HTTP (measured_exact)
  const xrayResult = await tryXray(sessionId, opts.fetchImpl)
  if (xrayResult) return xrayResult

  // Strategy 3: cumulative estimate from our DB (estimated_cumulative)
  const limit = resolveLimit(opts.activeModel)
  if (opts.db) {
    return cumulativeEstimate(opts.db, sessionId, limit)
  }

  return { tokens: 0, limit, percent: 0, estimation_method: 'unknown' }
}

function readTranscript(projectDir: string, sessionId: string): ContextMeasurement | null {
  try {
    const p = resolveTranscriptPath(projectDir, sessionId)
    if (!fs.existsSync(p)) return null
    const content = fs.readFileSync(p, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    let totalTokens = 0
    let limit = DEFAULT_LIMIT
    for (const line of lines) {
      try {
        const turn = JSON.parse(line) as {
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
          }
          model?: string
        }
        if (turn.usage) {
          totalTokens +=
            (turn.usage.input_tokens ?? 0) +
            (turn.usage.output_tokens ?? 0) +
            (turn.usage.cache_read_input_tokens ?? 0)
        }
        if (turn.model && /1m/i.test(turn.model)) limit = OPUS_1M_LIMIT
      } catch {
        // skip unparseable line
      }
    }
    return {
      tokens: totalTokens,
      limit,
      percent: limit > 0 ? totalTokens / limit : 0,
      estimation_method: 'measured_exact' as EstimationMethod,
    }
  } catch {
    return null
  }
}

async function tryXray(
  sessionId: string,
  fetchImpl?: typeof fetch,
): Promise<ContextMeasurement | null> {
  const opts: Parameters<typeof getSessionTokens>[1] = {}
  if (fetchImpl !== undefined) opts.fetchImpl = fetchImpl
  return getSessionTokens(sessionId, opts)
}

function resolveLimit(activeModel?: string): number {
  if (activeModel && /1m|opus/i.test(activeModel)) return OPUS_1M_LIMIT
  return DEFAULT_LIMIT
}

function cumulativeEstimate(
  db: DB,
  sessionId: string,
  limit: number = DEFAULT_LIMIT,
): ContextMeasurement {
  const queries = buildQueries(db)
  const sessionTokens = queries.sumTokensBySession(sessionId)
  const total = sessionTokens + BASELINE_TOKENS
  return {
    tokens: total,
    limit,
    percent: total / limit,
    estimation_method: 'estimated_cumulative',
  }
}
