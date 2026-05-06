/**
 * Decision Router — Phase D Story 54-2 (2026-04-05): original autonomy-gradient spec.
 * Story 72-1: --halt-on flag + Decision Router (this file).
 *   Classifies every halt-able decision by severity and enforces the chosen autonomy policy.
 *   Exports routeDecision(decision, policy) pure function for orchestrator consumption.
 * Epic 70: cross-story-race decision types (cross-story-race-recovered,
 *   cross-story-race-still-failed) motivate the registry pattern — different halt semantics
 *   based on severity (info vs critical).
 * Epic 73 (Recovery Engine) will register additional decision types via DECISION_SEVERITY_MAP.
 *
 * Story 72-2: --non-interactive flag consuming routeDecision for stdin suppression.
 * Enables strata + agent-mesh cross-project CI/CD invocation.
 */

// ---------------------------------------------------------------------------
// Types (AC1)
// ---------------------------------------------------------------------------

/**
 * Severity of a halt-able decision.
 * Controls which autonomy policies trigger a halt.
 */
export type Severity = 'info' | 'warning' | 'critical' | 'fatal'

/**
 * All known halt-able decision types (AC1).
 * Epic 73 (Recovery Engine) will extend this union with additional types.
 */
export type DecisionType =
  | 'cost-ceiling-exhausted'
  | 'build-verification-failure'
  | 'recovery-retry-attempt'
  | 're-scope-proposal'
  | 'scope-violation'
  | 'cross-story-race-recovered'
  | 'cross-story-race-still-failed'
  | 'pipeline-escalation'

// ---------------------------------------------------------------------------
// Decision classification table (AC3)
// ---------------------------------------------------------------------------

/**
 * Maps each known decision type to its severity level.
 *
 * Epic 70: cross-story-race-recovered (info — log only, no halt) and
 * cross-story-race-still-failed (critical — recovery exhausted, halt for operator)
 * motivate the registry pattern. Epic 73 (Recovery Engine) will register
 * additional decision types here.
 */
export const DECISION_SEVERITY_MAP: Record<DecisionType, Severity> = {
  'cost-ceiling-exhausted': 'critical',
  'build-verification-failure': 'critical',
  'recovery-retry-attempt': 'info',
  're-scope-proposal': 'warning',
  'scope-violation': 'fatal',
  'cross-story-race-recovered': 'info',
  'cross-story-race-still-failed': 'critical',
  // Story 72-2: post-run aggregate summary when stories escalated and --non-interactive
  // suppressed the operator halt prompt. Warning severity — individual escalations were
  // already classified at story level; this is the pipeline-level notification.
  'pipeline-escalation': 'warning',
}

// ---------------------------------------------------------------------------
// Default actions per decision type (AC5)
// ---------------------------------------------------------------------------

/**
 * Default action to apply when a decision does NOT trigger a halt.
 * Caller invokes the returned defaultAction string autonomously.
 */
const DEFAULT_ACTION_MAP: Record<string, string> = {
  'cost-ceiling-exhausted': 'skip-remaining',
  'build-verification-failure': 'escalate-without-halt',
  'recovery-retry-attempt': 'continue-autonomous',
  're-scope-proposal': 'escalate-without-halt',
  'scope-violation': 'abort-pipeline', // fatal — always halts regardless
  'cross-story-race-recovered': 'continue-autonomous',
  'cross-story-race-still-failed': 'escalate-without-halt',
  'pipeline-escalation': 'escalate-without-halt',
}

/** Fallback default action for unknown decision types. */
const DEFAULT_DEFAULT_ACTION = 'escalate-without-halt'

// ---------------------------------------------------------------------------
// routeDecision — pure function (AC1, AC4, AC5)
// ---------------------------------------------------------------------------

/**
 * Route a halt-able decision through the autonomy policy.
 *
 * Pure function — no I/O, no side effects. All orchestrator state interactions
 * remain in orchestrator-impl.ts.
 *
 * Halt policy logic (AC4):
 * - 'all':      halts on info | warning | critical | fatal
 * - 'critical': halts on critical | fatal  (default)
 * - 'none':     halts ONLY on fatal (scope violations bypass the autonomy-gradient
 *               policy — they are always halts regardless of the chosen policy)
 *
 * Fatal always halts regardless of policy — hard safety invariant, not configurable.
 *
 * Unknown decision types default to severity 'critical' (safe default, AC9e).
 *
 * @param decision - The decision type string to route
 * @param policy   - The autonomy policy from the --halt-on CLI flag
 * @returns { halt: boolean, defaultAction: string, severity: Severity }
 */
export function routeDecision(
  decision: string,
  policy: 'all' | 'critical' | 'none',
): { halt: boolean; defaultAction: string; severity: Severity } {
  // Look up severity — unknown types default to 'critical' (safe default, AC9e)
  const severity: Severity =
    (DECISION_SEVERITY_MAP as Record<string, Severity>)[decision] ?? 'critical'

  // Determine halt based on policy and severity (AC4)
  let halt: boolean
  switch (policy) {
    case 'all':
      // Halt on ALL severity tiers
      halt = true
      break
    case 'critical':
      // Halt on critical and fatal
      halt = severity === 'critical' || severity === 'fatal'
      break
    case 'none':
      // Halt ONLY on fatal — scope violations bypass the autonomy-gradient
      halt = severity === 'fatal'
      break
    default:
      // Safe fallback — treat as 'critical'
      halt = severity === 'critical' || severity === 'fatal'
  }

  // Fatal ALWAYS halts — hard safety invariant, not configurable (AC4)
  if (severity === 'fatal') {
    halt = true
  }

  const defaultAction = DEFAULT_ACTION_MAP[decision] ?? DEFAULT_DEFAULT_ACTION

  return { halt, defaultAction, severity }
}

// ---------------------------------------------------------------------------
// Exit code derivation (Story 72-2 — consumed by run.ts)
// ---------------------------------------------------------------------------

/**
 * Inputs for exit code derivation from pipeline completion results.
 * Used by the CLI layer to derive the machine-readable exit code (0/1/2)
 * for non-interactive CI/CD invocations.
 */
export interface PipelineOutcome {
  succeeded: string[]
  recovered?: string[]
  escalated: string[]
  failed: string[]
  total: number
  costCeilingExhausted?: boolean
  fatalHaltReached?: boolean
  orchestratorDied?: boolean
}

/**
 * Derive the machine-readable exit code from pipeline completion results.
 *
 * - Exit `0` when all stories succeeded (or recovered cleanly)
 * - Exit `1` when some stories escalated; run completed
 * - Exit `2` when run-level failure (cost ceiling, fatal halt, orchestrator died, stories failed)
 *
 * @param outcome - Pipeline completion outcome data
 * @returns 0 (success), 1 (escalated), or 2 (failure)
 */
export function deriveExitCode(outcome: PipelineOutcome): 0 | 1 | 2 {
  // Run-level failure — always exit 2
  if (
    outcome.failed.length > 0 ||
    outcome.costCeilingExhausted === true ||
    outcome.fatalHaltReached === true ||
    outcome.orchestratorDied === true
  ) {
    return 2
  }
  // Some stories escalated, none failed — exit 1 (run completed, needs operator review)
  if (outcome.escalated.length > 0 && outcome.failed.length === 0) {
    return 1
  }
  // All stories succeeded or recovered cleanly — exit 0
  return 0
}
