/**
 * Unit tests for VerificationFinding type + renderFindings helper — Story 55-1.
 *
 * Covers:
 * - VerificationFinding can be constructed with only required fields (AC1)
 * - VerificationFinding can carry the optional command/exitCode/tails/duration fields (AC1)
 * - renderFindings([]) returns '' (AC4)
 * - renderFindings([oneError, oneWarn]) produces a deterministic multi-line
 *   string with severity prefixes and preserves input order (AC3, AC6)
 */

import { describe, it, expect } from 'vitest'
import type { VerificationFinding } from '../findings.js'
import { renderFindings } from '../findings.js'

describe('VerificationFinding', () => {
  it('can be constructed with only the required fields', () => {
    const finding: VerificationFinding = {
      category: 'phantom-review',
      severity: 'error',
      message: 'reviewer produced no output',
    }

    expect(finding.category).toBe('phantom-review')
    expect(finding.severity).toBe('error')
    expect(finding.message).toBe('reviewer produced no output')
    // Optional fields are genuinely undefined when not supplied
    expect(finding.command).toBeUndefined()
    expect(finding.exitCode).toBeUndefined()
    expect(finding.stdoutTail).toBeUndefined()
    expect(finding.stderrTail).toBeUndefined()
    expect(finding.durationMs).toBeUndefined()
  })

  it('can carry the full set of optional command fields', () => {
    const finding: VerificationFinding = {
      category: 'build-error',
      severity: 'error',
      message: 'tsc --build failed (exit 2)',
      command: 'npm run build',
      exitCode: 2,
      stdoutTail: 'dist/index.js written\n',
      stderrTail: "error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.\n",
      durationMs: 1243,
    }

    expect(finding.command).toBe('npm run build')
    expect(finding.exitCode).toBe(2)
    expect(finding.stdoutTail).toContain('dist/index.js written')
    expect(finding.stderrTail).toContain('error TS2345')
    expect(finding.durationMs).toBe(1243)
  })
})

describe('renderFindings', () => {
  it('returns an empty string when given no findings', () => {
    expect(renderFindings([])).toBe('')
  })

  it('renders one finding as a single prefix + category + message line', () => {
    const out = renderFindings([
      { category: 'trivial-output', severity: 'error', message: '42 tokens < 100 threshold' },
    ])
    expect(out).toBe('ERROR [trivial-output] 42 tokens < 100 threshold')
  })

  it('renders multiple findings in input order, one per line, with correct severity prefixes', () => {
    const findings: VerificationFinding[] = [
      { category: 'build-error', severity: 'error', message: 'exit 2' },
      { category: 'ac-missing-evidence', severity: 'warn', message: 'AC3 unclaimed' },
      { category: 'telemetry', severity: 'info', message: 'cached run (no build attempted)' },
    ]
    const out = renderFindings(findings)

    expect(out).toBe(
      [
        'ERROR [build-error] exit 2',
        'WARN [ac-missing-evidence] AC3 unclaimed',
        'INFO [telemetry] cached run (no build attempted)',
      ].join('\n'),
    )
  })

  it('is deterministic — repeated calls on the same input produce identical output', () => {
    const findings: VerificationFinding[] = [
      { category: 'a', severity: 'error', message: 'first' },
      { category: 'b', severity: 'warn', message: 'second' },
    ]
    expect(renderFindings(findings)).toBe(renderFindings(findings))
  })
})
