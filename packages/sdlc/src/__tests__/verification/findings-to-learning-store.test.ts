/**
 * Unit tests for findings-to-learning-store — Story 74-2.
 *
 * Covers AC9 cases (a) through (e):
 *   (a) phantom-review check with status: 'fail' → root_cause: 'build-failure'
 *   (b) trivial-output check with status: 'fail' → root_cause: 'resource-exhaustion'
 *   (c) build check with status: 'fail' → root_cause: 'build-failure'
 *   (d) source-ac-fidelity check with status: 'warn' → Finding produced (warns inject)
 *   (e) Mock appendFinding; assert called with correct Finding shape
 *
 * Plus the explicit negative case (status: 'pass' produces zero findings),
 * unmapped check name skip behaviour, and the full ROOT_CAUSE_MAP coverage.
 *
 * Tests mock @substrate-ai/core's `appendFinding` so we never hit a real
 * adapter — keeps the unit suite hermetic and fast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { VerificationSummary } from '../../verification/types.js'

// vi.mock() is hoisted above imports — no module-level dependencies on
// resolved imports, only on the spy created via vi.hoisted.
const { appendFindingSpy } = vi.hoisted(() => ({
  appendFindingSpy: vi.fn(async () => {}),
}))

vi.mock('@substrate-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@substrate-ai/core')>()
  return {
    ...actual,
    appendFinding: appendFindingSpy,
  }
})

// Module under test — imported AFTER vi.mock so it picks up the mocked appendFinding.
import {
  injectVerificationFindings,
  buildFindingsFromSummary,
  ROOT_CAUSE_MAP,
} from '../../verification/findings-to-learning-store.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSummary(
  storyKey: string,
  checks: Array<{
    checkName: string
    status: 'pass' | 'warn' | 'fail'
    details?: string
  }>,
): VerificationSummary {
  const fullChecks = checks.map((c) => ({
    checkName: c.checkName,
    status: c.status,
    details: c.details ?? `${c.checkName} ${c.status} detail`,
    duration_ms: 1,
  }))
  const aggregate: 'pass' | 'warn' | 'fail' = fullChecks.some((c) => c.status === 'fail')
    ? 'fail'
    : fullChecks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'pass'
  return {
    storyKey,
    checks: fullChecks,
    status: aggregate,
    duration_ms: 1,
  }
}

/**
 * Build a fake DatabaseAdapter that records adapter operations. We don't
 * actually invoke its `query` method (the appendFinding spy is intercepted
 * at the module boundary), but the type must satisfy DatabaseAdapter so
 * `injectVerificationFindings` accepts it.
 */
function makeFakeAdapter(): DatabaseAdapter {
  return {
    backendType: 'memory',
    query: vi.fn(async () => []),
    exec: vi.fn(async () => {}),
    transaction: vi.fn(async (fn) => fn(makeFakeAdapter())),
    close: vi.fn(async () => {}),
    queryReadyStories: vi.fn(async () => []),
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  appendFindingSpy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// AC9 (a): phantom-review fail → build-failure
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — AC9(a): phantom-review fail', () => {
  it('produces a Finding with root_cause "build-failure" for phantom-review fail', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'phantom-review', status: 'fail', details: 'no code-review output' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-a', filesModified: ['packages/sdlc/src/foo.ts'] },
      makeFakeAdapter(),
    )

    expect(appendFindingSpy).toHaveBeenCalledTimes(1)
    const [, finding] = appendFindingSpy.mock.calls[0]!
    expect(finding.root_cause).toBe('build-failure')
    expect(finding.story_key).toBe('74-2')
    expect(finding.run_id).toBe('run-a')
    expect(finding.confidence).toBe('high')
    expect(finding.affected_files).toEqual(['packages/sdlc/src/foo.ts'])
  })
})

// ---------------------------------------------------------------------------
// AC9 (b): trivial-output fail → resource-exhaustion
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — AC9(b): trivial-output fail', () => {
  it('produces a Finding with root_cause "resource-exhaustion" for trivial-output fail', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'trivial-output', status: 'fail', details: 'output below threshold' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-b', filesModified: [] },
      makeFakeAdapter(),
    )

    expect(appendFindingSpy).toHaveBeenCalledTimes(1)
    const [, finding] = appendFindingSpy.mock.calls[0]!
    expect(finding.root_cause).toBe('resource-exhaustion')
    expect(finding.confidence).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// AC9 (c): build fail → build-failure
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — AC9(c): build fail', () => {
  it('produces a Finding with root_cause "build-failure" for build fail', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'build', status: 'fail', details: 'tsc error: TS2304' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-c', filesModified: ['packages/core/src/x.ts'] },
      makeFakeAdapter(),
    )

    expect(appendFindingSpy).toHaveBeenCalledTimes(1)
    const [, finding] = appendFindingSpy.mock.calls[0]!
    expect(finding.root_cause).toBe('build-failure')
    expect(finding.affected_files).toEqual(['packages/core/src/x.ts'])
  })
})

// ---------------------------------------------------------------------------
// AC9 (d): warns inject — not just fails
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — AC9(d): warns inject too', () => {
  it('produces a Finding for source-ac-fidelity warn (not just fail)', async () => {
    const summary = makeSummary('74-2', [
      {
        checkName: 'source-ac-fidelity',
        status: 'warn',
        details: 'epic file unreadable',
      },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-d', filesModified: [] },
      makeFakeAdapter(),
    )

    expect(appendFindingSpy).toHaveBeenCalledTimes(1)
    const [, finding] = appendFindingSpy.mock.calls[0]!
    expect(finding.root_cause).toBe('source-ac-drift')
    expect(finding.confidence).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// AC9 (e): appendFinding called with correct shape
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — AC9(e): appendFinding shape assertion', () => {
  it('invokes appendFinding with confidence=high, correct affected_files, and correct root_cause', async () => {
    const adapter = makeFakeAdapter()
    const summary = makeSummary('74-2', [
      { checkName: 'phantom-review', status: 'fail', details: 'phantom' },
    ])
    const filesModified = ['a.ts', 'b.ts']

    await injectVerificationFindings(summary, { runId: 'run-e', filesModified }, adapter)

    expect(appendFindingSpy).toHaveBeenCalledTimes(1)
    const [adapterArg, finding] = appendFindingSpy.mock.calls[0]!
    expect(adapterArg).toBe(adapter)
    expect(finding).toMatchObject({
      story_key: '74-2',
      run_id: 'run-e',
      root_cause: 'build-failure',
      affected_files: filesModified,
      confidence: 'high',
    })
    expect(typeof finding.id).toBe('string')
    expect(typeof finding.created_at).toBe('string')
    expect(finding.expires_after_runs).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Negative case: pass produces zero findings
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — pass status produces no findings', () => {
  it('does NOT call appendFinding when all checks pass', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'phantom-review', status: 'pass' },
      { checkName: 'build', status: 'pass' },
      { checkName: 'trivial-output', status: 'pass' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-pass', filesModified: ['x.ts'] },
      makeFakeAdapter(),
    )
    expect(appendFindingSpy).not.toHaveBeenCalled()
  })

  it('emits findings only for the failing/warning checks in a mixed summary', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'phantom-review', status: 'pass' },
      { checkName: 'build', status: 'fail', details: 'tsc error' },
      { checkName: 'trivial-output', status: 'pass' },
      { checkName: 'runtime-probes', status: 'warn', details: 'probe slow' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-mixed', filesModified: [] },
      makeFakeAdapter(),
    )
    // Two findings: build (fail) + runtime-probes (warn)
    expect(appendFindingSpy).toHaveBeenCalledTimes(2)
    const rootCauses = appendFindingSpy.mock.calls.map((call) => call[1].root_cause)
    expect(rootCauses).toContain('build-failure')
    expect(rootCauses).toContain('runtime-probe-fail')
  })
})

// ---------------------------------------------------------------------------
// Unmapped checks are skipped
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — unmapped check names', () => {
  it('skips checks whose name is not in ROOT_CAUSE_MAP', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'unknown-future-check', status: 'fail', details: 'whatever' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: 'run-skip', filesModified: ['z.ts'] },
      makeFakeAdapter(),
    )
    expect(appendFindingSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runId fallback
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — runId fallback', () => {
  it('falls back to "unknown" when runId is empty string', async () => {
    const summary = makeSummary('74-2', [
      { checkName: 'build', status: 'fail', details: 'tsc' },
    ])
    await injectVerificationFindings(
      summary,
      { runId: '', filesModified: [] },
      makeFakeAdapter(),
    )
    expect(appendFindingSpy).toHaveBeenCalledTimes(1)
    expect(appendFindingSpy.mock.calls[0]![1].run_id).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// Pure builder coverage — buildFindingsFromSummary
// ---------------------------------------------------------------------------

describe('buildFindingsFromSummary — pure builder', () => {
  it('returns one Finding per failing/warning mapped check', () => {
    const summary = makeSummary('74-2', [
      { checkName: 'phantom-review', status: 'fail' },
      { checkName: 'trivial-output', status: 'warn' },
      { checkName: 'build', status: 'pass' },
      { checkName: 'noise', status: 'fail' },
    ])
    const findings = buildFindingsFromSummary(summary, {
      runId: 'r1',
      filesModified: ['a.ts'],
    })
    expect(findings).toHaveLength(2)
    expect(findings.map((f) => f.root_cause).sort()).toEqual([
      'build-failure',
      'resource-exhaustion',
    ])
  })

  it('returns an empty array when there are no failing/warning checks', () => {
    const summary = makeSummary('74-2', [{ checkName: 'build', status: 'pass' }])
    expect(
      buildFindingsFromSummary(summary, { runId: 'r1', filesModified: [] }),
    ).toEqual([])
  })

  it('returns an empty array when the summary has no checks at all', () => {
    const summary: VerificationSummary = {
      storyKey: '74-2',
      checks: [],
      status: 'pass',
      duration_ms: 0,
    }
    expect(buildFindingsFromSummary(summary, { runId: 'r1', filesModified: [] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ROOT_CAUSE_MAP — full coverage of the AC2 mapping table
// ---------------------------------------------------------------------------

describe('ROOT_CAUSE_MAP — full AC2 coverage', () => {
  it.each([
    ['phantom-review', 'build-failure'],
    ['trivial-output', 'resource-exhaustion'],
    ['build', 'build-failure'],
    ['acceptance-criteria-evidence', 'ac-missing-evidence'],
    ['runtime-probes', 'runtime-probe-fail'],
    ['source-ac-fidelity', 'source-ac-drift'],
    ['cross-story-consistency', 'cross-story-concurrent-modification'],
  ])('maps "%s" → "%s"', (checkName, expectedRootCause) => {
    expect(ROOT_CAUSE_MAP[checkName]).toBe(expectedRootCause)
  })
})

// ---------------------------------------------------------------------------
// No-op when no findings to inject (don't acquire adapter)
// ---------------------------------------------------------------------------

describe('injectVerificationFindings — no-op fast path', () => {
  it('returns without invoking appendFinding when summary has no eligible checks', async () => {
    const summary = makeSummary('74-2', [{ checkName: 'build', status: 'pass' }])
    await injectVerificationFindings(
      summary,
      { runId: 'r1', filesModified: [] },
      makeFakeAdapter(),
    )
    expect(appendFindingSpy).not.toHaveBeenCalled()
  })
})
