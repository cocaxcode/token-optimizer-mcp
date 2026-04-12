import { describe, it, expect } from 'vitest'
import { PLACEHOLDER } from './helpers.js'

describe('sanity', () => {
  it('test harness works', () => {
    expect(true).toBe(true)
  })

  it('helpers module imports', () => {
    expect(PLACEHOLDER).toBe(true)
  })
})
