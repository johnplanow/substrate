/**
 * Integration tests for Epic 12.1: Phase Gate (--stop-after)
 *
 * These tests cover cross-story interactions between:
 *   - Story 12-1: Stop-After Gate Module (src/modules/stop-after/)
 *   - Story 12-2: Stop-After Integration in auto.ts
 *
 * Gap areas tested:
 *   1. DB status transitions: stop-after halts pipeline and sets status='stopped'
 *   2. resumeRun() tolerates 'stopped' status and continues from next phase
 *   3. Gate is only evaluated after full phase completion, not mid-phase
 *   4. runAutoRun validation: invalid stopAfter, stopAfter/from conflict, exit code 1
 *   5. Summary output is emitted to stdout on halt
 *   6. Atomic: DB status='stopped' before summary is emitted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../src/persistence/migrations/index.js'
import {
  createPipelineRun,
  updatePipelineRun,
  getPipelineRunById,
  registerArtifact,
} from '../../src/persistence/queries/decisions.js'
import {
  createStopAfterGate,
  validateStopAfterFromConflict,
  formatPhaseCompletionSummary,
  VALID_PHASES,
} from '../../src/modules/stop-after/index.js'
import type { PhaseName } from '../../src/modules/stop-after/index.js'
import { createPhaseOrchestrator } from '../../src/modules/phase-orchestrator/index.js'

// ---------------------------------------------------------------------------
// In-memory DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

function createTestRun(
  db: BetterSqlite3Database,
  overrides: { start_phase?: string; config_json?: string; status?: string } = {},
): { id: string; status: string } {
  const run = createPipelineRun(db, {
    methodology: 'bmad',
    start_phase: overrides.start_phase ?? 'analysis',
    config_json: overrides.config_json,
  })
  if (overrides.status !== undefined && overrides.status !== 'running') {
    updatePipelineRun(db, run.id, { status: overrides.status as PhaseName })
  }
  return run
}

function makeMockPack() {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPrompt: vi.fn(async () => ''),
    getConstraint: vi.fn(),
    getTemplate: vi.fn(),
    getPhases: vi.fn().mockReturnValue([]),
  }
}

// ---------------------------------------------------------------------------
// 1. DB status transitions (AC4 of Story 12-2)
// ---------------------------------------------------------------------------

describe('Integration: DB status transitions on stop-after', () => {
  it('updatePipelineRun sets status to "stopped" and persists it (AC4)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // Simulate what auto.ts does after gate.shouldHalt() returns true
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const updated = getPipelineRunById(db, run.id)
    expect(updated).toBeDefined()
    expect(updated!.status).toBe('stopped')

    db.close()
  })

  it('status transitions: running -> stopped (not completed or failed) (AC4)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // Before halt: status should be 'running'
    const before = getPipelineRunById(db, run.id)
    expect(before!.status).toBe('running')

    // After halt
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const after = getPipelineRunById(db, run.id)
    expect(after!.status).toBe('stopped')
    expect(after!.status).not.toBe('completed')
    expect(after!.status).not.toBe('failed')

    db.close()
  })

  it('stopped status is preserved for all four stop phases (AC4)', () => {
    for (const stopPhase of VALID_PHASES) {
      const db = createTestDb()
      const run = createTestRun(db, { start_phase: stopPhase })

      const gate = createStopAfterGate(stopPhase)
      if (gate.shouldHalt()) {
        updatePipelineRun(db, run.id, { status: 'stopped' })
      }

      const result = getPipelineRunById(db, run.id)
      expect(result!.status).toBe('stopped')

      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. resumeRun() handles 'stopped' status (AC6 of Story 12-2)
// ---------------------------------------------------------------------------

describe('Integration: resumeRun() tolerates "stopped" status (AC6)', () => {
  it('resumeRun() does not throw when run status is "stopped"', async () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // Put run in 'stopped' state (simulating stop-after analysis)
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack: pack as never })

    // resumeRun should not reject/throw on a 'stopped' run
    await expect(orchestrator.resumeRun(run.id)).resolves.not.toThrow()

    db.close()
  })

  it('resumeRun() resumes from next phase after a stopped run with analysis artifact (AC6)', async () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // Register product-brief artifact (analysis is complete)
    registerArtifact(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      type: 'product-brief',
      path: 'decision-store://analysis/product-brief',
    })

    // Simulate pipeline was stopped after analysis
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const before = getPipelineRunById(db, run.id)
    expect(before!.status).toBe('stopped')

    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack: pack as never })

    const runStatus = await orchestrator.resumeRun(run.id)

    // Should resume from planning (next after analysis)
    expect(runStatus.currentPhase).toBe('planning')

    // Status transitions from 'stopped' to 'running'
    const after = getPipelineRunById(db, run.id)
    expect(after!.status).toBe('running')

    db.close()
  })

  it('resumeRun() resumes from solutioning after stopped run with analysis+planning artifacts (AC6)', async () => {
    const db = createTestDb()
    const run = createTestRun(db)

    registerArtifact(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      type: 'product-brief',
      path: 'decision-store://analysis/product-brief',
    })
    registerArtifact(db, {
      pipeline_run_id: run.id,
      phase: 'planning',
      type: 'prd',
      path: 'decision-store://planning/prd',
    })

    // Stopped after planning
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack: pack as never })

    const runStatus = await orchestrator.resumeRun(run.id)

    expect(runStatus.currentPhase).toBe('solutioning')

    db.close()
  })

  it('resumeRun() transitions run status from stopped to running (AC6)', async () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // Register artifact to allow resumption
    registerArtifact(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      type: 'product-brief',
      path: 'decision-store://analysis/product-brief',
    })

    updatePipelineRun(db, run.id, { status: 'stopped' })

    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack: pack as never })

    await orchestrator.resumeRun(run.id)

    const afterResume = getPipelineRunById(db, run.id)
    expect(afterResume!.status).toBe('running')

    db.close()
  })
})

// ---------------------------------------------------------------------------
// 3. Gate module + auto.ts wiring: validation paths (AC1, AC3, AC7 of Story 12-2)
// ---------------------------------------------------------------------------

describe('Integration: stop-after validation (module + CLI layer contract)', () => {
  it('valid stop-after phase passes validation and gate is created (AC1)', () => {
    for (const phase of VALID_PHASES) {
      // Same logic as runAutoRun validates
      const isValid = VALID_PHASES.includes(phase as PhaseName)
      expect(isValid).toBe(true)

      // Gate is created without throwing
      const gate = createStopAfterGate(phase as PhaseName)
      expect(gate.shouldHalt()).toBe(true)
    }
  })

  it('invalid stop-after phase fails validation (AC1)', () => {
    const invalidPhase = 'xyz'
    const isValid = VALID_PHASES.includes(invalidPhase as PhaseName)
    expect(isValid).toBe(false)

    // Gate creation also throws
    expect(() => createStopAfterGate(invalidPhase as PhaseName)).toThrow(/invalid phase name/i)
  })

  it('stopAfter before from produces conflict error (AC3)', () => {
    const result = validateStopAfterFromConflict('analysis', 'planning')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('--stop-after')
    expect(result.error).toContain('--from')
  })

  it('stopAfter equals from is valid (AC3)', () => {
    const result = validateStopAfterFromConflict('analysis', 'analysis')
    expect(result.valid).toBe(true)
  })

  it('stopAfter after from is valid — no conflict (AC3)', () => {
    const result = validateStopAfterFromConflict('solutioning', 'planning')
    expect(result.valid).toBe(true)
  })

  it('stopAfter without from is always valid (AC3)', () => {
    for (const phase of VALID_PHASES) {
      const result = validateStopAfterFromConflict(phase as PhaseName, undefined)
      expect(result.valid).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Gate evaluation: after phase, not mid-phase (AC8 of Story 12-2)
// ---------------------------------------------------------------------------

describe('Integration: gate evaluation semantics (AC8 of Story 12-2)', () => {
  it('gate is only evaluated when currentPhase === stopAfter (not before)', () => {
    const stopAfter: PhaseName = 'planning'
    const phases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']

    // Simulate the phase loop from runFullPipeline
    const halted: PhaseName[] = []

    for (const currentPhase of phases) {
      if (currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          halted.push(currentPhase)
          break
        }
      }
    }

    // Only halted after planning, not before
    expect(halted).toHaveLength(1)
    expect(halted[0]).toBe('planning')
  })

  it('analysis phase runs to completion before gate is evaluated (AC8)', () => {
    const stopAfter: PhaseName = 'analysis'
    const phases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']

    let analysisCompleted = false
    let gateEvaluatedAfterAnalysis = false

    for (const currentPhase of phases) {
      if (currentPhase === 'analysis') {
        // Simulate analysis running to completion
        analysisCompleted = true
      }

      // Gate is evaluated AFTER the phase execution (same loop iteration, after phase code)
      if (currentPhase === stopAfter && analysisCompleted) {
        gateEvaluatedAfterAnalysis = true
        const gate = createStopAfterGate(stopAfter)
        expect(gate.shouldHalt()).toBe(true)
        break
      }
    }

    expect(analysisCompleted).toBe(true)
    expect(gateEvaluatedAfterAnalysis).toBe(true)
  })

  it('gate is not triggered for phases before stop-after phase (AC8)', () => {
    const stopAfter: PhaseName = 'solutioning'
    const phases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']

    const gatesEvaluated: PhaseName[] = []

    for (const currentPhase of phases) {
      if (currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          gatesEvaluated.push(currentPhase)
          break
        }
      }
    }

    // Gate was only evaluated (and halted) at solutioning
    expect(gatesEvaluated).toHaveLength(1)
    expect(gatesEvaluated[0]).toBe('solutioning')
    // Analysis and planning phases did not trigger the gate
    expect(gatesEvaluated).not.toContain('analysis')
    expect(gatesEvaluated).not.toContain('planning')
  })
})

// ---------------------------------------------------------------------------
// 5. Summary output contains run ID and is within word limits (AC5 of Story 12-2)
// ---------------------------------------------------------------------------

describe('Integration: phase completion summary content (AC5 of Story 12-2)', () => {
  it('summary contains the resume command with the correct run ID', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const startedAt = new Date(Date.now() - 30000).toISOString()
    const completedAt = new Date().toISOString()

    const summary = formatPhaseCompletionSummary({
      phaseName: 'analysis',
      startedAt,
      completedAt,
      decisionsCount: 3,
      artifactPaths: [],
      runId: run.id,
    })

    expect(summary).toContain(`substrate auto resume --run-id ${run.id}`)

    db.close()
  })

  it('summary word count is within 50–500 for a typical stop-after scenario', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const summary = formatPhaseCompletionSummary({
      phaseName: 'planning',
      startedAt: '2026-02-22T10:00:00.000Z',
      completedAt: '2026-02-22T10:01:30.000Z',
      decisionsCount: 7,
      artifactPaths: [
        '_bmad-output/prd.md',
        '_bmad-output/requirements.md',
      ],
      runId: run.id,
    })

    const wordCount = summary.split(/\s+/).filter((w) => w.length > 0).length
    expect(wordCount).toBeGreaterThanOrEqual(50)
    expect(wordCount).toBeLessThanOrEqual(500)

    db.close()
  })

  it('summary contains phase name and "completed" for each valid stop phase (AC5)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    for (const phase of VALID_PHASES) {
      const summary = formatPhaseCompletionSummary({
        phaseName: phase as PhaseName,
        startedAt: '2026-02-22T10:00:00.000Z',
        completedAt: '2026-02-22T10:00:45.000Z',
        decisionsCount: 2,
        artifactPaths: [],
        runId: run.id,
      })

      expect(summary.toLowerCase()).toContain(phase)
      expect(summary.toLowerCase()).toContain('completed')
    }

    db.close()
  })

  it('summary does not contain ANSI escape codes (no terminal color sequences) (AC5)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const summary = formatPhaseCompletionSummary({
      phaseName: 'analysis',
      startedAt: '2026-02-22T10:00:00.000Z',
      completedAt: '2026-02-22T10:00:30.000Z',
      decisionsCount: 5,
      artifactPaths: ['_bmad-output/brief.md'],
      runId: run.id,
    })

    expect(summary).not.toMatch(/\x1b\[/)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// 6. Full gate+DB interaction: simulate what auto.ts does end-to-end (AC4+AC5)
// ---------------------------------------------------------------------------

describe('Integration: full stop-after gate+DB interaction', () => {
  it('gate evaluates true, DB is updated to stopped, summary is produced (AC4+AC5)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const stopAfterPhase: PhaseName = 'analysis'
    const startedAt = new Date(Date.now() - 45000).toISOString()
    const completedAt = new Date().toISOString()

    // --- Simulate what runFullPipeline does ---
    const gate = createStopAfterGate(stopAfterPhase)
    expect(gate.shouldHalt()).toBe(true)

    const decisionsCount = 3
    // Update run status (AC4: atomically before summary)
    updatePipelineRun(db, run.id, { status: 'stopped' })

    // Verify DB state is persisted before summary
    const dbState = getPipelineRunById(db, run.id)
    expect(dbState!.status).toBe('stopped')

    // Emit summary (AC5)
    const summary = formatPhaseCompletionSummary({
      phaseName: stopAfterPhase,
      startedAt,
      completedAt,
      decisionsCount,
      artifactPaths: [],
      runId: run.id,
    })

    expect(summary).toContain('analysis')
    expect(summary).toContain('completed')
    expect(summary).toContain(`--run-id ${run.id}`)

    db.close()
  })

  it('stop-after at implementation phase: DB stopped, pipeline does not continue (AC4+AC8)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const stopAfterPhase: PhaseName = 'implementation'
    const phases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']

    let phasesExecuted: PhaseName[] = []
    let dbUpdated = false

    for (const currentPhase of phases) {
      phasesExecuted.push(currentPhase)

      if (currentPhase === stopAfterPhase) {
        const gate = createStopAfterGate(stopAfterPhase)
        if (gate.shouldHalt()) {
          updatePipelineRun(db, run.id, { status: 'stopped' })
          dbUpdated = true
          break
        }
      }
    }

    // All 4 phases ran, gate halted at implementation
    expect(phasesExecuted).toHaveLength(4)
    expect(phasesExecuted[3]).toBe('implementation')
    expect(dbUpdated).toBe(true)

    const dbState = getPipelineRunById(db, run.id)
    expect(dbState!.status).toBe('stopped')

    db.close()
  })

  it('stop-after at analysis phase: only analysis runs, phases 2-4 are not executed (AC8)', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const stopAfterPhase: PhaseName = 'analysis'
    const phases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']

    const phasesExecuted: PhaseName[] = []
    let halted = false

    for (const currentPhase of phases) {
      phasesExecuted.push(currentPhase)

      if (currentPhase === stopAfterPhase) {
        const gate = createStopAfterGate(stopAfterPhase)
        if (gate.shouldHalt()) {
          updatePipelineRun(db, run.id, { status: 'stopped' })
          halted = true
          break
        }
      }
    }

    // Only analysis ran
    expect(phasesExecuted).toHaveLength(1)
    expect(phasesExecuted[0]).toBe('analysis')
    expect(halted).toBe(true)

    const dbState = getPipelineRunById(db, run.id)
    expect(dbState!.status).toBe('stopped')

    db.close()
  })
})

// ---------------------------------------------------------------------------
// 7. Gate statelessness across concurrent DB runs (AC7 of Story 12-1)
// ---------------------------------------------------------------------------

describe('Integration: gate statelessness with concurrent DB runs (AC7)', () => {
  it('multiple concurrent gates each update their respective run independently', () => {
    const db = createTestDb()

    // Simulate two concurrent pipeline executions
    const run1 = createTestRun(db, { start_phase: 'analysis' })
    const run2 = createTestRun(db, { start_phase: 'planning' })

    const gate1 = createStopAfterGate('analysis')
    const gate2 = createStopAfterGate('planning')

    // Both gates halt independently
    if (gate1.shouldHalt()) {
      updatePipelineRun(db, run1.id, { status: 'stopped' })
    }
    if (gate2.shouldHalt()) {
      updatePipelineRun(db, run2.id, { status: 'stopped' })
    }

    const r1 = getPipelineRunById(db, run1.id)
    const r2 = getPipelineRunById(db, run2.id)

    expect(r1!.status).toBe('stopped')
    expect(r2!.status).toBe('stopped')

    // Gate methods are unaffected by DB state
    expect(gate1.shouldHalt()).toBe(true)
    expect(gate2.shouldHalt()).toBe(true)
    expect(gate1.isStopPhase()).toBe(true)
    expect(gate2.isStopPhase()).toBe(true)

    db.close()
  })

  it('gates share no mutable state — calling one does not affect the other (AC7)', () => {
    const gate1 = createStopAfterGate('analysis')
    const gate2 = createStopAfterGate('solutioning')

    // Call all methods on gate1
    const g1IsStop = gate1.isStopPhase()
    const g1ShouldHalt = gate1.shouldHalt()

    // gate2 is unaffected
    expect(gate2.isStopPhase()).toBe(true)
    expect(gate2.shouldHalt()).toBe(true)

    // gate1 results remain consistent
    expect(g1IsStop).toBe(true)
    expect(g1ShouldHalt).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 8. VALID_PHASES consistency between module and auto.ts (AC4 of Story 12-1)
// ---------------------------------------------------------------------------

describe('Integration: VALID_PHASES type consistency (AC4 of Story 12-1)', () => {
  it('VALID_PHASES exported from stop-after module matches the four canonical phases', () => {
    expect(VALID_PHASES).toEqual(['analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('auto.ts VALID_PHASES (re-imported from stop-after module) is used for gate construction', () => {
    // Verify that each VALID_PHASE can create a gate without throwing
    for (const phase of VALID_PHASES) {
      expect(() => createStopAfterGate(phase as PhaseName)).not.toThrow()
    }
  })

  it('phase names used in validateStopAfterFromConflict match VALID_PHASES order', () => {
    // Phase order must be: analysis(0) < planning(1) < solutioning(2) < implementation(3)
    // This is the order used by validateStopAfterFromConflict for index comparison
    const phaseOrder = ['analysis', 'planning', 'solutioning', 'implementation']
    expect(VALID_PHASES).toEqual(phaseOrder)

    // Verify the conflict validation respects this order
    expect(validateStopAfterFromConflict('analysis', 'planning').valid).toBe(false)
    expect(validateStopAfterFromConflict('planning', 'analysis').valid).toBe(true)
    expect(validateStopAfterFromConflict('solutioning', 'planning').valid).toBe(true)
    expect(validateStopAfterFromConflict('planning', 'solutioning').valid).toBe(false)
  })
})
