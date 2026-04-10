/**
 * VerificationPipeline — executes an ordered chain of VerificationCheck implementations.
 *
 * Story 51-1: Framework implementation.
 *
 * Design notes:
 * - No LLM calls in this file (FR-V9).
 * - Tier A checks always precede Tier B checks in registration order.
 * - Unhandled exceptions in check.run() are caught, logged at warn, and
 *   surfaced as status:'warn' results (AC6).
 * - Events are emitted via the injected TypedEventBus<SdlcEvents> (AC5).
 */

import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '../events.js'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationCheckResult,
  VerificationSummary,
} from './types.js'
import { PhantomReviewCheck } from './checks/phantom-review-check.js'
import { TrivialOutputCheck } from './checks/trivial-output-check.js'
import type { TrivialOutputCheckConfig } from './checks/trivial-output-check.js'
import { BuildCheck } from './checks/build-check.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the worst-case aggregate status across a list of check results.
 * Precedence: fail > warn > pass.
 */
function aggregateStatus(checks: VerificationCheckResult[]): 'pass' | 'warn' | 'fail' {
  let result: 'pass' | 'warn' | 'fail' = 'pass'
  for (const c of checks) {
    if (c.status === 'fail') return 'fail'
    if (c.status === 'warn') result = 'warn'
  }
  return result
}

// ---------------------------------------------------------------------------
// VerificationPipeline
// ---------------------------------------------------------------------------

/**
 * Runs an ordered chain of VerificationCheck implementations after each story dispatch.
 *
 * Checks are stored in registration order. When `run()` is called with `tier: 'A'`
 * only Tier A checks execute; when called with `tier: 'B'` only Tier B checks execute.
 * (Story 51-5 will invoke both tiers at the appropriate orchestration points.)
 */
export class VerificationPipeline {
  private readonly _bus: TypedEventBus<SdlcEvents>
  private readonly _checks: VerificationCheck[] = []

  /**
   * @param bus    Typed event bus for emitting verification events.
   * @param checks Optional initial list of checks to register at construction time.
   */
  constructor(bus: TypedEventBus<SdlcEvents>, checks: VerificationCheck[] = []) {
    this._bus = bus
    for (const check of checks) {
      this.register(check)
    }
  }

  /**
   * Register a VerificationCheck.
   *
   * Checks are stored in insertion order within their tier.
   * Tier A checks always run before Tier B checks regardless of registration order.
   */
  register(check: VerificationCheck): void {
    this._checks.push(check)
  }

  /**
   * Execute all checks matching the specified tier sequentially.
   *
   * AC2: Tier A checks execute in registration order.
   * AC4: Results are aggregated into a VerificationSummary.
   * AC5: verification:check-complete and verification:story-complete events are emitted.
   * AC6: Unhandled exceptions are caught and recorded as warn.
   *
   * @param context  Verification context for the story being verified.
   * @param tier     Which tier of checks to execute ('A' | 'B'). Defaults to 'A'.
   */
  async run(context: VerificationContext, tier: 'A' | 'B' = 'A'): Promise<VerificationSummary> {
    const pipelineStart = Date.now()
    const checks = this._checks.filter((c) => c.tier === tier)
    const checkResults: VerificationCheckResult[] = []

    for (const check of checks) {
      const checkStart = Date.now()
      let result: VerificationCheckResult

      try {
        const runResult = await check.run(context)
        result = {
          checkName: check.name,
          status: runResult.status,
          details: runResult.details,
          duration_ms: runResult.duration_ms,
        }
      } catch (err: unknown) {
        const elapsed = Date.now() - checkStart
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[verification-pipeline] check "${check.name}" threw an unhandled exception: ${message}\n`
        )
        result = {
          checkName: check.name,
          status: 'warn',
          details: message,
          duration_ms: elapsed,
        }
      }

      checkResults.push(result)

      // AC5: emit verification:check-complete after each check
      this._bus.emit('verification:check-complete', {
        storyKey: context.storyKey,
        checkName: result.checkName,
        status: result.status,
        details: result.details,
        duration_ms: result.duration_ms,
      })
    }

    const summary: VerificationSummary = {
      storyKey: context.storyKey,
      checks: checkResults,
      status: aggregateStatus(checkResults),
      duration_ms: Date.now() - pipelineStart,
    }

    // AC5: emit verification:story-complete with full summary
    this._bus.emit('verification:story-complete', summary)

    return summary
  }
}

// ---------------------------------------------------------------------------
// Default pipeline factory
// ---------------------------------------------------------------------------

/**
 * Create a VerificationPipeline pre-loaded with the canonical check set.
 *
 * Canonical Tier A check order (architecture section 3.5):
 *   1. PhantomReviewCheck — story 51-2  (runs first: unreviewed stories skipped)
 *   2. TrivialOutputCheck — story 51-3
 *   3. BuildCheck         — story 51-4
 *
 * @param bus    Typed event bus for verification events.
 * @param config Optional config (used to forward threshold to TrivialOutputCheck).
 */
export function createDefaultVerificationPipeline(
  bus: TypedEventBus<SdlcEvents>,
  config?: TrivialOutputCheckConfig
): VerificationPipeline {
  // Canonical Tier A order: 1→PhantomReview, 2→TrivialOutput, 3→Build (story 51-4)
  const checks: VerificationCheck[] = [
    new PhantomReviewCheck(),
    new TrivialOutputCheck(config),
    new BuildCheck(), // story 51-4: runs last in Tier A (expensive, 60s worst-case)
  ]
  return new VerificationPipeline(bus, checks)
}
