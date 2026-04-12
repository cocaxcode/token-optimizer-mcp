// TOON encoding tools — Phase 5.3
// toon_encode: data -> compact JSON (no whitespace) = token-efficient
// toon_decode: toon string -> JSON object
//
// Note: the original `toon-format` npm package was deferred during Phase 0
// due to package-name uncertainty. This implementation uses compact JSON under
// the hood, which is round-trip lossless and ~30-40% cheaper in tokens than
// pretty-printed JSON. The tool names are preserved so a real TOON impl can
// drop in later without changing the MCP API.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text, error } from '../lib/response.js'

function compactEncode(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/circular|cyclic/i.test(msg)) {
      throw new Error('Referencia circular detectada: TOON no soporta objetos ciclicos')
    }
    throw new Error(`No se pudo codificar a TOON: ${msg}`)
  }
}

function compactDecode(toon: string): unknown {
  try {
    return JSON.parse(toon)
  } catch (e) {
    throw new Error(`TOON invalido: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function registerToonTools(server: McpServer): void {
  // ── toon_encode ──
  server.tool(
    'toon_encode',
    'Codifica un objeto JSON a formato TOON (JSON compacto token-eficiente, round-trip lossless).',
    {
      data: z.unknown().describe('Valor a codificar (objeto, array, primitivo)'),
    },
    async ({ data }) => {
      try {
        const encoded = compactEncode(data)
        return text(encoded)
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )

  // ── toon_decode ──
  server.tool(
    'toon_decode',
    'Decodifica una cadena TOON a JSON. Devuelve el objeto formateado para lectura.',
    {
      toon: z.string().min(1).describe('Cadena TOON a decodificar'),
    },
    async ({ toon }) => {
      try {
        const decoded = compactDecode(toon)
        return text(JSON.stringify(decoded, null, 2))
      } catch (e) {
        return error(e instanceof Error ? e.message : String(e))
      }
    },
  )
}

// Exported for tests
export const _internal = { compactEncode, compactDecode }
