import { describe, it, expect } from 'vitest'
import { KNOWLEDGE_BASE } from '../coach/knowledge-base.js'

describe('coach knowledge base', () => {
  it('contains at least 18 tips', () => {
    expect(KNOWLEDGE_BASE.length).toBeGreaterThanOrEqual(18)
  })

  it('every tip has non-empty required fields', () => {
    for (const tip of KNOWLEDGE_BASE) {
      expect(tip.id).toBeTruthy()
      expect(tip.title).toBeTruthy()
      expect(tip.description).toBeTruthy()
      expect(tip.savings_estimate).toBeTruthy()
      expect(tip.how_to_invoke).toBeTruthy()
      expect(tip.when_applicable).toBeTruthy()
      expect(tip.source_type).toBeTruthy()
      expect(tip.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('no duplicate ids', () => {
    const ids = new Set<string>()
    for (const tip of KNOWLEDGE_BASE) {
      expect(ids.has(tip.id)).toBe(false)
      ids.add(tip.id)
    }
    expect(ids.size).toBe(KNOWLEDGE_BASE.length)
  })

  it('savings_source values are valid', () => {
    const allowed = new Set(['anthropic-docs', 'community-measured', 'internal', 'unknown'])
    for (const tip of KNOWLEDGE_BASE) {
      expect(allowed.has(tip.savings_source)).toBe(true)
    }
  })

  it('source_type values are valid', () => {
    const allowed = new Set(['built-in', 'settings', 'skill', 'mcp', 'workflow'])
    for (const tip of KNOWLEDGE_BASE) {
      expect(allowed.has(tip.source_type)).toBe(true)
    }
  })

  it('includes the key tips identified in the research', () => {
    const ids = new Set(KNOWLEDGE_BASE.map((t) => t.id))
    expect(ids.has('use-opusplan')).toBe(true)
    expect(ids.has('default-to-sonnet')).toBe(true)
    expect(ids.has('use-compact-long-session')).toBe(true)
    expect(ids.has('use-clear-rename-resume')).toBe(true)
    expect(ids.has('install-serena')).toBe(true)
    expect(ids.has('install-rtk')).toBe(true)
    expect(ids.has('migrate-claudemd-to-skills')).toBe(true)
    expect(ids.has('use-prompt-caching')).toBe(true)
  })
})
