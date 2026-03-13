/**
 * Integration tests for pipeline with research phase disabled (Story 20.1).
 *
 * Verifies that the pipeline operates correctly when research is disabled
 * (the default behavior — research is an opt-in phase):
 *
 *   AC1: When research is not enabled, analysis proceeds as the first phase
 *   AC3: No research-findings artifact gate blocks analysis progression
 *
 * These tests confirm the "disabled" path: analysis -> planning -> solutioning,
 * with no research phase and no research-findings artifact requirement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SyncDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun, registerArtifact } from '../../../persistence/queries/decisions.js'
import { createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import {
  createBuiltInPhases,
  createAnalysisPhaseDefinition,
} from '../built-in-phases.js'
import { runGates } from '../phase-orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'research-disabled-integration-'))
  const db = new Database(join(tmpDir, 'test.db'))
  const adapter = new SyncDatabaseAdapter(db)
  await initSchema(adapter)
  return { db, adapter, tmpDir }
}

async function registerArtifactForRun(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
  type: string,
): Promise<void> {
  await registerArtifact(adapter, {
    pipeline_run_id: runId,
    phase,
    type,
    path: `/artifacts/${phase}-${type}.md`,
    summary: `Test ${type} from ${phase}`,
  })
}

function makeMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack without research',
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

// ---------------------------------------------------------------------------
// Tests: createBuiltInPhases without research
// ---------------------------------------------------------------------------

describe('createBuiltInPhases - research disabled (default)', () => {
  it('returns exactly 4 phases when called with no arguments', () => {
    const phases = createBuiltInPhases()
    expect(phases).toHaveLength(4)
  })

  it('does NOT include research phase in default phase list', () => {
    const phases = createBuiltInPhases()
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('research')
  })

  it('phase order is analysis, planning, solutioning, implementation (no research)', () => {
    const phases = createBuiltInPhases()
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('analysis phase is the first phase when research is disabled', () => {
    const phases = createBuiltInPhases()
    expect(phases[0].name).toBe('analysis')
  })
})

// ---------------------------------------------------------------------------
// Tests: PhaseOrchestrator phase list without research
// ---------------------------------------------------------------------------

describe('PhaseOrchestrator - phase list without research', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string

  beforeEach(async () => {
    const r = await createTestDb()
    db = r.db
    adapter = r.adapter
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers exactly 4 phases when pack has no research config', () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const phases = orchestrator.getPhases()
    expect(phases).toHaveLength(4)
  })

  it('phase list does NOT include research', () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const phases = orchestrator.getPhases()
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('research')
  })

  it('phase list is [analysis, planning, solutioning, implementation]', () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const phases = orchestrator.getPhases()
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'solutioning', 'implementation'])
  })
})

// ---------------------------------------------------------------------------
// Tests: Analysis entry gate without research requirement
// ---------------------------------------------------------------------------

describe('Analysis entry gate - no research gate when research disabled', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const r = await createTestDb()
    db = r.db
    adapter = r.adapter
    tmpDir = r.tmpDir
    const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
    runId = run.id
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('analysis has no entry gates when research is disabled (AC3)', () => {
    const phase = createAnalysisPhaseDefinition()
    expect(phase.entryGates).toHaveLength(0)
  })

  it('analysis entry gate does NOT check for research-findings (AC3)', () => {
    const phase = createAnalysisPhaseDefinition()
    const gateNames = phase.entryGates.map((g) => g.name)
    expect(gateNames.every((n) => !n.includes('research'))).toBe(true)
  })

  it('analysis entry gates pass with no artifacts (no research requirement)', async () => {
    // No artifacts registered
    const phase = createAnalysisPhaseDefinition()
    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  it('analysis entry gates pass even when research-findings artifact does NOT exist', async () => {
    // research-findings explicitly not registered (simulating research skipped)
    const phase = createAnalysisPhaseDefinition()
    const gateNames = phase.entryGates.map((g) => g.name)
    // Confirm research is not in the gate names
    expect(gateNames.every((n) => !n.includes('research'))).toBe(true)

    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Full pipeline advance without research
// ---------------------------------------------------------------------------

describe('Full pipeline advance without research', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string

  beforeEach(async () => {
    const r = await createTestDb()
    db = r.db
    adapter = r.adapter
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('starts at analysis phase (not research) when research is disabled', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('analysis')
    expect(status.currentPhase).not.toBe('research')
  })

  it('can advance analysis to planning when product-brief artifact registered', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('planning')
  })

  it('can advance planning to solutioning with prd artifact (no research-findings needed)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Complete analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Complete planning, advance directly to solutioning (no research step)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('solutioning')
  })

  it('next phase after starting is analysis (not research)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('analysis')
  })

  it('pipeline status shows phase history without research when research skipped', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    const status = await orchestrator.getRunStatus(runId)
    const phaseNames = status.phaseHistory.map((h) => h.phase)

    expect(phaseNames).not.toContain('research')
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
  })

  it('pipeline can complete analysis, planning, and solutioning phases without any research involvement', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Phase 1: analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const planningResult = await orchestrator.advancePhase(runId)
    expect(planningResult.advanced).toBe(true)
    expect(planningResult.phase).toBe('planning')

    // Phase 2: planning -> solutioning (skipping research)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const solutioningResult = await orchestrator.advancePhase(runId)
    expect(solutioningResult.advanced).toBe(true)
    expect(solutioningResult.phase).toBe('solutioning')

    // Confirm current phase is solutioning
    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('solutioning')

    // Confirm no research in completed phases or history
    const completedPhases = status.completedPhases
    expect(completedPhases).not.toContain('research')
  })

  it('analysis cannot advance without product-brief artifact (gate still enforced)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Try to advance from analysis without product-brief
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('product-brief'))).toBe(true)
  })
})
