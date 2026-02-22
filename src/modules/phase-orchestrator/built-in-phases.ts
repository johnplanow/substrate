/**
 * Built-in phase definitions for the Phase Orchestrator.
 *
 * Defines the four standard phases of the BMAD pipeline:
 *   1. analysis      — no entry gates; exit gate: product-brief artifact exists
 *   2. planning      — entry: product-brief exists; exit: prd exists
 *   3. solutioning   — entry: prd exists; exit: architecture + stories exist
 *   4. implementation — entry: architecture + stories exist + readiness check
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { getArtifactByTypeForRun } from '../../persistence/queries/decisions.js'
import type { GateCheck, PhaseDefinition } from './types.js'

// ---------------------------------------------------------------------------
// Module-level logger (lightweight stderr-based for pipeline tracing)
// ---------------------------------------------------------------------------

function logPhase(message: string): void {
  process.stderr.write(`[phase-orchestrator] ${message}\n`)
}

// ---------------------------------------------------------------------------
// Shared gate check factory
// ---------------------------------------------------------------------------

/**
 * Create a gate check that verifies an artifact of the given type exists
 * for the specified phase in the current pipeline run.
 */
function createArtifactExistsGate(phase: string, artifactType: string): GateCheck {
  return {
    name: `${phase}:${artifactType}-exists`,
    check: async (db: BetterSqlite3Database, runId: string): Promise<boolean> => {
      const artifact = getArtifactByTypeForRun(db, runId, phase, artifactType)
      return artifact !== undefined
    },
    errorMessage: `Artifact '${artifactType}' from phase '${phase}' not found. The '${phase}' phase must complete and register this artifact first.`,
  }
}

// ---------------------------------------------------------------------------
// No-op lifecycle callbacks (default for phases without custom behavior)
// ---------------------------------------------------------------------------

async function noOp(_db: BetterSqlite3Database, _runId: string): Promise<void> {
  // No default behavior — phase-specific implementations override this in stories 11.2-11.4
}

// ---------------------------------------------------------------------------
// Analysis phase
// ---------------------------------------------------------------------------

/**
 * Create the Analysis phase definition.
 *
 * Entry gates: none (first phase — always can be entered)
 * Exit gates: 'product-brief' artifact must exist for this run
 */
export function createAnalysisPhaseDefinition(): PhaseDefinition {
  return {
    name: 'analysis',
    description:
      'Analyze the user concept and produce a product brief capturing requirements, constraints, and goals.',
    entryGates: [],
    exitGates: [createArtifactExistsGate('analysis', 'product-brief')],
    onEnter: async (_db: BetterSqlite3Database, runId: string): Promise<void> => {
      logPhase(`Analysis phase starting for run ${runId}`)
    },
    onExit: async (db: BetterSqlite3Database, runId: string): Promise<void> => {
      const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
      if (artifact === undefined) {
        logPhase(
          `Analysis phase exit WARNING: product-brief artifact not found for run ${runId}`,
        )
      } else {
        logPhase(
          `Analysis phase completed for run ${runId} — product-brief artifact registered: ${artifact.id}`,
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Planning phase
// ---------------------------------------------------------------------------

/**
 * Create the Planning phase definition.
 *
 * Entry gates: 'product-brief' artifact from analysis must exist
 * Exit gates: 'prd' artifact must exist for this run
 */
export function createPlanningPhaseDefinition(): PhaseDefinition {
  return {
    name: 'planning',
    description:
      'Develop a Product Requirements Document (PRD) from the product brief, defining features and acceptance criteria.',
    entryGates: [createArtifactExistsGate('analysis', 'product-brief')],
    exitGates: [createArtifactExistsGate('planning', 'prd')],
    onEnter: async (_db: BetterSqlite3Database, runId: string): Promise<void> => {
      logPhase(`Planning phase started for run ${runId}`)
    },
    onExit: async (db: BetterSqlite3Database, runId: string): Promise<void> => {
      const artifact = getArtifactByTypeForRun(db, runId, 'planning', 'prd')
      if (artifact === undefined) {
        logPhase(`Planning phase exit WARNING: prd artifact not found for run ${runId}`)
      } else {
        logPhase(
          `Planning phase completed for run ${runId} — prd artifact registered: ${artifact.id}`,
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Solutioning phase
// ---------------------------------------------------------------------------

/**
 * Create the Solutioning phase definition.
 *
 * Entry gates: 'prd' artifact from planning must exist
 * Exit gates: 'architecture' AND 'stories' artifacts must exist
 */
export function createSolutioningPhaseDefinition(): PhaseDefinition {
  return {
    name: 'solutioning',
    description:
      'Design the technical architecture and break down the PRD into implementation stories.',
    entryGates: [createArtifactExistsGate('planning', 'prd')],
    exitGates: [
      createArtifactExistsGate('solutioning', 'architecture'),
      createArtifactExistsGate('solutioning', 'stories'),
    ],
    onEnter: noOp,
    onExit: noOp,
  }
}

// ---------------------------------------------------------------------------
// Implementation phase
// ---------------------------------------------------------------------------

/**
 * Solutioning readiness gate — verifies both architecture and stories exist,
 * confirming the solutioning phase is fully complete before implementation begins.
 */
const solutioningReadinessGate: GateCheck = {
  name: 'solutioning-readiness',
  check: async (db: BetterSqlite3Database, runId: string): Promise<boolean> => {
    const architecture = getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')
    const stories = getArtifactByTypeForRun(db, runId, 'solutioning', 'stories')
    return architecture !== undefined && stories !== undefined
  },
  errorMessage:
    'Solutioning readiness check failed: both architecture and stories artifacts are required before implementation can begin.',
}

/**
 * Create the Implementation phase definition.
 *
 * Entry gates:
 *   - 'architecture' artifact from solutioning must exist
 *   - 'stories' artifact from solutioning must exist
 *   - solutioning-readiness gate (composite check)
 *
 * Exit gates: all stories completed (represented by 'implementation-complete' artifact)
 */
export function createImplementationPhaseDefinition(): PhaseDefinition {
  return {
    name: 'implementation',
    description: 'Execute the implementation stories using the ImplementationOrchestrator.',
    entryGates: [
      createArtifactExistsGate('solutioning', 'architecture'),
      createArtifactExistsGate('solutioning', 'stories'),
      solutioningReadinessGate,
    ],
    exitGates: [createArtifactExistsGate('implementation', 'implementation-complete')],
    onEnter: noOp,
    onExit: noOp,
  }
}

// ---------------------------------------------------------------------------
// Built-in phases registry
// ---------------------------------------------------------------------------

/**
 * Return all four built-in phase definitions in execution order.
 */
export function createBuiltInPhases(): PhaseDefinition[] {
  return [
    createAnalysisPhaseDefinition(),
    createPlanningPhaseDefinition(),
    createSolutioningPhaseDefinition(),
    createImplementationPhaseDefinition(),
  ]
}
