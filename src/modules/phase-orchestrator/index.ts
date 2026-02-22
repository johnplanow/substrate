/**
 * phase-orchestrator module — Public API re-exports.
 *
 * Provides the PhaseOrchestrator interface, factory function,
 * built-in phase definitions, and all associated types.
 */

// ---------------------------------------------------------------------------
// Orchestrator interface and factory
// ---------------------------------------------------------------------------

export type { PhaseOrchestrator } from './phase-orchestrator.js'
export { createPhaseOrchestrator } from './phase-orchestrator-impl.js'
export type { PhaseOrchestratorDeps } from './phase-orchestrator-impl.js'
export { runGates, serializePhaseHistory, deserializePhaseHistory } from './phase-orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  GateCheck,
  PhaseDefinition,
  PhaseHistoryEntry,
  PhaseRunStatus,
  GateRunResult,
  AdvancePhaseResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Built-in phases
// ---------------------------------------------------------------------------

export {
  createBuiltInPhases,
  createAnalysisPhaseDefinition,
  createPlanningPhaseDefinition,
  createSolutioningPhaseDefinition,
  createImplementationPhaseDefinition,
} from './built-in-phases.js'

// ---------------------------------------------------------------------------
// Phase implementations
// ---------------------------------------------------------------------------

export { runAnalysisPhase } from './phases/analysis.js'
export { runPlanningPhase } from './phases/planning.js'
export { runSolutioningPhase } from './phases/solutioning.js'

export type {
  PhaseDeps,
  AnalysisPhaseParams,
  AnalysisResult,
  ProductBrief,
  PlanningPhaseParams,
  PlanningResult,
  PlanningOutput,
  FunctionalRequirement,
  NonFunctionalRequirement,
  UserStory,
  SolutioningPhaseParams,
  SolutioningResult,
  ArchitectureDecision,
  EpicDefinition,
  StoryDefinition,
} from './phases/types.js'

export {
  ProductBriefSchema,
  AnalysisOutputSchema,
  PlanningOutputSchema,
  FunctionalRequirementSchema,
  NonFunctionalRequirementSchema,
  UserStorySchema,
  ArchitectureDecisionSchema,
  StoryDefinitionSchema,
  EpicDefinitionSchema,
  ArchitectureOutputSchema,
  StoryGenerationOutputSchema,
} from './phases/schemas.js'
