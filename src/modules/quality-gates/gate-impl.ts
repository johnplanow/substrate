/**
 * QualityGate implementation.
 *
 * Evaluates output using a configurable evaluator function,
 * tracks retry state, and returns structured gate results.
 */

import type { QualityGate } from './gate.js'
import type { GateConfig, GateResult } from './types.js'

/**
 * Concrete implementation of QualityGate.
 */
export class QualityGateImpl implements QualityGate {
  readonly config: GateConfig
  private _retryCount: number = 0

  constructor(config: GateConfig) {
    this.config = config
  }

  get name(): string {
    return this.config.name
  }

  /**
   * Evaluate the given output against this gate's evaluator function.
   *
   * Flow:
   * - Run evaluator
   * - If pass → return `{ action: 'proceed', result: output }`
   * - If fail and retries remain → increment counter, return `{ action: 'retry', ... }`
   * - If fail and no retries remain → return `{ action: 'warn', ... }`
   */
  evaluate(output: unknown): GateResult {
    const evaluation = this.config.evaluator(output)

    if (evaluation.pass) {
      return {
        action: 'proceed',
        issues: evaluation.issues,
        retriesRemaining: this.config.maxRetries - this._retryCount,
        result: output,
      }
    }

    // Failed — check retries
    const retriesRemaining = this.config.maxRetries - this._retryCount

    if (retriesRemaining > 0) {
      this._retryCount += 1
      return {
        action: 'retry',
        issues: evaluation.issues,
        retriesRemaining: retriesRemaining - 1,
      }
    }

    // No retries left — warn
    return {
      action: 'warn',
      issues: evaluation.issues,
      retriesRemaining: 0,
    }
  }

  /**
   * Reset the retry counter to 0, allowing re-use of this gate.
   */
  reset(): void {
    this._retryCount = 0
  }
}

/**
 * Factory function to create a QualityGate instance from config.
 */
export function createQualityGate(config: GateConfig): QualityGate {
  return new QualityGateImpl(config)
}
