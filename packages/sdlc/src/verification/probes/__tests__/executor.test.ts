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

  it('passes when no assertions are declared, exit code is 0, and stdout has no error envelope', async () => {
    // Story 63-2 changed this contract: no-assertions + clean response → pass.
    // No-assertions + error envelope (`"isError": true`) now fails via the
    // 63-2 defense-in-depth detector. See the dedicated 63-2 describe
    // block below for that case.
    const result = await executeProbeOnHost(
      probeWithAssertions({ command: "echo '{\"results\": [{\"id\": 1}]}'" }),
    )
    expect(result.outcome).toBe('pass')
    expect(result.assertionFailures).toBeUndefined()
    expect(result.errorShapeIndicators).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Story 63-2: error-shape auto-detection (defense-in-depth for obs_012 REOPENED)
// ---------------------------------------------------------------------------
//
// When a probe exits 0 AND no author-declared assertions tripped, the
// executor scans stdout for canonical error-envelope JSON shapes
// (`"isError": true`, `"status": "error"`). These signal a structured
// error response despite a clean exit code — the obs_012 REOPENED class
// where 4 broken MCP tools shipped SHIP_IT because their probes asserted
// presence-of-response without checking shape.

describe('executeProbeOnHost — error-shape auto-detection (Story 63-2)', () => {
  function plainProbe(command: string): RuntimeProbe {
    return { name: 'error-shape-test', sandbox: 'host', command }
  }

  it('flips outcome=pass to fail when stdout contains "isError": true (no author assertions needed)', async () => {
    const result = await executeProbeOnHost(
      plainProbe(
        `echo '{"isError": true, "text": "Error executing tool: AttributeError"}'`,
      ),
    )
    expect(result.outcome).toBe('fail')
    expect(result.exitCode).toBe(0)
    expect(result.errorShapeIndicators).toBeDefined()
    expect(result.errorShapeIndicators).toHaveLength(1)
    expect(result.errorShapeIndicators?.[0]).toContain('isError')
    // Author didn't declare assertions, so 60-4 field stays undefined
    expect(result.assertionFailures).toBeUndefined()
  })

  it('detects "status": "error" envelope', async () => {
    const result = await executeProbeOnHost(
      plainProbe(
        `echo '{"status": "error", "message": "strata-memory binary not found"}'`,
      ),
    )
    expect(result.outcome).toBe('fail')
    expect(result.errorShapeIndicators).toHaveLength(1)
    expect(result.errorShapeIndicators?.[0]).toContain('status')
  })

  it('detects both indicators together when stdout has both shapes', async () => {
    const result = await executeProbeOnHost(
      plainProbe(
        `echo '{"isError": true, "status": "error", "data": null}'`,
      ),
    )
    expect(result.outcome).toBe('fail')
    expect(result.errorShapeIndicators).toHaveLength(2)
  })

  it('passes cleanly when stdout shows isError: false (clean success payload)', async () => {
    const result = await executeProbeOnHost(
      plainProbe(`echo '{"isError": false, "content": [{"text": "ok"}]}'`),
    )
    expect(result.outcome).toBe('pass')
    expect(result.errorShapeIndicators).toBeUndefined()
    expect(result.assertionFailures).toBeUndefined()
  })

  it('passes cleanly when stdout has no error-envelope keys at all', async () => {
    const result = await executeProbeOnHost(
      plainProbe(`echo '{"results": [{"id": 1, "name": "foo"}]}'`),
    )
    expect(result.outcome).toBe('pass')
    expect(result.errorShapeIndicators).toBeUndefined()
  })

  it('does NOT scan for error shape when exit code is non-zero (existing exit-code finding takes precedence)', async () => {
    // Even though stdout contains the error envelope, the exit code already
    // captures the failure; we don't want a redundant error-shape finding.
    const result = await executeProbeOnHost(
      plainProbe(`echo '{"isError": true}'; exit 1`),
    )
    expect(result.outcome).toBe('fail')
    expect(result.exitCode).toBe(1)
    expect(result.errorShapeIndicators).toBeUndefined()
  })

  it('does NOT scan for error shape when an author assertion already tripped (60-4 takes precedence)', async () => {
    // The author already declared a more-specific assertion that catches
    // the error. The 63-2 detector is defense-in-depth and shouldn't
    // double-flag. Author assertion → assertionFailures path → category
    // runtime-probe-assertion-fail (set by 60-4).
    const result = await executeProbeOnHost({
      name: 'precedence-test',
      sandbox: 'host',
      command: `echo '{"isError": true}'`,
      expect_stdout_regex: ['"similarity_score"'], // required pattern is missing
    })
    expect(result.outcome).toBe('fail')
    expect(result.assertionFailures).toBeDefined()
    expect(result.errorShapeIndicators).toBeUndefined()
  })

  it('matches keys case-sensitively (does NOT trigger on prose-form "Error:" log lines)', async () => {
    // We deliberately don't try to detect prose-form errors — too many
    // false positives from informational log output. Only structured
    // JSON shapes count.
    const result = await executeProbeOnHost(
      plainProbe(`echo 'Error: this is just a log line, not a JSON envelope'`),
    )
    expect(result.outcome).toBe('pass')
    expect(result.errorShapeIndicators).toBeUndefined()
  })

  it('matches with arbitrary whitespace between key and value (per-spec JSON tolerance)', async () => {
    const variants = [
      '{"isError":true}',
      '{"isError": true}',
      '{"isError" : true}',
      '{"isError"  :  true}',
    ]
    for (const variant of variants) {
      const result = await executeProbeOnHost(plainProbe(`echo '${variant}'`))
      expect(result.outcome, `failed on variant: ${variant}`).toBe('fail')
      expect(result.errorShapeIndicators).toBeDefined()
    }
  })
})
