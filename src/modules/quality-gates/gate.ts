/**
 * QualityGate interface definition.
 *
 * A quality gate evaluates output against a defined criterion,
 * supports retry logic, and returns structured results indicating
 * whether to proceed, retry, or escalate.
 */

import type { GateConfig, GateResult } from './types.js'

/**
 * A quality gate that evaluates output and manages retry logic.
 */
export interface QualityGate {
  /** Name of this gate (from config) */
  readonly name: string
  /**
   * Evaluate the given output.
   * - pass → `{ action: 'proceed', result: output }`
   * - fail, retries remain → `{ action: 'retry', issues, retriesRemaining }`
   * - fail, no retries → `{ action: 'warn', issues, retriesRemaining: 0 }`
   */
  evaluate(output: unknown): GateResult
  /** Reset the retry counter to 0 */
  reset(): void
  /** Access to gate configuration */
  readonly config: GateConfig
}
