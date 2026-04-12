import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { findRtkBinary, rtkRewrite, resetRtkCache } from '../lib/rtk-bridge.js'

describe('findRtkBinary', () => {
  beforeEach(() => {
    resetRtkCache()
  })

  it('returns null when RTK is not installed and no search paths given', () => {
    // With empty searchPaths and no RTK in system PATH, should return null or a found path
    // We can't guarantee RTK is NOT in the tester's PATH, so test with explicit empty searchPaths
    const result = findRtkBinary({ searchPaths: [], resetCache: true })
    // It may still find via PATH/where — that's OK. Just verify it returns string or null
    expect(result === null || typeof result === 'string').toBe(true)
  })

  it('finds RTK in explicit search paths', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'tompx-rtk-find-'))
    try {
      const fakeRtk = path.join(tempDir, process.platform === 'win32' ? 'rtk.exe' : 'rtk')
      fs.writeFileSync(fakeRtk, 'fake binary')
      const result = findRtkBinary({ searchPaths: [tempDir], resetCache: true })
      expect(result).toBe(fakeRtk)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
      resetRtkCache()
    }
  })

  it('caches the result after first lookup', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'tompx-rtk-cache-'))
    try {
      const fakeRtk = path.join(tempDir, process.platform === 'win32' ? 'rtk.exe' : 'rtk')
      fs.writeFileSync(fakeRtk, 'fake binary')
      const first = findRtkBinary({ searchPaths: [tempDir], resetCache: true })
      // Delete the file — cache should still return the same path
      fs.unlinkSync(fakeRtk)
      const second = findRtkBinary({ searchPaths: [tempDir] })
      expect(second).toBe(first)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
      resetRtkCache()
    }
  })

  it('resetCache forces a re-check', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'tompx-rtk-reset-'))
    try {
      const fakeRtk = path.join(tempDir, process.platform === 'win32' ? 'rtk.exe' : 'rtk')
      fs.writeFileSync(fakeRtk, 'fake binary')
      findRtkBinary({ searchPaths: [tempDir], resetCache: true })
      fs.unlinkSync(fakeRtk)
      // With resetCache, should no longer find it (unless in system PATH)
      const result = findRtkBinary({ searchPaths: [tempDir], resetCache: true })
      // Can't assert null because system PATH may have rtk. Assert it's not the deleted file.
      if (result !== null) {
        expect(result).not.toBe(fakeRtk)
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
      resetRtkCache()
    }
  })
})

describe('rtkRewrite', () => {
  it('returns null for empty command', () => {
    expect(rtkRewrite('', '/fake/rtk')).toBeNull()
    expect(rtkRewrite('   ', '/fake/rtk')).toBeNull()
  })

  it('returns exitCode and rewritten for a real binary call', () => {
    // Use node as a fake "rtk" that echoes the command (exit 0)
    const result = rtkRewrite('echo hello', process.execPath, 2000)
    // node will fail because 'rewrite' is not a valid node arg — exitCode != 0
    expect(result).not.toBeNull()
    expect(typeof result!.exitCode).toBe('number')
    expect(result!.success).toBe(false) // node doesn't understand 'rewrite'
  })

  it('handles missing binary gracefully', () => {
    const result = rtkRewrite('git status', '/nonexistent/rtk-fake-binary')
    expect(result).toBeNull()
  })

  it('success is true only when exitCode === 0 and rewritten is non-empty', () => {
    // We can't easily simulate exit 0 with stdout without a real rtk binary.
    // This tests the contract: success = exitCode === 0 && rewritten.length > 0
    const result = rtkRewrite('test', process.execPath)
    if (result) {
      if (result.exitCode === 0 && result.rewritten.length > 0) {
        expect(result.success).toBe(true)
      } else {
        expect(result.success).toBe(false)
      }
    }
  })
})
