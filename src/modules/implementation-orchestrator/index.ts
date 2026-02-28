/**
 * implementation-orchestrator module — Public API re-exports.
 *
 * Provides the ImplementationOrchestrator interface, factory function,
 * conflict detection, and all associated types.
 */

// ---------------------------------------------------------------------------
// Orchestrator interface and factory
// ---------------------------------------------------------------------------

export type { ImplementationOrchestrator } from './orchestrator.js'
export { createImplementationOrchestrator } from './orchestrator-impl.js'
export type { OrchestratorDeps } from './orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  OrchestratorState,
  StoryPhase,
  StoryState,
  OrchestratorConfig,
  OrchestratorStatus,
} from './types.js'

// ---------------------------------------------------------------------------
// Conflict detector
// ---------------------------------------------------------------------------

export { detectConflictGroups } from './conflict-detector.js'

// ---------------------------------------------------------------------------
// Methodology context seeding
// ---------------------------------------------------------------------------

export { seedMethodologyContext } from './seed-methodology-context.js'
export type { SeedResult } from './seed-methodology-context.js'

// ---------------------------------------------------------------------------
// Story discovery (fallback for projects without full pipeline)
// ---------------------------------------------------------------------------

export { parseStoryKeysFromEpics, discoverPendingStoryKeys } from './story-discovery.js'
