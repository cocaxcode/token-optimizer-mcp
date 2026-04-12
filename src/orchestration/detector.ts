// Detection probes — Phase 4.1
// Multi-signal checks for serena, RTK, MCP pruning and prompt caching.
// Each probe returns DetectionResult { present, confidence, signals, details }

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DetectionResult } from '../lib/types.js'

function readSettings(p: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface DetectorPaths {
  home?: string
  cwd?: string
}

function globalSettings(home: string): string {
  return path.join(home, '.claude', 'settings.json')
}

function globalClaudeJson(home: string): string {
  return path.join(home, '.claude.json')
}

function localSettings(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.local.json')
}

function teamSettings(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.json')
}

function mcpServerKeys(json: Record<string, unknown> | null): string[] {
  if (!json) return []
  const mcp = json.mcpServers
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    return Object.keys(mcp as Record<string, unknown>)
  }
  return []
}

function runProbe(
  name: string,
  checks: Array<() => [boolean, string]>,
): DetectionResult {
  const signals: string[] = []
  let hits = 0
  for (const check of checks) {
    try {
      const [hit, label] = check()
      if (hit) {
        hits++
        signals.push(label)
      }
    } catch {
      // swallow
    }
  }
  const confidence = checks.length > 0 ? hits / checks.length : 0
  return {
    present: hits > 0,
    confidence,
    signals,
    details: { probe: name, signal_count: hits, total_checks: checks.length },
  }
}

export function probeSerena(paths: DetectorPaths = {}): DetectionResult {
  const home = paths.home ?? os.homedir()
  const cwd = paths.cwd ?? process.cwd()
  return runProbe('serena', [
    () => {
      const keys = mcpServerKeys(readSettings(globalSettings(home)))
      return [keys.some((k) => k.toLowerCase().includes('serena')), 'global-settings-registered']
    },
    () => {
      // ~/.claude.json — Claude Code also reads MCP servers from here
      const keys = mcpServerKeys(readSettings(globalClaudeJson(home)))
      return [keys.some((k) => k.toLowerCase().includes('serena')), 'claude-json-registered']
    },
    () => {
      const keys = mcpServerKeys(readSettings(teamSettings(cwd)))
      return [keys.some((k) => k.toLowerCase().includes('serena')), 'project-mcp-registered']
    },
    () => {
      const keys = mcpServerKeys(readSettings(localSettings(cwd)))
      return [keys.some((k) => k.toLowerCase().includes('serena')), 'local-mcp-registered']
    },
  ])
}

export function probeRtk(paths: DetectorPaths = {}): DetectionResult {
  const home = paths.home ?? os.homedir()
  const isWindows = process.platform === 'win32'
  return runProbe('rtk', [
    () => {
      const rtkDb = path.join(home, '.rtk', 'tracking.db')
      return [fs.existsSync(rtkDb), 'rtk-db-present']
    },
    () => {
      const bin = isWindows
        ? path.join(home, '.cargo', 'bin', 'rtk.exe')
        : path.join(home, '.cargo', 'bin', 'rtk')
      return [fs.existsSync(bin), 'rtk-binary-in-cargo']
    },
    () => {
      // Check common PATH locations directly (avoid dynamic import in sync probe)
      const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
      const binName = process.platform === 'win32' ? 'rtk.exe' : 'rtk'
      const found = pathDirs.some((dir) => {
        try {
          return fs.existsSync(path.join(dir, binName))
        } catch {
          return false
        }
      })
      return [found, 'rtk-binary-in-path']
    },
    () => {
      const json = readSettings(globalSettings(home))
      const hooks = json?.hooks
      if (!hooks || typeof hooks !== 'object') return [false, 'rtk-hook-registered']
      const serialized = JSON.stringify(hooks)
      return [serialized.toLowerCase().includes('rtk'), 'rtk-hook-registered']
    },
  ])
}

export function probeMcpPruning(paths: DetectorPaths = {}): DetectionResult {
  const cwd = paths.cwd ?? process.cwd()
  return runProbe('mcp_pruning', [
    () => {
      const json = readSettings(localSettings(cwd))
      const allowlist = json?.enabledMcpjsonServers
      return [Array.isArray(allowlist) && allowlist.length > 0, 'allowlist-in-settings-local']
    },
    () => {
      const json = readSettings(teamSettings(cwd))
      const allowlist = json?.enabledMcpjsonServers
      return [Array.isArray(allowlist) && allowlist.length > 0, 'allowlist-in-settings']
    },
  ])
}

export function probePromptCaching(): DetectionResult {
  // Claude Code has prompt caching enabled by default; no reliable local probe.
  return {
    present: true,
    confidence: 0.5,
    signals: ['claude-code-default-enabled'],
    details: {
      probe: 'prompt_caching',
      note: 'Revisa tu factura Anthropic para confirmar el ahorro real',
    },
  }
}
