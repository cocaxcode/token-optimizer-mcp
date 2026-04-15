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
 * Remove any handlers whose command contains `identifier` from the given
 * (eventName, matcher) group. Used to un-register hooks that were installed
 * in a previous run but no longer apply (e.g. the 3 official Serena hooks
 * when the `serena-hooks` CLI is no longer in PATH).
 *
 * Returns the number of handlers removed. If the matcher group becomes empty,
 * the whole group is dropped from the event list. If the event itself becomes
 * empty, the event key is deleted from the hooks map.
 */
function removeHook(
  allHooks: Record<string, unknown>,
  eventName: string,
  matcher: string,
  identifier: string,
): number {
  const existing = allHooks[eventName]
  if (!Array.isArray(existing)) return 0
  const list = existing as HookEntry[]
  const matchEntry = list.find((e) => e.matcher === matcher)
  if (!matchEntry || !Array.isArray(matchEntry.hooks)) return 0

  const before = matchEntry.hooks.length
  matchEntry.hooks = matchEntry.hooks.filter(
    (h) => !(typeof h.command === 'string' && h.command.includes(identifier)),
  )
  const removed = before - matchEntry.hooks.length
  if (removed === 0) return 0

  // Clean empty matcher groups
  if (matchEntry.hooks.length === 0) {
    const idx = list.indexOf(matchEntry)
    if (idx >= 0) list.splice(idx, 1)
  }
  // Clean empty event
  if (list.length === 0) {
    delete allHooks[eventName]
  } else {
    allHooks[eventName] = list
  }
  return removed
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

  // Serena integration — two independent decisions based on two probe signals:
  //
  //   (a) `--hook serena-activate` (our own SessionStart hook). Fixes the
  //       ToolSearch gap in the official `serena-hooks activate` output. Does
  //       NOT shell out to any binary — it's a node entry point that emits
  //       JSON. Gated by `serena_mcp_registered` (i.e. the user uses Serena
  //       as an MCP server at all).
  //
  //   (b) The 3 OFFICIAL Serena reminder hooks (remind, auto-approve, cleanup).
  //       These ARE invoked as `serena-hooks <cmd> ...` at runtime by Claude
  //       Code, so they require the actual CLI binary to be on PATH. Gated by
  //       `serena_cli_installed`. If the CLI disappears (user uninstalled
  //       Serena, or the probe was wrong in a previous release), we actively
  //       REMOVE the orphan entries so settings.json stops pointing at a
  //       missing binary.
  //
  // Both blocks can be individually skipped via `skipSerenaHooks: true`.
  const serenaProbe = opts.serenaProbe ?? probeSerenaPresence()
  const wantOfficialHooks =
    serenaProbe.serena_cli_installed && opts.skipSerenaHooks !== true

  if (serenaProbe.serena_mcp_registered || serenaProbe.serena_cli_installed) {
    upsertHook(hooks, 'SessionStart', '', `${hookBase} --hook serena-activate`)
  }

  if (wantOfficialHooks) {
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
    upsertHook(hooks, 'Stop', '', 'serena-hooks cleanup --client=claude-code', {
      identifier: 'serena-hooks cleanup',
      useFlagDisambiguation: false,
    })
  } else {
    // Reconcile: if the 3 official hooks were added by a previous install
    // (maybe from a buggier probe that accepted ~/.serena/ as sufficient),
    // but the CLI isn't actually available now, take them OUT so Claude
    // Code stops logging "command not found" on every hook dispatch.
    removeHook(hooks, 'PreToolUse', '', 'serena-hooks remind')
    removeHook(hooks, 'PreToolUse', 'mcp__serena__.*', 'serena-hooks auto-approve')
    removeHook(hooks, 'Stop', '', 'serena-hooks cleanup')
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

  // Serena status — 3 states
  if (serenaProbe.serena_cli_installed) {
    print(`  serena:   CLI detectado — 4 hooks registrados`)
    print(`            (activate + remind + auto-approve + cleanup)`)
    if (opts.skipSerenaHooks) {
      print(`            note: --skipSerenaHooks activo → solo se registró serena-activate`)
    }
  } else if (serenaProbe.serena_mcp_registered) {
    print(`  serena:   MCP detectado pero CLI no instalado`)
    print(`            → solo se registró serena-activate`)
    print(`            → para los otros 3: uv tool install git+https://github.com/oraios/serena`)
  } else {
    print(`  serena:   no detectado — hooks de serena omitidos`)
  }

  if (opts.runDoctorAtEnd !== false) {
    print('')
    runDoctor([], { cwd, home, print })
  }

  return 0
}
