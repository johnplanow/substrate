/**
 * TrivialOutputCheck — Story 51-3.
 *
 * Tier A verification check that flags story dispatches which produced
 * fewer output tokens than the configured threshold.  A very low output
 * token count is a strong signal that the agent exited early (e.g. hit a
 * maxTurns limit, encountered a fatal error, or did no real work).
 *
 * Architecture constraints (DC-6, FR-V9):
 * - No LLM calls.
 * - No shell invocations — pure in-process computation.
 * - Runs in Tier A: before BuildCheck, after PhantomReviewCheck.
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'
import { renderFindings } from '../findings.js'

// ---------------------------------------------------------------------------
// Default threshold
// ---------------------------------------------------------------------------

/**
 * Default minimum output-token count a story must produce to be
 * considered non-trivial.  Configurable via trivialOutputThreshold config field.
 */
export const DEFAULT_TRIVIAL_OUTPUT_THRESHOLD = 100

// ---------------------------------------------------------------------------
// TrivialOutputCheck config
// ---------------------------------------------------------------------------

/**
 * Minimal config interface for TrivialOutputCheck.
 * Uses a plain interface instead of Pick<SubstrateConfig, ...> to avoid
 * TypeScript errors when SubstrateConfig uses passthrough (unknown extra keys).
 */
export interface TrivialOutputCheckConfig {
  trivialOutputThreshold?: number
}

// ---------------------------------------------------------------------------
// TrivialOutputCheck
// ---------------------------------------------------------------------------

/**
 * Checks that a completed story dispatch produced at least `threshold` output
 * tokens.  Dispatches that produced fewer tokens are flagged as failures with
 * an actionable suggestion to re-run with increased maxTurns.
 *
 * AC1: fail when outputTokenCount < threshold.
 * AC2: details string includes "Re-run with increased maxTurns".
 * AC3: pass when outputTokenCount >= threshold.
 * AC4: threshold is configurable via trivialOutputThreshold config field.
 * AC5: warn (not fail) when outputTokenCount is undefined.
 * AC6: implements VerificationCheck with name='trivial-output', tier='A'.
 */
export class TrivialOutputCheck implements VerificationCheck {
  readonly name = 'trivial-output'
  readonly tier = 'A' as const

  private readonly threshold: number

  constructor(config?: TrivialOutputCheckConfig) {
    this.threshold = config?.trivialOutputThreshold ?? DEFAULT_TRIVIAL_OUTPUT_THRESHOLD
  }

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    // AC5: missing token data → warn, not fail
    if (context.outputTokenCount === undefined) {
      const findings: VerificationFinding[] = [
        {
          category: 'trivial-output',
          severity: 'warn',
          message: 'output token count unavailable — skipping check',
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const count = context.outputTokenCount

    // AC1 + AC2: below threshold → fail with actionable message.
    //
    // Story 61-2: when devStoryResult signals SUCCESS and files were
    // modified, the low last-dispatch token count is explained by
    // checkpoint recovery (Story 39-5/39-6) — earlier dispatches
    // already produced the work; the recovery dispatch is bookkeeping.
    // Surfaced live by the 60-12 dogfooding re-dispatch (run 4700c6e8,
    // 2026-04-27): dev produced 7 files of correct code across 4
    // dispatches, the 4th (recovery) returned 0 tokens, and the
    // verdict was VERIFICATION_FAILED despite the implementation being
    // demonstrably correct (17 tests pass, build clean, all 9 ACs met).
    //
    // When devStoryResult signals success + nontrivial files_modified,
    // downgrade fail → warn so the low-token signal stays visible
    // (not silently hidden) but doesn't block dispatches that
    // legitimately checkpoint-recovered.
    if (count < this.threshold) {
      const devResult = context.devStoryResult
      const recoveredAfterCheckpoint =
        devResult?.result === 'success' &&
        Array.isArray(devResult.files_modified) &&
        devResult.files_modified.length > 0

      if (recoveredAfterCheckpoint) {
        const findings: VerificationFinding[] = [
          {
            category: 'trivial-output',
            severity: 'warn',
            message:
              `output token count ${count} is below threshold ${this.threshold} ` +
              `but dev-story signals success with ${devResult.files_modified!.length} ` +
              `files modified — likely checkpoint-recovered dispatch (last dispatch ` +
              `was bookkeeping; earlier dispatches did the work). Verdict downgraded ` +
              `to warn so dispatches that legitimately recovered from checkpoint ` +
              `aren't blocked by the trivial-output gate.`,
          },
        ]
        return {
          status: 'warn',
          details: renderFindings(findings),
          duration_ms: Date.now() - start,
          findings,
        }
      }

      const findings: VerificationFinding[] = [
        {
          category: 'trivial-output',
          severity: 'error',
          message:
            `output token count ${count} is below threshold ${this.threshold}` +
            ` — Re-run with increased maxTurns`,
        },
      ]
      return {
        status: 'fail',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // AC3: at or above threshold → pass
    return {
      status: 'pass',
      details: `output token count ${count} meets threshold ${this.threshold}`,
      duration_ms: Date.now() - start,
      findings: [],
    }
  }
}
