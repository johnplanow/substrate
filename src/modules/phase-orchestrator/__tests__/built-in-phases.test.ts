/**
 * Unit tests for built-in phase definitions.
 *
 * Covers AC2 (entry gates) and AC3 (exit gates) for all four phases:
 * analysis, planning, solutioning, and implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { registerArtifact, createPipelineRun } from '../../../persistence/queries/decisions.js'
import {
  createAnalysisPhaseDefinition,
  createPlanningPhaseDefinition,
  createSolutioningPhaseDefinition,
  createImplementationPhaseDefinition,
  createUxDesignPhaseDefinition,
  createResearchPhaseDefinition,
  createBuiltInPhases,
} from '../built-in-phases.js'
import { runGates, createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'built-in-phases-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'test', start_phase: 'analysis' })
  return run.id
}

function registerArtifactForRun(
  db: BetterSqlite3Database,
  runId: string,
  phase: string,
  type: string,
): void {
  registerArtifact(db, {
    pipeline_run_id: runId,
    phase,
    type,
    path: `/artifacts/${phase}-${type}.md`,
    summary: `Test ${type} from ${phase}`,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Built-in Phase Definitions', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    tmpDir = result.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Analysis phase
  // -------------------------------------------------------------------------

  describe('Analysis phase', () => {
    it('has no entry gates (first phase)', () => {
      const phase = createAnalysisPhaseDefinition()
      expect(phase.name).toBe('analysis')
      expect(phase.entryGates).toHaveLength(0)
    })

    it('has one exit gate checking for product-brief artifact', () => {
      const phase = createAnalysisPhaseDefinition()
      expect(phase.exitGates).toHaveLength(1)
      expect(phase.exitGates[0].name).toContain('product-brief')
    })

    it('exit gate fails when product-brief artifact is missing', async () => {
      const phase = createAnalysisPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].gate).toContain('product-brief')
    })

    it('exit gate passes when product-brief artifact exists for this run', async () => {
      registerArtifactForRun(db, runId, 'analysis', 'product-brief')

      const phase = createAnalysisPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
      expect(result.failures).toHaveLength(0)
    })

    it('exit gate fails for a different run ID even when artifact exists for another run', async () => {
      // Create a separate run and register the artifact for that run
      const otherRunId = createTestRun(db)
      registerArtifactForRun(db, otherRunId, 'analysis', 'product-brief')

      const phase = createAnalysisPhaseDefinition()
      // Check gates for OUR run (not the other run)
      const result = await runGates(phase.exitGates, db, runId)

      // Should fail because the artifact belongs to a different run
      expect(result.passed).toBe(false)
    })

    it('has onEnter and onExit callbacks', () => {
      const phase = createAnalysisPhaseDefinition()
      expect(typeof phase.onEnter).toBe('function')
      expect(typeof phase.onExit).toBe('function')
    })
  })

  // -------------------------------------------------------------------------
  // Planning phase
  // -------------------------------------------------------------------------

  describe('Planning phase', () => {
    it('has one entry gate checking for product-brief artifact', () => {
      const phase = createPlanningPhaseDefinition()
      expect(phase.name).toBe('planning')
      expect(phase.entryGates).toHaveLength(1)
      expect(phase.entryGates[0].name).toContain('product-brief')
    })

    it('has one exit gate checking for prd artifact', () => {
      const phase = createPlanningPhaseDefinition()
      expect(phase.exitGates).toHaveLength(1)
      expect(phase.exitGates[0].name).toContain('prd')
    })

    it('entry gate fails when product-brief is missing', async () => {
      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures[0].gate).toContain('product-brief')
    })

    it('entry gate passes when product-brief exists for this run', async () => {
      registerArtifactForRun(db, runId, 'analysis', 'product-brief')

      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(true)
    })

    it('exit gate fails when prd is missing', async () => {
      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures[0].gate).toContain('prd')
    })

    it('exit gate passes when prd artifact exists for this run', async () => {
      registerArtifactForRun(db, runId, 'planning', 'prd')

      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Solutioning phase
  // -------------------------------------------------------------------------

  describe('Solutioning phase', () => {
    it('has one entry gate checking for prd artifact', () => {
      const phase = createSolutioningPhaseDefinition()
      expect(phase.name).toBe('solutioning')
      expect(phase.entryGates).toHaveLength(1)
      expect(phase.entryGates[0].name).toContain('prd')
    })

    it('has two exit gates checking for architecture and stories artifacts', () => {
      const phase = createSolutioningPhaseDefinition()
      expect(phase.exitGates).toHaveLength(2)

      const gateNames = phase.exitGates.map((g) => g.name)
      expect(gateNames.some((n) => n.includes('architecture'))).toBe(true)
      expect(gateNames.some((n) => n.includes('stories'))).toBe(true)
    })

    it('entry gate fails when prd is missing', async () => {
      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
    })

    it('entry gate passes when prd exists for this run', async () => {
      registerArtifactForRun(db, runId, 'planning', 'prd')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(true)
    })

    it('exit gates fail when neither architecture nor stories exist', async () => {
      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(2)
    })

    it('exit gates fail when only architecture exists (stories missing)', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].gate).toContain('stories')
    })

    it('exit gates fail when only stories exists (architecture missing)', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'stories')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].gate).toContain('architecture')
    })

    it('exit gates pass when both architecture and stories exist', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')
      registerArtifactForRun(db, runId, 'solutioning', 'stories')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Implementation phase
  // -------------------------------------------------------------------------

  describe('Implementation phase', () => {
    it('has three entry gates: architecture, stories, and solutioning-readiness', () => {
      const phase = createImplementationPhaseDefinition()
      expect(phase.name).toBe('implementation')
      expect(phase.entryGates).toHaveLength(3)

      const gateNames = phase.entryGates.map((g) => g.name)
      expect(gateNames.some((n) => n.includes('architecture'))).toBe(true)
      expect(gateNames.some((n) => n.includes('stories'))).toBe(true)
      expect(gateNames.some((n) => n.includes('readiness'))).toBe(true)
    })

    it('entry gates fail when architecture and stories are missing', async () => {
      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures.length).toBeGreaterThanOrEqual(2)
    })

    it('entry gates fail when only architecture exists (stories missing)', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')

      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
    })

    it('entry gates pass when both architecture and stories exist', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')
      registerArtifactForRun(db, runId, 'solutioning', 'stories')

      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(true)
    })

    it('has one exit gate checking for implementation-complete artifact', () => {
      const phase = createImplementationPhaseDefinition()
      expect(phase.exitGates).toHaveLength(1)
      expect(phase.exitGates[0].name).toContain('implementation-complete')
    })

    it('exit gate fails when implementation-complete artifact is missing', async () => {
      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
    })

    it('exit gate passes when implementation-complete artifact exists', async () => {
      registerArtifactForRun(db, runId, 'implementation', 'implementation-complete')

      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// T8: Conditional UX design phase registration tests
// ---------------------------------------------------------------------------

function makeMockPackWithUxDesign(uxDesign?: boolean): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
      ...(uxDesign !== undefined ? { uxDesign } : {}),
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

describe('createBuiltInPhases - conditional UX design registration (T8)', () => {
  it('returns 4 phases by default (no uxDesignEnabled)', () => {
    const phases = createBuiltInPhases()
    expect(phases).toHaveLength(4)
  })

  it('returns 4 phases when uxDesignEnabled is false', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: false })
    expect(phases).toHaveLength(4)
  })

  it('returns 5 phases when uxDesignEnabled is true', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    expect(phases).toHaveLength(5)
  })

  it('does NOT include ux-design phase by default', () => {
    const phases = createBuiltInPhases()
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('ux-design')
  })

  it('includes ux-design phase when uxDesignEnabled is true', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toContain('ux-design')
  })

  it('ux-design phase is inserted between planning and solutioning', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    const uxIdx = names.indexOf('ux-design')
    const planningIdx = names.indexOf('planning')
    const solutioningIdx = names.indexOf('solutioning')

    expect(uxIdx).toBe(planningIdx + 1)
    expect(solutioningIdx).toBe(uxIdx + 1)
  })

  it('phase order with UX enabled is analysis, planning, ux-design, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'ux-design', 'solutioning', 'implementation'])
  })

  it('phase order without UX is analysis, planning, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: false })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'solutioning', 'implementation'])
  })
})

describe('createUxDesignPhaseDefinition (T8)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    tmpDir = result.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has name "ux-design"', () => {
    const phase = createUxDesignPhaseDefinition()
    expect(phase.name).toBe('ux-design')
  })

  it('has one entry gate checking for prd artifact from planning', () => {
    const phase = createUxDesignPhaseDefinition()
    expect(phase.entryGates).toHaveLength(1)
    expect(phase.entryGates[0].name).toContain('prd')
  })

  it('has one exit gate checking for ux-design artifact', () => {
    const phase = createUxDesignPhaseDefinition()
    expect(phase.exitGates).toHaveLength(1)
    expect(phase.exitGates[0].name).toContain('ux-design')
  })

  it('entry gate fails when prd artifact is missing', async () => {
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.entryGates, db, runId)
    expect(result.passed).toBe(false)
    expect(result.failures[0].gate).toContain('prd')
  })

  it('entry gate passes when prd artifact exists', async () => {
    registerArtifactForRun(db, runId, 'planning', 'prd')
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.entryGates, db, runId)
    expect(result.passed).toBe(true)
  })

  it('exit gate fails when ux-design artifact is missing', async () => {
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.exitGates, db, runId)
    expect(result.passed).toBe(false)
    expect(result.failures[0].gate).toContain('ux-design')
  })

  it('exit gate passes when ux-design artifact exists', async () => {
    registerArtifactForRun(db, runId, 'ux-design', 'ux-design')
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.exitGates, db, runId)
    expect(result.passed).toBe(true)
  })

  it('has onEnter and onExit callbacks', () => {
    const phase = createUxDesignPhaseDefinition()
    expect(typeof phase.onEnter).toBe('function')
    expect(typeof phase.onExit).toBe('function')
  })
})

describe('PhaseOrchestrator - conditional UX design registration (T8)', () => {
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

  it('registers 4 phases when pack manifest has uxDesign: false', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    expect(orchestrator.getPhases()).toHaveLength(4)
  })

  it('registers 5 phases when pack manifest has uxDesign: true', () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    expect(orchestrator.getPhases()).toHaveLength(5)
  })

  it('does NOT include ux-design when pack manifest has uxDesign: false', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).not.toContain('ux-design')
  })

  it('includes ux-design when pack manifest has uxDesign: true', () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toContain('ux-design')
  })

  it('does NOT include ux-design when pack manifest has no uxDesign field', () => {
    const pack = makeMockPackWithUxDesign(undefined)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).not.toContain('ux-design')
  })

  it('ux-design is between planning and solutioning when uxDesign: true', () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    const uxIdx = names.indexOf('ux-design')
    const planningIdx = names.indexOf('planning')
    const solutioningIdx = names.indexOf('solutioning')
    expect(uxIdx).toBe(planningIdx + 1)
    expect(solutioningIdx).toBe(uxIdx + 1)
  })

  it('can advance from planning to ux-design when prd artifact exists and uxDesign enabled', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Test concept')

    // Complete analysis
    registerArtifactForRun(db, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Complete planning
    registerArtifactForRun(db, runId, 'planning', 'prd')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('ux-design')
  })

  it('can advance from ux-design to solutioning when ux-design artifact exists', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Test concept')

    // Complete analysis
    registerArtifactForRun(db, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Complete planning
    registerArtifactForRun(db, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)

    // Complete ux-design
    registerArtifactForRun(db, runId, 'ux-design', 'ux-design')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('solutioning')
  })
})

// ---------------------------------------------------------------------------
// Research phase unit tests (Story 20.1)
// ---------------------------------------------------------------------------

describe('createResearchPhaseDefinition (Story 20.1)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    tmpDir = result.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has name "research"', () => {
    const phase = createResearchPhaseDefinition()
    expect(phase.name).toBe('research')
  })

  it('has no entry gates (research is always the pipeline entrypoint when enabled)', () => {
    const phase = createResearchPhaseDefinition()
    expect(phase.entryGates).toHaveLength(0)
  })

  it('has one exit gate checking for research-findings artifact', () => {
    const phase = createResearchPhaseDefinition()
    expect(phase.exitGates).toHaveLength(1)
    expect(phase.exitGates[0].name).toContain('research-findings')
  })

  it('exit gate fails when research-findings artifact is missing', async () => {
    const phase = createResearchPhaseDefinition()
    const result = await runGates(phase.exitGates, db, runId)
    expect(result.passed).toBe(false)
    expect(result.failures[0].gate).toContain('research-findings')
  })

  it('exit gate passes when research-findings artifact exists', async () => {
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    const phase = createResearchPhaseDefinition()
    const result = await runGates(phase.exitGates, db, runId)
    expect(result.passed).toBe(true)
  })

  it('has onEnter and onExit callbacks', () => {
    const phase = createResearchPhaseDefinition()
    expect(typeof phase.onEnter).toBe('function')
    expect(typeof phase.onExit).toBe('function')
  })
})

describe('createBuiltInPhases - conditional research registration (Story 20.1)', () => {
  it('returns 4 phases by default (no researchEnabled)', () => {
    const phases = createBuiltInPhases()
    expect(phases).toHaveLength(4)
  })

  it('returns 4 phases when researchEnabled is false', () => {
    const phases = createBuiltInPhases({ researchEnabled: false })
    expect(phases).toHaveLength(4)
  })

  it('returns 5 phases when researchEnabled is true', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    expect(phases).toHaveLength(5)
  })

  it('does NOT include research phase by default', () => {
    const phases = createBuiltInPhases()
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('research')
  })

  it('includes research phase when researchEnabled is true', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toContain('research')
  })

  it('research phase is at position 0 (before analysis) when enabled', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names[0]).toBe('research')
    expect(names[1]).toBe('analysis')
  })

  it('phase order with research enabled is research, analysis, planning, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['research', 'analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('phase order without research is analysis, planning, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ researchEnabled: false })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('analysis phase has no entry gates when research is disabled', () => {
    const phases = createBuiltInPhases({ researchEnabled: false })
    const analysis = phases.find((p) => p.name === 'analysis')
    expect(analysis?.entryGates).toHaveLength(0)
  })

  it('analysis phase has research-findings entry gate when research is enabled', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const analysis = phases.find((p) => p.name === 'analysis')
    expect(analysis?.entryGates).toHaveLength(1)
    expect(analysis?.entryGates[0].name).toContain('research-findings')
  })

  it('returns 6 phases when both research and uxDesign are enabled', () => {
    const phases = createBuiltInPhases({ researchEnabled: true, uxDesignEnabled: true })
    expect(phases).toHaveLength(6)
  })

  it('phase order with research and ux-design enabled is research, analysis, planning, ux-design, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ researchEnabled: true, uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['research', 'analysis', 'planning', 'ux-design', 'solutioning', 'implementation'])
  })
})

describe('createAnalysisPhaseDefinition - conditional research entry gate (Story 20.1)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    tmpDir = result.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has no entry gates when requiresResearch is not set', () => {
    const phase = createAnalysisPhaseDefinition()
    expect(phase.entryGates).toHaveLength(0)
  })

  it('has no entry gates when requiresResearch is false', () => {
    const phase = createAnalysisPhaseDefinition({ requiresResearch: false })
    expect(phase.entryGates).toHaveLength(0)
  })

  it('has one entry gate when requiresResearch is true', () => {
    const phase = createAnalysisPhaseDefinition({ requiresResearch: true })
    expect(phase.entryGates).toHaveLength(1)
    expect(phase.entryGates[0].name).toContain('research-findings')
  })

  it('entry gate fails when research-findings artifact is missing (requiresResearch: true)', async () => {
    const phase = createAnalysisPhaseDefinition({ requiresResearch: true })
    const result = await runGates(phase.entryGates, db, runId)
    expect(result.passed).toBe(false)
    expect(result.failures[0].gate).toContain('research-findings')
  })

  it('entry gate passes when research-findings artifact exists (requiresResearch: true)', async () => {
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    const phase = createAnalysisPhaseDefinition({ requiresResearch: true })
    const result = await runGates(phase.entryGates, db, runId)
    expect(result.passed).toBe(true)
  })
})

describe('PhaseOrchestrator - conditional research registration (Story 20.1)', () => {
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

  it('registers 4 phases when pack manifest has research: false', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({
      db,
      pack: { ...pack, manifest: { ...pack.manifest, research: false } },
    })
    expect(orchestrator.getPhases()).toHaveLength(4)
  })

  it('registers 5 phases when pack manifest has research: true', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({
      db,
      pack: { ...pack, manifest: { ...pack.manifest, research: true } },
    })
    expect(orchestrator.getPhases()).toHaveLength(5)
  })

  it('does NOT include research when pack manifest has research: false', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({
      db,
      pack: { ...pack, manifest: { ...pack.manifest, research: false } },
    })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).not.toContain('research')
  })

  it('includes research when pack manifest has research: true', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({
      db,
      pack: { ...pack, manifest: { ...pack.manifest, research: true } },
    })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toContain('research')
  })

  it('research is the first phase (before analysis) when research: true', () => {
    const pack = makeMockPackWithUxDesign(false)
    const orchestrator = createPhaseOrchestrator({
      db,
      pack: { ...pack, manifest: { ...pack.manifest, research: true } },
    })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names[0]).toBe('research')
    expect(names[1]).toBe('analysis')
  })
})
