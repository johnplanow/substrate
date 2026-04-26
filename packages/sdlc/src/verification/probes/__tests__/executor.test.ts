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

// ---------------------------------------------------------------------------
// Story 60-4: stdout-shape assertions (expect_stdout_no_regex / expect_stdout_regex)
// ---------------------------------------------------------------------------
//
// Closes the exit-0-with-error-body gap surfaced by strata Run 12 (four MCP
// tools shipped SHIP_IT while their probes returned `{"isError": true}` JSON
// payloads with shell exit 0). assertionFailures is undefined when no
// assertions are declared OR when all assertions pass — it is set ONLY when
// an assertion tripped, so the check can route to runtime-probe-assertion-fail.

describe('executeProbeOnHost — stdout-shape assertions (Story 60-4)', () => {
  function probeWithAssertions(overrides: {
    command: string
    expect_stdout_no_regex?: string[]
    expect_stdout_regex?: string[]
  }): RuntimeProbe {
    return {
      name: 'assertion-test',
      sandbox: 'host',
      command: overrides.command,
      ...(overrides.expect_stdout_no_regex !== undefined
        ? { expect_stdout_no_regex: overrides.expect_stdout_no_regex }
        : {}),
      ...(overrides.expect_stdout_regex !== undefined
        ? { expect_stdout_regex: overrides.expect_stdout_regex }
        : {}),
    }
  }

  it('passes when no assertions are declared and exit code is 0', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({ command: "echo '{\"isError\": true}'" }),
    )
    expect(result.outcome).toBe('pass')
    expect(result.assertionFailures).toBeUndefined()
  })

  it('fails when expect_stdout_no_regex matches stdout (the strata Run 12 class)', async () => {
    // Reproduces the exact failure mode: tool exits 0 with MCP error envelope.
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command:
          "echo '{\"isError\": true, \"text\": \"Error executing tool: str object has no attribute get\"}'",
        expect_stdout_no_regex: ['"isError"\\s*:\\s*true'],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.exitCode).toBe(0)
    expect(result.assertionFailures).toBeDefined()
    expect(result.assertionFailures).toHaveLength(1)
    expect(result.assertionFailures?.[0]).toContain('expect_stdout_no_regex')
    expect(result.assertionFailures?.[0]).toContain('"isError"')
  })

  it('fails when expect_stdout_no_regex matches a REST-shaped error envelope', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command: "echo '{\"status\": \"error\", \"message\": \"backend unavailable\"}'",
        expect_stdout_no_regex: ['"status"\\s*:\\s*"error"'],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.assertionFailures?.[0]).toContain('"status"')
  })

  it('fails when expect_stdout_regex pattern is absent from stdout', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command: "echo '{\"results\": []}'",
        expect_stdout_regex: ['"similarity_score"'],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.assertionFailures).toHaveLength(1)
    expect(result.assertionFailures?.[0]).toContain('expect_stdout_regex')
    expect(result.assertionFailures?.[0]).toContain('similarity_score')
  })

  it('passes when all expect_stdout_regex patterns match', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command:
          'echo \'{"results": [{"file_path": "x.ts", "snippet": "...", "similarity_score": 0.9}]}\'',
        expect_stdout_regex: ['"file_path"', '"similarity_score"'],
      }),
    )
    expect(result.outcome).toBe('pass')
    expect(result.assertionFailures).toBeUndefined()
  })

  it('passes when expect_stdout_no_regex patterns do NOT match a clean response', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command: "echo '{\"results\": [{\"id\": 1}]}'",
        expect_stdout_no_regex: ['"isError"\\s*:\\s*true', '"status"\\s*:\\s*"error"'],
      }),
    )
    expect(result.outcome).toBe('pass')
    expect(result.assertionFailures).toBeUndefined()
  })

  it('aggregates failures from both no-regex and regex assertions', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command: "echo '{\"isError\": true}'",
        expect_stdout_no_regex: ['"isError"\\s*:\\s*true'],
        expect_stdout_regex: ['"similarity_score"'],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.assertionFailures).toHaveLength(2)
    expect(result.assertionFailures?.[0]).toContain('expect_stdout_no_regex')
    expect(result.assertionFailures?.[1]).toContain('expect_stdout_regex')
  })

  it('does NOT evaluate assertions when exit code is non-zero (avoids redundant findings)', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command: "echo '{\"isError\": true}'; exit 7",
        expect_stdout_no_regex: ['"isError"\\s*:\\s*true'],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.exitCode).toBe(7)
    // Assertion would have matched, but exit-code failure takes precedence
    // and assertion evaluation is suppressed so the finding stays focused.
    expect(result.assertionFailures).toBeUndefined()
  })

  it('reports invalid regex as an assertion failure rather than crashing', async () => {
    const result = await executeProbeOnHost(
      probeWithAssertions({
        command: 'echo ok',
        // Unbalanced bracket — RegExp constructor throws SyntaxError.
        expect_stdout_no_regex: ['['],
      }),
    )
    expect(result.outcome).toBe('fail')
    expect(result.assertionFailures).toHaveLength(1)
    expect(result.assertionFailures?.[0]).toContain('not a valid regex')
  })
})
