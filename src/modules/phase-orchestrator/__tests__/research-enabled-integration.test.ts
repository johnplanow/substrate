/**
 * Integration tests for pipeline with research phase enabled (Story 20.1).
 *
 * Verifies that the pipeline operates correctly when research is enabled
 * via `research: true` in the pack manifest:
 *
 *   AC1: research phase is registered as the first phase (before analysis)
 *   AC2: When research is true, phase runs and its findings are available to analysis
 *   AC3: Analysis entry gate is conditionally applied (research-findings gate applied when enabled)
 *
 * These tests confirm the "enabled" path:
 *   research -> analysis -> planning -> solutioning -> implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun, registerArtifact } from '../../../persistence/queries/decisions.js'
import { createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import {
  createBuiltInPhases,
  createResearchPhaseDefinition,
  createAnalysisPhaseDefinition,
} from '../built-in-phases.js'
import { runGates } from '../phase-orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: InMemoryDatabaseAdapter }> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function registerArtifactForRun(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
  type: string
): Promise<void> {
  await registerArtifact(adapter, {
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
      description: 'Test pack with research',
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

describe('createBuiltInPhases - research enabled (Story 20.1)', () => {
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

  it('research is at index 0 (first phase) when enabled (AC1)', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    expect(phases[0].name).toBe('research')
  })

  it('research is immediately followed by analysis (AC1)', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const names = phases.map((p) => p.name)
    const researchIdx = names.indexOf('research')
    expect(names[researchIdx + 1]).toBe('analysis')
  })

  it('analysis entry gate requires research-findings when research enabled (AC3)', () => {
    const phases = createBuiltInPhases({ researchEnabled: true })
    const analysis = phases.find((p) => p.name === 'analysis')
    expect(analysis?.entryGates).toHaveLength(1)
    expect(analysis?.entryGates[0].name).toContain('research-findings')
  })
})

// ---------------------------------------------------------------------------
// Tests: PhaseOrchestrator with research enabled
// ---------------------------------------------------------------------------

describe('PhaseOrchestrator - research enabled (Story 20.1)', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('registers 5 phases when pack has research: true', () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    expect(orchestrator.getPhases()).toHaveLength(5)
  })

  it('phase list includes research when research: true', () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toContain('research')
  })

  it('phase list is [research, analysis, planning, solutioning, implementation]', () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const names = orchestrator.getPhases().map((p) => p.name)
    expect(names).toEqual(['research', 'analysis', 'planning', 'solutioning', 'implementation'])
  })
})

// ---------------------------------------------------------------------------
// Tests: Research gate enforcement
// ---------------------------------------------------------------------------

describe('Research gate enforcement (Story 20.1)', () => {
  let adapter: InMemoryDatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
    const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'research' })
    runId = run.id
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('research has no entry gates (AC1: it is always the entrypoint)', () => {
    const phase = createResearchPhaseDefinition()
    expect(phase.entryGates).toHaveLength(0)
  })

  it('research exit gate requires research-findings artifact', async () => {
    const phase = createResearchPhaseDefinition()
    const result = await runGates(phase.exitGates, adapter, runId)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.gate.includes('research-findings'))).toBe(true)
  })

  it('research exit gate passes with research-findings artifact', async () => {
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    const phase = createResearchPhaseDefinition()
    const result = await runGates(phase.exitGates, adapter, runId)
    expect(result.passed).toBe(true)
  })

  it('analysis entry gate requires research-findings when research enabled (AC3)', async () => {
    const phase = createAnalysisPhaseDefinition({ requiresResearch: true })
    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.gate.includes('research-findings'))).toBe(true)
  })

  it('analysis entry gate passes with research-findings artifact when research enabled', async () => {
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    const phase = createAnalysisPhaseDefinition({ requiresResearch: true })
    const result = await runGates(phase.entryGates, adapter, runId)
    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: Full pipeline advance with research enabled
// ---------------------------------------------------------------------------

describe('Full pipeline advance with research enabled (Story 20.1)', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('advances from research to analysis when research-findings artifact registered', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('analysis')
  })

  it('cannot advance from research to analysis without research-findings artifact', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Do NOT register research-findings — try to advance
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('research-findings'))).toBe(true)
  })

  it('advances from analysis to planning (requires research-findings for analysis entry)', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Complete research
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    // Complete analysis
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(true)
    expect(result.phase).toBe('planning')
  })

  it('cannot advance from analysis without product-brief when research enabled', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Complete research
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    // Try to advance from analysis without product-brief
    const result = await orchestrator.advancePhase(runId)

    expect(result.advanced).toBe(false)
    expect(result.gateFailures?.some((f) => f.gate.includes('product-brief'))).toBe(true)
  })

  it('full pipeline completes research -> analysis -> planning with all artifacts', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Phase 0: research -> analysis
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    const r1 = await orchestrator.advancePhase(runId)
    expect(r1.advanced).toBe(true)
    expect(r1.phase).toBe('analysis')

    // Phase 1: analysis -> planning
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    const r2 = await orchestrator.advancePhase(runId)
    expect(r2.advanced).toBe(true)
    expect(r2.phase).toBe('planning')

    // Phase 2: planning -> solutioning
    await registerArtifactForRun(adapter, runId, 'planning', 'prd')
    const r3 = await orchestrator.advancePhase(runId)
    expect(r3.advanced).toBe(true)
    expect(r3.phase).toBe('solutioning')

    // Verify current phase and history
    const status = await orchestrator.getRunStatus(runId)
    expect(status.currentPhase).toBe('solutioning')
    const completedPhases = status.completedPhases
    expect(completedPhases).toContain('research')
    expect(completedPhases).toContain('analysis')
    expect(completedPhases).toContain('planning')
  })

  it('phase history includes research when research phase is traversed', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Run through research -> analysis -> planning
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    const status = await orchestrator.getRunStatus(runId)
    const phaseNames = status.phaseHistory.map((h) => h.phase)
    expect(phaseNames).toContain('research')
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
  })

  it('resumeRun resumes at analysis when research is complete but analysis is not', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Complete research only
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)

    // Resume — should be at analysis since research-findings exists but no product-brief
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('analysis')
  })

  it('resumeRun resumes at planning when research and analysis are both complete', async () => {
    const pack = makeMockPackWithResearch(true)
    const orchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runId = await orchestrator.startRun('Build a product with pre-research')

    // Complete research and analysis
    await registerArtifactForRun(adapter, runId, 'research', 'research-findings')
    await orchestrator.advancePhase(runId)
    await registerArtifactForRun(adapter, runId, 'analysis', 'product-brief')
    await orchestrator.advancePhase(runId)

    // Resume — should be at planning
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('planning')
  })
})
