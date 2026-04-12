// Tool-schema size measurement — Phase 4.2
// Heuristic: count registered MCP servers from settings files and estimate tool-schema cost.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TOKENS_PER_TOOL = 400
const ESTIMATED_TOOLS_PER_SERVER = 10
const BYTES_PER_TOKEN = 4

export interface SchemaMeasurement {
  tool_schema_bytes: number
  tool_schema_tokens: number
  tool_count_estimated: number
  mcp_servers: string[]
  measurement_method: 'accurate' | 'heuristic' | 'unknown'
}

export interface SchemaMeasurerOptions {
  home?: string
  cwd?: string
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function collectServerNames(jsonFiles: Array<Record<string, unknown> | null>): string[] {
  const set = new Set<string>()
  for (const json of jsonFiles) {
    if (!json) continue
    const mcp = json.mcpServers
    if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
      for (const k of Object.keys(mcp as Record<string, unknown>)) {
        set.add(k)
      }
    }
  }
  return Array.from(set)
}

export function measureCurrentSchemaBytes(
  opts: SchemaMeasurerOptions = {},
): SchemaMeasurement {
  const home = opts.home ?? os.homedir()
  const cwd = opts.cwd ?? process.cwd()
  const sources = [
    readJson(path.join(home, '.claude', 'settings.json')),
    readJson(path.join(cwd, '.claude', 'settings.json')),
    readJson(path.join(cwd, '.claude', 'settings.local.json')),
  ]
  const servers = collectServerNames(sources)
  const toolCount = servers.length * ESTIMATED_TOOLS_PER_SERVER
  const tokens = toolCount * TOKENS_PER_TOOL
  return {
    tool_schema_bytes: tokens * BYTES_PER_TOKEN,
    tool_schema_tokens: tokens,
    tool_count_estimated: toolCount,
    mcp_servers: servers,
    measurement_method: servers.length > 0 ? 'heuristic' : 'unknown',
  }
}
