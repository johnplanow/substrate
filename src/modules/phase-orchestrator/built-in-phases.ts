/**
 * Built-in phase definitions for the Phase Orchestrator.
 *
 * Defines the standard phases of the BMAD pipeline:
 *   0. research      — optional; no entry gates (first phase when enabled); exit: research-findings artifact exists
 *   1. analysis      — no entry gates (or research-findings when research enabled); exit gate: product-brief artifact exists
 *   2. planning      — entry: product-brief exists; exit: prd exists
 *   3. ux-design     — optional; entry: prd exists; exit: ux-design artifact exists
 *   4. solutioning   — entry: prd exists (+ ux-design when enabled); exit: architecture + stories exist
 *   5. implementation — entry: architecture + stories exist + readiness check
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
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
    check: async (db: DatabaseAdapter, runId: string): Promise<boolean> => {
      const artifact = await getArtifactByTypeForRun(db, runId, phase, artifactType)
      return artifact !== undefined
    },
    errorMessage: `Artifact '${artifactType}' from phase '${phase}' not found. The '${phase}' phase must complete and register this artifact first.`,
  }
}

// ---------------------------------------------------------------------------
// No-op lifecycle callbacks (default for phases without custom behavior)
// ---------------------------------------------------------------------------

async function noOp(_db: DatabaseAdapter, _runId: string): Promise<void> {
  // No default behavior — phase-specific implementations override this in stories 11.2-11.4
}

// ---------------------------------------------------------------------------
// Research phase (optional)
// ---------------------------------------------------------------------------

/**
 * Create the Research phase definition.
 *
 * Entry gates: empty array (research is always the pipeline entrypoint when enabled)
 * Exit gates: 'research-findings' artifact must exist for this run
 *
 * This phase is inserted before analysis when research is enabled in the pack
 * manifest (`research: true`) or via the `--research` CLI flag.
 */
export function createResearchPhaseDefinition(): PhaseDefinition {
  return {
    name: 'research',
    description:
      'Conduct pre-analysis research: market landscape, competitive analysis, technical feasibility, and synthesized findings.',
    entryGates: [],
    exitGates: [createArtifactExistsGate('research', 'research-findings')],
    onEnter: async (_db: DatabaseAdapter, runId: string): Promise<void> => {
      logPhase(`Research phase starting for run ${runId}`)
    },
    onExit: async (db: DatabaseAdapter, runId: string): Promise<void> => {
      const artifact = await getArtifactByTypeForRun(db, runId, 'research', 'research-findings')
      if (artifact === undefined) {
        logPhase(
          `Research phase exit WARNING: research-findings artifact not found for run ${runId}`
        )
      } else {
        logPhase(
          `Research phase completed for run ${runId} — research-findings artifact registered: ${artifact.id}`
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Analysis phase
// ---------------------------------------------------------------------------

/**
 * Create the Analysis phase definition.
 *
 * Entry gates: none by default (first phase — always can be entered);
 *              when research is enabled, requires 'research-findings' artifact
 * Exit gates: 'product-brief' artifact must exist for this run
 */
export function createAnalysisPhaseDefinition(options?: {
  requiresResearch?: boolean
}): PhaseDefinition {
  const entryGates =
    options?.requiresResearch === true
      ? [createArtifactExistsGate('research', 'research-findings')]
      : []
  return {
    name: 'analysis',
    description:
      'Analyze the user concept and produce a product brief capturing requirements, constraints, and goals.',
    entryGates,
    exitGates: [createArtifactExistsGate('analysis', 'product-brief')],
    onEnter: async (_db: DatabaseAdapter, runId: string): Promise<void> => {
      logPhase(`Analysis phase starting for run ${runId}`)
    },
    onExit: async (db: DatabaseAdapter, runId: string): Promise<void> => {
      const artifact = await getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
      if (artifact === undefined) {
        logPhase(`Analysis phase exit WARNING: product-brief artifact not found for run ${runId}`)
      } else {
        logPhase(
          `Analysis phase completed for run ${runId} — product-brief artifact registered: ${artifact.id}`
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
    onEnter: async (_db: DatabaseAdapter, runId: string): Promise<void> => {
      logPhase(`Planning phase started for run ${runId}`)
    },
    onExit: async (db: DatabaseAdapter, runId: string): Promise<void> => {
      const artifact = await getArtifactByTypeForRun(db, runId, 'planning', 'prd')
      if (artifact === undefined) {
        logPhase(`Planning phase exit WARNING: prd artifact not found for run ${runId}`)
      } else {
        logPhase(
          `Planning phase completed for run ${runId} — prd artifact registered: ${artifact.id}`
        )
      }
    },
  }
}

// ---------------------------------------------------------------------------
// UX Design phase (optional)
// ---------------------------------------------------------------------------

/**
 * Create the UX Design phase definition.
 *
 * Entry gates: 'prd' artifact from planning must exist
 * Exit gates: 'ux-design' artifact must exist for this run
 *
 * This phase is inserted between planning and solutioning when UX design is
 * enabled in the pack manifest (`uxDesign: true`).
 */
export function createUxDesignPhaseDefinition(): PhaseDefinition {
  return {
    name: 'ux-design',
    description:
      'Design the user experience: personas, core experience vision, design system, visual foundation, user journeys, and accessibility guidelines.',
    entryGates: [createArtifactExistsGate('planning', 'prd')],
    exitGates: [createArtifactExistsGate('ux-design', 'ux-design')],
    onEnter: async (_db: DatabaseAdapter, runId: string): Promise<void> => {
      logPhase(`UX Design phase starting for run ${runId}`)
    },
    onExit: async (db: DatabaseAdapter, runId: string): Promise<void> => {
      const artifact = await getArtifactByTypeForRun(db, runId, 'ux-design', 'ux-design')
      if (artifact === undefined) {
        logPhase(`UX Design phase exit WARNING: ux-design artifact not found for run ${runId}`)
      } else {
        logPhase(
          `UX Design phase completed for run ${runId} — ux-design artifact registered: ${artifact.id}`
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
  check: async (db: DatabaseAdapter, runId: string): Promise<boolean> => {
    const architecture = await getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')
    const stories = await getArtifactByTypeForRun(db, runId, 'solutioning', 'stories')
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
 * Configuration options for built-in phase registration.
 */
export interface BuiltInPhasesConfig {
  /**
   * When true, the optional UX design phase is inserted between planning and solutioning.
   * Corresponds to `uxDesign: true` in the pack manifest.
   * Defaults to false.
   */
  uxDesignEnabled?: boolean
  /**
   * When true, the optional research phase is inserted before analysis.
   * Corresponds to `research: true` in the pack manifest.
   * Defaults to false.
   */
  researchEnabled?: boolean
}

/**
 * Return the built-in phase definitions in execution order.
 *
 * When `researchEnabled` is true, the `research` phase is inserted at position 0
 * (before analysis), and the analysis phase gains a `research-findings` entry gate.
 *
 * When `uxDesignEnabled` is true, the `ux-design` phase is inserted between
 * `planning` and `solutioning`, with its own entry/exit gates.
 *
 * @param config - Optional configuration for conditional phase inclusion
 */
export function createBuiltInPhases(config?: BuiltInPhasesConfig): PhaseDefinition[] {
  const phases: PhaseDefinition[] = []

  if (config?.researchEnabled === true) {
    phases.push(createResearchPhaseDefinition())
  }

  phases.push(createAnalysisPhaseDefinition({ requiresResearch: config?.researchEnabled === true }))
  phases.push(createPlanningPhaseDefinition())

  if (config?.uxDesignEnabled === true) {
    phases.push(createUxDesignPhaseDefinition())
  }

  phases.push(createSolutioningPhaseDefinition())
  phases.push(createImplementationPhaseDefinition())

  return phases
}
