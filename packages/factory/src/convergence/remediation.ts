/**
 * Remediation context injection for the convergence loop.
 * Story 45-7: builds structured remediation context from failure data and
 * injects it into a retried node's IGraphContext.
 *
 * Architecture reference: Section 6.5 — Remediation Context fields
 *
 * Pure functions (`formatScenarioDiff`, `deriveFixScope`, `buildRemediationContext`)
 * have no I/O and no side effects.
 * Only `injectRemediationContext` mutates state (the IGraphContext).
 *
 * Consumed by:
 *   - Story 45-8 (convergence controller integration with executor)
 *   - CodergenBackend handlers (via `getRemediationContext`)
 */

import type { ScenarioRunResult } from '../events.js'
import type { IGraphContext } from '../graph/types.js'

// ---------------------------------------------------------------------------
// Constant
// ---------------------------------------------------------------------------

/**
 * The agreed key under which remediation context is stored in `IGraphContext`.
 * Namespaced under `convergence.` to avoid collision with user-defined context keys.
 * Story 45-8 writes this key; CodergenBackend handlers read it via `getRemediationContext()`.
 */
export const REMEDIATION_CONTEXT_KEY = 'convergence.remediation'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured remediation context injected into a retried node's IGraphContext.
 *
 * Architecture reference: Section 6.5 — the five fields below match the
 * factory convergence spec exactly. No additional fields should be added
 * without updating the architecture document.
 *
 * Fields:
 * - `previousFailureReason` — why the goal gate was not satisfied
 * - `scenarioDiff` — which scenarios failed and why (formatted from ScenarioRunResult)
 * - `iterationCount` — which retry attempt this is (starts at 1 on first retry)
 * - `satisfactionScoreHistory` — satisfaction scores from each previous iteration (oldest first)
 * - `fixScope` — focused instruction for the retried agent derived from failing scenario names
 */
export interface RemediationContext {
  previousFailureReason: string
  scenarioDiff: string
  iterationCount: number
  satisfactionScoreHistory: number[]
  fixScope: string
}

/**
 * Input parameters for `buildRemediationContext()`.
 *
 * `scenarioResults` is optional because the first retry in a pipeline may occur
 * before any scenario validation has run.
 */
export interface BuildRemediationContextParams {
  previousFailureReason: string
  scenarioResults?: ScenarioRunResult
  iterationCount: number
  satisfactionScoreHistory: number[]
}

// ---------------------------------------------------------------------------
// Pure formatting functions
// ---------------------------------------------------------------------------

/**
 * Formats a human-readable diff of failed scenarios from a ScenarioRunResult.
 *
 * This is a pure formatting function with no side effects. For each failed
 * scenario it produces a line `"- {name}: {stderr || stdout || '(no output)'}"`,
 * preferring stderr (most useful for debugging), falling back to stdout
 * (some tools write errors to stdout), then to the literal `'(no output)'`.
 *
 * Returns `"All scenarios passed"` when there are no failures.
 */
export function formatScenarioDiff(results: ScenarioRunResult): string {
  const failed = results.scenarios.filter((s) => s.status === 'fail')
  if (failed.length === 0) {
    return 'All scenarios passed'
  }
  const lines = failed.map((s) => {
    const output = s.stderr || s.stdout || '(no output)'
    return `- ${s.name}: ${output}`
  })
  return lines.join('\n')
}

/**
 * Derives a focused fix instruction string from failed scenarios.
 *
 * This function produces human-readable fix instructions for the retried agent.
 * Returns `"Fix {n} failing scenario{s}: {name1}, {name2}, ..."` when there are
 * failures, or `""` when all scenarios pass.
 *
 * Pluralization: singular "scenario" when n === 1, plural "scenarios" otherwise.
 */
export function deriveFixScope(results: ScenarioRunResult): string {
  const failed = results.scenarios.filter((s) => s.status === 'fail')
  if (failed.length === 0) {
    return ''
  }
  const n = failed.length
  const plural = n === 1 ? 'scenario' : 'scenarios'
  const names = failed.map((s) => s.name).join(', ')
  return `Fix ${n} failing ${plural}: ${names}`
}

// ---------------------------------------------------------------------------
// Builder function
// ---------------------------------------------------------------------------

/**
 * Builds a complete `RemediationContext` from the provided parameters.
 *
 * `scenarioResults` is optional — first-iteration retries may not have scenario
 * data yet. When omitted, `scenarioDiff` defaults to
 * `"No scenario results available"` and `fixScope` defaults to `""`.
 *
 * Stores `satisfactionScoreHistory` as a defensive copy (`[...params.satisfactionScoreHistory]`)
 * so external mutation of the caller's array does not corrupt the stored history.
 */
export function buildRemediationContext(params: BuildRemediationContextParams): RemediationContext {
  const scenarioDiff = params.scenarioResults
    ? formatScenarioDiff(params.scenarioResults)
    : 'No scenario results available'

  const fixScope = params.scenarioResults ? deriveFixScope(params.scenarioResults) : ''

  return {
    previousFailureReason: params.previousFailureReason,
    scenarioDiff,
    iterationCount: params.iterationCount,
    satisfactionScoreHistory: [...params.satisfactionScoreHistory],
    fixScope,
  }
}

// ---------------------------------------------------------------------------
// IGraphContext inject / retrieve helpers
// ---------------------------------------------------------------------------

/**
 * Injects a `RemediationContext` into an `IGraphContext` under `REMEDIATION_CONTEXT_KEY`.
 *
 * Called by the executor's retry loop before dispatching to the retried node —
 * story 45-8 wires this call into the graph executor.
 */
export function injectRemediationContext(
  context: IGraphContext,
  remediation: RemediationContext
): void {
  context.set(REMEDIATION_CONTEXT_KEY, remediation)
}

/**
 * Retrieves the `RemediationContext` previously injected via `injectRemediationContext`.
 *
 * Returns `undefined` when no remediation context has been injected yet.
 *
 * This is the accessor for `CodergenBackend` and other handlers that need to
 * read remediation context in their `generate()` methods.
 */
export function getRemediationContext(context: IGraphContext): RemediationContext | undefined {
  return context.get(REMEDIATION_CONTEXT_KEY) as RemediationContext | undefined
}
