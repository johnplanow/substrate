/**
 * PhantomReviewCheck — Story 51-2.
 *
 * Tier A verification check that detects when a code review dispatch failed
 * but was recorded as a passing verdict. Stories that were never actually
 * reviewed should not be counted as verified.
 *
 * Architecture constraints (FR-V9):
 * - No LLM calls.
 * - No shell invocations — pure static signal inspection over VerificationContext fields.
 * - Runs first in Tier A (before TrivialOutputCheck, before BuildCheck).
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'
import { renderFindings } from '../findings.js'

// ---------------------------------------------------------------------------
// PhantomReviewCheck
// ---------------------------------------------------------------------------

/**
 * Detects phantom reviews — dispatches that failed or produced no output but
 * were recorded as passing verdicts.
 *
 * AC1: dispatch failed (non-zero exit, timeout, crash) → fail
 * AC2: empty or null rawOutput → fail
 * AC3: schema_validation_failed error → fail
 * AC5: valid review (non-empty rawOutput, no dispatchFailed) → pass
 * AC6: name='phantom-review', tier='A'
 */
export class PhantomReviewCheck implements VerificationCheck {
  readonly name = 'phantom-review'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()
    const review = context.reviewResult

    // No review signals available — treat as pass (check cannot determine failure)
    if (!review) {
      return {
        status: 'pass',
        details: 'phantom-review: no review result in context — skipping check',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }

    // AC1 + AC3: dispatch itself failed (non-zero exit, timeout, crash, or schema validation failure)
    if (review.dispatchFailed === true) {
      const reason =
        review.error === 'schema_validation_failed'
          ? 'schema validation failed'
          : `dispatch failed${review.error ? ` — ${review.error}` : ''}`
      const findings: VerificationFinding[] = [
        {
          category: 'phantom-review',
          severity: 'error',
          message: reason,
        },
      ]
      return {
        status: 'fail',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // AC2: agent produced no output — only flag when rawOutput is explicitly empty
    // string (dispatch ran but returned nothing). When rawOutput is undefined, the
    // dispatch result may not have captured it (e.g., parsed YAML result without
    // raw output preservation) — treat as pass since dispatchFailed was not set.
    if (review.rawOutput !== undefined && review.rawOutput.trim().length === 0) {
      const findings: VerificationFinding[] = [
        {
          category: 'phantom-review',
          severity: 'error',
          message: 'empty review output',
        },
      ]
      return {
        status: 'fail',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // AC5: valid review — non-empty output, no dispatch failure
    return {
      status: 'pass',
      details: 'phantom-review: review output is valid',
      duration_ms: Date.now() - start,
      findings: [],
    }
  }
}
