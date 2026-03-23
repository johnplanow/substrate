/**
 * Unit tests for remediation context injection — story 45-7
 *
 * Tests cover:
 *  - formatScenarioDiff (AC2, AC3)
 *  - deriveFixScope (AC4, AC5)
 *  - buildRemediationContext (AC1, AC7)
 *  - injectRemediationContext / getRemediationContext (AC6)
 */

import { describe, it, expect } from 'vitest'
import type { ScenarioRunResult } from '../../events.js'
import type { IGraphContext } from '../../graph/types.js'
import {
  REMEDIATION_CONTEXT_KEY,
  formatScenarioDiff,
  deriveFixScope,
  buildRemediationContext,
  injectRemediationContext,
  getRemediationContext,
} from '../remediation.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScenarioRunResult(
  scenarios: Array<{ name: string; status: 'pass' | 'fail'; stderr?: string; stdout?: string }>,
): ScenarioRunResult {
  const results = scenarios.map((s) => ({
    ...s,
    exitCode: s.status === 'fail' ? 1 : 0,
    durationMs: 10,
    stderr: s.stderr ?? '',
    stdout: s.stdout ?? '',
  }))
  const failed = results.filter((s) => s.status === 'fail').length
  return {
    scenarios: results,
    summary: { total: results.length, passed: results.length - failed, failed },
    durationMs: 50,
  }
}

function makeContext(): IGraphContext {
  const store = new Map<string, unknown>()
  return {
    get: (k) => store.get(k),
    set: (k, v) => {
      store.set(k, v)
    },
    getString: (k, d = '') => String(store.get(k) ?? d),
    getNumber: (k, d = 0) => Number(store.get(k) ?? d),
    getBoolean: (k, d = false) => Boolean(store.get(k) ?? d),
    applyUpdates: (u) => {
      for (const [k, v] of Object.entries(u)) store.set(k, v)
    },
    snapshot: () => Object.fromEntries(store),
    clone: () => makeContext(),
  }
}

// ---------------------------------------------------------------------------
// formatScenarioDiff
// ---------------------------------------------------------------------------

describe('formatScenarioDiff', () => {
  it('AC2: single failed scenario includes name and stderr', () => {
    const results = makeScenarioRunResult([
      { name: 'login-empty-password', status: 'fail', stderr: 'password cannot be empty' },
    ])
    const diff = formatScenarioDiff(results)
    expect(diff).toContain('login-empty-password')
    expect(diff).toContain('password cannot be empty')
  })

  it('AC2 (multiple): two failed scenarios — both names and stderr messages appear', () => {
    const results = makeScenarioRunResult([
      { name: 'login-empty-password', status: 'fail', stderr: 'password cannot be empty' },
      { name: 'auth-null-token', status: 'fail', stderr: 'token is null' },
    ])
    const diff = formatScenarioDiff(results)
    expect(diff).toContain('login-empty-password')
    expect(diff).toContain('password cannot be empty')
    expect(diff).toContain('auth-null-token')
    expect(diff).toContain('token is null')
  })

  it('AC3: all scenarios passed returns "All scenarios passed"', () => {
    const results = makeScenarioRunResult([
      { name: 'login-success', status: 'pass' },
      { name: 'auth-valid', status: 'pass' },
    ])
    expect(formatScenarioDiff(results)).toBe('All scenarios passed')
  })

  it('AC3 (empty): empty scenarios array returns "All scenarios passed"', () => {
    const results = makeScenarioRunResult([])
    expect(formatScenarioDiff(results)).toBe('All scenarios passed')
  })

  it('AC2 (no stderr): failed scenario with empty stderr falls back to stdout', () => {
    const results = makeScenarioRunResult([
      { name: 'check-output', status: 'fail', stderr: '', stdout: 'error from stdout' },
    ])
    const diff = formatScenarioDiff(results)
    expect(diff).toContain('check-output')
    expect(diff).toContain('error from stdout')
  })

  it('AC2 (no output): failed scenario with both stderr and stdout empty uses "(no output)"', () => {
    const results = makeScenarioRunResult([{ name: 'silent-fail', status: 'fail', stderr: '', stdout: '' }])
    const diff = formatScenarioDiff(results)
    expect(diff).toContain('silent-fail')
    expect(diff).toContain('(no output)')
  })

  it('passes through scenarios — only failed ones appear in the diff', () => {
    const results = makeScenarioRunResult([
      { name: 'passing-scenario', status: 'pass' },
      { name: 'failing-scenario', status: 'fail', stderr: 'oops' },
    ])
    const diff = formatScenarioDiff(results)
    expect(diff).toContain('failing-scenario')
    expect(diff).not.toContain('passing-scenario')
  })
})

// ---------------------------------------------------------------------------
// deriveFixScope
// ---------------------------------------------------------------------------

describe('deriveFixScope', () => {
  it('AC4: two failures — result starts with "Fix 2 failing scenarios:" and contains both names', () => {
    const results = makeScenarioRunResult([
      { name: 'login-empty-password', status: 'fail' },
      { name: 'auth-null-token', status: 'fail' },
    ])
    const scope = deriveFixScope(results)
    expect(scope).toContain('Fix 2 failing scenarios:')
    expect(scope).toContain('login-empty-password')
    expect(scope).toContain('auth-null-token')
  })

  it('AC4 (singular): one failure uses singular "scenario"', () => {
    const results = makeScenarioRunResult([{ name: 'login-empty-password', status: 'fail' }])
    const scope = deriveFixScope(results)
    expect(scope).toBe('Fix 1 failing scenario: login-empty-password')
  })

  it('AC5: all scenarios passed returns ""', () => {
    const results = makeScenarioRunResult([
      { name: 'login-success', status: 'pass' },
      { name: 'auth-valid', status: 'pass' },
    ])
    expect(deriveFixScope(results)).toBe('')
  })

  it('AC5 (empty): empty scenarios array returns ""', () => {
    const results = makeScenarioRunResult([])
    expect(deriveFixScope(results)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildRemediationContext
// ---------------------------------------------------------------------------

describe('buildRemediationContext', () => {
  it('AC1: with full params — returned object has all 5 fields with matching values', () => {
    const scenarioResults = makeScenarioRunResult([
      { name: 'login-empty-password', status: 'fail', stderr: 'password cannot be empty' },
    ])
    const remediation = buildRemediationContext({
      previousFailureReason: 'goal gate unsatisfied',
      scenarioResults,
      iterationCount: 2,
      satisfactionScoreHistory: [0.4, 0.55],
    })
    expect(remediation.previousFailureReason).toBe('goal gate unsatisfied')
    expect(remediation.iterationCount).toBe(2)
    expect(remediation.satisfactionScoreHistory).toEqual([0.4, 0.55])
    expect(typeof remediation.scenarioDiff).toBe('string')
    expect(typeof remediation.fixScope).toBe('string')
    // All 5 fields present
    expect('previousFailureReason' in remediation).toBe(true)
    expect('scenarioDiff' in remediation).toBe(true)
    expect('iterationCount' in remediation).toBe(true)
    expect('satisfactionScoreHistory' in remediation).toBe(true)
    expect('fixScope' in remediation).toBe(true)
  })

  it('AC1 (no scenarioResults): omitted scenarioResults → scenarioDiff = "No scenario results available", fixScope = ""', () => {
    const remediation = buildRemediationContext({
      previousFailureReason: 'initial failure',
      iterationCount: 1,
      satisfactionScoreHistory: [0.3],
    })
    expect(remediation.scenarioDiff).toBe('No scenario results available')
    expect(remediation.fixScope).toBe('')
  })

  it('AC7: mutating original satisfactionScoreHistory after build does not affect stored copy', () => {
    const original = [0.4, 0.5, 0.55]
    const remediation = buildRemediationContext({
      previousFailureReason: 'goal gate unsatisfied',
      iterationCount: 3,
      satisfactionScoreHistory: original,
    })
    // Mutate the original array
    original.push(0.9)
    original[0] = 999
    // Stored copy should be unchanged
    expect(remediation.satisfactionScoreHistory).toEqual([0.4, 0.5, 0.55])
  })
})

// ---------------------------------------------------------------------------
// injectRemediationContext / getRemediationContext
// ---------------------------------------------------------------------------

describe('injectRemediationContext / getRemediationContext', () => {
  it('REMEDIATION_CONTEXT_KEY is exported and equals "convergence.remediation"', () => {
    expect(REMEDIATION_CONTEXT_KEY).toBe('convergence.remediation')
  })

  it('AC6: inject then get returns the same object', () => {
    const context = makeContext()
    const remediation = buildRemediationContext({
      previousFailureReason: 'test failure',
      iterationCount: 1,
      satisfactionScoreHistory: [0.6],
    })
    injectRemediationContext(context, remediation)
    const retrieved = getRemediationContext(context)
    expect(retrieved).toEqual(remediation)
  })

  it('AC6 (undefined): fresh context with no injection returns undefined', () => {
    const context = makeContext()
    expect(getRemediationContext(context)).toBeUndefined()
  })
})
