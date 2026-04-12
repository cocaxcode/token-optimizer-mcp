import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  getConfigPath,
  runConfigCommand,
} from '../cli/config.js'

describe('config CLI', () => {
  let home: string
  const captured: string[] = []
  const print = (m: string) => captured.push(m)

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'tompx-config-'))
    captured.length = 0
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('loadConfig returns defaults when file missing', () => {
    const cfg = loadConfig(home)
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  it('saveConfig + loadConfig round-trips', () => {
    const cfg = { ...DEFAULT_CONFIG }
    cfg.coach = { ...cfg.coach, enabled: false }
    saveConfig(cfg, home)
    expect(fs.existsSync(getConfigPath(home))).toBe(true)
    const loaded = loadConfig(home)
    expect(loaded.coach.enabled).toBe(false)
  })

  it('defaults are merged for partial config files', () => {
    const configPath = getConfigPath(home)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ coach: { enabled: false } }))
    const loaded = loadConfig(home)
    expect(loaded.coach.enabled).toBe(false)
    // Other defaults preserved
    expect(loaded.coach.posttooluse_throttle).toBe(20)
    expect(loaded.shadow_measurement.serena).toBe(false)
  })

  it('config set creates file with dotted key', () => {
    const code = runConfigCommand(['set', 'coach.enabled', 'false'], { home, print })
    expect(code).toBe(0)
    const loaded = loadConfig(home)
    expect(loaded.coach.enabled).toBe(false)
  })

  it('config set coerces numbers and booleans', () => {
    runConfigCommand(['set', 'coach.posttooluse_throttle', '50'], { home, print })
    runConfigCommand(['set', 'shadow_measurement.serena', 'true'], { home, print })
    const loaded = loadConfig(home)
    expect(loaded.coach.posttooluse_throttle).toBe(50)
    expect(loaded.shadow_measurement.serena).toBe(true)
  })

  it('config get returns the value', () => {
    runConfigCommand(['set', 'coach.posttooluse_throttle', '33'], { home, print })
    captured.length = 0
    runConfigCommand(['get', 'coach.posttooluse_throttle'], { home, print })
    expect(captured.join('')).toBe('33')
  })

  it('config get without key prints full config', () => {
    runConfigCommand(['get'], { home, print })
    const out = captured.join('\n')
    expect(out).toContain('"coach"')
    expect(out).toContain('"shadow_measurement"')
  })

  it('rejects set without value', () => {
    const code = runConfigCommand(['set', 'coach.enabled'], { home, print })
    expect(code).toBe(1)
  })
})
