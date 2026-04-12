// Session search MCP tool — Phase 3.3

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import { SessionRetriever } from '../services/session-retriever.js'
import { text, error } from '../lib/response.js'

type DB = Database.Database

export function registerSessionTools(server: McpServer, db: DB): void {
  const retriever = new SessionRetriever(db)

  server.tool(
    'session_search',
    'Busqueda full-text (FTS5 BM25) sobre los eventos guardados en la sesion. Sanitiza operadores especiales automaticamente.',
    {
      query: z.string().min(1).describe('Consulta en lenguaje natural'),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Maximo resultados (default: 10, max: 50)'),
      scope: z
        .enum(['session', 'project'])
        .optional()
        .describe('Scope: session (default, solo sesion actual) o project (todas las sesiones)'),
      session_id: z
        .string()
        .optional()
        .describe('ID de la sesion cuando scope=session (default: "default")'),
    },
    async ({ query, limit, scope, session_id }) => {
      try {
        const effectiveScope = scope ?? 'session'
        const sessionId = session_id ?? 'default'
        const results = retriever.searchFts5(
          query,
          limit ?? 10,
          effectiveScope === 'session' ? { session_id: sessionId } : {},
        )
        if (results.length === 0) {
          return text('Sin resultados.')
        }
        const lines = [`${results.length} resultado(s):`, '']
        for (const r of results) {
          const preview = (r.content ?? '').slice(0, 100).replace(/\s+/g, ' ')
          lines.push(
            `• ${r.created_at} — ${r.tool_name} (${r.source}) score=${r.score.toFixed(2)}`,
          )
          if (preview) lines.push(`  ${preview}`)
        }
        return text(lines.join('\n'))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
