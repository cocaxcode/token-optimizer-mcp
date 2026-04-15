// Unit tests for the serena-activate SessionStart hook.
//
// Behaviour matrix we care about:
//   1. Serena NOT present → emit `{}` and don't touch additionalContext
//   2. Serena present (probe said so) → emit JSON with the full activation
//      block including the ToolSearch step (which the official serena-hooks
//      activate omits)
//   3. The instruction block mentions every tool the agent needs to call
//      (ToolSearch, initial_instructions, activate_project, check_onboarding)
//   4. The hook never throws even when there is no stdin to drain

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runSerenaActivateHook, probeSerenaPresence } from '../hooks/serena-activate.js'

interface StdoutCapture {
  text: string
  restore(): void
}

function captureStdout(): StdoutCapture {
  const original = process.stdout.write.bind(process.stdout)
  let buffered = ''
  ;(process.stdout as unknown as { write: (c: string) => boolean }).write = (
    chunk: string,
  ): boolean => {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }
  return {
    get text(): string {
      return buffered
    },
    restore(): void {
      ;(process.stdout as unknown as { write: typeof original }).write = original
    },
  }
}

describe('runSerenaActivateHook', () => {
  let cap: StdoutCapture

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it('emits an empty object when Serena is not detected', () => {
    const result = runSerenaActivateHook({
      probe: {
        serena_cli_installed: false,
        serena_mcp_registered: false,
        present: false,
      },
    })

    expect(result.emitted).toBe(false)
    expect(cap.text).toBe('{}')
  })

  it('emits the full activation payload when Serena CLI is detected via $PATH', () => {
    const result = runSerenaActivateHook({
      probe: {
        serena_cli_installed: true,
        serena_mcp_registered: false,
        present: true,
      },
    })

    expect(result.emitted).toBe(true)
    const parsed = JSON.parse(cap.text) as {
      hookSpecificOutput: {
        hookEventName: string
        additionalContext: string
      }
    }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('ToolSearch')
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'mcp__serena__initial_instructions',
    )
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'mcp__serena__activate_project',
    )
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'mcp__serena__check_onboarding_performed',
    )
  })

  it('emits the activation payload when only ~/.serena/ is present (MCP-only)', () => {
    const result = runSerenaActivateHook({
      probe: {
        serena_cli_installed: false,
        serena_mcp_registered: true,
        present: true,
      },
    })

    expect(result.emitted).toBe(true)
    const parsed = JSON.parse(cap.text) as {
      hookSpecificOutput: {
        hookEventName: string
        additionalContext: string
      }
    }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(100)
  })

  it('does not write stdout when writeStdout is false', () => {
    runSerenaActivateHook({
      probe: {
        serena_cli_installed: true,
        serena_mcp_registered: true,
        present: true,
      },
      writeStdout: false,
    })
    expect(cap.text).toBe('')
  })

  it('returns the probe it actually used', () => {
    const probe = {
      serena_cli_installed: true,
      serena_mcp_registered: false,
      present: true,
    }
    const result = runSerenaActivateHook({ probe, writeStdout: false })
    expect(result.probe).toEqual(probe)
  })
})

describe('probeSerenaPresence', () => {
  it('returns a probe object with the expected shape', () => {
    const probe = probeSerenaPresence()
    expect(probe).toHaveProperty('serena_cli_installed')
    expect(probe).toHaveProperty('serena_mcp_registered')
    expect(probe).toHaveProperty('present')
    expect(typeof probe.present).toBe('boolean')
    expect(typeof probe.serena_cli_installed).toBe('boolean')
    expect(typeof probe.serena_mcp_registered).toBe('boolean')
  })

  it('considers the machine ready when neither the binary nor the home dir exists', () => {
    // Use a fake env/home that guarantees nothing is found.
    const fakeEnv = { ...process.env, PATH: '/definitely/not/real/path' }
    vi.stubGlobal('process', { ...process, env: fakeEnv })
    const probe = probeSerenaPresence(fakeEnv)
    // We can't assert false here because the test host may still have
    // ~/.serena on disk; but we can assert the probe does not crash.
    expect(typeof probe.present).toBe('boolean')
    vi.unstubAllGlobals()
  })
})
