// Coach MCP tool — Phase 4.46
// coach_tips: returns active hits + full knowledge base + context measurement + reference table

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import { text, error } from '../lib/response.js'
import { KNOWLEDGE_BASE } from '../coach/knowledge-base.js'
import { REFERENCE_DATA, getStaleRows } from '../coach/reference-data.js'
import { runRules } from '../coach/detector.js'
import { measureContextSize } from '../coach/context-meter.js'
import { buildQueries } from '../db/queries.js'
import type { EventContext, ToolEvent } from '../lib/types.js'

type DB = Database.Database

export function registerCoachTools(server: McpServer, db: DB): void {
  server.tool(
    'coach_tips',
    'Devuelve tips activos (rules disparadas), catalogo completo de trucos de Claude Code, medicion de contexto y tabla de referencia.',
    {
      session_id: z.string().optional().describe('ID de la sesion (default: "default")'),
      project_dir: z
        .string()
        .optional()
        .describe('Directorio del proyecto para medir contexto desde transcript JSONL'),
      active_model: z
        .string()
        .optional()
        .describe('Modelo activo (opcional, habilita regla detect-opus-for-simple-task)'),
    },
    async ({ session_id, project_dir, active_model }) => {
      try {
        const sessionId = session_id ?? 'default'
        const contextOpts: {
          db: DB
          projectDir?: string
          activeModel?: string
        } = { db }
        if (project_dir !== undefined) contextOpts.projectDir = project_dir
        if (active_model !== undefined) contextOpts.activeModel = active_model
        const context = await measureContextSize(sessionId, contextOpts)

        const queries = buildQueries(db)
        const since = new Date(Date.now() - 86_400_000).toISOString()
        const rawRows = queries.getToolCallsSince(since) as ToolEvent[]
        const events = rawRows.slice(0, 100)

        const ctx: EventContext = {
          session_id: sessionId,
          events,
          session_token_total: context.tokens,
          session_token_method: context.estimation_method,
          session_token_limit: context.limit,
          active_model: active_model ?? null,
        }
        const hits = runRules(ctx)
        const staleTips = getStaleRows()

        const response = {
          current: hits,
          known_tricks: KNOWLEDGE_BASE,
          context,
          reference_data: REFERENCE_DATA,
          stale_reference_count: staleTips.length,
          last_computed_at: new Date().toISOString(),
        }
        return text(JSON.stringify(response, null, 2))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
