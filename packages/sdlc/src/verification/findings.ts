/**
 * VerificationFinding — structured per-issue payload emitted by verification checks.
 *
 * Replaces the ad-hoc "stuff everything into VerificationResult.details" pattern
 * that preceded it: every downstream consumer (retry prompts, run manifest,
 * post-run analysis) used to string-parse a free-form blob that the emitting
 * check never promised a schema for. With findings, each issue is an
 * addressable record the pipeline can act on individually.
 *
 * The {command, exitCode, stdoutTail, stderrTail} optional fields are reserved
 * primarily for Phase 2 runtime probes — they cost nothing on the current four
 * Tier A checks (which leave them undefined) but let probe output flow through
 * the same shape without a second refactor.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Severity of a single verification finding.
 *
 * - `error` → verification check returns `fail` (the aggregate status of the
 *   containing VerificationResult is `fail`).
 * - `warn`  → verification check returns `warn`.
 * - `info`  → a finding captured for diagnostic/telemetry purposes that does
 *   not itself raise the containing VerificationResult's status.
 */
export type VerificationFindingSeverity = 'error' | 'warn' | 'info'

/**
 * One structured issue emitted by a verification check.
 *
 * `category` is the stable machine-readable identifier consumers filter/group
 * on (e.g. `'build-error'`, `'ac-missing-evidence'`, `'phantom-review'`,
 * `'trivial-output'`). New categories should be introduced alongside the
 * check that emits them.
 */
export interface VerificationFinding {
  /** Stable machine-readable category (e.g. `'build-error'`). */
  category: string
  /** Severity classification for aggregate-status computation. */
  severity: VerificationFindingSeverity
  /** Single-line human-readable summary. */
  message: string
  /** The command that produced this finding, if any. Reserved primarily for Phase 2 runtime probes. */
  command?: string
  /** Exit status of `command`, if applicable. */
  exitCode?: number
  /** Last ≤ 4 KiB of stdout from `command`, if captured. */
  stdoutTail?: string
  /** Last ≤ 4 KiB of stderr from `command`, if captured. */
  stderrTail?: string
  /** Wall-clock milliseconds the producing action took. */
  durationMs?: number
  /**
   * Story 60-15: when this finding came from a runtime-probe failure,
   * records who authored the failing probe (`'probe-author'` if Epic 60
   * Phase 2's probe-author phase appended it, `'create-story-ac-transfer'`
   * for the legacy AC-transfer path). Absent for findings from other
   * checks (build, phantom-review, ac-evidence, etc.). Persisted on the
   * stored finding so post-run analysis can compute byAuthor breakdowns
   * and the catch-rate KPI's per-author attribution.
   */
  _authoredBy?: 'probe-author' | 'create-story-ac-transfer'
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SEVERITY_PREFIX: Record<VerificationFindingSeverity, string> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
}

/**
 * Render a list of findings into the multi-line human-readable string that
 * populates VerificationResult.details. One line per finding:
 *
 *   `${PREFIX} [${category}] ${message}`
 *
 * Checks that migrate to the findings-first pattern call this helper to derive
 * `details` from the findings they emit, guaranteeing the two stay in sync.
 */
export function renderFindings(findings: VerificationFinding[]): string {
  if (findings.length === 0) return ''
  return findings
    .map((f) => `${SEVERITY_PREFIX[f.severity]} [${f.category}] ${f.message}`)
    .join('\n')
}
