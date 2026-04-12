// Rules orchestrator — Phase 4.44
// Runs all detection rules, dedupes by (rule_id, tip_id), sorts by severity desc.

import type { DetectionHit, EventContext } from '../lib/types.js'
import { DETECTION_RULES } from './rules.js'

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warn: 1, info: 2 }

export function runRules(ctx: EventContext): DetectionHit[] {
  const hits: DetectionHit[] = []
  for (const rule of DETECTION_RULES) {
    try {
      const hit = rule.run(ctx)
      if (hit) hits.push(hit)
    } catch {
      // swallow — rules must never crash the caller
    }
  }
  // Dedupe by rule_id
  const seen = new Set<string>()
  const unique: DetectionHit[] = []
  for (const h of hits) {
    if (seen.has(h.rule_id)) continue
    seen.add(h.rule_id)
    unique.push(h)
  }
  unique.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
  return unique
}
