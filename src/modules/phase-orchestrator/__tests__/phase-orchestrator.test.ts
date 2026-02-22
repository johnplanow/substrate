/**
 * Unit tests for createPhaseOrchestrator().
 *
 * Covers AC1-AC8: phase registration, entry/exit gate enforcement,
 * pipeline run lifecycle, resume capability, state persistence,
 * artifact registration/querying, and extensible phase definitions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { registerArtifact, getPipelineRunById } from '../../../persistence/queries/decisions.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import { createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import type { PhaseDefinition } from '../types.js'
import { runGates, serializePhaseHistory, deserializePhaseHistory } from '../phase-orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'phase-orch-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createMockPack(name = 'test-pack'): MethodologyPack {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function createNoGatePhase(name: string): PhaseDefinition {
  return {
    name,
    description: `Test phase: ${name}`,
    entryGates: [],
    exitGates: [],
    onEnter: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn().mockResolvedValue(undefined),
  }
}

// Register a product-brief artifact for a run (simulates analysis completing)
function registerProductBriefArtifact(db: BetterSqlite3Database, runId: string): void {
  registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'analysis',
    type: 'product-brief',
    path: '/artifacts/product-brief.md',
    summary: 'Test product brief',
  })
}

function registerPrdArtifact(db: BetterSqlite3Database, runId: string): void {
  registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'planning',
    type: 'prd',
    path: '/artifacts/prd.md',
    summary: 'Test PRD',
  })
}

function registerArchitectureArtifact(db: BetterSqlite3Database, runId: string): void {
  registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    type: 'architecture',
    path: '/artifacts/architecture.md',
    summary: 'Test architecture',
  })
}

function registerStoriesArtifact(db: BetterSqlite3Database, runId: string): void {
  registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    type: 'stories',
    path: '/artifacts/stories.md',
    summary: 'Test stories',
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PhaseOrchestrator — core', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    tmpDir = result.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // AC1: Phase Registration and Ordering
  // -------------------------------------------------------------------------

  describe('AC1: Phase registration and ordering', () => {
    it('registers four built-in phases in the correct order', () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const phases = orchestrator.getPhases()
      expect(phases).toHaveLength(4)
      expect(phases[0].name).toBe('analysis')
      expect(phases[1].name).toBe('planning')
      expect(phases[2].name).toBe('solutioning')
      expect(phases[3].name).toBe('implementation')
    })

    it('each built-in phase has required PhaseDefinition fields', () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      for (const phase of orchestrator.getPhases()) {
        expect(typeof phase.name).toBe('string')
        expect(typeof phase.description).toBe('string')
        expect(Array.isArray(phase.entryGates)).toBe(true)
        expect(Array.isArray(phase.exitGates)).toBe(true)
        expect(typeof phase.onEnter).toBe('function')
        expect(typeof phase.onExit).toBe('function')
      }
    })

    it('registerPhase adds a custom phase to the sequence', () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const customPhase = createNoGatePhase('custom-phase')
      orchestrator.registerPhase(customPhase)

      const phases = orchestrator.getPhases()
      expect(phases).toHaveLength(5)
      expect(phases[4].name).toBe('custom-phase')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Pipeline Run Lifecycle
  // -------------------------------------------------------------------------

  describe('AC4: Pipeline run lifecycle', () => {
    it('startRun creates a pipeline_run record with status running', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')

      expect(typeof runId).toBe('string')
      expect(runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )

      const run = getPipelineRunById(db, runId)
      expect(run).toBeDefined()
      expect(run!.status).toBe('running')
      expect(run!.current_phase).toBe('analysis')
    })

    it('startRun sets the specified startPhase as current_phase', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept', 'planning')

      const run = getPipelineRunById(db, runId)
      expect(run!.current_phase).toBe('planning')
    })

    it('getRunStatus returns current phase, completed phases, and artifacts', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)

      const status = await orchestrator.getRunStatus(runId)

      expect(status.runId).toBe(runId)
      expect(status.currentPhase).toBe('analysis')
      expect(status.status).toBe('running')
      expect(Array.isArray(status.completedPhases)).toBe(true)
      expect(status.artifacts).toHaveLength(1)
      expect(status.artifacts[0].type).toBe('product-brief')
      expect(status.artifacts[0].phase).toBe('analysis')
    })

    it('getRunStatus throws for unknown runId', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      await expect(
        orchestrator.getRunStatus('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Entry Gate Enforcement
  // -------------------------------------------------------------------------

  describe('AC2: Entry gate enforcement', () => {
    it('blocks advance to planning if product-brief artifact is missing', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      // Don't register product-brief — advance should fail

      const result = await orchestrator.advancePhase(runId)

      expect(result.advanced).toBe(false)
      expect(result.gateFailures).toBeDefined()
      expect(result.gateFailures!.length).toBeGreaterThan(0)
      // Failure is on exit gate (analysis needs product-brief exit gate)
      expect(result.gateFailures![0].gate).toContain('product-brief')
    })

    it('allows advance to planning when product-brief artifact exists', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)

      const result = await orchestrator.advancePhase(runId)

      expect(result.advanced).toBe(true)
      expect(result.phase).toBe('planning')
    })

    it('blocks advance to solutioning if prd artifact is missing', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)
      await orchestrator.advancePhase(runId) // analysis → planning

      // Don't register prd
      const result = await orchestrator.advancePhase(runId)

      expect(result.advanced).toBe(false)
      expect(result.gateFailures).toBeDefined()
      expect(result.gateFailures!.some((f) => f.gate.includes('prd'))).toBe(true)
    })

    it('blocks advance to implementation if architecture or stories missing', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)
      await orchestrator.advancePhase(runId) // → planning
      registerPrdArtifact(db, runId)
      await orchestrator.advancePhase(runId) // → solutioning

      // Register only architecture, not stories
      registerArchitectureArtifact(db, runId)

      const result = await orchestrator.advancePhase(runId)

      expect(result.advanced).toBe(false)
      expect(result.gateFailures!.some((f) => f.gate.includes('stories'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Exit Gate Enforcement
  // -------------------------------------------------------------------------

  describe('AC3: Exit gate enforcement', () => {
    it('blocks phase advance when exit gates fail', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      // No product-brief — analysis exit gate fails

      const result = await orchestrator.advancePhase(runId)

      expect(result.advanced).toBe(false)
      expect(result.phase).toBe('analysis')
      expect(result.gateFailures).toBeDefined()
    })

    it('passes exit gates and advances when required artifacts exist', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)

      const result = await orchestrator.advancePhase(runId)

      expect(result.advanced).toBe(true)
      expect(result.phase).toBe('planning')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Full pipeline progression
  // -------------------------------------------------------------------------

  describe('Full pipeline: analysis → planning → solutioning → implementation', () => {
    it('progresses through all four phases when gates are satisfied', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')

      // analysis → planning
      registerProductBriefArtifact(db, runId)
      const r1 = await orchestrator.advancePhase(runId)
      expect(r1.advanced).toBe(true)
      expect(r1.phase).toBe('planning')

      // planning → solutioning
      registerPrdArtifact(db, runId)
      const r2 = await orchestrator.advancePhase(runId)
      expect(r2.advanced).toBe(true)
      expect(r2.phase).toBe('solutioning')

      // solutioning → implementation
      registerArchitectureArtifact(db, runId)
      registerStoriesArtifact(db, runId)
      const r3 = await orchestrator.advancePhase(runId)
      expect(r3.advanced).toBe(true)
      expect(r3.phase).toBe('implementation')

      // Verify DB state
      const run = getPipelineRunById(db, runId)
      expect(run!.current_phase).toBe('implementation')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Resume from Any Phase
  // -------------------------------------------------------------------------

  describe('AC5: Resume capability', () => {
    it('resumeRun throws for unknown runId', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      await expect(
        orchestrator.resumeRun('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow()
    })

    it('resumeRun with no completed exit gates resumes at analysis', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      // No artifacts registered — analysis exit gate won't pass

      const status = await orchestrator.resumeRun(runId)

      expect(status.runId).toBe(runId)
      // Should still be at analysis (no exit gates passed)
      expect(status.currentPhase).toBe('analysis')
      expect(status.status).toBe('running')
    })

    it('resumeRun with product-brief artifact resumes at planning', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)
      // Manually set current_phase to analysis to simulate interrupted run
      const { updatePipelineRun } = await import('../../../persistence/queries/decisions.js')
      updatePipelineRun(db, runId, { current_phase: 'analysis', status: 'paused' })

      const status = await orchestrator.resumeRun(runId)

      // Analysis exit gate passes (product-brief exists), so should resume at planning
      expect(status.currentPhase).toBe('planning')
      expect(status.status).toBe('running')
    })

    it('resumeRun updates status back to running', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      const { updatePipelineRun } = await import('../../../persistence/queries/decisions.js')
      updatePipelineRun(db, runId, { status: 'paused' })

      await orchestrator.resumeRun(runId)

      const run = getPipelineRunById(db, runId)
      expect(run!.status).toBe('running')
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Phase State Persistence
  // -------------------------------------------------------------------------

  describe('AC6: Phase state persistence', () => {
    it('updates current_phase in pipeline_runs after each advance', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)
      await orchestrator.advancePhase(runId)

      const run = getPipelineRunById(db, runId)
      expect(run!.current_phase).toBe('planning')
    })

    it('stores phase history in config_json after phase transition', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)
      await orchestrator.advancePhase(runId)

      const run = getPipelineRunById(db, runId)
      expect(run!.config_json).toBeTruthy()

      const config = JSON.parse(run!.config_json!) as { phaseHistory: unknown[] }
      expect(Array.isArray(config.phaseHistory)).toBe(true)
      expect(config.phaseHistory.length).toBeGreaterThan(0)
    })

    it('config_json contains concept from startRun', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('My test concept')

      const run = getPipelineRunById(db, runId)
      const config = JSON.parse(run!.config_json!) as { concept: string }
      expect(config.concept).toBe('My test concept')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Artifact Registration and Querying
  // -------------------------------------------------------------------------

  describe('AC7: Artifact querying in getRunStatus', () => {
    it('getRunStatus includes all artifacts for the run', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)
      registerArtifact(db, {
        pipeline_run_id: runId,
        phase: 'analysis',
        type: 'constraints',
        path: '/artifacts/constraints.md',
      })

      const status = await orchestrator.getRunStatus(runId)

      expect(status.artifacts).toHaveLength(2)
      const types = status.artifacts.map((a) => a.type)
      expect(types).toContain('product-brief')
      expect(types).toContain('constraints')
    })

    it('getRunStatus artifacts include type, phase, and id fields', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId = await orchestrator.startRun('Test concept')
      registerProductBriefArtifact(db, runId)

      const status = await orchestrator.getRunStatus(runId)

      const artifact = status.artifacts[0]
      expect(typeof artifact.type).toBe('string')
      expect(typeof artifact.phase).toBe('string')
      expect(typeof artifact.id).toBe('string')
    })

    it('artifacts from different runs do not appear in each other\'s status', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const runId1 = await orchestrator.startRun('Concept 1')
      const runId2 = await orchestrator.startRun('Concept 2')
      registerProductBriefArtifact(db, runId1)

      const status2 = await orchestrator.getRunStatus(runId2)
      expect(status2.artifacts).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC8: Extensible Phase Definitions
  // -------------------------------------------------------------------------

  describe('AC8: Custom phase registration', () => {
    it('custom phase is processed like built-in phases', async () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const onEnterMock = vi.fn().mockResolvedValue(undefined)
      const onExitMock = vi.fn().mockResolvedValue(undefined)

      const customPhase: PhaseDefinition = {
        name: 'custom-phase',
        description: 'A custom test phase',
        entryGates: [],
        exitGates: [],
        onEnter: onEnterMock,
        onExit: onExitMock,
      }
      orchestrator.registerPhase(customPhase)

      const phases = orchestrator.getPhases()
      expect(phases.some((p) => p.name === 'custom-phase')).toBe(true)
    })

    it('custom phase can define its own entry and exit gates', () => {
      const pack = createMockPack()
      const orchestrator = createPhaseOrchestrator({ db, pack })

      const customGate = {
        name: 'custom-gate',
        check: vi.fn().mockResolvedValue(true),
        errorMessage: 'Custom gate failed',
      }

      const customPhase: PhaseDefinition = {
        name: 'custom-phase',
        description: 'Custom phase',
        entryGates: [customGate],
        exitGates: [customGate],
        onEnter: vi.fn().mockResolvedValue(undefined),
        onExit: vi.fn().mockResolvedValue(undefined),
      }
      orchestrator.registerPhase(customPhase)

      const registered = orchestrator.getPhases().find((p) => p.name === 'custom-phase')
      expect(registered!.entryGates).toHaveLength(1)
      expect(registered!.exitGates).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // runGates utility
  // -------------------------------------------------------------------------

  describe('runGates utility', () => {
    it('returns passed=true when all gates pass', async () => {
      const gates = [
        { name: 'gate1', check: vi.fn().mockResolvedValue(true), errorMessage: 'Gate 1 failed' },
        { name: 'gate2', check: vi.fn().mockResolvedValue(true), errorMessage: 'Gate 2 failed' },
      ]

      const result = await runGates(gates, db, 'test-run-id')

      expect(result.passed).toBe(true)
      expect(result.failures).toHaveLength(0)
    })

    it('returns passed=false and collects all failures when gates fail', async () => {
      const gates = [
        { name: 'gate1', check: vi.fn().mockResolvedValue(false), errorMessage: 'Gate 1 failed' },
        { name: 'gate2', check: vi.fn().mockResolvedValue(false), errorMessage: 'Gate 2 failed' },
        { name: 'gate3', check: vi.fn().mockResolvedValue(true), errorMessage: 'Gate 3 failed' },
      ]

      const result = await runGates(gates, db, 'test-run-id')

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(2)
      expect(result.failures[0].gate).toBe('gate1')
      expect(result.failures[1].gate).toBe('gate2')
    })

    it('does not short-circuit — reports all failed gates', async () => {
      const gate1Check = vi.fn().mockResolvedValue(false)
      const gate2Check = vi.fn().mockResolvedValue(false)
      const gates = [
        { name: 'gate1', check: gate1Check, errorMessage: 'Gate 1 failed' },
        { name: 'gate2', check: gate2Check, errorMessage: 'Gate 2 failed' },
      ]

      await runGates(gates, db, 'test-run-id')

      // Both gate checks should be called (no short-circuit)
      expect(gate1Check).toHaveBeenCalledOnce()
      expect(gate2Check).toHaveBeenCalledOnce()
    })

    it('handles gate check errors gracefully', async () => {
      const gates = [
        {
          name: 'error-gate',
          check: vi.fn().mockRejectedValue(new Error('DB error')),
          errorMessage: 'Error gate failed',
        },
      ]

      const result = await runGates(gates, db, 'test-run-id')

      expect(result.passed).toBe(false)
      expect(result.failures[0].gate).toBe('error-gate')
      expect(result.failures[0].error).toContain('DB error')
    })

    it('returns passed=true for empty gates array', async () => {
      const result = await runGates([], db, 'test-run-id')

      expect(result.passed).toBe(true)
      expect(result.failures).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // serializePhaseHistory / deserializePhaseHistory
  // -------------------------------------------------------------------------

  describe('Phase history serialization', () => {
    it('serializes and deserializes phase history round-trip', () => {
      const history = [
        {
          phase: 'analysis',
          startedAt: '2024-01-01T00:00:00Z',
          completedAt: '2024-01-01T00:01:00Z',
          gateResults: [{ gate: 'product-brief-exists', passed: true }],
        },
        {
          phase: 'planning',
          startedAt: '2024-01-01T00:01:00Z',
          gateResults: [],
        },
      ]

      const serialized = serializePhaseHistory(history)
      const deserialized = deserializePhaseHistory(serialized)

      expect(deserialized).toEqual(history)
    })

    it('deserializePhaseHistory returns empty array for null input', () => {
      expect(deserializePhaseHistory(null)).toEqual([])
      expect(deserializePhaseHistory(undefined)).toEqual([])
      expect(deserializePhaseHistory('')).toEqual([])
    })

    it('deserializePhaseHistory returns empty array for invalid JSON', () => {
      expect(deserializePhaseHistory('not-json')).toEqual([])
      expect(deserializePhaseHistory('{invalid}')).toEqual([])
    })

    it('deserializePhaseHistory returns empty array for non-array JSON', () => {
      expect(deserializePhaseHistory('"string"')).toEqual([])
      expect(deserializePhaseHistory('42')).toEqual([])
      expect(deserializePhaseHistory('{}')).toEqual([])
    })
  })
})
