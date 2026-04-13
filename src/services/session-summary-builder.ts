// Session summary builder for xray integration.
// Aggregates all local data sources into a single payload for xray.
// Only called once per session (not in PostToolUse hot path).

import type Database from 'better-sqlite3'
import { getUsageStats, getCostReport } from './stats.js'
import {
  probeSerena,
  probeRtk,
  probeMcpPruning,
  probePromptCaching,
} from '../orchestration/detector.js'
import { measureCurrentSchemaBytes } from '../orchestration/schema-measurer.js'
import { getCoachSurfaceLog } from '../coach/surface.js'
import { resolveProjectDir } from '../lib/paths.js'

type DB = Database.Database

export interface XraySummaryPayload {
  session_id: string
  project_path: string
  project_name: string
  total_tokens: number
  total_events: number
  by_source: Array<{ source: string; count: number; tokens: number }>
  by_tool: Array<{ tool_name: string; count: number; tokens: number }>
  cost_haiku: number
  cost_sonnet: number
  cost_opus: number
  probes: {
    serena: { present: boolean; confidence: number; signals: string[] }
    rtk: { present: boolean; confidence: number; signals: string[] }
    mcp_pruning: { present: boolean; confidence: number; signals: string[] }
    prompt_caching: { present: boolean; confidence: number }
  }
  coach_tips_surfaced: Array<{ rule_id: string; tip_ids: string[]; severity: string }>
  schema_measurement: { tool_schema_tokens: number; mcp_servers: string[] }
  optimizer_version: string
}

export function buildSessionSummary(
  db: DB,
  sessionId: string,
  version: string,
): XraySummaryPayload {
  // Usage stats for last 24h (covers the session)
  const usage = getUsageStats(db, 1)
  const cost = getCostReport(db, 1)

  // Detection probes (reads local files, no network)
  const serena = probeSerena()
  const rtk = probeRtk()
  const mcpPruning = probeMcpPruning()
  const promptCaching = probePromptCaching()

  // Schema measurement (reads settings files, no network)
  const schema = measureCurrentSchemaBytes()

  // Coach tips surfaced during this session
  const coachTips = getCoachSurfaceLog(db, sessionId)

  const projDir = resolveProjectDir()
  const projName = projDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown'

  return {
    session_id: sessionId,
    project_path: projDir,
    project_name: projName,
    total_tokens: usage.total_tokens,
    total_events: usage.total_events,
    by_source: usage.by_source,
    by_tool: usage.by_tool.map((t) => ({
      tool_name: t.tool_name,
      count: t.count,
      tokens: t.tokens,
    })),
    cost_haiku: cost.estimated_cost_usd_haiku,
    cost_sonnet: cost.estimated_cost_usd_sonnet,
    cost_opus: cost.estimated_cost_usd_opus,
    probes: {
      serena: { present: serena.present, confidence: serena.confidence, signals: serena.signals },
      rtk: { present: rtk.present, confidence: rtk.confidence, signals: rtk.signals },
      mcp_pruning: {
        present: mcpPruning.present,
        confidence: mcpPruning.confidence,
        signals: mcpPruning.signals,
      },
      prompt_caching: { present: promptCaching.present, confidence: promptCaching.confidence },
    },
    coach_tips_surfaced: coachTips,
    schema_measurement: {
      tool_schema_tokens: schema.tool_schema_tokens,
      mcp_servers: schema.mcp_servers,
    },
    optimizer_version: version,
  }
}
