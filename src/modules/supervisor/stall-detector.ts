/**
 * StallDetector — phase-aware stall threshold computation.
 *
 * Pure class (no I/O, no side effects). All I/O lives in handleStallRecovery.
 * Consumed by supervisor.ts (Story 53-1) and extended by Story 53-2 (Multi-Signal).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Map of pipeline phase name → staleness threshold in seconds.
 * Unknown phases fall back to the maximum value in the config (safest default).
 */
export type StallThresholdConfig = Record<string, number>

export interface StallEvaluateInput {
  phase: string
  staleness_seconds: number
  timeoutMultiplier: number
}

export interface StallEvaluateResult {
  isStalled: boolean
  effectiveThreshold: number
  phase: string
  timeoutMultiplier: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default phase-aware stall thresholds (seconds).
 * Stored in the run manifest cli_flags so they can be overridden per-run.
 */
export const DEFAULT_STALL_THRESHOLDS: StallThresholdConfig = {
  'create-story': 300,
  'dev-story': 900,
  'code-review': 900,
  'test-plan': 600,
}

// ---------------------------------------------------------------------------
// StallDetector
// ---------------------------------------------------------------------------

export class StallDetector {
  constructor(private readonly thresholds: StallThresholdConfig) {}

  /**
   * Return the base threshold (seconds) for a given phase.
   * Falls back to the maximum configured value for unknown phases.
   */
  getThreshold(phase: string): number {
    if (Object.prototype.hasOwnProperty.call(this.thresholds, phase)) {
      return this.thresholds[phase]!
    }
    const values = Object.values(this.thresholds)
    return values.length > 0 ? Math.max(...values) : 600
  }

  /**
   * Return the effective threshold after applying the backend's timeout multiplier.
   */
  getEffectiveThreshold(phase: string, multiplier: number): number {
    return this.getThreshold(phase) * multiplier
  }

  /**
   * Evaluate whether the pipeline is stalled based on phase and staleness.
   */
  evaluate(input: StallEvaluateInput): StallEvaluateResult {
    const effectiveThreshold = this.getEffectiveThreshold(input.phase, input.timeoutMultiplier)
    return {
      isStalled: input.staleness_seconds >= effectiveThreshold,
      effectiveThreshold,
      phase: input.phase,
      timeoutMultiplier: input.timeoutMultiplier,
    }
  }

  /**
   * Return an adaptive poll interval based on the backend multiplier.
   *
   * When all effective thresholds exceed 600 s (e.g. Codex with 3× multiplier),
   * the poll interval is doubled to reduce unnecessary overhead.
   */
  getAdaptivePollInterval(baseSeconds: number, multiplier: number): number {
    const values = Object.values(this.thresholds)
    if (values.length === 0) return baseSeconds
    const minEffective = Math.min(...values.map((v) => v * multiplier))
    return minEffective > 600 ? baseSeconds * 2 : baseSeconds
  }
}
