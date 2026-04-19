// Session retrieval + re-injection payload builder — Phase 3.1, 3.2 (simplified: no FTS5)
// Reinjection focuses on actionable signal: budget status + conditional reminders
// based on recent tool activity and detected external tools (serena, RTK).

import type Database from 'better-sqlite3'
import type { BudgetStatus, ReinjectionPayload } from '../lib/types.js'
import { BudgetManager } from './budget-manager.js'
import { estimateTokensFast } from '../lib/token-estimator.js'
import { probeSerena, probeRtk } from '../orchestration/detector.js'

type DB = Database.Database

const FILE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookRead',
  'NotebookEdit',
]

export interface RecentToolEntry {
  tool_name: string
  created_at: string
  tokens_estimated: number
}

export interface ReinjectionContext {
  serenaAvailable?: boolean
  rtkAvailable?: boolean
}

export class SessionRetriever {
  constructor(private db: DB) {}

  getRecentFileReads(sessionId: string, n = 5): RecentToolEntry[] {
    const placeholders = FILE_TOOLS.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT tool_name, created_at, tokens_estimated
         FROM tool_calls
         WHERE session_id = ? AND tool_name IN (${placeholders})
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, ...FILE_TOOLS, n) as RecentToolEntry[]
  }

  getRecentBashCommands(sessionId: string, n = 5): RecentToolEntry[] {
    return this.db
      .prepare(
        `SELECT tool_name, created_at, tokens_estimated
         FROM tool_calls
         WHERE session_id = ? AND tool_name = 'Bash'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, n) as RecentToolEntry[]
  }

  getBudgetSnapshot(sessionId: string, projectHash: string | null): BudgetStatus {
    const manager = new BudgetManager(this.db)
    return manager.checkBudget(sessionId, projectHash)
  }

  /**
   * Build the compact re-injection markdown payload. 2 possible sections:
   * 1. Presupuesto (always, when budget data available)
   * 2. Recordatorios (conditional: serena/RTK hints when relevant activity)
   *
   * Previous file-read and bash-count metadata sections were removed — they
   * reinjected filler tokens without actionable value. The agent cannot act
   * on "you read 5 files an hour ago". Hints that tell it WHICH tool to use
   * next (serena symbolic reads, RTK-filtered bash) are useful.
   *
   * Token-capped via estimateTokensFast. Lowest-priority sections dropped
   * first when cap is exceeded.
   */
  buildReinjectionPayload(
    sessionId: string,
    projectHash: string | null,
    budgetTokens = 2000,
    ctx: ReinjectionContext = {},
  ): ReinjectionPayload {
    const fileReads = this.getRecentFileReads(sessionId, 5)
    const bashCmds = this.getRecentBashCommands(sessionId, 5)
    const budget = this.getBudgetSnapshot(sessionId, projectHash)

    const serenaAvailable =
      ctx.serenaAvailable ?? probeSerena().present
    const rtkAvailable = ctx.rtkAvailable ?? probeRtk().present

    const sections: Array<{ title: string; body: string; priority: number }> = []
    sections.push({
      title: '## Presupuesto',
      body: formatBudgetSection(budget),
      priority: 1, // always keep
    })

    const reminders = buildReminders({
      fileReadCount: fileReads.length,
      bashCount: bashCmds.length,
      serenaAvailable,
      rtkAvailable,
    })
    if (reminders.length > 0) {
      sections.push({
        title: '## Recordatorios',
        body: reminders.map((r) => `- ${r}`).join('\n'),
        priority: 2,
      })
    }

    // Sort by priority ascending; drop highest-priority-number first when over cap
    sections.sort((a, b) => a.priority - b.priority)
    const kept: typeof sections = [...sections]
    let droppedCount = 0

    const assemble = (list: typeof sections): string =>
      list.map((s) => `${s.title}\n${s.body}`).join('\n\n')

    while (kept.length > 0) {
      const candidate = assemble(kept)
      if (estimateTokensFast(candidate) <= budgetTokens) break
      kept.pop()
      droppedCount++
    }

    let output = assemble(kept)
    const truncated = droppedCount > 0
    if (truncated) {
      output += `\n\n[token-optimizer: ${droppedCount} secciones omitidas por limite]`
    }

    const sectionsArr = kept.map((s) => `${s.title}\n${s.body}`)
    return {
      sections: sectionsArr,
      tokens_estimated: estimateTokensFast(output),
      truncated,
      dropped_count: droppedCount,
    }
  }
}

interface BuildRemindersOpts {
  fileReadCount: number
  bashCount: number
  serenaAvailable: boolean
  rtkAvailable: boolean
}

function buildReminders(opts: BuildRemindersOpts): string[] {
  const out: string[] = []
  if (opts.serenaAvailable && opts.fileReadCount >= 3) {
    out.push(
      'Venías leyendo varios archivos. Usa Serena (`find_symbol`, `get_symbols_overview`) para lecturas simbólicas en vez de `Read` completo.',
    )
  }
  if (opts.rtkAvailable && opts.bashCount >= 3) {
    out.push(
      'RTK está activo: los comandos Bash se filtran automáticamente, no trunques output manualmente.',
    )
  }
  return out
}

function formatBudgetSection(status: BudgetStatus): string {
  if (!status.active) {
    return '- sin presupuesto activo'
  }
  const percent = (status.percent_used * 100).toFixed(1)
  return [
    `- gastado: ${status.spent} tokens`,
    `- restante: ${status.remaining} tokens`,
    `- uso: ${percent}%`,
    `- modo: ${status.mode ?? 'n/a'}`,
  ].join('\n')
}

export function renderReinjectionMarkdown(payload: ReinjectionPayload): string {
  const body = payload.sections.join('\n\n')
  if (!payload.truncated) return body
  return `${body}\n\n[token-optimizer: ${payload.dropped_count} secciones omitidas por limite]`
}
