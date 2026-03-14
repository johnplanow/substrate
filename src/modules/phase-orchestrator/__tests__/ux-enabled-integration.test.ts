/**
 * Integration tests for pipeline with UX design phase enabled (Story 16-5, T10).
 *
 * Verifies that the pipeline operates correctly when UX design is enabled
 * via `uxDesign: true` in the pack manifest:
 *
 *   AC1: ux-design phase is registered between planning and solutioning
 *   AC4: When uxDesign is true, phase runs and its decisions are available to architecture
 *   AC7: Solutioning entry gate is conditionally applied (ux-design gate applied when enabled)
 *
 * These tests confirm the "enabled" path:
 *   analysis -> planning -> ux-design -> solutioning -> implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun, registerArtifact } from '../../../persistence/queries/decisions.js'
import { createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import {
  createBuiltInPhases,
  createUxDesignPhaseDefinition,
} from '../built-in-phases.js'
import { runGates } from '../phase-orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: WasmSqliteDatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ux-enabled-integration-'))
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  await initSchema(adapter)
  return { adapter, tmpDir }
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

function makeMockPackWithUxDesign(uxDesign = true): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack with UX design',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
      uxDesign,
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

// ---------------------------------------------------------------------------
// Tests: createBuiltInPhases with UX design enabled
// ---------------------------------------------------------------------------

describe('createBuiltInPhases - UX design enabled (T10)', () => {
  it('returns exactly 5 phases when uxDesignEnabled is true', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    expect(phases).toHaveLength(5)
  })

  it('includes ux-design phase in phase list', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toContain('ux-design')
  })

  it('phase order is analysis, planning, ux-design, solutioning, implementation', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'ux-design', 'solutioning', 'implementation'])
  })

  it('planning is immediately followed by ux-design (AC1)', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    const planningIdx = names.indexOf('planning')
    expect(names[planningIdx + 1]).toBe('ux-design')
  })

  it('ux-design is immediately followed by solutioning (AC1)', () => {
    const phases = createBuiltInPhases({ uxDesignEnabled: true })
    const names = phases.map((p) => p.name)
    const uxIdx = names.indexOf('ux-design')
    expect(names[uxIdx + 1]).toBe('solutioning')
  })
})

// ---------------------------------------------------------------------------
// Tests: PhaseOrchestrator with UX design enabled
// ---------------------------------------------------------------------------

describe('PhaseOrchestrator - UX design enabled (T10)', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let tmpDir: string

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
    tmpDir = r.tmpDir
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers 5 phases when pack has uxDesign: true', () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    expect(orchestrator.getPhases()).toHaveLength(5)
  })

  it('phase list includes ux-design when uxDesign: true', () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toContain('ux-design')
  })

  it('phase list is [analysis, planning, ux-design, solutioning, implementation]', () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toEqual(['analysis', 'planning', 'ux-design', 'solutioning', 'implementation'])
  })
})

// ---------------------------------------------------------------------------
// Tests: UX design gate enforcement
// ---------------------------------------------------------------------------

describe('UX design gate enforcement (T10)', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
    tmpDir = r.tmpDir
    const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
    runId = run.id
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ux-design entry gate requires prd artifact', async () => {
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.gate.includes('prd'))).toBe(true)
  })

  it('ux-design entry gate passes with prd artifact', async () => {
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(true)
  })

  it('ux-design exit gate requires ux-design artifact', async () => {
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.exitGates, adapter, runId)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.gate.includes('ux-design'))).toBe(true)
  })

  it('ux-design exit gate passes with ux-design artifact', async () => {
    await registerArtifactForRun(adapter, runId, 'ux-design', 'ux-design')
    const phase = createUxDesignPhaseDefinition()
    const result = await runGates(phase.exitGates, adapter, runId)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Full pipeline advance with UX design enabled
// ---------------------------------------------------------------------------

describe('Full pipeline advance with UX design enabled (T10)', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let tmpDir: string

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
    tmpDir = r.tmpDir
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('advances from analysis to planning', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('planning')
  })

  it('advances from planning to ux-design (not solutioning) when UX enabled (AC1)', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Complete analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Complete planning
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('ux-design')
    expect(result.phase).not.toBe('solutioning')
  })

  it('advances from ux-design to solutioning', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Complete analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Complete planning
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)

    // Complete ux-design
    await registerArtifactForRun(adapter, runId, 'ux-design', 'ux-design')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('solutioning')
  })

  it('cannot advance from planning to ux-design without prd artifact', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Complete analysis only
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Try to advance from planning without prd
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('prd'))).toBe(true)
  })

  it('cannot advance from ux-design to solutioning without ux-design artifact', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Complete analysis and planning
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)

    // Try to advance from ux-design without ux-design artifact
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('ux-design'))).toBe(true)
  })

  it('full pipeline completes analysis -> planning -> ux-design -> solutioning with all artifacts', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Phase 1: analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const r1 = await orchestrator.advancePhase(runId)
    expect(r1.advanced).toBe(true)
    expect(r1.phase).toBe('planning')

    // Phase 2: planning -> ux-design
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const r2 = await orchestrator.advancePhase(runId)
    expect(r2.advanced).toBe(true)
    expect(r2.phase).toBe('ux-design')

    // Phase 3: ux-design -> solutioning
    await registerArtifactForRun(adapter, runId, 'ux-design', 'ux-design')
    const r3 = await orchestrator.advancePhase(runId)
    expect(r3.advanced).toBe(true)
    expect(r3.phase).toBe('solutioning')

    // Verify current phase and history
    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('solutioning')
    const completedPhases = status.completedPhases
    expect(completedPhases).toContain('analysis')
    expect(completedPhases).toContain('planning')
    expect(completedPhases).toContain('ux-design')
  })

  it('phase history includes ux-design when UX phase is traversed', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Run through analysis -> planning -> ux-design -> solutioning
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'ux-design', 'ux-design')
    await orchestrator.advancePhase(runId)

    const status = await orchestrator.getRunStatus(runId)
    const phaseNames = status.phaseHistory.map((h) => h.phase)
    expect(phaseNames).toContain('ux-design')
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
    expect(phaseNames).toContain('solutioning')
  })

  it('resumeRun resumes at ux-design when analysis and planning are complete', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Complete analysis and planning
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)

    // Resume — should be at ux-design since planning prd exists but no ux-design artifact
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('ux-design')
  })

  it('resumeRun resumes at solutioning when analysis, planning, and ux-design are complete', async () => {
    const pack = makeMockPackWithUxDesign(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a UI-rich web app')

    // Complete analysis, planning, ux-design
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'ux-design', 'ux-design')
    await orchestrator.advancePhase(runId)

    // Resume — should be at solutioning since all 3 previous phases complete
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('solutioning')
  })
})
