// SessionStart hook that forces Serena activation via explicit ToolSearch.
//
// Context: Serena ships its own `serena-hooks activate` hook, but the output of
// that binary does NOT mention ToolSearch — it just tells the agent to "activate
// the current working directory as project using Serena's tools". In a Claude
// Code environment where MCP tools are marked `deferred` at session start, the
// agent cannot call `mcp__serena__*` tools without first loading their schemas
// via the `ToolSearch` tool — trying to do so fails with InputValidationError.
//
// This hook emits an explicit four-step instruction block that starts with the
// ToolSearch call, so the agent does the right thing on PCs where Serena tools
// happen to be deferred.
//
// Behaviour:
//   - If Serena is NOT detected on the machine → emit `{}` and exit 0 (noop).
//     This keeps the hook safe to install globally, even on PCs without Serena.
//   - If Serena IS detected → emit the JSON with hookSpecificOutput.
//
// Intentionally stateless. Detection is a cheap synchronous probe so the hook
// stays well under the p95 latency budget for SessionStart.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const INSTRUCTION = [
  '**IMPORTANT — Serena activation (do this FIRST, before anything else):**',
  '1. Call ToolSearch with query "select:mcp__serena__initial_instructions,mcp__serena__activate_project,mcp__serena__check_onboarding_performed" to load the tool schemas (they are deferred and cannot be called without this step).',
  '2. Call mcp__serena__initial_instructions (read the manual).',
  '3. Call mcp__serena__activate_project with the current working directory as the `project` argument.',
  '4. Call mcp__serena__check_onboarding_performed.',
  'Do NOT skip step 1 — calling Serena tools without loading their schemas first will fail with InputValidationError.',
].join(' ')

export interface SerenaProbe {
  serena_hooks_in_path: boolean
  serena_home_dir_exists: boolean
  present: boolean
}

/** Detect whether Serena looks installed on this machine. Cheap and sync. */
export function probeSerenaPresence(
  env: NodeJS.ProcessEnv = process.env,
): SerenaProbe {
  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const binName = isWindows ? 'serena-hooks.exe' : 'serena-hooks'

  // Strategy 1: $PATH via where/which.
  let serena_hooks_in_path = false
  try {
    const result = spawnSync(whichCmd, ['serena-hooks'], {
      encoding: 'utf8',
      timeout: 500,
      windowsHide: true,
      env,
    })
    if (result.status === 0 && result.stdout && result.stdout.trim().length > 0) {
      serena_hooks_in_path = true
    }
  } catch {
    /* swallow — falls through to strategy 2 */
  }

  // Strategy 2: common install locations (fallback when `which` is flaky).
  if (!serena_hooks_in_path) {
    const candidates = [
      path.join(os.homedir(), '.local', 'bin', binName),
      ...(isWindows
        ? [
            path.join(os.homedir(), 'scoop', 'shims', binName),
            path.join('C:\\', 'tools', 'serena', binName),
          ]
        : ['/usr/local/bin/serena-hooks', '/opt/homebrew/bin/serena-hooks']),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        serena_hooks_in_path = true
        break
      }
    }
  }

  // Strategy 3: ~/.serena/ config dir. Even without the binary, this usually
  // means the user had Serena at some point and likely still has the MCP
  // server registered.
  const serena_home_dir_exists = fs.existsSync(path.join(os.homedir(), '.serena'))

  return {
    serena_hooks_in_path,
    serena_home_dir_exists,
    present: serena_hooks_in_path || serena_home_dir_exists,
  }
}

export interface RunSerenaActivateOptions {
  writeStdout?: boolean
  /** Inject a custom probe result (used by tests). */
  probe?: SerenaProbe
}

export interface SerenaActivateResult {
  emitted: boolean
  probe: SerenaProbe
}

/**
 * Pure function — doesn't read stdin. Callers from the entry point should
 * drain stdin themselves before invoking (Claude Code pipes a payload we
 * don't use). Tests call this directly without touching stdin.
 */
export function runSerenaActivateHook(
  opts: RunSerenaActivateOptions = {},
): SerenaActivateResult {
  const probe = opts.probe ?? probeSerenaPresence()

  if (!probe.present) {
    if (opts.writeStdout !== false) process.stdout.write('{}')
    return { emitted: false, probe }
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: INSTRUCTION,
    },
  }
  if (opts.writeStdout !== false) process.stdout.write(JSON.stringify(payload))
  return { emitted: true, probe }
}

/**
 * Entry-point helper that drains stdin (Claude Code always pipes a payload)
 * and delegates to `runSerenaActivateHook`. Safe to call from the CLI
 * dispatcher in src/index.ts.
 */
export function runSerenaActivateHookFromCli(): SerenaActivateResult {
  try {
    fs.readFileSync(0, 'utf8')
  } catch {
    /* no stdin attached — fine */
  }
  return runSerenaActivateHook()
}
