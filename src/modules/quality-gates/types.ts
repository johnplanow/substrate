/**
 * Shared types for the Quality Gates module.
 */

import type { ZodSchema } from 'zod'

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Result of running a gate evaluator function against some output.
 */
export interface GateEvaluation {
  pass: boolean
  issues: string[]
  severity: 'info' | 'warning' | 'error'
}

/**
 * Function that evaluates an output and returns a GateEvaluation.
 */
export type EvaluatorFn = (output: unknown) => GateEvaluation

// ---------------------------------------------------------------------------
// Gate configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a QualityGate instance.
 */
export interface GateConfig {
  /** Human-readable name for this gate */
  name: string
  /** Maximum number of retries before transitioning to 'warn' */
  maxRetries: number
  /** Evaluator function that determines pass/fail */
  evaluator: EvaluatorFn
  /** Optional Zod schema for schema-compliance gate */
  schema?: ZodSchema<unknown>
}

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

/**
 * Result of running evaluate() on a QualityGate.
 */
export interface GateResult {
  /** Action to take based on evaluation outcome */
  action: 'proceed' | 'retry' | 'warn' | 'escalate'
  /** Issues reported by the evaluator */
  issues: string[]
  /** Number of retries remaining (0 means this is the last retry) */
  retriesRemaining: number
  /** The evaluated output (pass-through on proceed/warn) */
  result?: unknown
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/**
 * Issue reported from a gate within a pipeline run.
 */
export interface GateIssue {
  /** Name of the gate that raised this issue */
  gate: string
  /** Severity of the issue */
  severity: string
  /** Human-readable issue description */
  message: string
}

/**
 * Overall result of running a GatePipeline.
 */
export interface GatePipelineResult {
  /** Action to take: proceed if all gates pass, retry/escalate if any gate halts */
  action: 'proceed' | 'retry' | 'warn' | 'escalate'
  /** Number of gates that were executed */
  gatesRun: number
  /** Number of gates that passed */
  gatesPassed: number
  /** Accumulated issues from all gates */
  issues: GateIssue[]
}
