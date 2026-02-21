/**
 * GatePipeline — chains multiple QualityGates together.
 *
 * Gates execute in order. If any gate returns action 'retry' or 'escalate',
 * the pipeline halts immediately and returns that action. If all gates pass
 * (or warn), the pipeline returns 'proceed'.
 */

import type { QualityGate } from './gate.js'
import type { GateIssue, GatePipelineResult } from './types.js'

/**
 * A pipeline that runs a sequence of QualityGates in order.
 */
export interface GatePipeline {
  /**
   * Run all gates in order against the given output.
   * Halts on first 'retry' or 'escalate' result.
   */
  run(output: unknown): GatePipelineResult
}

/**
 * Concrete GatePipeline implementation.
 */
export class GatePipelineImpl implements GatePipeline {
  private readonly _gates: QualityGate[]

  constructor(gates: QualityGate[]) {
    this._gates = gates
  }

  run(output: unknown): GatePipelineResult {
    let gatesRun = 0
    let gatesPassed = 0
    const issues: GateIssue[] = []

    for (const gate of this._gates) {
      gatesRun += 1
      const result = gate.evaluate(output)

      // Accumulate issues from all gates
      for (const message of result.issues) {
        issues.push({ gate: gate.name, severity: 'error', message })
      }

      if (result.action === 'proceed') {
        gatesPassed += 1
        // Continue to next gate
      } else if (result.action === 'warn') {
        // Warn but continue — count as "run" but not "passed"
        // Add issues with warning severity
        // (issues already added above, but adjust severity)
        const startIdx = issues.length - result.issues.length
        for (let i = startIdx; i < issues.length; i++) {
          issues[i] = { ...issues[i], severity: 'warning' }
        }
      } else {
        // 'retry' or 'escalate' — halt the pipeline
        return {
          action: result.action,
          gatesRun,
          gatesPassed,
          issues,
        }
      }
    }

    return {
      action: 'proceed',
      gatesRun,
      gatesPassed,
      issues,
    }
  }
}

/**
 * Factory function to create a GatePipeline from an array of QualityGates.
 */
export function createGatePipeline(gates: QualityGate[]): GatePipeline {
  return new GatePipelineImpl(gates)
}
