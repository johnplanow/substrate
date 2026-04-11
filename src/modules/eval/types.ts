// src/modules/eval/types.ts

/** Evaluation depth tier */
export type EvalDepth = 'standard' | 'deep'

/** Pipeline phases that can be evaluated */
export type EvalPhase = 'analysis' | 'planning' | 'solutioning' | 'implementation'

/** Output report format */
export type ReportFormat = 'table' | 'json' | 'markdown'

/** Options for running an eval */
export interface EvalOptions {
  depth: EvalDepth
  phases?: EvalPhase[]
  runId?: string
  concept?: string
  report: ReportFormat
  projectRoot: string
}

/** A single assertion to evaluate against an output */
export interface EvalAssertion {
  /** promptfoo assertion type */
  type: 'llm-rubric' | 'javascript' | 'similar'
  /** The rubric text, JS expression, or similarity target */
  value: string
  /** Score threshold for passing (0-1, default 0.7) */
  threshold?: number
  /** Human-readable label for this assertion */
  label?: string
}

/** Result of a single assertion evaluation */
export interface AssertionResult {
  name: string
  score: number
  pass: boolean
  reason: string
}

/** Result from a single evaluator layer */
export interface LayerResult {
  layer: string
  score: number
  pass: boolean
  assertions: AssertionResult[]
}

/** Aggregated eval result for a single phase */
export interface PhaseEvalResult {
  phase: EvalPhase
  score: number
  pass: boolean
  layers: LayerResult[]
  issues: string[]
  /** Human-readable feedback suitable for injecting into retry prompts */
  feedback: string
}

/** Full eval report across all phases */
export interface EvalReport {
  runId: string
  depth: EvalDepth
  timestamp: string
  phases: PhaseEvalResult[]
  overallScore: number
  pass: boolean
}

/** Default pass threshold for eval assertions */
export const DEFAULT_PASS_THRESHOLD = 0.7
