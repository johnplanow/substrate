/**
 * Verification finding count roll-up — Story 55-3b.
 *
 * Collapses every finding across every check in a StoredVerificationSummary
 * into a `{error, warn, info}` triple, suitable for per-story surfacing in
 * the status/metrics CLI JSON payloads.
 *
 * Intentionally pure: no I/O, no logger, no throw. Fits cleanly in the
 * run-model package so both the status and metrics commands (and any
 * future consumer) can share a single implementation and one set of tests.
 */

import type { StoredVerificationSummary } from './verification-result.js'

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * Per-severity roll-up of verification findings for a single story.
 *
 * Every field is always populated. Consumers should not have to test for
 * presence; a story that emitted zero findings (or whose checks pre-date
 * the structured-finding migration) reports `{ error: 0, warn: 0, info: 0 }`.
 */
export interface VerificationFindingsCounts {
  error: number
  warn: number
  info: number
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/** Zero-counts object used as the default return value and as the identity
 *  element in consumer-side accumulations. */
export const ZERO_FINDING_COUNTS: Readonly<VerificationFindingsCounts> = Object.freeze({
  error: 0,
  warn: 0,
  info: 0,
})

/**
 * Sum findings across every check in the summary, grouped by severity.
 *
 * Backward-compatible — when the summary is `undefined`, or a check has no
 * `findings` field (legacy manifests written before Story 55-2 migrated the
 * checks), the absent arrays contribute 0 to every severity. No severity
 * ever reports undefined.
 */
export function rollupFindingCounts(
  summary: StoredVerificationSummary | undefined | null,
): VerificationFindingsCounts {
  if (summary === undefined || summary === null) {
    return { ...ZERO_FINDING_COUNTS }
  }
  let error = 0
  let warn = 0
  let info = 0
  for (const check of summary.checks) {
    const findings = check.findings
    if (findings === undefined) continue
    for (const finding of findings) {
      switch (finding.severity) {
        case 'error':
          error += 1
          break
        case 'warn':
          warn += 1
          break
        case 'info':
          info += 1
          break
        // No default — the schema rejects other severities at parse time, so
        // an unknown value at runtime would indicate bit-rot, not user data.
      }
    }
  }
  return { error, warn, info }
}
