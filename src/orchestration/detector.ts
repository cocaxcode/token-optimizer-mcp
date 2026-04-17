// Detection probes — Phase 4.1
// Multi-signal checks for serena, RTK, MCP pruning and prompt caching.
// Each probe returns DetectionResult { present, confidence, signals, details }

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { DetectionResult, SerenaHealthWarning } from '../lib/types.js'

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
    () => {
      // Check if current CWD is registered as a serena project
      const configPath = path.join(home, '.serena', 'serena_config.yml')
      if (!fs.existsSync(configPath)) return [false, 'project-registered-for-cwd']
      try {
        const content = fs.readFileSync(configPath, 'utf8')
        const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
        // Simple check: does the config mention a path matching our CWD?
        const normalizedContent = content.replace(/\\/g, '/').toLowerCase()
        return [normalizedContent.includes(normalizedCwd), 'project-registered-for-cwd']
      } catch {
        return [false, 'project-registered-for-cwd']
      }
    },
  ])
}

/**
 * Health checks for Serena configuration.
 * Separate from probeSerena() (presence detection) to avoid polluting confidence scores.
 * Returns actionable warnings when Serena is misconfigured for Claude Code usage.
 */
export function checkSerenaHealth(paths: DetectorPaths = {}): SerenaHealthWarning[] {
  const home = paths.home ?? os.homedir()
  const cwd = paths.cwd ?? process.cwd()
  const warnings: SerenaHealthWarning[] = []

  // Check 1: web_dashboard_open_on_launch should be false
  try {
    const configPath = path.join(home, '.serena', 'serena_config.yml')
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8')
      const match = content.match(/web_dashboard_open_on_launch\s*:\s*(\w+)/)
      const value = match ? match[1].toLowerCase() : 'true' // default is true
      if (value === 'true') {
        warnings.push({
          id: 'dashboard-auto-open',
          message: 'El dashboard de Serena se abre automaticamente al iniciar cada terminal',
          fix: 'Pon web_dashboard_open_on_launch: false en ~/.serena/serena_config.yml',
        })
      }
    }
  } catch {
    // swallow
  }

  // Check 2: --context claude-code should be in MCP server args
  try {
    const hasContextFlag = checkSerenaContextFlag(home, cwd)
    if (!hasContextFlag) {
      warnings.push({
        id: 'missing-context-claude-code',
        message: 'Serena no usa el contexto claude-code (modo headless optimizado para CLI)',
        fix: 'Añade --context claude-code a los args del MCP server de serena',
      })
    }
  } catch {
    // swallow
  }

  return warnings
}

function checkSerenaContextFlag(home: string, cwd: string): boolean {
  // Search across all possible MCP config locations
  const settingsFiles = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]

  for (const file of settingsFiles) {
    if (hasContextClaudeCodeInFile(file)) return true
  }

  // Also check plugin .mcp.json files
  try {
    const pluginsDir = path.join(home, '.claude', 'plugins')
    if (fs.existsSync(pluginsDir)) {
      const mcpFiles = findMcpJsonFiles(pluginsDir)
      for (const file of mcpFiles) {
        if (hasContextClaudeCodeInFile(file)) return true
      }
    }
  } catch {
    // swallow
  }

  return false
}

function hasContextClaudeCodeInFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    // Check mcpServers keys for serena entries
    const servers = json.mcpServers ?? json
    if (!servers || typeof servers !== 'object') return false

    for (const key of Object.keys(servers)) {
      if (!key.toLowerCase().includes('serena')) continue
      const server = servers[key]
      if (!server || !Array.isArray(server.args)) continue
      const args = server.args as string[]
      // Aceptar las 3 formas válidas en CLI:
      //   --context claude-code      (dos args separados)
      //   --context=claude-code      (un arg fusionado con =)
      //   -c claude-code / -c=claude-code (forma corta)
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if ((a === '--context' || a === '-c') && args[i + 1] === 'claude-code') {
          return true
        }
        if (a === '--context=claude-code' || a === '-c=claude-code') {
          return true
        }
      }
    }
  } catch {
    // swallow
  }
  return false
}

function findMcpJsonFiles(dir: string): string[] {
  const results: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findMcpJsonFiles(full))
      } else if (entry.name === '.mcp.json') {
        results.push(full)
      }
    }
  } catch {
    // swallow
  }
  return results
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
    () => {
      // Check if token-optimizer PreToolUse hook is installed (acts as RTK bridge)
      const json = readSettings(globalSettings(home))
      const hooks = json?.hooks
      if (!hooks || typeof hooks !== 'object') return [false, 'token-optimizer-bridge-active']
      const serialized = JSON.stringify(hooks)
      const hasPreToolUse = serialized.includes('token-optimizer') && serialized.includes('pretooluse')
      return [hasPreToolUse, 'token-optimizer-bridge-active']
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
