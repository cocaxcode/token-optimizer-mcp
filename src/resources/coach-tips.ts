// token-optimizer://coach/tips resource — Phase 4.H
// Mirrors coach_tips() tool payload, readable without a tool call.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import { computeCoachTipsPayload } from '../coach/tips-payload.js'

type DB = Database.Database

export const COACH_TIPS_URI = 'token-optimizer://coach/tips'

export function registerCoachTipsResource(server: McpServer, db: DB): void {
  server.resource(
    'coach-tips',
    COACH_TIPS_URI,
    {
      description:
        'Tips activos del coach, catalogo completo de trucos, medicion de contexto y tabla de referencia.',
      mimeType: 'application/json',
    },
    async (uri: URL) => {
      try {
        const payload = await computeCoachTipsPayload({ db })
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: message }),
            },
          ],
        }
      }
    },
  )
}
