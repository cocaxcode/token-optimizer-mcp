// Install CLI — Phase 4.10
// Writes token-optimizer mcpServers entry + 3 hooks into ~/.claude/settings.json
// Also creates per-project storage dir and appends .gitignore in git repos.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { ensureStorageDir } from '../lib/storage.js'
import { probeSerenaPresence, type SerenaProbe } from '../hooks/serena-activate.js'
import { runDoctor } from './doctor.js'

const SERVER_NAME = 'token-optimizer'

/**
 * Resolve the hook command base.
 * Prefer `node <global-path>/dist/index.js` for speed (~0.2s vs ~1.5s with npx).
 * Falls back to `npx @cocaxcode/token-optimizer-mcp` if global path not found.
 */
function resolveHookCommandBase(): string {
  try {
    const globalRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules')
    const indexPath = path.join(globalRoot, '@cocaxcode', 'token-optimizer-mcp', 'dist', 'index.js')
    if (fs.existsSync(indexPath)) {
      return `node "${indexPath.replace(/\\/g, '/')}"`
    }
  } catch { /* fallback */ }

  // Unix global paths
  const unixPaths = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
  ]
  for (const root of unixPaths) {
    try {
      const indexPath = path.join(root, '@cocaxcode', 'token-optimizer-mcp', 'dist', 'index.js')
      if (fs.existsSync(indexPath)) {
        return `node "${indexPath}"`
      }
    } catch { /* fallback */ }
  }

  // npm root -g fallback
  try {
    const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 3000, shell: true })
    const npmRoot = (result.stdout ?? '').trim()
    const indexPath = path.join(npmRoot, '@cocaxcode', 'token-optimizer-mcp', 'dist', 'index.js')
    if (fs.existsSync(indexPath)) {
      return `node "${indexPath.replace(/\\/g, '/')}"`
    }
  } catch { /* fallback */ }

  return 'npx @cocaxcode/token-optimizer-mcp'
}

export interface InstallOptions {
  home?: string
  cwd?: string
  print?: (msg: string) => void
  runDoctorAtEnd?: boolean
  /**
   * Override the Serena presence probe. Used by tests to get deterministic
   * behaviour independent of whether the test host actually has Serena.
   * Undefined = probe the real filesystem/PATH.
   */
  serenaProbe?: SerenaProbe
  /**
   * Skip installing the 3 official Serena reminder hooks (remind, auto-approve,
   * cleanup) even when Serena is detected. The Serena-activate hook we own is
   * still installed. Use this if you prefer managing the official hooks yourself
   * or you don't want to depend on Serena's alpha feature.
   */
  skipSerenaHooks?: boolean
}

function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json')
}

function readSettings(p: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeSettings(p: string, data: Record<string, unknown>): void {
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

interface HookEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
  [key: string]: unknown
}

/**
 * Extract the `--hook <kind>` flag from a command line so we can use it as
 * a unique identity for upsert. `node .../index.js --hook serena-activate`
 * becomes `--hook serena-activate`. Anything without a `--hook X` returns null.
 */
function extractHookFlag(command: string): string | null {
  const match = command.match(/--hook\s+(\S+)/)
  return match ? `--hook ${match[1]}` : null
}

/**
 * Options for upsertHook.
 * - `identifier`: a substring that uniquely identifies an existing handler of
 *   the same kind so we can replace it in place. Defaults to "token-optimizer"
 *   for our own hooks. For external hooks (e.g. serena-hooks), callers should
 *   pass something like "serena-hooks remind".
 * - `useFlagDisambiguation`: if true, use the `--hook X` flag as extra
 *   disambiguation so multiple token-optimizer hooks can coexist in the same
 *   matcher group without trampling each other. Default true.
 */
interface UpsertHookOptions {
  identifier?: string
  useFlagDisambiguation?: boolean
}

function upsertHook(
  allHooks: Record<string, unknown>,
  eventName: string,
  matcher: string,
  command: string,
  upsertOpts: UpsertHookOptions = {},
): void {
  const identifier = upsertOpts.identifier ?? 'token-optimizer'
  const useFlagDisambiguation = upsertOpts.useFlagDisambiguation ?? true

  const existing = (allHooks[eventName] ?? []) as HookEntry[]
  const list: HookEntry[] = Array.isArray(existing) ? [...existing] : []
  const matchEntry = list.find((e) => e.matcher === matcher)
  const ourHandler = { type: 'command', command }
  const ourFlag = useFlagDisambiguation ? extractHookFlag(command) : null

  if (matchEntry) {
    const handlers = Array.isArray(matchEntry.hooks) ? [...matchEntry.hooks] : []
    // 1) Preferred: find the exact handler we own by identifier + flag.
    let idx = -1
    if (ourFlag) {
      idx = handlers.findIndex(
        (h) =>
          typeof h.command === 'string' &&
          h.command.includes(identifier) &&
          extractHookFlag(h.command) === ourFlag,
      )
    }
    // 2) Fallback: any handler that includes the identifier (and doesn't
    //    have a --hook flag of its own so we don't steal a sibling's slot).
    if (idx < 0) {
      idx = handlers.findIndex(
        (h) =>
          typeof h.command === 'string' &&
          h.command.includes(identifier) &&
          extractHookFlag(h.command) === null,
      )
    }

    if (idx >= 0) {
      handlers[idx] = ourHandler
    } else {
      handlers.push(ourHandler)
    }
    matchEntry.hooks = handlers
  } else {
    list.push({ matcher, hooks: [ourHandler] })
  }
  allHooks[eventName] = list
}

export function runInstall(_args: string[] = [], opts: InstallOptions = {}): number {
  const home = opts.home ?? os.homedir()
  const cwd = opts.cwd ?? process.cwd()
  const print = opts.print ?? ((m: string) => console.error(m))

  const p = settingsPath(home)
  const settings = readSettings(p)

  // mcpServers upsert
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>
  mcpServers[SERVER_NAME] = {
    command: 'npx',
    args: ['-y', '@cocaxcode/token-optimizer-mcp', '--mcp'],
  }
  settings.mcpServers = mcpServers

  // hooks upsert — prefer node direct for speed (~0.2s vs ~1.5s with npx)
  const hookBase = resolveHookCommandBase()
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>
  upsertHook(hooks, 'PreToolUse', 'Bash', `${hookBase} --hook pretooluse`)
  upsertHook(hooks, 'PostToolUse', '*', `${hookBase} --hook posttooluse`)
  upsertHook(hooks, 'SessionStart', 'compact', `${hookBase} --hook sessionstart`)

  // Serena integration — three independent blocks, all gated by the same
  // probe:
  //
  //   1) Our own `--hook serena-activate` (SessionStart). Fixes the ToolSearch
  //      gap in the official `serena-hooks activate` output.
  //   2) The 3 OFFICIAL Serena reminder hooks (remind, auto-approve, cleanup),
  //      registered as `serena-hooks <cmd> --client=claude-code` entries.
  //      We do NOT reimplement them — we just point settings.json at the
  //      binary the user already has on PATH. This keeps behaviour in sync
  //      with upstream Serena and avoids duplicating stateful logic.
  //
  // Both blocks are skipped when Serena isn't detected. The official hooks
  // can also be skipped explicitly via `skipSerenaHooks: true`.
  const serenaProbe = opts.serenaProbe ?? probeSerenaPresence()
  const serenaOfficialInstalled = serenaProbe.present && opts.skipSerenaHooks !== true

  if (serenaProbe.present) {
    upsertHook(hooks, 'SessionStart', '', `${hookBase} --hook serena-activate`)
  }

  if (serenaOfficialInstalled) {
    // PreToolUse: `remind` on every tool call, `auto-approve` on Serena tools.
    upsertHook(hooks, 'PreToolUse', '', 'serena-hooks remind --client=claude-code', {
      identifier: 'serena-hooks remind',
      useFlagDisambiguation: false,
    })
    upsertHook(
      hooks,
      'PreToolUse',
      'mcp__serena__.*',
      'serena-hooks auto-approve --client=claude-code',
      {
        identifier: 'serena-hooks auto-approve',
        useFlagDisambiguation: false,
      },
    )
    // Stop: cleanup
    upsertHook(hooks, 'Stop', '', 'serena-hooks cleanup --client=claude-code', {
      identifier: 'serena-hooks cleanup',
      useFlagDisambiguation: false,
    })
  }
  settings.hooks = hooks

  writeSettings(p, settings)

  // Global storage dir
  const globalDir = path.join(home, '.token-optimizer')
  if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true })

  // Per-project storage dir (only in git repos)
  if (fs.existsSync(path.join(cwd, '.git'))) {
    ensureStorageDir(cwd)
  }

  print('token-optimizer-mcp instalado correctamente.')
  print(`  settings: ${p}`)
  print(`  global:   ${globalDir}`)
  if (serenaProbe.present) {
    print(`  serena:   detectado — hook serena-activate registrado en SessionStart`)
    if (serenaOfficialInstalled) {
      print(`            + 3 hooks oficiales registrados (remind, auto-approve, cleanup)`)
    } else {
      print(`            hooks oficiales omitidos (skipSerenaHooks)`)
    }
  } else {
    print(`  serena:   no detectado — hooks de serena omitidos`)
  }

  if (opts.runDoctorAtEnd !== false) {
    print('')
    runDoctor([], { cwd, home, print })
  }

  return 0
}
