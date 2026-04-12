// Session tools — Phase 3.3 (simplified: session_search removed, FTS5 no longer available)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'

type DB = Database.Database

// No session tools registered after FTS5 removal.
// Keeping the function signature for backwards compatibility with server.ts imports.
export function registerSessionTools(_server: McpServer, _db: DB): void {
  // noop
}
