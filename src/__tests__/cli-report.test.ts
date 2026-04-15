import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runReport } from '../cli/report.js'
import { closeDb, getDb } from '../db/connection.js'
import { seedAnalyticsDb, makeEvent } from './helpers.js'
import { resolveAnalyticsDbPath, resolveStorageDir } from '../lib/paths.js'

describe('runReport', () => {
  let cwd: string
  const captured: string[] = []
  const print = (m: string) => captured.push(m)

  let prevHome: string | undefined

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'tompx-report-'))
    // Make it resolve as project dir by adding a package.json
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"test"}')
    // Isolate from the real user's global DB
    prevHome = process.env.TOKEN_OPTIMIZER_HOME
    process.env.TOKEN_OPTIMIZER_HOME = path.join(cwd, '.token-optimizer')
    captured.length = 0
    closeDb()
  })

  afterEach(() => {
    closeDb()
    if (prevHome === undefined) delete process.env.TOKEN_OPTIMIZER_HOME
    else process.env.TOKEN_OPTIMIZER_HOME = prevHome
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('prints message when no DB exists yet', () => {
    runReport([], { cwd, period: 'day', print })
    const output = captured.join('\n')
    expect(output).toContain('No hay datos registrados')
  })

  it('always prints the reference data section', () => {
    runReport([], { cwd, period: 'day', print })
    const output = captured.join('\n')
    expect(output).toContain('Referencia (datos publicos verificables)')
    expect(output).toContain('Model switching')
    expect(output).toContain('Progressive disclosure')
    expect(output).toContain('Prompt caching')
  })

  it('renders Medido / Estimado split with seeded mixed-source fixture', () => {
    const storageDir = resolveStorageDir(cwd)
    fs.mkdirSync(storageDir, { recursive: true })
    const dbPath = resolveAnalyticsDbPath(cwd)
    const db = getDb(dbPath)

    seedAnalyticsDb(db, [
      makeEvent({
        source: 'builtin',
        estimation_method: 'measured_exact',
        tokens_estimated: 1000,
      }),
      makeEvent({
        source: 'serena',
        estimation_method: 'estimated_serena_shadow',
        tokens_estimated: 500,
      }),
      makeEvent({
        source: 'rtk',
        estimation_method: 'estimated_rtk_db',
        tokens_estimated: 200,
      }),
    ])
    closeDb()

    runReport([], { cwd, period: 'day', print })
    const output = captured.join('\n')
    expect(output).toContain('Por fuente y metodo de estimacion')
    expect(output).toContain('[measured_exact]')
    expect(output).toContain('[estimated_serena_shadow]')
    expect(output).toContain('[estimated_rtk_db]')
    expect(output).toContain('Medido: 1000 tokens')
    expect(output).toContain('Estimado: 700 tokens')
  })

  it('includes Coach activity stub section', () => {
    runReport([], { cwd, period: 'day', print })
    const output = captured.join('\n')
    expect(output).toContain('Coach activity')
  })

  it('accepts all period values', () => {
    for (const period of ['session', 'day', 'week', 'month'] as const) {
      captured.length = 0
      const code = runReport([], { cwd, period, print })
      expect(code).toBe(0)
      expect(captured.join('\n')).toContain(period)
    }
  })
})
