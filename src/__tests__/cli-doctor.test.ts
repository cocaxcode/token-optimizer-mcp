import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runDoctor } from '../cli/doctor.js'

describe('runDoctor', () => {
  let home: string
  let cwd: string
  const captured: string[] = []
  const print = (m: string) => captured.push(m)

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'tompx-doctor-home-'))
    cwd = await mkdtemp(path.join(tmpdir(), 'tompx-doctor-cwd-'))
    captured.length = 0
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('exits 0 even when nothing is installed', () => {
    const code = runDoctor([], { home, cwd, print })
    expect(code).toBe(0)
  })

  it('prints at least 5 signal lines', () => {
    runDoctor([], { home, cwd, print })
    const output = captured.join('\n')
    expect(output).toContain('[serena]')
    expect(output).toContain('[rtk]')
    expect(output).toContain('[mcp-pruning]')
    expect(output).toContain('[prompt-cache]')
    expect(output).toContain('[schema-size]')
  })

  it('includes 3 suggestions when nothing is installed', () => {
    // Isolate PATH so the real rtk binary on this machine isn't found
    const origPath = process.env.PATH
    process.env.PATH = home
    try {
      runDoctor([], { home, cwd, print })
      const output = captured.join('\n')
      expect(output).toContain('Sugerencias')
      expect(output).toContain('[serena]')
      expect(output).toContain('uvx')
      expect(output).toContain('[rtk]')
      expect(output).toContain('github.com/standard-input/rtk')
      expect(output).toContain('[mcp-pruning]')
      expect(output).toContain('mcp_prune_suggest')
    } finally {
      process.env.PATH = origPath
    }
  })

  it('omits serena install suggestion when serena is detected', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { 'serena-mcp': {} } }),
    )
    runDoctor([], { home, cwd, print })
    const output = captured.join('\n')
    // Should NOT suggest installing serena (it's already present)
    const sugIndex = output.indexOf('Sugerencias')
    if (sugIndex >= 0) {
      const sugSection = output.slice(sugIndex)
      expect(sugSection).not.toContain('[serena] Para lecturas simbolicas')
      // Should suggest registering the project instead
      expect(sugSection).toContain('[serena] Serena esta instalada pero este proyecto no esta registrado')
    }
  })

  it('omits serena registration suggestion when project is registered', () => {
    // Register serena MCP AND register the CWD in serena_config.yml
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { 'serena-mcp': {} } }),
    )
    const normalizedCwd = cwd.replace(/\\/g, '/')
    fs.mkdirSync(path.join(home, '.serena'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.serena', 'serena_config.yml'),
      `projects:\n  - path: "${normalizedCwd}"\n`,
    )
    runDoctor([], { home, cwd, print })
    const output = captured.join('\n')
    const sugIndex = output.indexOf('Sugerencias')
    if (sugIndex >= 0) {
      const sugSection = output.slice(sugIndex)
      // No install or registration suggestions for serena
      expect(sugSection).not.toContain('[serena] Para lecturas simbolicas')
      expect(sugSection).not.toContain('[serena] Serena esta instalada pero este proyecto no esta registrado')
      // Health warnings (dashboard, context) are expected and OK
    }
  })
})
