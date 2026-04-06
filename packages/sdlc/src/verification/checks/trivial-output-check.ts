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
  VerificationResult,
} from '../types.js'

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
      return {
        status: 'warn',
        details: 'trivial-output: output token count unavailable — skipping check',
        duration_ms: Date.now() - start,
      }
    }

    const count = context.outputTokenCount

    // AC1 + AC2: below threshold → fail with actionable message
    if (count < this.threshold) {
      return {
        status: 'fail',
        details:
          `trivial-output: output token count ${count} is below threshold ${this.threshold}` +
          ` — Re-run with increased maxTurns`,
        duration_ms: Date.now() - start,
      }
    }

    // AC3: at or above threshold → pass
    return {
      status: 'pass',
      details: `output token count ${count} meets threshold ${this.threshold}`,
      duration_ms: Date.now() - start,
    }
  }
}
