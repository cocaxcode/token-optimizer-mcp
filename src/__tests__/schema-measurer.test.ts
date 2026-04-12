import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { measureCurrentSchemaBytes } from '../orchestration/schema-measurer.js'

async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'tompx-schema-'))
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data))
}

describe('measureCurrentSchemaBytes', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await makeTempRoot()
    cwd = await makeTempRoot()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('returns unknown when no settings', () => {
    const result = measureCurrentSchemaBytes({ home, cwd })
    expect(result.measurement_method).toBe('unknown')
    expect(result.mcp_servers).toEqual([])
    expect(result.tool_schema_tokens).toBe(0)
  })

  it('counts 6 MCPs from settings and applies heuristic', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: {
        a: {},
        b: {},
        c: {},
        d: {},
        e: {},
        f: {},
      },
    })
    const result = measureCurrentSchemaBytes({ home, cwd })
    expect(result.mcp_servers.length).toBe(6)
    // Heuristic: 6 servers × 10 tools × 400 tokens/tool = 24000
    expect(result.tool_schema_tokens).toBe(24_000)
    // 6 × N × 400 minimum = 6 × 400 = 2400 (very conservative lower bound)
    expect(result.tool_schema_tokens).toBeGreaterThanOrEqual(6 * 400)
    expect(result.measurement_method).toBe('heuristic')
  })

  it('deduplicates MCPs appearing in multiple settings files', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { shared: {}, only_global: {} },
    })
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      mcpServers: { shared: {}, only_team: {} },
    })
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
      mcpServers: { shared: {}, only_local: {} },
    })
    const result = measureCurrentSchemaBytes({ home, cwd })
    expect(result.mcp_servers.sort()).toEqual(['only_global', 'only_local', 'only_team', 'shared'])
  })

  it('bytes column is tokens × 4', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { one: {}, two: {} },
    })
    const result = measureCurrentSchemaBytes({ home, cwd })
    expect(result.tool_schema_bytes).toBe(result.tool_schema_tokens * 4)
  })
})
