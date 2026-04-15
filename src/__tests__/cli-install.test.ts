import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runInstall } from '../cli/install.js'
import { runUninstall } from '../cli/uninstall.js'
import type { SerenaProbe } from '../hooks/serena-activate.js'

// Default probe for existing tests that pre-date Serena detection: pretend
// Serena is absent so the baseline hook count stays at 3.
const PROBE_ABSENT: SerenaProbe = {
  serena_cli_installed: false,
  serena_mcp_registered: false,
  present: false,
}
// "Full" Serena — CLI is installed, MCP is registered. All 4 hooks go in.
const PROBE_PRESENT: SerenaProbe = {
  serena_cli_installed: true,
  serena_mcp_registered: true,
  present: true,
}
// "Mcp only" — only the config dir / MCP server is registered, no CLI binary.
// Only the serena-activate hook should be installed; the 3 official ones must
// NOT be registered (they would fail at runtime).
const PROBE_MCP_ONLY: SerenaProbe = {
  serena_cli_installed: false,
  serena_mcp_registered: true,
  present: true,
}

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `tompx-cli-${prefix}-`))
}

function readSettings(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
}

function countTokenOptimizerEntries(hooks: unknown): number {
  if (!hooks || typeof hooks !== 'object') return 0
  let count = 0
  for (const event of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(event)) continue
    for (const entry of event as Array<{ hooks?: Array<{ command?: string }> }>) {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command === 'string' && h.command.includes('token-optimizer')) count++
      }
    }
  }
  return count
}

function countSerenaOfficialEntries(hooks: unknown): number {
  if (!hooks || typeof hooks !== 'object') return 0
  let count = 0
  for (const event of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(event)) continue
    for (const entry of event as Array<{ hooks?: Array<{ command?: string }> }>) {
      for (const h of entry.hooks ?? []) {
        if (
          typeof h.command === 'string' &&
          h.command.includes('serena-hooks ') &&
          !h.command.includes('token-optimizer')
        ) {
          count++
        }
      }
    }
  }
  return count
}

describe('runInstall', () => {
  let home: string
  let cwd: string
  const captured: string[] = []
  const print = (m: string) => captured.push(m)

  beforeEach(async () => {
    home = await makeTempRoot('install-home')
    cwd = await makeTempRoot('install-cwd')
    captured.length = 0
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('creates settings.json with mcpServers + 3 hooks on fresh install', () => {
    const code = runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
    expect(code).toBe(0)
    const settingsPath = path.join(home, '.claude', 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)
    const json = readSettings(settingsPath)
    expect((json.mcpServers as Record<string, unknown>)['token-optimizer']).toBeDefined()
    expect(countTokenOptimizerEntries(json.hooks)).toBe(3)
  })

  it('preserves pre-existing unrelated MCP servers and hooks', () => {
    const settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: { 'other-mcp': { command: 'node', args: ['x.js'] } },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk filter' }] }],
        },
      }),
    )
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
    const json = readSettings(settingsPath)
    expect((json.mcpServers as Record<string, unknown>)['other-mcp']).toBeDefined()
    // rtk handler MUST still be there alongside our own
    const pre = (json.hooks as Record<string, unknown>).PreToolUse as Array<{
      matcher?: string
      hooks?: Array<{ command?: string }>
    }>
    const bashEntry = pre.find((e) => e.matcher === 'Bash')
    expect(bashEntry?.hooks?.some((h) => h.command?.includes('rtk'))).toBe(true)
    expect(bashEntry?.hooks?.some((h) => h.command?.includes('token-optimizer'))).toBe(true)
  })

  it('is idempotent (re-install does not duplicate entries)', () => {
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect(countTokenOptimizerEntries(json.hooks)).toBe(3)
  })

  it('creates global storage dir', () => {
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
    const globalDir = path.join(home, '.token-optimizer')
    expect(fs.existsSync(globalDir)).toBe(true)
  })

  it('installs the serena-activate hook when Serena is detected', () => {
    runInstall([], {
      home,
      cwd,
      print,
      runDoctorAtEnd: false,
      serenaProbe: PROBE_PRESENT,
    })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    // Now 4 token-optimizer hooks: pretooluse, posttooluse, sessionstart:compact,
    // and serena-activate in SessionStart matcher ''.
    expect(countTokenOptimizerEntries(json.hooks)).toBe(4)
    // Find the serena-activate entry specifically.
    const sessionStart = (json.hooks as { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).SessionStart
    const emptyMatcher = sessionStart.find((e) => e.matcher === '')
    expect(emptyMatcher).toBeDefined()
    const serenaHook = emptyMatcher?.hooks.find(
      (h) => h.command.includes('--hook serena-activate'),
    )
    expect(serenaHook).toBeDefined()
  })

  it('does not install the serena-activate hook when Serena is absent', () => {
    runInstall([], {
      home,
      cwd,
      print,
      runDoctorAtEnd: false,
      serenaProbe: PROBE_ABSENT,
    })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect(countTokenOptimizerEntries(json.hooks)).toBe(3)
    // And the specific command must NOT appear anywhere.
    const raw = fs.readFileSync(settingsPath, 'utf8')
    expect(raw).not.toContain('--hook serena-activate')
  })

  it('is idempotent with the serena-activate hook', () => {
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    // Must still be 4, not 8.
    expect(countTokenOptimizerEntries(json.hooks)).toBe(4)
    // And specifically: exactly one --hook serena-activate.
    const sessionStart = (json.hooks as { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).SessionStart
    const allSerena = sessionStart.flatMap((e) => (e.hooks ?? []).filter((h) => h.command.includes('--hook serena-activate')))
    expect(allSerena).toHaveLength(1)
  })

  it('installs the 3 official Serena hooks when Serena is detected', () => {
    runInstall([], {
      home,
      cwd,
      print,
      runDoctorAtEnd: false,
      serenaProbe: PROBE_PRESENT,
    })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect(countSerenaOfficialEntries(json.hooks)).toBe(3)
    // Verify each official hook is registered in the right place.
    const preToolUse = (json.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse
    const emptyMatcher = preToolUse.find((e) => e.matcher === '')
    expect(emptyMatcher?.hooks.some((h) => h.command === 'serena-hooks remind --client=claude-code')).toBe(true)
    const serenaMatcher = preToolUse.find((e) => e.matcher === 'mcp__serena__.*')
    expect(serenaMatcher?.hooks.some((h) => h.command === 'serena-hooks auto-approve --client=claude-code')).toBe(true)
    const stop = (json.hooks as { Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).Stop
    const stopEmpty = stop.find((e) => e.matcher === '')
    expect(stopEmpty?.hooks.some((h) => h.command === 'serena-hooks cleanup --client=claude-code')).toBe(true)
  })

  it('does not install the 3 official Serena hooks when Serena is absent', () => {
    runInstall([], {
      home,
      cwd,
      print,
      runDoctorAtEnd: false,
      serenaProbe: PROBE_ABSENT,
    })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect(countSerenaOfficialEntries(json.hooks)).toBe(0)
  })

  it('skipSerenaHooks installs serena-activate but not the 3 official ones', () => {
    runInstall([], {
      home,
      cwd,
      print,
      runDoctorAtEnd: false,
      serenaProbe: PROBE_PRESENT,
      skipSerenaHooks: true,
    })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    // serena-activate still goes in (it's ours)
    expect(countTokenOptimizerEntries(json.hooks)).toBe(4)
    // but the 3 official ones are omitted
    expect(countSerenaOfficialEntries(json.hooks)).toBe(0)
  })

  it('is idempotent with the 3 official Serena hooks', () => {
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect(countSerenaOfficialEntries(json.hooks)).toBe(3)
    expect(countTokenOptimizerEntries(json.hooks)).toBe(4)
  })

  it('preserves pre-existing non-serena hooks in the same matcher groups', () => {
    // Simulate a settings.json that already has xray hooks in PreToolUse
    // matcher="" and Stop matcher="", so we can confirm we append next to
    // them without stealing their handler slot.
    const settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'cxc-xray-hook pre-tool-use 3333' }],
              },
            ],
            Stop: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'cxc-xray-hook stop 3333' }],
              },
            ],
          },
        },
        null,
        2,
      ),
    )

    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    const json = readSettings(settingsPath)
    const preEmpty = (json.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse.find((e) => e.matcher === '')
    expect(preEmpty?.hooks.some((h) => h.command.includes('cxc-xray'))).toBe(true)
    expect(preEmpty?.hooks.some((h) => h.command === 'serena-hooks remind --client=claude-code')).toBe(true)
    const stopEmpty = (json.hooks as { Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).Stop.find((e) => e.matcher === '')
    expect(stopEmpty?.hooks.some((h) => h.command.includes('cxc-xray'))).toBe(true)
    expect(stopEmpty?.hooks.some((h) => h.command === 'serena-hooks cleanup --client=claude-code')).toBe(true)
  })

  it('MCP-only probe installs serena-activate but NOT the 3 official hooks', () => {
    runInstall([], {
      home,
      cwd,
      print,
      runDoctorAtEnd: false,
      serenaProbe: PROBE_MCP_ONLY,
    })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    // serena-activate yes (it doesn't need the CLI)
    expect(countTokenOptimizerEntries(json.hooks)).toBe(4)
    // 3 official ones NO — CLI not installed, they would fail at runtime
    expect(countSerenaOfficialEntries(json.hooks)).toBe(0)
  })

  it('reconcile: removes orphan serena-hooks entries when CLI disappeared', () => {
    // Simulate a settings.json left behind by an older install that
    // registered the 3 official hooks even though the CLI is no longer
    // available (the 0.4.11 bug path). On the next install with the
    // fixed probe, we should clean them out.
    const settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '',
                hooks: [
                  { type: 'command', command: 'cxc-xray-hook pre-tool-use 3333' },
                  { type: 'command', command: 'serena-hooks remind --client=claude-code' },
                ],
              },
              {
                matcher: 'mcp__serena__.*',
                hooks: [
                  { type: 'command', command: 'serena-hooks auto-approve --client=claude-code' },
                ],
              },
            ],
            Stop: [
              {
                matcher: '',
                hooks: [
                  { type: 'command', command: 'cxc-xray-hook stop 3333' },
                  { type: 'command', command: 'serena-hooks cleanup --client=claude-code' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    )

    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_MCP_ONLY })
    const json = readSettings(settingsPath)

    // All 3 orphan official entries gone
    expect(countSerenaOfficialEntries(json.hooks)).toBe(0)
    // xray entries still there (not ours, don't touch)
    const preEmpty = (json.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse?.find((e) => e.matcher === '')
    expect(preEmpty?.hooks.some((h) => h.command.includes('cxc-xray'))).toBe(true)
    const stopEmpty = (json.hooks as { Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).Stop?.find((e) => e.matcher === '')
    expect(stopEmpty?.hooks.some((h) => h.command.includes('cxc-xray'))).toBe(true)
    // mcp__serena__.* matcher group now has zero hooks and was removed
    const serenaMatcher = (json.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse?.find((e) => e.matcher === 'mcp__serena__.*')
    expect(serenaMatcher).toBeUndefined()
  })

  it('reconcile: leaves orphan entries alone when CLI is back again', () => {
    // Same starting state as above, but this time the probe says CLI is
    // installed. Re-running install should keep the 3 official hooks in
    // place (idempotent, not duplicated).
    const settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '',
                hooks: [
                  { type: 'command', command: 'serena-hooks remind --client=claude-code' },
                ],
              },
            ],
            Stop: [
              {
                matcher: '',
                hooks: [
                  { type: 'command', command: 'serena-hooks cleanup --client=claude-code' },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    )

    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    const json = readSettings(settingsPath)
    expect(countSerenaOfficialEntries(json.hooks)).toBe(3)
  })

  it('does not overwrite sessionstart:compact when serena-activate is installed', () => {
    // Regression: both hooks live in SessionStart under different matchers;
    // upserting one must not delete or rewrite the other.
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_PRESENT })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    const sessionStart = (json.hooks as { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).SessionStart
    const compact = sessionStart.find((e) => e.matcher === 'compact')
    expect(compact?.hooks.some((h) => h.command.includes('--hook sessionstart'))).toBe(true)
    const empty = sessionStart.find((e) => e.matcher === '')
    expect(empty?.hooks.some((h) => h.command.includes('--hook serena-activate'))).toBe(true)
  })

  it('creates per-project storage dir when cwd is a git repo', () => {
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
    const projectStorage = path.join(cwd, '.token-optimizer')
    expect(fs.existsSync(projectStorage)).toBe(true)
    // .gitignore should contain our entry
    const gitignore = path.join(cwd, '.gitignore')
    expect(fs.existsSync(gitignore)).toBe(true)
    expect(fs.readFileSync(gitignore, 'utf8')).toContain('.token-optimizer/')
  })
})

describe('runUninstall', () => {
  let home: string
  let cwd: string
  const captured: string[] = []
  const print = (m: string) => captured.push(m)

  beforeEach(async () => {
    home = await makeTempRoot('uninst-home')
    cwd = await makeTempRoot('uninst-cwd')
    captured.length = 0
    runInstall([], { home, cwd, print, runDoctorAtEnd: false, serenaProbe: PROBE_ABSENT })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('removes token-optimizer entries from settings.json', () => {
    runUninstall([], { home, cwd, print })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect((json.mcpServers as Record<string, unknown>)['token-optimizer']).toBeUndefined()
    expect(countTokenOptimizerEntries(json.hooks)).toBe(0)
  })

  it('--purge alone does not delete storage without --confirm', () => {
    runUninstall([], { home, cwd, print, purge: true })
    const globalDir = path.join(home, '.token-optimizer')
    expect(fs.existsSync(globalDir)).toBe(true)
    expect(captured.join('\n')).toContain('requiere tambien --confirm')
  })

  it('--purge --confirm deletes the global storage dir', () => {
    runUninstall([], { home, cwd, print, purge: true, confirm: true })
    const globalDir = path.join(home, '.token-optimizer')
    expect(fs.existsSync(globalDir)).toBe(false)
  })
})
