/**
 * Gate Registry — predefined gate types and custom gate registration.
 *
 * Provides factory functions for common gate types:
 * - ac-validation: checks that `ac_met` field is `yes` in sub-agent output
 * - test-coverage: checks that `tests.fail` is 0
 * - code-review-verdict: checks that `verdict` is `SHIP_IT`
 * - schema-compliance: validates output against a provided Zod schema
 *
 * Custom gates can be registered with `registerGateType(name, evaluatorFn)`.
 */

import type { ZodSchema } from 'zod'
import type { QualityGate } from './gate.js'
import { createQualityGate } from './gate-impl.js'
import type { EvaluatorFn, GateConfig } from './types.js'

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

const _registry: Map<string, EvaluatorFn> = new Map()

// ---------------------------------------------------------------------------
// Built-in evaluators
// ---------------------------------------------------------------------------

function acValidationEvaluator(output: unknown) {
  const o = output as Record<string, unknown>
  if (o?.ac_met === 'yes') {
    return { pass: true, issues: [], severity: 'info' as const }
  }
  return {
    pass: false,
    issues: [`ac_met is "${String(o?.ac_met ?? 'missing')}", expected "yes"`],
    severity: 'error' as const,
  }
}

function testCoverageEvaluator(output: unknown) {
  const o = output as Record<string, unknown>
  const tests = o?.tests as Record<string, unknown> | undefined
  const failCount = Number(tests?.fail ?? -1)
  if (failCount === 0) {
    return { pass: true, issues: [], severity: 'info' as const }
  }
  return {
    pass: false,
    issues: [`tests.fail is ${String(failCount)}, expected 0`],
    severity: 'error' as const,
  }
}

function codeReviewVerdictEvaluator(output: unknown) {
  const o = output as Record<string, unknown>
  if (o?.verdict === 'SHIP_IT') {
    return { pass: true, issues: [], severity: 'info' as const }
  }
  return {
    pass: false,
    issues: [`verdict is "${String(o?.verdict ?? 'missing')}", expected "SHIP_IT"`],
    severity: 'error' as const,
  }
}

function createSchemaComplianceEvaluator(schema: ZodSchema<unknown>): EvaluatorFn {
  return (output: unknown) => {
    const result = schema.safeParse(output)
    if (result.success) {
      return { pass: true, issues: [], severity: 'info' as const }
    }
    // Zod v4 uses .issues; v3 uses .errors — support both
    const zodIssues =
      (result.error as { issues?: { path: (string | number)[]; message: string }[] }).issues ??
      (result.error as { errors?: { path: (string | number)[]; message: string }[] }).errors ??
      []
    const issues = zodIssues.map((e) => `${e.path.join('.')}: ${e.message}`)
    return {
      pass: false,
      issues: issues.length > 0 ? issues : [result.error.message],
      severity: 'error' as const,
    }
  }
}

// ---------------------------------------------------------------------------
// Register built-in gates
// ---------------------------------------------------------------------------

_registry.set('ac-validation', acValidationEvaluator)
_registry.set('test-coverage', testCoverageEvaluator)
_registry.set('code-review-verdict', codeReviewVerdictEvaluator)
// schema-compliance is dynamic (requires a schema), handled in createGate

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for creating a gate via `createGate()`.
 */
export interface CreateGateOptions {
  /** Human-readable gate name (defaults to the type name) */
  name?: string
  /** Maximum retries before transitioning to 'warn' (defaults to 0) */
  maxRetries?: number
  /** Zod schema for 'schema-compliance' gate type */
  schema?: ZodSchema<unknown>
}

/**
 * Register a custom gate type.
 *
 * @param name - Unique type name for this gate
 * @param evaluatorFn - Evaluator function for the gate type
 */
export function registerGateType(name: string, evaluatorFn: EvaluatorFn): void {
  _registry.set(name, evaluatorFn)
}

/**
 * Create a QualityGate of the given registered type.
 *
 * @param type - Registered gate type name
 * @param options - Optional gate configuration overrides
 */
export function createGate(type: string, options: CreateGateOptions = {}): QualityGate {
  let evaluator: EvaluatorFn

  if (type === 'schema-compliance') {
    if (options.schema === undefined) {
      throw new Error('schema-compliance gate requires a Zod schema in options.schema')
    }
    evaluator = createSchemaComplianceEvaluator(options.schema)
  } else {
    const registered = _registry.get(type)
    if (registered === undefined) {
      throw new Error(`Unknown gate type: "${type}". Register it first with registerGateType().`)
    }
    evaluator = registered
  }

  const config: GateConfig = {
    name: options.name ?? type,
    maxRetries: options.maxRetries ?? 0,
    evaluator,
    schema: options.schema,
  }

  return createQualityGate(config)
}

/**
 * Get all registered gate type names.
 */
export function getRegisteredGateTypes(): string[] {
  return Array.from(_registry.keys())
}
