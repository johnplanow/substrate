/**
 * Dual-signal coordinator — evaluates code review and scenario signals together.
 *
 * Code review is the authoritative Phase 2 decision-maker.
 * Scenario score is a parallel signal used for monitoring and agreement tracking.
 *
 * Story 46-5.
 */

import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Code review verdict union.
 * Mirrors CodeReviewResult.verdict from story 43-5 without importing from @substrate-ai/sdlc
 * (ADR-003: factory must not compile-time-depend on sdlc).
 */
export type DualSignalVerdict =
  | 'SHIP_IT'
  | 'NEEDS_MINOR_FIXES'
  | 'NEEDS_MAJOR_REWORK'
  | 'LGTM_WITH_NOTES'

/** Whether the two signals agree on the pass/fail outcome. */
export type DualSignalAgreement = 'AGREE' | 'DISAGREE'

/**
 * Quality mode determines which signal is authoritative for goal gate decisions.
 * Story 46-6.
 */
export type QualityMode = 'code-review' | 'dual-signal' | 'scenario-primary' | 'scenario-only'

/**
 * Context key under which code review handlers store their verdict.
 * Used by the executor to read the verdict when emitting advisory events.
 * Story 46-6.
 */
export const CONTEXT_KEY_CODE_REVIEW_VERDICT = 'factory.codeReviewVerdict'

/**
 * Combined result of evaluating the code review verdict and scenario score.
 */
export interface DualSignalResult {
  codeReviewPassed: boolean
  scenarioPassed: boolean
  agreement: DualSignalAgreement
  /** Code review is always the authoritative decision in Phase 2. */
  authoritativeDecision: DualSignalVerdict
  score: number
  threshold: number
}

/**
 * Options for constructing a DualSignalCoordinator.
 */
export interface DualSignalCoordinatorOptions {
  eventBus: TypedEventBus<FactoryEvents>
  threshold: number
  /** Quality mode — when 'scenario-primary', also emits scenario:advisory-computed. Story 46-6. */
  qualityMode?: QualityMode
}

/**
 * Evaluates the dual signal on each story iteration and emits telemetry.
 */
export interface DualSignalCoordinator {
  evaluate(codeReviewVerdict: DualSignalVerdict, scenarioScore: number, runId: string): DualSignalResult
}

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Evaluate dual signals without side effects.
 *
 * `SHIP_IT` and `LGTM_WITH_NOTES` are treated as code review passes.
 * Code review verdict is always the authoritative decision.
 */
export function evaluateDualSignal(
  verdict: DualSignalVerdict,
  score: number,
  threshold: number,
): DualSignalResult {
  const codeReviewPassed = verdict === 'SHIP_IT' || verdict === 'LGTM_WITH_NOTES'
  const scenarioPassed = score >= threshold
  const agreement: DualSignalAgreement = codeReviewPassed === scenarioPassed ? 'AGREE' : 'DISAGREE'

  return {
    codeReviewPassed,
    scenarioPassed,
    agreement,
    authoritativeDecision: verdict,
    score,
    threshold,
  }
}

// ---------------------------------------------------------------------------
// Coordinator factory
// ---------------------------------------------------------------------------

/**
 * Create a DualSignalCoordinator that evaluates signals and emits
 * `scenario:score-computed` events on each call.
 *
 * When `options.qualityMode === 'scenario-primary'`, also emits
 * `scenario:advisory-computed` with the code review verdict as advisory info.
 * Story 46-6.
 */
export function createDualSignalCoordinator(options: DualSignalCoordinatorOptions): DualSignalCoordinator {
  return {
    evaluate(verdict: DualSignalVerdict, score: number, runId: string): DualSignalResult {
      const result = evaluateDualSignal(verdict, score, options.threshold)
      options.eventBus.emit('scenario:score-computed', {
        runId,
        score: result.score,
        threshold: result.threshold,
        passes: result.scenarioPassed,
        agreement: result.agreement,
        codeReviewPassed: result.codeReviewPassed,
        scenarioPassed: result.scenarioPassed,
        authoritativeDecision: result.authoritativeDecision,
      })
      // In scenario-primary mode, emit code review verdict as advisory — story 46-6.
      // The advisory event does not affect the gate decision; it is informational only.
      if (options.qualityMode === 'scenario-primary') {
        options.eventBus.emit('scenario:advisory-computed', {
          runId,
          verdict: result.authoritativeDecision,
          codeReviewPassed: result.codeReviewPassed,
          score: result.score,
          threshold: result.threshold,
          agreement: result.agreement,
        })
      }
      return result
    },
  }
}
