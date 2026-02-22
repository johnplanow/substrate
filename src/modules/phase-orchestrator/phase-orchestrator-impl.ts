/**
 * PhaseOrchestrator implementation.
 *
 * Factory: createPhaseOrchestrator(deps) → PhaseOrchestrator
 *
 * Implements the multi-phase pipeline with entry/exit gate enforcement,
 * resume capability, artifact tracking, and phase history serialization.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { GatePipeline } from '../quality-gates/gate-pipeline.js'
import type { MethodologyPack } from '../methodology-pack/types.js'
import {
  createPipelineRun,
  updatePipelineRun,
  getPipelineRunById,
  updatePipelineRunConfig,
  getArtifactsByRun,
} from '../../persistence/queries/decisions.js'
import { createBuiltInPhases } from './built-in-phases.js'
import type { PhaseOrchestrator } from './phase-orchestrator.js'
import type {
  PhaseDefinition,
  PhaseRunStatus,
  AdvancePhaseResult,
  GateCheck,
  GateRunResult,
  PhaseHistoryEntry,
} from './types.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies required to create a PhaseOrchestrator.
 */
export interface PhaseOrchestratorDeps {
  /** SQLite database instance (decision store) */
  db: BetterSqlite3Database
  /** Optional quality gate pipeline (used for solutioning-readiness checks) */
  qualityGates?: GatePipeline
  /** The loaded methodology pack (provides phase definitions and metadata) */
  pack: MethodologyPack
}

// ---------------------------------------------------------------------------
// Gate running logic
// ---------------------------------------------------------------------------

/**
 * Run all gate checks sequentially, collecting all failures (no short-circuit).
 *
 * @param gates - Array of gate checks to run
 * @param db - SQLite database instance
 * @param runId - Pipeline run ID
 * @returns Aggregate result with pass/fail status and failure details
 */
export async function runGates(
  gates: GateCheck[],
  db: BetterSqlite3Database,
  runId: string,
): Promise<GateRunResult> {
  const failures: Array<{ gate: string; error: string }> = []

  for (const gate of gates) {
    try {
      const passed = await gate.check(db, runId)
      if (!passed) {
        failures.push({ gate: gate.name, error: gate.errorMessage })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      failures.push({ gate: gate.name, error: `Gate check threw an error: ${errorMsg}` })
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  }
}

// ---------------------------------------------------------------------------
// Phase history serialization
// ---------------------------------------------------------------------------

/**
 * Serialize phase history to a JSON string for storage in config_json.
 */
export function serializePhaseHistory(history: PhaseHistoryEntry[]): string {
  return JSON.stringify(history)
}

/**
 * Deserialize phase history from a JSON string.
 * Returns an empty array if the input is invalid or empty.
 */
export function deserializePhaseHistory(json: string | null | undefined): PhaseHistoryEntry[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed as PhaseHistoryEntry[]
  } catch {
    return []
  }
}

/**
 * Parse the config_json field from a pipeline_run and extract phase history.
 * Handles both old-format (plain array) and new-format ({ phaseHistory: [...] }).
 */
export function parseConfigJson(configJson: string | null | undefined): {
  phaseHistory: PhaseHistoryEntry[]
  concept?: string
  [key: string]: unknown
} {
  if (!configJson) return { phaseHistory: [] }
  try {
    const parsed = JSON.parse(configJson) as unknown
    if (Array.isArray(parsed)) {
      // Old format: direct array
      return { phaseHistory: parsed as PhaseHistoryEntry[] }
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>
      return {
        ...obj,
        phaseHistory: Array.isArray(obj['phaseHistory'])
          ? (obj['phaseHistory'] as PhaseHistoryEntry[])
          : [],
      }
    }
    return { phaseHistory: [] }
  } catch {
    return { phaseHistory: [] }
  }
}

// ---------------------------------------------------------------------------
// PhaseOrchestratorImpl
// ---------------------------------------------------------------------------

class PhaseOrchestratorImpl implements PhaseOrchestrator {
  private readonly _db: BetterSqlite3Database
  private readonly _pack: MethodologyPack
  private readonly _qualityGates: GatePipeline | undefined
  private _phases: PhaseDefinition[]

  constructor(deps: PhaseOrchestratorDeps) {
    this._db = deps.db
    this._pack = deps.pack
    this._qualityGates = deps.qualityGates
    // Start with the built-in phases
    this._phases = createBuiltInPhases()

    // Merge any additional phases defined in the methodology pack.
    // Pack phases use a lightweight definition (string gate names, no callbacks),
    // so we only register pack-defined phases that are NOT already in the built-in set.
    const builtInNames = new Set(this._phases.map((p) => p.name))
    const packPhases = this._pack.getPhases()
    for (const packPhase of packPhases) {
      if (!builtInNames.has(packPhase.name)) {
        this._phases.push({
          name: packPhase.name,
          description: packPhase.description,
          entryGates: [],
          exitGates: [],
          onEnter: async (_db, _runId) => {},
          onExit: async (_db, _runId) => {},
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // startRun
  // -------------------------------------------------------------------------

  async startRun(concept: string, startPhase?: string): Promise<string> {
    const firstPhase = startPhase ?? this._phases[0]?.name ?? 'analysis'

    const configJson = JSON.stringify({
      concept,
      phaseHistory: [
        {
          phase: firstPhase,
          startedAt: new Date().toISOString(),
          gateResults: [],
        } satisfies PhaseHistoryEntry,
      ],
    })

    const run = createPipelineRun(this._db, {
      methodology: this._pack.manifest.name,
      start_phase: firstPhase,
      config_json: configJson,
    })

    return run.id
  }

  // -------------------------------------------------------------------------
  // advancePhase
  // -------------------------------------------------------------------------

  async advancePhase(runId: string): Promise<AdvancePhaseResult> {
    const run = getPipelineRunById(this._db, runId)
    if (!run) {
      return {
        advanced: false,
        phase: '',
        gateFailures: [{ gate: 'run-exists', error: `Pipeline run '${runId}' not found` }],
      }
    }

    const currentPhaseName = run.current_phase ?? this._phases[0]?.name ?? 'analysis'
    const currentPhaseIdx = this._phases.findIndex((p) => p.name === currentPhaseName)

    if (currentPhaseIdx === -1) {
      return {
        advanced: false,
        phase: currentPhaseName,
        gateFailures: [
          { gate: 'phase-exists', error: `Phase '${currentPhaseName}' not found in phase list` },
        ],
      }
    }

    const currentPhaseDef = this._phases[currentPhaseIdx]

    // 1. Check exit gates for current phase
    const exitResult = await runGates(currentPhaseDef.exitGates, this._db, runId)
    if (!exitResult.passed) {
      return {
        advanced: false,
        phase: currentPhaseName,
        gateFailures: exitResult.failures,
      }
    }

    // 2. Determine next phase
    const nextPhaseIdx = currentPhaseIdx + 1
    if (nextPhaseIdx >= this._phases.length) {
      // No more phases — mark as completed
      updatePipelineRun(this._db, runId, { status: 'completed' })
      return {
        advanced: true,
        phase: currentPhaseName,
      }
    }

    const nextPhaseDef = this._phases[nextPhaseIdx]

    // 3. Check entry gates for next phase
    const entryResult = await runGates(nextPhaseDef.entryGates, this._db, runId)
    if (!entryResult.passed) {
      return {
        advanced: false,
        phase: currentPhaseName,
        gateFailures: entryResult.failures,
      }
    }

    // 4. Update phase history (before callbacks, so state is persisted first)
    const config = parseConfigJson(run.config_json)
    const now = new Date().toISOString()

    // Build the complete gate results for the exit check: record both passes and failures
    const exitGateResults = currentPhaseDef.exitGates.map((gate) => {
      const failure = exitResult.failures.find((f) => f.gate === gate.name)
      return failure
        ? { gate: gate.name, passed: false, error: failure.error }
        : { gate: gate.name, passed: true }
    })

    // Mark current phase as completed
    const history = config.phaseHistory
    const currentHistoryEntry = history.find((h) => h.phase === currentPhaseName && !h.completedAt)
    if (currentHistoryEntry) {
      currentHistoryEntry.completedAt = now
      currentHistoryEntry.gateResults = exitGateResults
    }

    // Add entry for next phase
    history.push({
      phase: nextPhaseDef.name,
      startedAt: now,
      gateResults: [],
    })

    const newConfigJson = JSON.stringify({ ...config, phaseHistory: history })

    // 5. Update pipeline_run config and current_phase (before callbacks for defensive ordering)
    updatePipelineRunConfig(this._db, runId, newConfigJson)
    updatePipelineRun(this._db, runId, { current_phase: nextPhaseDef.name })

    // 6. Call lifecycle callbacks (after state is persisted)
    await currentPhaseDef.onExit(this._db, runId)
    await nextPhaseDef.onEnter(this._db, runId)

    return {
      advanced: true,
      phase: nextPhaseDef.name,
    }
  }

  // -------------------------------------------------------------------------
  // resumeRun
  // -------------------------------------------------------------------------

  async resumeRun(runId: string): Promise<PhaseRunStatus> {
    const run = getPipelineRunById(this._db, runId)
    if (!run) {
      throw new Error(`Pipeline run '${runId}' not found`)
    }

    // Find the last phase whose exit gates all pass (= last fully completed phase).
    // Phases with no exit gates are NOT treated as completed — we cannot verify completion
    // without gate evidence, so they are treated as "not completed" and scanning stops there.
    let lastCompletedPhaseIdx = -1
    for (let i = 0; i < this._phases.length; i++) {
      const phase = this._phases[i]
      if (phase.exitGates.length === 0) {
        // No exit gates — cannot confirm completion; stop scanning here
        break
      }
      const result = await runGates(phase.exitGates, this._db, runId)
      if (result.passed) {
        lastCompletedPhaseIdx = i
      } else {
        // Gates failed — this phase is not complete; stop scanning
        break
      }
    }

    // Resume from the phase AFTER the last completed one
    const resumePhaseIdx = lastCompletedPhaseIdx + 1

    // If all phases are done, mark the run as completed and return
    if (resumePhaseIdx >= this._phases.length) {
      updatePipelineRun(this._db, runId, { status: 'completed' })
      return this.getRunStatus(runId)
    }

    const resumePhaseName = this._phases[resumePhaseIdx].name

    // Update the run status and current_phase
    updatePipelineRun(this._db, runId, {
      status: 'running',
      current_phase: resumePhaseName,
    })

    return this.getRunStatus(runId)
  }

  // -------------------------------------------------------------------------
  // getRunStatus
  // -------------------------------------------------------------------------

  async getRunStatus(runId: string): Promise<PhaseRunStatus> {
    const run = getPipelineRunById(this._db, runId)
    if (!run) {
      throw new Error(`Pipeline run '${runId}' not found`)
    }

    const config = parseConfigJson(run.config_json)
    const allArtifacts = getArtifactsByRun(this._db, runId)

    // Determine completed phases from phase history (phases with completedAt set)
    const completedPhases = config.phaseHistory
      .filter((h) => h.completedAt !== undefined)
      .map((h) => h.phase)

    return {
      runId,
      currentPhase: run.current_phase ?? null,
      completedPhases,
      artifacts: allArtifacts.map((a) => ({
        type: a.type,
        phase: a.phase,
        id: a.id,
      })),
      status: run.status as 'running' | 'paused' | 'completed' | 'failed',
      phaseHistory: config.phaseHistory,
    }
  }

  // -------------------------------------------------------------------------
  // registerPhase
  // -------------------------------------------------------------------------

  registerPhase(phase: PhaseDefinition): void {
    this._phases.push(phase)
  }

  // -------------------------------------------------------------------------
  // getPhases
  // -------------------------------------------------------------------------

  getPhases(): PhaseDefinition[] {
    return [...this._phases]
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new PhaseOrchestrator with the given dependencies.
 *
 * The orchestrator is pre-loaded with the four built-in phases
 * (analysis, planning, solutioning, implementation).
 */
export function createPhaseOrchestrator(deps: PhaseOrchestratorDeps): PhaseOrchestrator {
  return new PhaseOrchestratorImpl(deps)
}
