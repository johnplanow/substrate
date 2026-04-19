/**
 * Unit tests for VerificationPipeline — Story 51-1 (AC7).
 *
 * Covers:
 * - Checks execute in registration order (AC2)
 * - Results included in summary with correct fields (AC4)
 * - Aggregate status: worst-case logic (AC4)
 * - Unhandled exceptions produce status:'warn' and pipeline continues (AC6)
 * - verification:check-complete emitted once per check (AC5)
 * - verification:story-complete emitted once per run (AC5)
 * - Tier B checks skipped when running tier:'A' (AC2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VerificationPipeline, createDefaultVerificationPipeline } from '../verification-pipeline.js'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationResult,
} from '../types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '../../events.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal VerificationContext for tests. */
function makeContext(overrides?: Partial<VerificationContext>): VerificationContext {
  return {
    storyKey: 'test-1',
    workingDir: '/tmp/test',
    commitSha: 'abc123',
    timeout: 5000,
    ...overrides,
  }
}

/** Build a mock VerificationCheck that resolves to a given result. */
function makeCheck(
  name: string,
  tier: 'A' | 'B',
  result: VerificationResult,
): VerificationCheck & { run: ReturnType<typeof vi.fn> } {
  return {
    name,
    tier,
    run: vi.fn().mockResolvedValue(result),
  }
}

/** Build a mock TypedEventBus<SdlcEvents>. */
function makeBus(): TypedEventBus<SdlcEvents> & {
  emit: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
} {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationPipeline', () => {
  let bus: ReturnType<typeof makeBus>
  let ctx: VerificationContext

  beforeEach(() => {
    bus = makeBus()
    ctx = makeContext()
  })

  // -------------------------------------------------------------------------
  // Execution order
  // -------------------------------------------------------------------------

  it('executes registered Tier A checks in registration order', async () => {
    const callOrder: string[] = []

    const checkA: VerificationCheck = {
      name: 'check-a',
      tier: 'A',
      run: vi.fn().mockImplementation(async () => {
        callOrder.push('check-a')
        return { status: 'pass' as const, details: 'ok', duration_ms: 0 }
      }),
    }
    const checkB: VerificationCheck = {
      name: 'check-b',
      tier: 'A',
      run: vi.fn().mockImplementation(async () => {
        callOrder.push('check-b')
        return { status: 'pass' as const, details: 'ok', duration_ms: 0 }
      }),
    }
    const checkC: VerificationCheck = {
      name: 'check-c',
      tier: 'A',
      run: vi.fn().mockImplementation(async () => {
        callOrder.push('check-c')
        return { status: 'pass' as const, details: 'ok', duration_ms: 0 }
      }),
    }

    const pipeline = new VerificationPipeline(bus)
    pipeline.register(checkA)
    pipeline.register(checkB)
    pipeline.register(checkC)

    await pipeline.run(ctx, 'A')

    expect(callOrder).toEqual(['check-a', 'check-b', 'check-c'])
  })

  // -------------------------------------------------------------------------
  // Summary content
  // -------------------------------------------------------------------------

  it('includes each check result in the summary with correct checkName, status, details, duration_ms', async () => {
    const check1 = makeCheck('lint', 'A', { status: 'pass', details: 'all good', duration_ms: 10 })
    const check2 = makeCheck('types', 'A', { status: 'warn', details: 'possible issue', duration_ms: 20 })

    const pipeline = new VerificationPipeline(bus, [check1, check2])
    const summary = await pipeline.run(ctx, 'A')

    expect(summary.checks).toHaveLength(2)

    const r1 = summary.checks[0]!
    expect(r1.checkName).toBe('lint')
    expect(r1.status).toBe('pass')
    expect(r1.details).toBe('all good')
    expect(typeof r1.duration_ms).toBe('number')
    expect(r1.duration_ms).toBeGreaterThanOrEqual(0)

    const r2 = summary.checks[1]!
    expect(r2.checkName).toBe('types')
    expect(r2.status).toBe('warn')
    expect(r2.details).toBe('possible issue')
    expect(typeof r2.duration_ms).toBe('number')
    expect(r2.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('summary storyKey matches context.storyKey', async () => {
    const pipeline = new VerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({ storyKey: '51-1' }), 'A')
    expect(summary.storyKey).toBe('51-1')
  })

  it('summary duration_ms is a non-negative number', async () => {
    const check = makeCheck('x', 'A', { status: 'pass', details: '', duration_ms: 5 })
    const pipeline = new VerificationPipeline(bus, [check])
    const summary = await pipeline.run(ctx, 'A')
    expect(typeof summary.duration_ms).toBe('number')
    expect(summary.duration_ms).toBeGreaterThanOrEqual(0)
  })

  // -------------------------------------------------------------------------
  // Aggregate status
  // -------------------------------------------------------------------------

  it('aggregate status is pass when all checks pass', async () => {
    const pipeline = new VerificationPipeline(bus, [
      makeCheck('a', 'A', { status: 'pass', details: '', duration_ms: 0 }),
      makeCheck('b', 'A', { status: 'pass', details: '', duration_ms: 0 }),
    ])
    const summary = await pipeline.run(ctx, 'A')
    expect(summary.status).toBe('pass')
  })

  it('aggregate status is warn when mix of pass and warn', async () => {
    const pipeline = new VerificationPipeline(bus, [
      makeCheck('a', 'A', { status: 'pass', details: '', duration_ms: 0 }),
      makeCheck('b', 'A', { status: 'warn', details: '', duration_ms: 0 }),
    ])
    const summary = await pipeline.run(ctx, 'A')
    expect(summary.status).toBe('warn')
  })

  it('aggregate status is fail when any check fails', async () => {
    const pipeline = new VerificationPipeline(bus, [
      makeCheck('a', 'A', { status: 'pass', details: '', duration_ms: 0 }),
      makeCheck('b', 'A', { status: 'warn', details: '', duration_ms: 0 }),
      makeCheck('c', 'A', { status: 'fail', details: 'broke', duration_ms: 0 }),
    ])
    const summary = await pipeline.run(ctx, 'A')
    expect(summary.status).toBe('fail')
  })

  it('aggregate status is pass for an empty check list', async () => {
    const pipeline = new VerificationPipeline(bus)
    const summary = await pipeline.run(ctx, 'A')
    expect(summary.status).toBe('pass')
  })

  // -------------------------------------------------------------------------
  // Exception handling (AC6)
  // -------------------------------------------------------------------------

  it('records status:warn when a check throws an unhandled exception', async () => {
    const throwingCheck: VerificationCheck = {
      name: 'exploding-check',
      tier: 'A',
      run: vi.fn().mockRejectedValue(new Error('kaboom')),
    }

    const pipeline = new VerificationPipeline(bus, [throwingCheck])
    const summary = await pipeline.run(ctx, 'A')

    expect(summary.checks).toHaveLength(1)
    expect(summary.checks[0]!.status).toBe('warn')
    expect(summary.checks[0]!.details).toBe('kaboom')
    expect(summary.checks[0]!.checkName).toBe('exploding-check')
  })

  it('continues executing subsequent checks after an exception', async () => {
    const throwingCheck: VerificationCheck = {
      name: 'throws',
      tier: 'A',
      run: vi.fn().mockRejectedValue(new Error('error')),
    }
    const laterCheck = makeCheck('later', 'A', { status: 'pass', details: 'ran', duration_ms: 0 })

    const pipeline = new VerificationPipeline(bus, [throwingCheck, laterCheck])
    const summary = await pipeline.run(ctx, 'A')

    expect(summary.checks).toHaveLength(2)
    expect(summary.checks[0]!.status).toBe('warn')
    expect(summary.checks[1]!.checkName).toBe('later')
    expect(summary.checks[1]!.status).toBe('pass')
  })

  it('exception details use the error message string', async () => {
    const throwingCheck: VerificationCheck = {
      name: 'throws',
      tier: 'A',
      run: vi.fn().mockRejectedValue(new Error('specific error message')),
    }
    const pipeline = new VerificationPipeline(bus, [throwingCheck])
    const summary = await pipeline.run(ctx, 'A')
    expect(summary.checks[0]!.details).toBe('specific error message')
  })

  // -------------------------------------------------------------------------
  // Events (AC5)
  // -------------------------------------------------------------------------

  it('emits verification:check-complete once per check with correct payload', async () => {
    const check = makeCheck('my-check', 'A', { status: 'pass', details: 'great', duration_ms: 5 })

    const pipeline = new VerificationPipeline(bus, [check])
    await pipeline.run(makeContext({ storyKey: 'ev-test' }), 'A')

    const checkCompleteEmits = (bus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]: [string]) => event === 'verification:check-complete',
    )

    expect(checkCompleteEmits).toHaveLength(1)
    const [, payload] = checkCompleteEmits[0] as [string, unknown]
    expect(payload).toMatchObject({
      storyKey: 'ev-test',
      checkName: 'my-check',
      status: 'pass',
      details: 'great',
    })
    expect(typeof (payload as { duration_ms: number }).duration_ms).toBe('number')
  })

  it('emits verification:check-complete for each check when multiple checks run', async () => {
    const pipeline = new VerificationPipeline(bus, [
      makeCheck('c1', 'A', { status: 'pass', details: '', duration_ms: 0 }),
      makeCheck('c2', 'A', { status: 'warn', details: '', duration_ms: 0 }),
      makeCheck('c3', 'A', { status: 'fail', details: '', duration_ms: 0 }),
    ])

    await pipeline.run(ctx, 'A')

    const checkCompleteEmits = (bus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]: [string]) => event === 'verification:check-complete',
    )
    expect(checkCompleteEmits).toHaveLength(3)
    expect((checkCompleteEmits[0]![1] as { checkName: string }).checkName).toBe('c1')
    expect((checkCompleteEmits[1]![1] as { checkName: string }).checkName).toBe('c2')
    expect((checkCompleteEmits[2]![1] as { checkName: string }).checkName).toBe('c3')
  })

  it('emits verification:story-complete once per run with full summary', async () => {
    const check = makeCheck('x', 'A', { status: 'pass', details: 'ok', duration_ms: 0 })
    const pipeline = new VerificationPipeline(bus, [check])

    const summary = await pipeline.run(makeContext({ storyKey: 'story-key' }), 'A')

    const storyCompleteEmits = (bus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]: [string]) => event === 'verification:story-complete',
    )
    expect(storyCompleteEmits).toHaveLength(1)
    const [, payload] = storyCompleteEmits[0] as [string, unknown]
    expect(payload).toEqual(summary)
  })

  // -------------------------------------------------------------------------
  // Tier filtering
  // -------------------------------------------------------------------------

  it('skips Tier B checks when running with tier:A', async () => {
    const tierA = makeCheck('tier-a', 'A', { status: 'pass', details: '', duration_ms: 0 })
    const tierB = makeCheck('tier-b', 'B', { status: 'fail', details: 'should not run', duration_ms: 0 })

    const pipeline = new VerificationPipeline(bus, [tierA, tierB])
    const summary = await pipeline.run(ctx, 'A')

    expect(summary.checks).toHaveLength(1)
    expect(summary.checks[0]!.checkName).toBe('tier-a')
    expect(tierB.run).not.toHaveBeenCalled()
  })

  it('skips Tier A checks when running with tier:B', async () => {
    const tierA = makeCheck('tier-a', 'A', { status: 'fail', details: 'should not run', duration_ms: 0 })
    const tierB = makeCheck('tier-b', 'B', { status: 'pass', details: '', duration_ms: 0 })

    const pipeline = new VerificationPipeline(bus, [tierA, tierB])
    const summary = await pipeline.run(ctx, 'B')

    expect(summary.checks).toHaveLength(1)
    expect(summary.checks[0]!.checkName).toBe('tier-b')
    expect(tierA.run).not.toHaveBeenCalled()
  })

  it('defaults to Tier A when no tier argument is provided', async () => {
    const tierA = makeCheck('tier-a', 'A', { status: 'pass', details: '', duration_ms: 0 })
    const tierB = makeCheck('tier-b', 'B', { status: 'fail', details: '', duration_ms: 0 })

    const pipeline = new VerificationPipeline(bus, [tierA, tierB])
    // Call without tier argument
    const summary = await pipeline.run(ctx)

    expect(summary.checks).toHaveLength(1)
    expect(summary.checks[0]!.checkName).toBe('tier-a')
  })

  // -------------------------------------------------------------------------
  // Constructor pre-registration
  // -------------------------------------------------------------------------

  it('accepts initial checks in constructor and runs them', async () => {
    const check = makeCheck('pre-reg', 'A', { status: 'pass', details: 'constructed', duration_ms: 1 })
    const pipeline = new VerificationPipeline(bus, [check])
    const summary = await pipeline.run(ctx, 'A')
    expect(summary.checks).toHaveLength(1)
    expect(summary.checks[0]!.checkName).toBe('pre-reg')
  })

  it('default Tier A pipeline includes AC evidence before build', async () => {
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({
      reviewResult: { rawOutput: 'review ok' },
      outputTokenCount: 500,
      storyContent: [
        '## Acceptance Criteria',
        '### AC1: Works',
      ].join('\n'),
      devStoryResult: {
        result: 'success',
        ac_met: ['AC1'],
        ac_failures: [],
        files_modified: ['src/foo.ts'],
        tests: 'pass',
      },
      buildCommand: '',
    }), 'A')

    expect(summary.checks.map((check) => check.checkName)).toEqual([
      'phantom-review',
      'trivial-output',
      'acceptance-criteria-evidence',
      'build',
      'runtime-probes',
    ])
  })
})
