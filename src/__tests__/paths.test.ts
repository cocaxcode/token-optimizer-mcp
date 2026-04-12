import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import {
  normalizePath,
  resolveStorageDir,
  resolveAnalyticsDbPath,
  projectHash,
  resolveTranscriptPath,
} from '../lib/paths.js'

const IS_WINDOWS = process.platform === 'win32'

describe('paths', () => {
  it('normalizePath resolves to absolute', () => {
    const n = normalizePath('foo/bar')
    expect(path.isAbsolute(n)).toBe(true)
  })

  it('normalizePath lowercases on Windows only', () => {
    const n = normalizePath('/Some/Path')
    if (IS_WINDOWS) {
      expect(n).toBe(n.toLowerCase())
    } else {
      expect(n).toBe(path.resolve('/Some/Path'))
    }
  })

  it('resolveStorageDir appends .token-optimizer', () => {
    const d = resolveStorageDir('/tmp/project')
    expect(d.endsWith('.token-optimizer')).toBe(true)
  })

  it('resolveAnalyticsDbPath ends with analytics.db', () => {
    const p = resolveAnalyticsDbPath('/tmp/project')
    expect(p.endsWith('analytics.db')).toBe(true)
  })

  it('projectHash is deterministic and 16 chars', () => {
    const a = projectHash('/tmp/project')
    const b = projectHash('/tmp/project')
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('projectHash differs for different paths', () => {
    const a = projectHash('/tmp/a')
    const b = projectHash('/tmp/b')
    expect(a).not.toBe(b)
  })

  it('resolveTranscriptPath includes session id and project key', () => {
    const p = resolveTranscriptPath('/tmp/project', 'sess-123')
    expect(path.basename(p)).toBe('sess-123.jsonl')
    expect(p).toContain(path.join(os.homedir(), '.claude', 'projects'))
    // project key: the encoded dir segment replaces / \ : with dashes
    const segments = p.split(path.sep)
    const projectKey = segments[segments.length - 2]
    expect(projectKey).not.toMatch(/[\\/:]/)
    expect(projectKey).toContain('tmp')
    expect(projectKey).toContain('project')
  })
})
