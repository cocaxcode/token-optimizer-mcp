import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  probeSerena,
  probeRtk,
  probeMcpPruning,
  probePromptCaching,
  checkSerenaHealth,
} from '../orchestration/detector.js'

async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'tompx-detector-'))
}

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data))
}

describe('probeSerena', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await makeTempRoot()
    cwd = await makeTempRoot()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('returns present=false when no settings', () => {
    const result = probeSerena({ home, cwd })
    expect(result.present).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('detects serena in global settings.json', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { 'serena-mcp': { command: 'uvx' } },
    })
    const result = probeSerena({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('global-settings-registered')
  })

  it('detects serena in ~/.claude.json', () => {
    writeJson(path.join(home, '.claude.json'), {
      mcpServers: { serena: { command: 'serena', args: ['start-mcp-server'] } },
    })
    const result = probeSerena({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('claude-json-registered')
  })

  it('detects serena in project local settings', () => {
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
      mcpServers: { serena: { command: 'uvx' } },
    })
    const result = probeSerena({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('local-mcp-registered')
  })

  it('confidence scales with number of signals (5 checks total)', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { serena: {} },
    })
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
      mcpServers: { serena: {} },
    })
    const result = probeSerena({ home, cwd })
    // 2 hits out of 5 total checks
    expect(result.confidence).toBeCloseTo(2 / 5, 2)
  })

  it('detects project registered in serena_config.yml', () => {
    const normalizedCwd = cwd.replace(/\\/g, '/')
    const configDir = path.join(home, '.serena')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'serena_config.yml'),
      `projects:\n  - path: "${normalizedCwd}"\n`,
    )
    const result = probeSerena({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('project-registered-for-cwd')
  })
})

describe('probeRtk', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await makeTempRoot()
    cwd = await makeTempRoot()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('returns absent when nothing present', () => {
    // Isolate PATH so the real rtk.exe on this machine isn't found
    const origPath = process.env.PATH
    process.env.PATH = home
    try {
      const result = probeRtk({ home, cwd })
      expect(result.present).toBe(false)
    } finally {
      process.env.PATH = origPath
    }
  })

  it('detects rtk tracking db', () => {
    const rtkDir = path.join(home, '.rtk')
    fs.mkdirSync(rtkDir, { recursive: true })
    fs.writeFileSync(path.join(rtkDir, 'tracking.db'), 'fake')
    const result = probeRtk({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('rtk-db-present')
  })

  it('detects rtk binary in .cargo/bin', () => {
    const cargoBin = path.join(home, '.cargo', 'bin')
    fs.mkdirSync(cargoBin, { recursive: true })
    const exe = process.platform === 'win32' ? 'rtk.exe' : 'rtk'
    fs.writeFileSync(path.join(cargoBin, exe), 'fake')
    const result = probeRtk({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('rtk-binary-in-cargo')
  })

  it('detects rtk hook in global settings', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'rtk filter' }] }],
      },
    })
    const result = probeRtk({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('rtk-hook-registered')
  })

  it('detects token-optimizer bridge as RTK proxy', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'npx @cocaxcode/token-optimizer-mcp --hook pretooluse' }] }],
      },
    })
    const result = probeRtk({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('token-optimizer-bridge-active')
  })
})

describe('probeMcpPruning', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await makeTempRoot()
    cwd = await makeTempRoot()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('absent when no allowlist set', () => {
    const result = probeMcpPruning({ home, cwd })
    expect(result.present).toBe(false)
  })

  it('detects allowlist in settings.local.json', () => {
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
      enabledMcpjsonServers: ['database', 'logbook'],
    })
    const result = probeMcpPruning({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('allowlist-in-settings-local')
  })

  it('detects allowlist in team settings.json', () => {
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      enabledMcpjsonServers: ['shared-mcp'],
    })
    const result = probeMcpPruning({ home, cwd })
    expect(result.present).toBe(true)
    expect(result.signals).toContain('allowlist-in-settings')
  })

  it('ignores empty allowlist array', () => {
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
      enabledMcpjsonServers: [],
    })
    const result = probeMcpPruning({ home, cwd })
    expect(result.present).toBe(false)
  })
})

describe('probePromptCaching', () => {
  it('always reports present with low confidence and explanatory note', () => {
    const result = probePromptCaching()
    expect(result.present).toBe(true)
    expect(result.confidence).toBe(0.5)
    expect((result.details as { note: string }).note).toContain('factura Anthropic')
  })
})

describe('checkSerenaHealth', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await makeTempRoot()
    cwd = await makeTempRoot()
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('returns only context warning when no serena config exists but no MCP args found', () => {
    const warnings = checkSerenaHealth({ home, cwd })
    // No serena_config.yml → no dashboard warning
    // No MCP config with --context → context warning
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('dashboard-auto-open')
    expect(ids).toContain('missing-context-claude-code')
  })

  it('warns when web_dashboard_open_on_launch is true', () => {
    const configDir = path.join(home, '.serena')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'serena_config.yml'),
      'web_dashboard: true\nweb_dashboard_open_on_launch: true\n',
    )
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).toContain('dashboard-auto-open')
  })

  it('no dashboard warning when web_dashboard_open_on_launch is false', () => {
    const configDir = path.join(home, '.serena')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'serena_config.yml'),
      'web_dashboard: true\nweb_dashboard_open_on_launch: false\n',
    )
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('dashboard-auto-open')
  })

  it('warns when web_dashboard_open_on_launch is not set (defaults to true)', () => {
    const configDir = path.join(home, '.serena')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'serena_config.yml'),
      'web_dashboard: true\nlog_level: 20\n',
    )
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).toContain('dashboard-auto-open')
  })

  it('warns when --context claude-code is missing from MCP args', () => {
    // Serena registered but without --context flag
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { serena: { command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'] } },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).toContain('missing-context-claude-code')
  })

  it('no context warning when --context claude-code is in MCP args', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { serena: { command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server', '--context', 'claude-code'] } },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('missing-context-claude-code')
  })

  it('finds --context claude-code in plugin .mcp.json files', () => {
    // No settings files, but plugin has the flag
    const pluginDir = path.join(home, '.claude', 'plugins', 'serena')
    fs.mkdirSync(pluginDir, { recursive: true })
    writeJson(path.join(pluginDir, '.mcp.json'), {
      serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '--context', 'claude-code'] },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('missing-context-claude-code')
  })

  it('finds --context claude-code in local project settings', () => {
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
      mcpServers: { 'my-serena': { command: 'uvx', args: ['serena', 'start-mcp-server', '--context', 'claude-code'] } },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('missing-context-claude-code')
  })

  // Regression: usuarios escriben --context=claude-code como un solo arg
  // (forma válida en CLI). El detector antiguo sólo miraba la forma separada
  // y marcaba falso positivo.
  it('reconoce --context=claude-code fusionado con =', () => {
    writeJson(path.join(home, '.claude.json'), {
      mcpServers: { serena: { command: 'serena', args: ['start-mcp-server', '--context=claude-code', '--project-from-cwd'] } },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('missing-context-claude-code')
  })

  it('reconoce forma corta -c claude-code (separado)', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '-c', 'claude-code'] } },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('missing-context-claude-code')
  })

  it('reconoce forma corta -c=claude-code (fusionado)', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      mcpServers: { serena: { command: 'uvx', args: ['serena', 'start-mcp-server', '-c=claude-code'] } },
    })
    const warnings = checkSerenaHealth({ home, cwd })
    const ids = warnings.map((w) => w.id)
    expect(ids).not.toContain('missing-context-claude-code')
  })
})
