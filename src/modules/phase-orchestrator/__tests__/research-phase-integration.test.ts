/**
 * Integration tests for pipeline with research phase enabled (Story 20-3).
 *
 * Verifies that the pipeline operates correctly when research is enabled
 * via `research: true` in the pack manifest:
 *
 *   AC1: research phase is registered before analysis
 *   AC4: When research is true, phase runs and its decisions are available
 *   AC5: research-findings artifact is registered on completion
 *
 * These tests confirm the "enabled" path:
 *   research -> analysis -> planning -> solutioning -> implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPipelineRun, registerArtifact } from '../../../persistence/queries/decisions.js'
import { createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import {
  createBuiltInPhases,
  createResearchPhaseDefinition,
} from '../built-in-phases.js'
import { runGates } from '../phase-orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'research-integration-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
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

function makeMockPackWithResearch(research = true): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack with research phase',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
      research,
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

// ---------------------------------------------------------------------------
// Tests: createBuiltInPhases with research enabled
// ---------------------------------------------------------------------------

describe('createBuiltInPhases - research enabled', () => {
  it('returns exactly 5 phases when researchEnabled is true', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    expect(phases).toHaveLength(5)
  })

  it('includes research phase in phase list', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toContain('research')
  })

  it('phase order is research, analysis, planning, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['research', 'analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('research is immediately followed by analysis', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    const researchIdx = names.indexOf('research')
    expect(names[researchIdx + 1]).toBe('analysis')
  })

  it('research is the first phase when enabled', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    expect(phases[0].name).toBe('research')
  })

  it('returns 4 phases when researchEnabled is false', () => {
    const phases = createBuiltInPhases({ researchEnabled: false })
    expect(phases).toHaveLength(4)
  })

  it('does not include research phase when researchEnabled is false', () => {
    const phases = createBuiltInPhases({ researchEnabled: false })
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('research')
  })
})

// ---------------------------------------------------------------------------
// Tests: PhaseOrchestrator with research enabled
// ---------------------------------------------------------------------------

describe('PhaseOrchestrator - research enabled', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers 5 phases when pack has research: true', () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    expect(orchestrator.getPhases()).toHaveLength(5)
  })

  it('phase list includes research when research: true', () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toContain('research')
  })

  it('phase list is [research, analysis, planning, solutioning, implementation]', () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toEqual(['research', 'analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('registers 4 phases when pack has research: false', () => {
    const pack = makeMockPackWithResearch(false)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    expect(orchestrator.getPhases()).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Tests: research gate enforcement (AC5)
// ---------------------------------------------------------------------------

describe('research gate enforcement', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
    const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'research' })
    runId = run.id
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('research phase has no entry gates (always can be entered)', async () => {
    const phase = createResearchPhaseDefinition()
    expect(phase.entryGates).toHaveLength(0)
  })

  it('research exit gate requires research-findings artifact (AC5)', async () => {
    const phase = createResearchPhaseDefinition()
    const result = await runGates(phase.exitGates, db, runId)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.gate.includes('research-findings'))).toBe(true)
  })

  it('research exit gate passes with research-findings artifact (AC5)', async () => {
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    const phase = createResearchPhaseDefinition()
    const result = await runGates(phase.exitGates, db, runId)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Full pipeline advance with research enabled
// ---------------------------------------------------------------------------

describe('Full pipeline advance with research enabled', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('advances from research to analysis', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    registerArtifactForRun(db, runId, 'research', 'research-findings')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('analysis')
  })

  it('research is the starting phase when research: true', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('research')
  })

  it('cannot advance from research without research-findings artifact', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    // Try to advance without registering research-findings artifact
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('research-findings'))).toBe(true)
  })

  it('advances from analysis to planning after research completes', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    // Complete research
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    // Complete analysis
    registerArtifactForRun(db, runId, 'analysis', 'product-brief')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('planning')
  })

  it('full pipeline includes research in completed phases', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    // Complete research -> analysis -> planning
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    registerArtifactForRun(db, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    registerArtifactForRun(db, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)

    const status = await orchestrator.getRunStatus(runId)
    expect(status.completedPhases).toContain('research')
    expect(status.completedPhases).toContain('analysis')
    expect(status.completedPhases).toContain('planning')
    expect(status.currentPhase).toBe('solutioning')
  })

  it('resumeRun resumes at research when no artifacts registered', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    // Resume without completing anything — should still be at research
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('research')
  })

  it('resumeRun resumes at analysis when research-findings artifact exists', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    // Register research-findings but don't advance
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    // Resume — should be at analysis since research is complete
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('analysis')
  })

  it('phase history includes research when research phase is traversed', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build an AI-powered research assistant')

    // Complete research
    registerArtifactForRun(db, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    // Complete analysis
    registerArtifactForRun(db, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    const status = await orchestrator.getRunStatus(runId)
    const phaseNames = status.phaseHistory.map((h) => h.phase)
    expect(phaseNames).toContain('research')
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
  })
})
