import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runInstall } from '../cli/install.js'
import { runUninstall } from '../cli/uninstall.js'

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
    const code = runInstall([], { home, cwd, print, runDoctorAtEnd: false })
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
    runInstall([], { home, cwd, print, runDoctorAtEnd: false })
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
    runInstall([], { home, cwd, print, runDoctorAtEnd: false })
    runInstall([], { home, cwd, print, runDoctorAtEnd: false })
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const json = readSettings(settingsPath)
    expect(countTokenOptimizerEntries(json.hooks)).toBe(3)
  })

  it('creates global storage dir', () => {
    runInstall([], { home, cwd, print, runDoctorAtEnd: false })
    const globalDir = path.join(home, '.token-optimizer')
    expect(fs.existsSync(globalDir)).toBe(true)
  })

  it('creates per-project storage dir when cwd is a git repo', () => {
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
    runInstall([], { home, cwd, print, runDoctorAtEnd: false })
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
    runInstall([], { home, cwd, print, runDoctorAtEnd: false })
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
