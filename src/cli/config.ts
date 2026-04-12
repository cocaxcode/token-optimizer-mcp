// Config CLI + loader — Phase 4.8
// Reads/writes ~/.token-optimizer/config.json. Supports dotted key get/set.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface CoachConfig {
  enabled: boolean
  auto_surface: boolean
  posttooluse_throttle: number
  sessionstart_tips_max: number
  context_thresholds: {
    info: number
    warn: number
    critical: number
  }
  dedupe_window_seconds: number
  stale_tip_days: number
}

export interface Config {
  xray_url: string | null
  shadow_measurement: {
    serena: boolean
  }
  rtk_integration: {
    rtk_db_path: string | null
  }
  coach: CoachConfig
}

export const DEFAULT_CONFIG: Config = {
  xray_url: null,
  shadow_measurement: { serena: false },
  rtk_integration: { rtk_db_path: null },
  coach: {
    enabled: true,
    auto_surface: true,
    posttooluse_throttle: 20,
    sessionstart_tips_max: 3,
    context_thresholds: {
      info: 0.5,
      warn: 0.75,
      critical: 0.9,
    },
    dedupe_window_seconds: 60,
    stale_tip_days: 90,
  },
}

export function getConfigPath(home?: string): string {
  return path.join(home ?? os.homedir(), '.token-optimizer', 'config.json')
}

function deepMerge<T>(target: T, source: unknown): T {
  if (source === null || typeof source !== 'object') return target
  if (typeof target !== 'object' || target === null) return target
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) }
  const src = source as Record<string, unknown>
  for (const key of Object.keys(src)) {
    const s = src[key]
    const t = result[key]
    if (
      s !== null &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      t !== null &&
      typeof t === 'object' &&
      !Array.isArray(t)
    ) {
      result[key] = deepMerge(t, s)
    } else {
      result[key] = s
    }
  }
  return result as T
}

export function loadConfig(home?: string): Config {
  const p = getConfigPath(home)
  try {
    if (!fs.existsSync(p)) return DEFAULT_CONFIG
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return deepMerge(DEFAULT_CONFIG, parsed)
  } catch {
    return DEFAULT_CONFIG
  }
}

export function saveConfig(config: Config, home?: string): void {
  const p = getConfigPath(home)
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(config, null, 2))
}

function dotGet(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function dotSet(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cur[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function coerceValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw)
  return raw
}

export interface ConfigCliOptions {
  home?: string
  print?: (msg: string) => void
}

export function runConfigCommand(args: string[], opts: ConfigCliOptions = {}): number {
  const print = opts.print ?? ((m: string) => console.error(m))
  const sub = args[0]
  if (sub === 'get') {
    const key = args[1]
    const cfg = loadConfig(opts.home)
    if (!key) {
      print(JSON.stringify(cfg, null, 2))
      return 0
    }
    const value = dotGet(cfg, key)
    print(value === undefined ? '(undefined)' : JSON.stringify(value))
    return 0
  }
  if (sub === 'set') {
    const key = args[1]
    const rawValue = args[2]
    if (!key || rawValue === undefined) {
      print('Uso: token-optimizer-mcp config set <key> <value>')
      return 1
    }
    const cfg = loadConfig(opts.home) as unknown as Record<string, unknown>
    dotSet(cfg, key, coerceValue(rawValue))
    saveConfig(cfg as unknown as Config, opts.home)
    print(`Guardado: ${key} = ${rawValue}`)
    return 0
  }
  print('Uso: token-optimizer-mcp config <get|set> [key] [value]')
  return 1
}

/**
 * Resolve xray URL: config.json xray_url > XRAY_URL env var > null
 */
export function resolveXrayUrl(home?: string): string | null {
  const cfg = loadConfig(home)
  return cfg.xray_url ?? process.env.XRAY_URL ?? null
}
