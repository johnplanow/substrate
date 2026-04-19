/**
 * Unit tests for executeProbeOnHost — Epic 55 / Phase 2.
 *
 * Uses real `sh -c` execution (no spawn mocks) because the cost of a
 * short-lived shell is trivial (< 30 ms per test) and mocking the spawn
 * surface would re-implement most of the logic we want to verify.
 *
 * Covers:
 *   - exit 0 → outcome 'pass', exitCode 0, stdoutTail carries output
 *   - exit non-zero → outcome 'fail', exitCode matches, stderrTail carries error
 *   - timeout → outcome 'timeout', exitCode undefined, command killed
 *   - stdoutTail and stderrTail separated correctly
 *   - durationMs is non-negative and realistic
 */

import { describe, it, expect } from 'vitest'
import { executeProbeOnHost } from '../executor.js'
import type { RuntimeProbe } from '../types.js'

function probe(overrides: Partial<RuntimeProbe> & { command: string }): RuntimeProbe {
  return {
    name: overrides.name ?? 'test-probe',
    sandbox: 'host',
    command: overrides.command,
    ...(overrides.timeout_ms !== undefined ? { timeout_ms: overrides.timeout_ms } : {}),
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
  }
}

describe('executeProbeOnHost', () => {
  it('returns outcome=pass for a command that exits 0', async () => {
    const result = await executeProbeOnHost(probe({ command: 'true' }))
    expect(result.outcome).toBe('pass')
    expect(result.exitCode).toBe(0)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.command).toBe('true')
  })

  it('returns outcome=fail with exit code for a command that exits non-zero', async () => {
    const result = await executeProbeOnHost(probe({ command: 'exit 7' }))
    expect(result.outcome).toBe('fail')
    expect(result.exitCode).toBe(7)
  })

  it('captures stdout in stdoutTail', async () => {
    const result = await executeProbeOnHost(probe({ command: 'echo hello-from-stdout' }))
    expect(result.outcome).toBe('pass')
    expect(result.stdoutTail).toContain('hello-from-stdout')
    expect(result.stderrTail).toBe('')
  })

  it('captures stderr in stderrTail and distinguishes it from stdout', async () => {
    const result = await executeProbeOnHost(probe({ command: 'echo oops 1>&2; exit 2' }))
    expect(result.outcome).toBe('fail')
    expect(result.exitCode).toBe(2)
    expect(result.stderrTail).toContain('oops')
    expect(result.stdoutTail).toBe('')
  })

  it('returns outcome=timeout with undefined exit code when the probe exceeds its timeout', async () => {
    const result = await executeProbeOnHost(probe({ command: 'sleep 5', timeout_ms: 150 }))
    expect(result.outcome).toBe('timeout')
    expect(result.exitCode).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(100)
    expect(result.durationMs).toBeLessThan(2000) // killed quickly after timeout
  }, 10_000)

  it('does not throw on a command with shell-special characters', async () => {
    // `|| true` makes this a successful pipeline; we just care it runs
    // cleanly without the caller having to sanitize.
    const result = await executeProbeOnHost(
      probe({ command: "test 1 -eq 2 || echo 'not equal' " }),
    )
    expect(result.outcome).toBe('pass')
    expect(result.stdoutTail).toContain('not equal')
  })
})
