// Test helpers — Phase 1.15
// createTestClient with InMemoryTransport (InMemoryTransport.createLinkedPair pattern)
// + seedAnalyticsDb for fixture seeding

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type Database from 'better-sqlite3'
import { createServer } from '../server.js'
import { closeDb, getDb } from '../db/connection.js'
import type { ToolEvent } from '../lib/types.js'

export const PLACEHOLDER = true

export interface TestContext {
  client: Client
  db: Database.Database
  cleanup: () => Promise<void>
}

export async function createTestClient(): Promise<TestContext> {
  // Fresh in-memory DB for each test context
  closeDb()
  const db = getDb(':memory:')
  const server = createServer({ dbPath: ':memory:' })

  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: {} },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])

  return {
    client,
    db,
    async cleanup() {
      await client.close()
      await server.close()
      closeDb()
    },
  }
}

export function seedAnalyticsDb(db: Database.Database, events: ToolEvent[]): void {
  const insertSession = db.prepare(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`)
  const insertEvent = db.prepare(
    `INSERT INTO tool_calls (
      session_id, tool_name, source, input_hash, tool_input_summary, output_bytes,
      tokens_estimated, tokens_actual, duration_ms, content, estimation_method, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const seedMany = db.transaction((batch: ToolEvent[]) => {
    for (const e of batch) {
      insertSession.run(e.session_id)
      insertEvent.run(
        e.session_id,
        e.tool_name,
        e.source,
        e.input_hash,
        e.tool_input_summary,
        e.output_bytes,
        e.tokens_estimated,
        e.tokens_actual,
        e.duration_ms,
        e.content,
        e.estimation_method,
        e.created_at,
      )
    }
  })
  seedMany(events)
}

export function makeEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return {
    session_id: 'test-session',
    tool_name: 'Read',
    source: 'builtin',
    input_hash: 'abc123',
    tool_input_summary: null,
    output_bytes: 100,
    tokens_estimated: 27,
    tokens_actual: null,
    duration_ms: 5,
    content: 'fixture',
    estimation_method: 'measured_exact',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}
