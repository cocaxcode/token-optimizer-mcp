// Detection rules registry (11 rules) — Phase 4.43
// Each rule is a pure function over EventContext returning DetectionHit | null.
// Rules MUST NOT throw; the orchestrator catches everything.

import type { DetectionRule, DetectionSeverity, ToolEvent } from '../lib/types.js'

function countMatching(events: readonly ToolEvent[], predicate: (e: ToolEvent) => boolean): number {
  let c = 0
  for (const e of events) if (predicate(e)) c++
  return c
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export const DETECTION_RULES: readonly DetectionRule[] = [
  // 1. detect-context-threshold
  {
    id: 'detect-context-threshold',
    tip_ids: ['use-compact-long-session'],
    run(ctx) {
      if (ctx.session_token_total === null || ctx.session_token_limit <= 0) return null
      const percent = ctx.session_token_total / ctx.session_token_limit
      if (percent < 0.5) return null
      let severity: DetectionSeverity = 'info'
      if (percent >= 0.9) severity = 'critical'
      else if (percent >= 0.75) severity = 'warn'
      return {
        rule_id: 'detect-context-threshold',
        tip_ids: ['use-compact-long-session'],
        severity,
        evidence: `Contexto: ${(percent * 100).toFixed(1)}% usado (${ctx.session_token_total}/${ctx.session_token_limit} tokens)`,
        estimation_method: ctx.session_token_method,
      }
    },
  },

  // 2. detect-long-reasoning-no-code
  {
    id: 'detect-long-reasoning-no-code',
    tip_ids: ['use-plan-mode', 'use-opusplan'],
    run(ctx) {
      const recent = ctx.events.slice(0, 10)
      if (recent.length < 10) return null
      const edits = countMatching(recent, (e) => EDIT_TOOLS.has(e.tool_name))
      if (edits > 0) return null
      return {
        rule_id: 'detect-long-reasoning-no-code',
        tip_ids: ['use-plan-mode', 'use-opusplan'],
        severity: 'info',
        evidence: '10 eventos recientes sin ediciones de codigo',
        estimation_method: 'measured_exact',
      }
    },
  },

  // 3. detect-repeated-searches
  {
    id: 'detect-repeated-searches',
    tip_ids: ['use-agent-explore'],
    run(ctx) {
      const window = ctx.events.slice(0, 20)
      const searches = countMatching(window, (e) => e.tool_name === 'Grep' || e.tool_name === 'Glob')
      if (searches < 3) return null
      return {
        rule_id: 'detect-repeated-searches',
        tip_ids: ['use-agent-explore'],
        severity: 'info',
        evidence: `${searches} busquedas Grep/Glob en los ultimos 20 eventos`,
        estimation_method: 'measured_exact',
      }
    },
  },

  // 4. detect-huge-file-reads
  {
    id: 'detect-huge-file-reads',
    tip_ids: ['install-serena'],
    run(ctx) {
      const huge = ctx.events.find((e) => e.tool_name === 'Read' && e.tokens_estimated > 50_000)
      if (!huge) return null
      return {
        rule_id: 'detect-huge-file-reads',
        tip_ids: ['install-serena'],
        severity: 'warn',
        evidence: `Read consumio ${huge.tokens_estimated} tokens (umbral 50k)`,
        estimation_method: 'measured_exact',
      }
    },
  },

  // 5. detect-many-bash-commands
  {
    id: 'detect-many-bash-commands',
    tip_ids: ['install-rtk'],
    run(ctx) {
      const window = ctx.events.slice(0, 100)
      const bash = countMatching(window, (e) => e.tool_name === 'Bash')
      if (bash <= 10) return null
      return {
        rule_id: 'detect-many-bash-commands',
        tip_ids: ['install-rtk'],
        severity: 'info',
        evidence: `${bash} comandos Bash en los ultimos ${window.length} eventos`,
        estimation_method: 'measured_exact',
      }
    },
  },

  // 6. detect-clear-opportunity (was #7 — detect-unused-mcp-servers stub removed)
  {
    id: 'detect-clear-opportunity',
    tip_ids: ['use-clear-rename-resume'],
    run(ctx) {
      if (ctx.events.length < 40) return null
      const recentTools = new Set(ctx.events.slice(0, 20).map((e) => e.tool_name))
      const priorTools = new Set(ctx.events.slice(20, 40).map((e) => e.tool_name))
      if (recentTools.size === 0) return null
      let overlap = 0
      for (const t of recentTools) if (priorTools.has(t)) overlap++
      const ratio = overlap / recentTools.size
      if (ratio >= 0.3) return null
      return {
        rule_id: 'detect-clear-opportunity',
        tip_ids: ['use-clear-rename-resume'],
        severity: 'info',
        evidence: `Solapamiento de herramientas ${(ratio * 100).toFixed(0)}% — posible pivote de tema`,
        estimation_method: 'measured_exact',
      }
    },
  },

  // 8. detect-opus-for-simple-task
  {
    id: 'detect-opus-for-simple-task',
    tip_ids: ['default-to-sonnet', 'use-haiku-for-simple'],
    run(ctx) {
      if (!ctx.active_model || !/opus/i.test(ctx.active_model)) return null
      const recent = ctx.events.slice(0, 20)
      if (recent.length < 6) return null
      const edits = countMatching(recent, (e) => EDIT_TOOLS.has(e.tool_name))
      const bash = countMatching(recent, (e) => e.tool_name === 'Bash')
      // Opus es correcto para planificar/preguntar — solo avisar cuando está ejecutando código
      if (edits + bash < 6) return null
      return {
        rule_id: 'detect-opus-for-simple-task',
        tip_ids: ['default-to-sonnet', 'use-haiku-for-simple'],
        severity: 'info',
        evidence: `Opus ejecutando trabajo mecanico: ${edits} edits + ${bash} Bash en ultimos 20 eventos. Sonnet haria lo mismo un 80% mas barato.`,
        estimation_method: 'measured_exact',
      }
    },
  },

  // 9. detect-claudemd-bloat (stub — requires filesystem stat at runtime)
  {
    id: 'detect-claudemd-bloat',
    tip_ids: ['migrate-claudemd-to-skills'],
    run() {
      return null
    },
  },

  // 10. detect-post-milestone-opportunity
  {
    id: 'detect-post-milestone-opportunity',
    tip_ids: ['use-compact-long-session'],
    run(ctx) {
      const recent = ctx.events.slice(0, 20)
      const edits = countMatching(recent, (e) => e.tool_name === 'Edit' || e.tool_name === 'Write')
      const hasBash = countMatching(recent, (e) => e.tool_name === 'Bash') > 0
      if (edits < 5 || !hasBash) return null
      if (ctx.session_token_total === null) return null
      const percent = ctx.session_token_total / ctx.session_token_limit
      if (percent < 0.4) return null
      return {
        rule_id: 'detect-post-milestone-opportunity',
        tip_ids: ['use-compact-long-session'],
        severity: 'info',
        evidence: `${edits} ediciones + Bash reciente + contexto ${(percent * 100).toFixed(0)}%`,
        estimation_method: ctx.session_token_method,
      }
    },
  },

  // 11. detect-skill-trigger-ignored (stub — requires skill registry)
  {
    id: 'detect-skill-trigger-ignored',
    tip_ids: ['use-skill-trigger'],
    run() {
      return null
    },
  },

  // 12. detect-read-over-serena
  {
    id: 'detect-read-over-serena',
    tip_ids: ['prefer-serena-reads'],
    run(ctx) {
      const window = ctx.events.slice(0, 30)
      const largeReads = window.filter(
        (e) => e.tool_name === 'Read' && e.tokens_estimated > 2_000,
      )
      if (largeReads.length < 3) return null
      const totalTokens = largeReads.reduce((sum, e) => sum + e.tokens_estimated, 0)
      const estimatedSaving = Math.round(totalTokens * 0.7)
      const severity: DetectionSeverity = largeReads.length >= 6 ? 'warn' : 'info'
      return {
        rule_id: 'detect-read-over-serena',
        tip_ids: ['prefer-serena-reads'],
        severity,
        evidence: `${largeReads.length} lecturas Read >2k tokens (total: ${totalTokens}). Serena ahorraria ~${estimatedSaving} tokens (~70%).`,
        estimation_method: ctx.session_token_method,
      }
    },
  },
]
