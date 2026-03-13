/**
 * Integration tests for pipeline with UX design phase skipped (Story 16-5 T11).
 *
 * Verifies that the pipeline operates correctly when UX design is disabled
 * (the default behavior — ux-design is an opt-in phase):
 *
 *   AC4: When uxDesign is not enabled, solutioning proceeds directly after planning
 *   AC7: No ux-design artifact gate blocks solutioning progression
 *
 * These tests confirm the "skipped" path: analysis -> planning -> solutioning,
 * with no intermediate ux-design phase and no ux-design artifact requirement.
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
  createSolutioningPhaseDefinition,
} from '../built-in-phases.js'
import { runGates } from '../phase-orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ux-skipped-integration-'))
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
      description: 'Test pack without UX design',
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
// Tests: createBuiltInPhases without UX design
// ---------------------------------------------------------------------------

describe('createBuiltInPhases - UX design disabled (default)', () => {
  it('returns exactly 4 phases when called with no arguments', () => {
    const phases = createBuiltInPhases()
    expect(phases).toHaveLength(4)
  })

  it('does NOT include ux-design phase in default phase list', () => {
    const phases = createBuiltInPhases()
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('ux-design')
  })

  it('phase order is analysis, planning, solutioning, implementation (no ux-design)', () => {
    const phases = createBuiltInPhases()
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'solutioning', 'implementation'])
  })

  it('planning phase is immediately followed by solutioning (no intermediate phase)', () => {
    const phases = createBuiltInPhases()
    const planningIdx = phases.findIndex((p) => p.name === 'planning')
    const solutioningIdx = phases.findIndex((p) => p.name === 'solutioning')
    expect(solutioningIdx).toBe(planningIdx + 1)
  })
})

// ---------------------------------------------------------------------------
// Tests: PhaseOrchestrator phase list without UX design
// ---------------------------------------------------------------------------

describe('PhaseOrchestrator - phase list without UX design', () => {
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

  it('registers exactly 4 phases when pack has no UX design config', () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const phases = orchestrator.getPhases()
    expect(phases).toHaveLength(4)
  })

  it('phase list does NOT include ux-design', () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const phases = orchestrator.getPhases()
    const names = phases.map((p) => p.name)
    expect(names).not.toContain('ux-design')
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
// Tests: Solutioning entry gate without UX design artifact requirement
// ---------------------------------------------------------------------------

describe('Solutioning entry gate - no ux-design gate when UX skipped', () => {
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

  it('solutioning has exactly 1 entry gate (prd only, no ux-design gate)', () => {
    const phase = createSolutioningPhaseDefinition()
    expect(phase.entryGates).toHaveLength(1)
  })

  it('solutioning entry gate only checks for prd artifact (not ux-design)', () => {
    const phase = createSolutioningPhaseDefinition()
    const gateNames = phase.entryGates.map((g) => g.name)
    expect(gateNames.some((n) => n.includes('prd'))).toBe(true)
    expect(gateNames.some((n) => n.includes('ux-design'))).toBe(false)
  })

  it('solutioning entry gate passes with prd artifact alone (no ux-design artifact needed)', async () => {
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    // Deliberately do NOT register any ux-design artifact

    const phase = createSolutioningPhaseDefinition()
    const result = await runGates(phase.entryGates, adapter, runId)

    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  it('solutioning entry gate still requires prd (fails without it)', async () => {
    // No artifacts registered at all
    const phase = createSolutioningPhaseDefinition()
    const result = await runGates(phase.entryGates, adapter, runId)

    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.gate.includes('prd'))).toBe(true)
  })

  it('solutioning entry gate passes even when ux-design artifact does NOT exist', async () => {
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    // ux-design artifact explicitly not registered (simulating UX skipped)

    const phase = createSolutioningPhaseDefinition()
    const gateNames = phase.entryGates.map((g) => g.name)
    // Confirm ux-design is not in the gate names
    expect(gateNames.every((n) => !n.includes('ux-design'))).toBe(true)

    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Full pipeline advance without UX design
// ---------------------------------------------------------------------------

describe('Full pipeline advance without UX design', () => {
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

  it('can advance analysis to planning when product-brief artifact registered', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('planning')
  })

  it('can advance planning to solutioning with prd artifact (no ux-design artifact needed)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Complete analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Complete planning, advance directly to solutioning (no ux-design step)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('solutioning')
  })

  it('next phase after planning is solutioning (not ux-design)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const result = await orchestrator.advancePhase(runId)

    // Confirm we went directly from planning to solutioning, not to ux-design
    expect(result.phase).toBe('solutioning')
    expect(result.phase).not.toBe('ux-design')
  })

  it('pipeline status shows phase history without ux-design when UX skipped', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    const status = await orchestrator.getRunStatus(runId)
    const phaseNames = status.phaseHistory.map((h) => h.phase)

    expect(phaseNames).not.toContain('ux-design')
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
  })

  it('pipeline can complete analysis, planning, and solutioning phases without any ux-design involvement', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Phase 1: analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const planningResult = await orchestrator.advancePhase(runId)
    expect(planningResult.advanced).toBe(true)
    expect(planningResult.phase).toBe('planning')

    // Phase 2: planning -> solutioning (skipping ux-design)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const solutioningResult = await orchestrator.advancePhase(runId)
    expect(solutioningResult.advanced).toBe(true)
    expect(solutioningResult.phase).toBe('solutioning')

    // Confirm current phase is solutioning
    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('solutioning')

    // Confirm no ux-design in completed phases or history
    const completedPhases = status.completedPhases
    expect(completedPhases).not.toContain('ux-design')
  })

  it('planning phase cannot advance to solutioning without prd artifact (gate still enforced)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Complete analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Try to advance from planning without prd
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('prd'))).toBe(true)
  })
})
