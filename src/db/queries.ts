// Prepared statement factory — Phase 1.7 + 2.2

import type Database from 'better-sqlite3'
import type { ToolEvent, Budget, BudgetScope, BudgetMode } from '../lib/types.js'

type DB = Database.Database

export interface ToolCountRow {
  tool_name: string
  count: number
  tokens: number
}

export interface SourceCountRow {
  source: string
  count: number
  tokens: number
}

export function buildQueries(db: DB) {
  // ── sessions ──
  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (id, project_hash) VALUES (?, ?)`,
  )

  // ── tool_calls ──
  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (
      session_id, tool_name, source, output_bytes,
      tokens_estimated, tokens_actual, duration_ms, estimation_method,
      shadow_delta_tokens, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const getToolCallsSince = db.prepare(
    `SELECT * FROM tool_calls WHERE created_at >= ? ORDER BY created_at DESC`,
  )

  const countToolCallsByTool = db.prepare(
    `SELECT tool_name, COUNT(*) as count, COALESCE(SUM(tokens_estimated), 0) as tokens
     FROM tool_calls WHERE created_at >= ?
     GROUP BY tool_name ORDER BY tokens DESC`,
  )

  const countToolCallsBySource = db.prepare(
    `SELECT source, COUNT(*) as count, COALESCE(SUM(tokens_estimated), 0) as tokens
     FROM tool_calls WHERE created_at >= ?
     GROUP BY source ORDER BY tokens DESC`,
  )

  const sumTokensBySession = db.prepare(
    `SELECT COALESCE(SUM(tokens_estimated), 0) as total
     FROM tool_calls WHERE session_id = ?`,
  )

  const countToolCallsBySessionStmt = db.prepare(
    `SELECT COUNT(*) as c FROM tool_calls WHERE session_id = ?`,
  )

  const sumTokensBySessionSince = db.prepare(
    `SELECT COALESCE(SUM(tokens_estimated), 0) as total
     FROM tool_calls WHERE session_id = ? AND created_at >= ?`,
  )

  const sumTokensByProjectSince = db.prepare(
    `SELECT COALESCE(SUM(tc.tokens_estimated), 0) as total
     FROM tool_calls tc
     JOIN sessions s ON tc.session_id = s.id
     WHERE s.project_hash = ? AND tc.created_at >= ?`,
  )

  const insertToolCallMany = db.transaction((events: readonly ToolEvent[]) => {
    for (const e of events) {
      insertToolCall.run(
        e.session_id,
        e.tool_name,
        e.source,
        e.output_bytes,
        e.tokens_estimated,
        e.tokens_actual,
        e.duration_ms,
        e.estimation_method,
        e.shadow_delta_tokens ?? null,
        e.created_at,
      )
    }
  })

  // ── serena_symbol_touches ──
  const insertSerenaTouch = db.prepare(
    `INSERT INTO serena_symbol_touches (session_id, tool_name, relative_path, name_path)
     VALUES (?, ?, ?, ?)`,
  )

  const getRecentSerenaSymbols = db.prepare(
    `SELECT tool_name, relative_path, name_path, created_at
     FROM serena_symbol_touches
     WHERE session_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  )

  // ── meta ──
  // ── rtk_rewrites ──
  const insertRtkRewrite = db.prepare(
    `INSERT INTO rtk_rewrites (session_id, command_hash, rewritten_to) VALUES (?, ?, ?)`,
  )
  // Consume (look up AND delete) the most recent matching mark. If the PostToolUse
  // hook finds a mark for this (session, command_hash), the call was rewritten by
  // rtk in PreToolUse and must be reclassified as source=rtk. We bound the lookup
  // to 60 s so stale marks never poison future events.
  const findRtkMark = db.prepare(
    `SELECT id, rewritten_to FROM rtk_rewrites
     WHERE session_id = ? AND command_hash = ?
       AND created_at >= datetime('now', '-60 seconds')
     ORDER BY id DESC LIMIT 1`,
  )
  const deleteRtkMarkById = db.prepare(`DELETE FROM rtk_rewrites WHERE id = ?`)
  const purgeStaleRtkMarks = db.prepare(
    `DELETE FROM rtk_rewrites WHERE created_at < datetime('now', '-60 seconds')`,
  )

  const upsertMetaCounter = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
  )

  const getMeta = db.prepare(`SELECT value FROM meta WHERE key = ?`)

  // ── budgets ──
  const upsertBudget = db.prepare(
    `INSERT INTO budgets (scope, scope_key, limit_tokens, mode)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, scope_key) DO UPDATE SET
       limit_tokens = excluded.limit_tokens,
       mode = excluded.mode`,
  )

  const selectBudgetByScope = db.prepare(
    `SELECT id, scope, scope_key, limit_tokens, spent_tokens, mode, created_at
     FROM budgets WHERE scope = ? AND scope_key = ?`,
  )

  const deleteBudgetByScope = db.prepare(
    `DELETE FROM budgets WHERE scope = ? AND scope_key = ?`,
  )

  const listBudgets = db.prepare(
    `SELECT id, scope, scope_key, limit_tokens, spent_tokens, mode, created_at
     FROM budgets ORDER BY created_at DESC`,
  )

  const insertBudgetEvent = db.prepare(
    `INSERT INTO budget_events (budget_id, event_type, tokens) VALUES (?, ?, ?)`,
  )

  return {
    // sessions
    insertSession(id: string, projectHash: string | null) {
      insertSession.run(id, projectHash)
    },

    // tool_calls
    insertToolCall(event: ToolEvent) {
      insertToolCall.run(
        event.session_id,
        event.tool_name,
        event.source,
        event.output_bytes,
        event.tokens_estimated,
        event.tokens_actual,
        event.duration_ms,
        event.estimation_method,
        event.shadow_delta_tokens ?? null,
        event.created_at,
      )
    },
    insertToolCallMany(events: readonly ToolEvent[]) {
      insertToolCallMany(events)
    },
    getToolCallsSince(timestamp: string) {
      return getToolCallsSince.all(timestamp)
    },
    countToolCallsByTool(since: string): ToolCountRow[] {
      return countToolCallsByTool.all(since) as ToolCountRow[]
    },
    countToolCallsBySource(since: string): SourceCountRow[] {
      return countToolCallsBySource.all(since) as SourceCountRow[]
    },
    sumTokensBySession(sessionId: string): number {
      const row = sumTokensBySession.get(sessionId) as { total: number } | undefined
      return row?.total ?? 0
    },
    countToolCallsBySession(sessionId: string): number {
      const row = countToolCallsBySessionStmt.get(sessionId) as { c: number } | undefined
      return row?.c ?? 0
    },
    sumTokensBySessionSince(sessionId: string, since: string): number {
      const row = sumTokensBySessionSince.get(sessionId, since) as { total: number } | undefined
      return row?.total ?? 0
    },
    sumTokensByProjectSince(projectHash: string, since: string): number {
      const row = sumTokensByProjectSince.get(projectHash, since) as { total: number } | undefined
      return row?.total ?? 0
    },

    // meta
    upsertMetaCounter(key: string) {
      upsertMetaCounter.run(key)
    },
    getMeta(key: string): string | null {
      const row = getMeta.get(key) as { value: string } | undefined
      return row?.value ?? null
    },

    // budgets
    upsertBudget(scope: BudgetScope, scopeKey: string, limitTokens: number, mode: BudgetMode) {
      upsertBudget.run(scope, scopeKey, limitTokens, mode)
    },
    getBudgetByScope(scope: BudgetScope, scopeKey: string): Budget | null {
      const row = selectBudgetByScope.get(scope, scopeKey) as Budget | undefined
      return row ?? null
    },
    deleteBudgetByScope(scope: BudgetScope, scopeKey: string): number {
      const info = deleteBudgetByScope.run(scope, scopeKey)
      return info.changes as number
    },
    listBudgets(): Budget[] {
      return listBudgets.all() as Budget[]
    },
    insertBudgetEvent(budgetId: number, eventType: string, tokens: number | null) {
      insertBudgetEvent.run(budgetId, eventType, tokens)
    },

    // rtk rewrites
    insertRtkRewrite(sessionId: string, commandHash: string, rewrittenTo: string) {
      insertRtkRewrite.run(sessionId, commandHash, rewrittenTo)
    },
    /**
     * Look up and consume an RTK rewrite mark. Returns the rewritten command if
     * there was a mark for this (session, hash) within the last 60 s, or null.
     * The row is deleted on match so it cannot be double-consumed.
     */
    consumeRtkRewrite(sessionId: string, commandHash: string): string | null {
      const row = findRtkMark.get(sessionId, commandHash) as
        | { id: number; rewritten_to: string }
        | undefined
      if (!row) return null
      deleteRtkMarkById.run(row.id)
      return row.rewritten_to
    },
    purgeStaleRtkMarks(): number {
      const info = purgeStaleRtkMarks.run()
      return info.changes as number
    },

    // serena symbol touches
    insertSerenaTouch(
      sessionId: string,
      toolName: string,
      relativePath: string,
      namePath: string | null,
    ) {
      insertSerenaTouch.run(sessionId, toolName, relativePath, namePath)
    },
    getRecentSerenaSymbols(
      sessionId: string,
      limit: number,
    ): { tool_name: string; relative_path: string; name_path: string | null; created_at: string }[] {
      return getRecentSerenaSymbols.all(sessionId, limit) as {
        tool_name: string
        relative_path: string
        name_path: string | null
        created_at: string
      }[]
    },
  }
}

export type Queries = ReturnType<typeof buildQueries>
