// Shared type definitions — Phase 1.1
// Core interfaces used across services, tools, hooks and coach layer

export type EventSource = 'own' | 'builtin' | 'mcp' | 'serena' | 'rtk' | 'xray'

export type EstimationMethod =
  | 'measured_exact'
  | 'measured_delta'
  | 'measured_rtk_rewrite'
  | 'estimated_rtk_db'
  | 'estimated_rtk_marker'
  | 'estimated_rtk_fallback'
  | 'estimated_serena_shadow'
  | 'estimated_serena_metadata'
  | 'estimated_serena_fallback'
  | 'estimated_cumulative'
  | 'reference_measured'
  | 'unknown'

export interface Session {
  id: string
  project_hash: string | null
  started_at: string
}

export interface ToolEvent {
  session_id: string
  tool_name: string
  source: EventSource
  output_bytes: number
  tokens_estimated: number
  tokens_actual: number | null
  duration_ms: number | null
  estimation_method: EstimationMethod
  created_at: string
  /** Tokens saved vs reading the full file — populated by shadow measurement (Serena tools only) */
  shadow_delta_tokens?: number | null
  /** Short preview of the command/path (≤100 chars) for xray live feed */
  command_preview?: string | null
}

export type BudgetScope = 'session' | 'project'
export type BudgetMode = 'warn'

export interface Budget {
  id: number
  scope: BudgetScope
  scope_key: string
  limit_tokens: number
  spent_tokens: number
  mode: BudgetMode
  created_at: string
}

export interface BudgetStatus {
  active: boolean
  spent: number
  remaining: number
  percent_used: number
  mode: BudgetMode | null
}

export interface DetectionResult {
  present: boolean
  confidence: number
  signals: string[]
  details: Record<string, unknown>
}

export interface SerenaHealthWarning {
  id: string
  message: string
  fix: string
}

export interface OptimizationStatus {
  serena: DetectionResult
  rtk: DetectionResult
  mcp_pruning: DetectionResult
  prompt_caching: {
    active_by_default: true
    savings_tokens: number | null
    estimation_method: EstimationMethod
    note: string
  }
  schema_bytes: { tool_schema_bytes: number; measurement_method: string }
}

export interface ReinjectionPayload {
  sections: string[]
  tokens_estimated: number
  truncated: boolean
  dropped_count: number
}

// Coach layer types (filled in Phase 4.40+)

export interface CoachTip {
  id: string
  title: string
  description: string
  savings_estimate: string
  savings_source: 'anthropic-docs' | 'community-measured' | 'internal' | 'unknown'
  how_to_invoke: string
  when_applicable: string
  source_type: 'built-in' | 'settings' | 'skill' | 'mcp' | 'workflow'
  verified_at: string
  detector_id: string | null
}

export interface EventContext {
  session_id: string
  events: ToolEvent[]
  session_token_total: number | null
  session_token_method: EstimationMethod
  session_token_limit: number
  active_model: string | null
}

export type DetectionSeverity = 'info' | 'warn' | 'critical'

export interface DetectionHit {
  rule_id: string
  tip_ids: string[]
  severity: DetectionSeverity
  evidence: string
  estimation_method: EstimationMethod
}

export interface DetectionRule {
  id: string
  tip_ids: string[]
  run(ctx: EventContext): DetectionHit | null
}

export interface ContextMeasurement {
  tokens: number
  limit: number
  percent: number
  estimation_method: EstimationMethod
}
