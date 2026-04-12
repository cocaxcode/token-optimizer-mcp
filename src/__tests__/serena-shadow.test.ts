import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { shadowMeasureSerena } from '../services/serena-shadow.js'

describe('shadowMeasureSerena', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tompx-shadow-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null when disabled', () => {
    const result = shadowMeasureSerena(
      {
        tool_name: 'mcp__serena__read_file',
        file_path: '/fake',
        tokens_estimated: 100,
      },
      false,
    )
    expect(result).toBeNull()
  })

  it('returns null when summary is missing', () => {
    const result = shadowMeasureSerena(
      {
        tool_name: 'mcp__serena__read_file',
        file_path: undefined,
        tokens_estimated: 100,
      },
      true,
    )
    expect(result).toBeNull()
  })

  it('returns null when file does not exist', () => {
    const result = shadowMeasureSerena(
      {
        tool_name: 'mcp__serena__read_file',
        file_path: path.join(tempDir, 'nonexistent.ts'),
        tokens_estimated: 100,
      },
      true,
    )
    expect(result).toBeNull()
  })

  it('returns delta tokens when file exists and shadow is enabled', () => {
    const filePath = path.join(tempDir, 'sample.ts')
    // 1000 chars of content → ~270 tokens heuristic
    fs.writeFileSync(filePath, 'x'.repeat(1000))
    const result = shadowMeasureSerena(
      {
        tool_name: 'mcp__serena__read_file',
        file_path: filePath,
        tokens_estimated: 50,
      },
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.estimation_method).toBe('estimated_serena_shadow')
    expect(result!.full_file_tokens).toBeGreaterThan(0)
    expect(result!.delta_tokens).toBeGreaterThan(0)
    expect(result!.delta_tokens).toBe(result!.full_file_tokens - 50)
  })

  it('clamps delta to 0 when output tokens exceed full file', () => {
    const filePath = path.join(tempDir, 'small.ts')
    fs.writeFileSync(filePath, 'tiny')
    const result = shadowMeasureSerena(
      {
        tool_name: 'mcp__serena__read_file',
        file_path: filePath,
        tokens_estimated: 10_000,
      },
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.delta_tokens).toBe(0)
  })

  it('works with file_path field', () => {
    const filePath = path.join(tempDir, 'dual.ts')
    fs.writeFileSync(filePath, 'x'.repeat(200))
    const result = shadowMeasureSerena(
      {
        tool_name: 'serena',
        file_path: filePath,
        tokens_estimated: 10,
      },
      true,
    )
    expect(result).not.toBeNull()
    expect(result!.full_file_tokens).toBeGreaterThan(0)
  })
})
