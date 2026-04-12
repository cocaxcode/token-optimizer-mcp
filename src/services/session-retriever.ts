// Session retrieval with FTS5 + re-injection payload builder — Phase 3.1, 3.2, 3.6

import type Database from 'better-sqlite3'
import type { BudgetStatus, ReinjectionPayload } from '../lib/types.js'
import { BudgetManager } from './budget-manager.js'
import { estimateTokensFast } from '../lib/token-estimator.js'

type DB = Database.Database

const FILE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookRead',
  'NotebookEdit',
]

export interface SessionSearchResult {
  tool_name: string
  content: string | null
  source: string
  created_at: string
  score: number
}

export interface RecentFileEntry {
  tool_name: string
  path: string
  created_at: string
  tokens_estimated: number
}

export interface RecentBashEntry {
  command: string
  created_at: string
  tokens_estimated: number
}

export interface SearchScope {
  session_id?: string
}

/**
 * Sanitize user query for FTS5 MATCH. Strips any non alphanumeric/underscore
 * and wraps each surviving term as a phrase (quoted). This protects against
 * operators like *, ^, (, ), NEAR, OR, AND, NOT, etc.
 */
export function sanitizeFts5Query(query: string): string {
  if (!query || query.trim().length === 0) return ''
  // Replace any character that is not a Unicode letter, number or underscore
  // with a space, then split on whitespace.
  const cleaned = query.replace(/[^\p{L}\p{N}_]/gu, ' ')
  const terms = cleaned.split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return ''
  return terms.map((t) => `"${t}"`).join(' ')
}

export class SessionRetriever {
  constructor(private db: DB) {}

  searchFts5(query: string, limit = 10, scope: SearchScope = {}): SessionSearchResult[] {
    const sanitized = sanitizeFts5Query(query)
    if (!sanitized) return []
    const clamped = Math.min(Math.max(1, limit), 50)
    try {
      let sql = `
        SELECT tc.tool_name, tc.content, tc.source, tc.created_at, bm25(events_fts) AS score
        FROM tool_calls tc
        JOIN events_fts f ON f.rowid = tc.id
        WHERE events_fts MATCH ?
      `
      const params: unknown[] = [sanitized]
      if (scope.session_id) {
        sql += ` AND tc.session_id = ?`
        params.push(scope.session_id)
      }
      sql += ` ORDER BY bm25(events_fts), tc.created_at DESC LIMIT ?`
      params.push(clamped)
      return this.db.prepare(sql).all(...params) as SessionSearchResult[]
    } catch {
      return []
    }
  }

  getRecentFileReads(sessionId: string, n = 5): RecentFileEntry[] {
    const placeholders = FILE_TOOLS.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT tool_name, tool_input_summary, created_at, tokens_estimated
         FROM tool_calls
         WHERE session_id = ? AND tool_name IN (${placeholders})
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, ...FILE_TOOLS, n) as Array<{
      tool_name: string
      tool_input_summary: string | null
      created_at: string
      tokens_estimated: number
    }>
    return rows.map((r) => ({
      tool_name: r.tool_name,
      path: extractPath(r.tool_input_summary),
      created_at: r.created_at,
      tokens_estimated: r.tokens_estimated,
    }))
  }

  getRecentBashCommands(sessionId: string, n = 5): RecentBashEntry[] {
    const rows = this.db
      .prepare(
        `SELECT tool_input_summary, created_at, tokens_estimated
         FROM tool_calls
         WHERE session_id = ? AND tool_name = 'Bash'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, n) as Array<{
      tool_input_summary: string | null
      created_at: string
      tokens_estimated: number
    }>
    return rows.map((r) => ({
      command: extractCommand(r.tool_input_summary),
      created_at: r.created_at,
      tokens_estimated: r.tokens_estimated,
    }))
  }

  getBudgetSnapshot(sessionId: string, projectHash: string | null): BudgetStatus {
    const manager = new BudgetManager(this.db)
    return manager.checkBudget(sessionId, projectHash)
  }

  /**
   * Build the compact re-injection markdown payload. 4 sections in Phase 3:
   * 1. Archivos recientes
   * 2. Comandos recientes
   * 3. Presupuesto
   * 4. Contexto relevante
   * (Section 5 "Tips del coach" is added in Phase 4.49)
   *
   * Token-capped via estimateTokensFast. Lowest-priority sections are dropped
   * first when cap is exceeded. Always appends a drop notice if anything dropped.
   */
  buildReinjectionPayload(
    sessionId: string,
    projectHash: string | null,
    budgetTokens = 2000,
  ): ReinjectionPayload {
    const fileReads = this.getRecentFileReads(sessionId, 5)
    const bashCmds = this.getRecentBashCommands(sessionId, 5)
    const budget = this.getBudgetSnapshot(sessionId, projectHash)
    const relevant = this.getTopRelevantEvents(sessionId, 5)

    const sections: Array<{ title: string; body: string; priority: number }> = []
    sections.push({
      title: '## Presupuesto',
      body: formatBudgetSection(budget),
      priority: 1, // always keep
    })
    if (fileReads.length > 0) {
      sections.push({
        title: '## Archivos recientes',
        body: fileReads
          .map((e) => `- ${e.created_at} — ${e.tool_name}: ${e.path || '(sin ruta)'}`)
          .join('\n'),
        priority: 2,
      })
    }
    if (bashCmds.length > 0) {
      sections.push({
        title: '## Comandos recientes',
        body: bashCmds
          .map((e) => `- ${e.created_at} — ${truncate(e.command || '(sin comando)', 120)}`)
          .join('\n'),
        priority: 3,
      })
    }
    if (relevant.length > 0) {
      sections.push({
        title: '## Contexto relevante',
        body: relevant
          .map(
            (e) =>
              `- ${e.tool_name} (${e.tokens_estimated} tokens): ${truncate(e.content ?? '', 120)}`,
          )
          .join('\n'),
        priority: 4,
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

  /** Internal: pick top events by tokens (recency-weighted) for "contexto relevante". */
  private getTopRelevantEvents(
    sessionId: string,
    n: number,
  ): Array<{ tool_name: string; content: string | null; tokens_estimated: number }> {
    return this.db
      .prepare(
        `SELECT tool_name, content, tokens_estimated
         FROM tool_calls
         WHERE session_id = ?
         ORDER BY tokens_estimated DESC, created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, n) as Array<{
      tool_name: string
      content: string | null
      tokens_estimated: number
    }>
  }
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

function extractPath(summary: string | null): string {
  if (!summary) return ''
  try {
    const parsed = JSON.parse(summary) as { path?: unknown; file_path?: unknown }
    const value = parsed.path ?? parsed.file_path
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

function extractCommand(summary: string | null): string {
  if (!summary) return ''
  try {
    const parsed = JSON.parse(summary) as { command?: unknown }
    return typeof parsed.command === 'string' ? parsed.command : ''
  } catch {
    return ''
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

export function renderReinjectionMarkdown(payload: ReinjectionPayload): string {
  const body = payload.sections.join('\n\n')
  if (!payload.truncated) return body
  return `${body}\n\n[token-optimizer: ${payload.dropped_count} secciones omitidas por limite]`
}
