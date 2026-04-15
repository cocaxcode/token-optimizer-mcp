// RTK bridge — v0.2.0
// Detects RTK binary in PATH and delegates command rewriting via `rtk rewrite`.
// Used by the PreToolUse hook to transparently compress Bash output on all platforms.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const IS_WINDOWS = process.platform === 'win32'
const RTK_BIN = IS_WINDOWS ? 'rtk.exe' : 'rtk'
const REWRITE_TIMEOUT_MS = 2000

// Module-level cache: undefined = not checked, null = not found, string = path
let cachedRtkPath: string | null | undefined = undefined

/**
 * RTK exit code semantics (from RTK docs):
 * 0 = rewrite found + auto-allow
 * 1 = no RTK equivalent → passthrough
 * 2 = deny rule matched → passthrough (let Claude Code handle)
 * 3 = ask rule matched → rewrite but prompt user for permission
 */
export type RtkExitCode = 0 | 1 | 2 | 3

export interface RtkRewriteResult {
  rewritten: string
  exitCode: number
  success: boolean
}

export interface FindRtkOptions {
  /** Override PATH search for testing */
  searchPaths?: string[]
  /** Force reset the cache */
  resetCache?: boolean
}

/**
 * Find the `rtk` binary. Checks PATH first (via `where` on Windows, `which` on Unix),
 * then falls back to common install locations. Caches the result for the process lifetime.
 */
export function findRtkBinary(opts: FindRtkOptions = {}): string | null {
  if (opts.resetCache) cachedRtkPath = undefined
  if (cachedRtkPath !== undefined) return cachedRtkPath

  // Strategy 1: explicit search paths (for testing or config override)
  if (opts.searchPaths) {
    for (const dir of opts.searchPaths) {
      const candidate = path.join(dir, RTK_BIN)
      if (fs.existsSync(candidate)) {
        cachedRtkPath = candidate
        return candidate
      }
    }
  }

  // Strategy 2: check PATH via where/which
  try {
    const whichCmd = IS_WINDOWS ? 'where' : 'which'
    const result = spawnSync(whichCmd, [IS_WINDOWS ? 'rtk' : 'rtk'], {
      encoding: 'utf8',
      timeout: 1000,
      windowsHide: true,
    })
    if (result.status === 0 && result.stdout?.trim()) {
      const found = result.stdout.trim().split(/\r?\n/)[0]
      cachedRtkPath = found
      return found
    }
  } catch {
    // swallow
  }

  // Strategy 3: common install locations
  const fallbackDirs = [
    path.join(os.homedir(), '.cargo', 'bin'),
    ...(IS_WINDOWS
      ? ['C:\\tools\\rtk', path.join(os.homedir(), 'scoop', 'shims')]
      : ['/usr/local/bin', '/opt/homebrew/bin']),
  ]
  for (const dir of fallbackDirs) {
    const candidate = path.join(dir, RTK_BIN)
    if (fs.existsSync(candidate)) {
      cachedRtkPath = candidate
      return candidate
    }
  }

  cachedRtkPath = null
  return null
}

/**
 * Call `rtk rewrite "command"` synchronously and return the result.
 * Returns null on any error (timeout, crash, missing binary).
 */
export function rtkRewrite(
  command: string,
  rtkPath: string,
  timeoutMs: number = REWRITE_TIMEOUT_MS,
): RtkRewriteResult | null {
  if (!command.trim()) return null
  try {
    const result = spawnSync(rtkPath, ['rewrite', command], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // spawnSync sets result.error on ENOENT / EACCES / timeout
    if (result.error) return null
    const exitCode = result.status ?? 1
    const rewritten = result.stdout?.trim() ?? ''
    return {
      rewritten,
      exitCode,
      success: exitCode === 0 && rewritten.length > 0,
    }
  } catch {
    return null
  }
}

/** Reset the binary cache (useful for testing) */
export function resetRtkCache(): void {
  cachedRtkPath = undefined
}
