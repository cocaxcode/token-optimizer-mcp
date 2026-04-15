// createServer factory — Phase 1.13
// Returns a configured McpServer. Tools are registered in later phases.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDb } from './db/connection.js'
import { resolveProjectDir, resolveAnalyticsDbPath } from './lib/paths.js'
import { ensureStorageDir } from './lib/storage.js'
import { registerBudgetTools } from './tools/budget.js'
import { registerSessionTools } from './tools/session.js'
import { registerOrchestrationTools } from './tools/orchestration.js'
import { registerCoachTools } from './tools/coach.js'
import { registerToonTools } from './tools/toon.js'
import { registerCoachTipsResource } from './resources/coach-tips.js'

declare const __PKG_VERSION__: string
const VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : '0.1.0'

const INSTRUCTIONS = `token-optimizer-mcp: orchestration + observability + coach layer for Claude Code.

Measures tool usage, enforces token budgets, advises on complementary tools (serena, RTK),
and proactively surfaces savings tips. Coach layer detects inefficiencies and suggests
optimizations like opusplan, /compact, plan mode, and more.

Does NOT replace serena (symbolic file reads) or RTK (Bash output filtering) —
coordinates with them and adds measurements, budgets, compact recovery, and coaching.`

export interface CreateServerOptions {
  storageDir?: string
  projectDir?: string
  dbPath?: string
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const resolvedProject = options.projectDir ?? resolveProjectDir()
  const dbPath =
    options.dbPath ??
    (options.storageDir === ':memory:'
      ? ':memory:'
      : (ensureStorageDir(resolvedProject), resolveAnalyticsDbPath(resolvedProject)))

  // Initialize DB (schema created by getDb)
  const db = getDb(dbPath)

  const server = new McpServer(
    {
      name: 'token-optimizer-mcp',
      version: VERSION,
    },
    {
      instructions: INSTRUCTIONS,
    },
  )

  // Phase 2 tools
  registerBudgetTools(server, db)
  // Phase 3 tools
  registerSessionTools(server, db)
  // Phase 4 tools
  registerOrchestrationTools(server, db)
  registerCoachTools(server, db)
  registerCoachTipsResource(server, db)
  // Phase 5 tools
  registerToonTools(server)

  return server
}
