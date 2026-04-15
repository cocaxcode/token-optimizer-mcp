// Coach MCP tool — Phase 4.46
// coach_tips: returns active hits + full knowledge base + context measurement + reference table

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import { text, error } from '../lib/response.js'
import { computeCoachTipsPayload } from '../coach/tips-payload.js'

type DB = Database.Database

export function registerCoachTools(server: McpServer, db: DB): void {
  server.tool(
    'coach_tips',
    'Devuelve tips activos (rules disparadas) y medicion de contexto. Por defecto modo compacto (~500 tokens). Usa verbose=true para incluir el catalogo completo de 18 tips y la tabla de referencia (~3.5k tokens).',
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
      verbose: z
        .boolean()
        .optional()
        .describe(
          'Si true, incluye el knowledge base completo (18 tips) y la reference data. Default false = solo hits activos + contexto. Ahorra ~3.3k tokens por llamada en modo compacto.',
        ),
    },
    async ({ session_id, project_dir, active_model, verbose }) => {
      try {
        const payloadOpts: Parameters<typeof computeCoachTipsPayload>[0] = { db }
        if (session_id !== undefined) payloadOpts.sessionId = session_id
        if (project_dir !== undefined) payloadOpts.projectDir = project_dir
        if (active_model !== undefined) payloadOpts.activeModel = active_model
        const response = await computeCoachTipsPayload(payloadOpts)

        // Default compact mode: strip the heavy knowledge_base + reference_data
        // to avoid burning ~3.3k tokens per call. verbose=true restores them.
        if (verbose !== true) {
          const { known_tricks: _kb, reference_data: _ref, ...compact } = response
          return text(JSON.stringify(compact, null, 2))
        }
        return text(JSON.stringify(response, null, 2))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
