// Uninstall CLI — Phase 4.11
// Removes token-optimizer entries from settings.json. --purge --confirm also
// removes the global storage dir.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface UninstallOptions {
  home?: string
  cwd?: string
  print?: (msg: string) => void
  purge?: boolean
  confirm?: boolean
}

function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json')
}

interface HookEntry {
  matcher?: string
  hooks?: Array<{ type?: string; command?: string }>
  [key: string]: unknown
}

function stripTokenOptimizerFromEvent(entries: unknown): HookEntry[] {
  if (!Array.isArray(entries)) return []
  return (entries as HookEntry[])
    .map((entry) => {
      const handlers = Array.isArray(entry.hooks) ? entry.hooks : []
      const filtered = handlers.filter(
        (h) => !(typeof h.command === 'string' && h.command.includes('token-optimizer')),
      )
      return { ...entry, hooks: filtered }
    })
    .filter((entry) => Array.isArray(entry.hooks) && entry.hooks.length > 0)
}

export function runUninstall(args: string[] = [], opts: UninstallOptions = {}): number {
  const home = opts.home ?? os.homedir()
  const print = opts.print ?? ((m: string) => console.error(m))
  const purge = opts.purge ?? args.includes('--purge')
  const confirm = opts.confirm ?? args.includes('--confirm')

  const p = settingsPath(home)
  if (fs.existsSync(p)) {
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>

      // mcpServers: delete token-optimizer
      const mcpServers = (json.mcpServers ?? {}) as Record<string, unknown>
      delete mcpServers['token-optimizer']
      json.mcpServers = mcpServers

      // hooks: strip token-optimizer handlers from all 3 events
      const hooks = (json.hooks ?? {}) as Record<string, unknown>
      for (const eventName of ['PreToolUse', 'PostToolUse', 'SessionStart']) {
        hooks[eventName] = stripTokenOptimizerFromEvent(hooks[eventName])
      }
      json.hooks = hooks

      fs.writeFileSync(p, JSON.stringify(json, null, 2))
      print('Entradas de token-optimizer eliminadas de settings.json')
    } catch (e) {
      print(`Error editando settings.json: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
  } else {
    print('settings.json no existe; nada que eliminar.')
  }

  if (purge) {
    if (!confirm) {
      print('--purge requiere tambien --confirm para borrar datos. Nada borrado.')
      return 0
    }
    const globalDir = path.join(home, '.token-optimizer')
    if (fs.existsSync(globalDir)) {
      fs.rmSync(globalDir, { recursive: true, force: true })
      print(`Borrado: ${globalDir}`)
    }
  }

  return 0
}
