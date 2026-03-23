/**
 * Type definitions for the SDLC handler module.
 * Story 43-2.
 *
 * All types are defined locally — structurally compatible with monolith types
 * but not compile-time coupled to the monolith or @substrate-ai/factory.
 * See ADR-003: sdlc must NOT import from @substrate-ai/factory.
 */

// ---------------------------------------------------------------------------
// SDLC outcome types
// ---------------------------------------------------------------------------

/**
 * Structured outcome returned by every SDLC node handler.
 *
 * Structurally compatible with Outcome from @substrate-ai/factory via
 * TypeScript duck-typing — the CLI composition root can assign one to
 * the other without any sdlc→factory import.
 */
export interface SdlcOutcome {
  status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' | 'NEEDS_RETRY' | 'ESCALATE'
  failureReason?: string
  contextUpdates?: Record<string, unknown>
  notes?: string
  /**
   * Optional preferred edge label for the graph engine's edge selector.
   * The graph engine uses this to match the DOT edge `label` attribute when
   * choosing the next node after this handler returns.
   * e.g., 'SHIP_IT' routes to exit, 'NEEDS_FIXES' routes back to dev_story.
   */
  preferredLabel?: string
}

/**
 * SDLC node handler type alias.
 *
 * Structurally compatible with NodeHandler from @substrate-ai/factory:
 *   type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>
 *
 * TypeScript structural typing ensures the CLI composition root can assign
 * SdlcNodeHandler to NodeHandler without any sdlc→factory import.
 */
export type SdlcNodeHandler = (
  node: { id: string; label: string; prompt: string },
  context: { getString(key: string, defaultValue?: string): string },
  graph: unknown,
) => Promise<SdlcOutcome>

// ---------------------------------------------------------------------------
// Phase handler dependency types
// ---------------------------------------------------------------------------

/** Gate failure detail from a phase advance attempt. */
export interface GateFailure {
  gate: string
  error: string
}

/** Result of attempting to advance the pipeline phase. */
interface AdvancePhaseResult {
  advanced: boolean
  phase: string
  gateFailures?: GateFailure[]
}

/**
 * Result of evaluating entry gates before a phase dispatch.
 * Story 43-13.
 */
export interface EntryGateResult {
  passed: boolean
  failures?: GateFailure[]
}

/**
 * Local minimal PhaseOrchestrator interface.
 * Structurally compatible with the monolith PhaseOrchestrator.
 * `advancePhase` handles post-runner exit gates; `evaluateEntryGates` handles
 * pre-runner entry gates (added in story 43-13).
 */
export interface PhaseOrchestrator {
  advancePhase(runId: string): Promise<AdvancePhaseResult>
  evaluateEntryGates(runId: string): Promise<EntryGateResult>
}

/**
 * Phase runner function type.
 *
 * Structurally compatible with the monolith phase runner signatures
 * (runAnalysisPhase, runPlanningPhase, runSolutioningPhase) when called
 * with the monolith's PhaseDeps and phase-specific params.
 *
 * `deps` is typed as `unknown` because PhaseDeps is defined in the monolith
 * and this package has no need to inspect or modify it — it is passed through
 * as-is from SdlcPhaseHandlerDeps.phaseDeps.
 */
export type PhaseRunnerFn = (
  deps: unknown,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>

/**
 * Map of phase name → runner function.
 * Index signature allows additional phases to be registered without
 * modifying the type (e.g., ux-design in a follow-on story).
 */
export interface PhaseRunners {
  analysis: PhaseRunnerFn
  planning: PhaseRunnerFn
  solutioning: PhaseRunnerFn
  [key: string]: PhaseRunnerFn
}

/**
 * Dependency injection container for createSdlcPhaseHandler.
 *
 * Architecture note (ADR-003): phaseDeps is typed as `unknown` because
 * PhaseDeps is defined in the monolith. It is passed through opaquely to the
 * injected phase runner functions — this package has no need to inspect or
 * modify it. The CLI composition root injects the concrete PhaseDeps instance
 * at runtime.
 *
 * Phase runner functions are provided via `phases` to allow test injection of
 * mocks without vi.mock — preferred per ADR-003 (no monolith compile-time
 * coupling). At runtime the CLI composition root injects the real runners.
 */
export interface SdlcPhaseHandlerDeps {
  /** Phase orchestrator for gate evaluation and phase advancement. */
  orchestrator: PhaseOrchestrator
  /**
   * Phase dependencies — passed through to runner functions.
   * Typed as `unknown` to avoid compile-time coupling to monolith PhaseDeps.
   */
  phaseDeps: unknown
  /**
   * Whether to call orchestrator.advancePhase() after each runner completes.
   * Defaults to `true`. Pass `false` when managing phase advancement
   * externally or in integration scenarios where only the runner is tested.
   */
  advanceAfterRun?: boolean
  /**
   * Injectable phase runner functions — keyed by phase name (node.id).
   * At runtime, the CLI composition root provides the real monolith runners.
   * In tests, pass vi.fn() stubs directly (no vi.mock needed).
   */
  phases: PhaseRunners
}
