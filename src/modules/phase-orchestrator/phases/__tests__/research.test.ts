/**
 * Unit tests for research phase step execution (Story 20-3).
 *
 * Covers:
 *   AC1: 2 steps named research-step-1-discovery and research-step-2-synthesis
 *   AC2: Step context sources (param:concept, step references)
 *   AC3: Step behavior flags (elicitate step 1, critique step 2)
 *   AC4: Decision store persistence under category 'research'
 *   AC5: Artifact registration for research-findings
 *   AC6: ResearchResult type shape
 *   AC7: Failure handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../../persistence/memory-adapter.js'
import { initSchema } from '../../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'
import {
  createPipelineRun,
  getArtifactByTypeForRun,
  getDecisionsByPhaseForRun,
} from '../../../../persistence/queries/decisions.js'
import { runResearchPhase, buildResearchSteps } from '../research.js'
import type { PhaseDeps, ResearchPhaseParams } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: DatabaseAdapter }> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'research' })
  return run.id
}

// Step output fixtures
const RESEARCH_DISCOVERY_OUTPUT = {
  result: 'success' as const,
  concept_classification: 'B2B SaaS productivity tool',
  market_findings: 'Large and growing market with strong demand for productivity tools',
  domain_findings: 'Well-understood domain with clear user personas and use cases',
  technical_findings: 'High feasibility — mature libraries and frameworks available',
}

const RESEARCH_SYNTHESIS_OUTPUT = {
  result: 'success' as const,
  market_context: 'TAM $5B, SAM $500M, SOM $50M by year 3',
  competitive_landscape: 'Differentiation via AI-first approach and developer-friendly API',
  technical_feasibility: 'Confirmed feasible — similar products ship in 6-12 months with team of 5',
  risk_flags: ['market saturation risk', 'regulatory compliance in EU'],
  opportunity_signals: ['underserved SMB segment', 'AI integration demand growing 40% YoY'],
}

function makeDispatchResult(parsed: unknown, index: number): DispatchResult<unknown> {
  return {
    id: `dispatch-research-${index}`,
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed,
    parseError: null,
    durationMs: 500,
    tokenEstimate: { input: 200 + index * 50, output: 80 + index * 20 },
  }
}

/**
 * Create a sequential dispatcher that returns step outputs in order.
 */
function makeSequentialDispatcher(outputs: unknown[]): Dispatcher {
  let callIndex = 0
  return {
    dispatch: vi.fn().mockImplementation(() => {
      const parsed = outputs[callIndex] ?? outputs[outputs.length - 1]
      const result = makeDispatchResult(parsed, callIndex)
      callIndex++
      return {
        id: result.id,
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(result),
      }
    }),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(promptTemplate = 'Research prompt: {{concept}}'): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack with research phase',
      phases: [],
      prompts: {
        'research-step-1-discovery': 'prompts/research-step-1-discovery.md',
        'research-step-2-synthesis': 'prompts/research-step-2-synthesis.md',
        'critique-research': 'prompts/critique-research.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(promptTemplate),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({
      prompt: 'compiled prompt',
      tokenCount: 100,
      sections: [],
      truncated: false,
    }),
  } as unknown as ContextCompiler
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack?: MethodologyPack
): PhaseDeps {
  return {
    db: adapter,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Tests: buildResearchSteps - step definitions (AC1, AC2, AC3)
// ---------------------------------------------------------------------------

describe('buildResearchSteps - step definitions (AC1, AC2, AC3)', () => {
  it('returns exactly 2 steps (AC1)', () => {
    const steps = buildResearchSteps()
    expect(steps).toHaveLength(2)
  })

  it('step 1 is named research-step-1-discovery (AC1)', () => {
    const steps = buildResearchSteps()
    expect(steps[0].name).toBe('research-step-1-discovery')
  })

  it('step 2 is named research-step-2-synthesis (AC1)', () => {
    const steps = buildResearchSteps()
    expect(steps[1].name).toBe('research-step-2-synthesis')
  })

  it('step 1 has taskType research-discovery (AC1)', () => {
    const steps = buildResearchSteps()
    expect(steps[0].taskType).toBe('research-discovery')
  })

  it('step 2 has taskType research-synthesis (AC1)', () => {
    const steps = buildResearchSteps()
    expect(steps[1].taskType).toBe('research-synthesis')
  })

  it('step 1 has elicitate: true (AC3)', () => {
    const steps = buildResearchSteps()
    expect(steps[0].elicitate).toBe(true)
  })

  it('step 2 has critique: true (AC3)', () => {
    const steps = buildResearchSteps()
    expect(steps[1].critique).toBe(true)
  })

  it('step 2 does NOT have elicitate: true (critique only) (AC3)', () => {
    const steps = buildResearchSteps()
    expect(steps[1].elicitate).not.toBe(true)
  })

  it('step 1 does NOT have critique: true (elicitate only) (AC3)', () => {
    const steps = buildResearchSteps()
    expect(steps[0].critique).not.toBe(true)
  })

  it('step 1 context has param:concept (AC2)', () => {
    const steps = buildResearchSteps()
    const conceptCtx = steps[0].context?.find((c) => c.placeholder === 'concept')
    expect(conceptCtx).toBeDefined()
    expect(conceptCtx?.source).toBe('param:concept')
  })

  it('step 2 context has param:concept (AC2)', () => {
    const steps = buildResearchSteps()
    const conceptCtx = steps[1].context?.find((c) => c.placeholder === 'concept')
    expect(conceptCtx).toBeDefined()
    expect(conceptCtx?.source).toBe('param:concept')
  })

  it('step 2 context has step:research-step-1-discovery for raw_findings (AC2)', () => {
    const steps = buildResearchSteps()
    const rawFindingsCtx = steps[1].context?.find((c) => c.placeholder === 'raw_findings')
    expect(rawFindingsCtx).toBeDefined()
    expect(rawFindingsCtx?.source).toBe('step:research-step-1-discovery')
  })

  it('step 2 registers a research-findings artifact (AC5)', () => {
    const steps = buildResearchSteps()
    expect(steps[1].registerArtifact).toBeDefined()
    expect(steps[1].registerArtifact?.type).toBe('research-findings')
    expect(steps[1].registerArtifact?.path).toBe('decision-store://research/research-findings')
  })

  it('step 1 persists concept_classification, market_findings, domain_findings, technical_findings', () => {
    const steps = buildResearchSteps()
    const persistKeys = steps[0].persist?.map((p) => p.key)
    expect(persistKeys).toContain('concept_classification')
    expect(persistKeys).toContain('market_findings')
    expect(persistKeys).toContain('domain_findings')
    expect(persistKeys).toContain('technical_findings')
  })

  it('step 2 persists market_context, competitive_landscape, technical_feasibility, risk_flags, opportunity_signals (AC4)', () => {
    const steps = buildResearchSteps()
    const persistKeys = steps[1].persist?.map((p) => p.key)
    expect(persistKeys).toContain('market_context')
    expect(persistKeys).toContain('competitive_landscape')
    expect(persistKeys).toContain('technical_feasibility')
    expect(persistKeys).toContain('risk_flags')
    expect(persistKeys).toContain('opportunity_signals')
  })

  it('step 1 persists to category research (AC4)', () => {
    const steps = buildResearchSteps()
    const categories = steps[0].persist?.map((p) => p.category)
    expect(categories?.every((c) => c === 'research')).toBe(true)
  })

  it('step 2 persists to category research (AC4)', () => {
    const steps = buildResearchSteps()
    const categories = steps[1].persist?.map((p) => p.category)
    expect(categories?.every((c) => c === 'research')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: runResearchPhase - execution (AC6, AC7)
// ---------------------------------------------------------------------------

describe('runResearchPhase - execution (AC6, AC7)', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns result: success on happy path with 2 sequential dispatches (AC6)', async () => {
    const dispatcher = makeSequentialDispatcher([
      RESEARCH_DISCOVERY_OUTPUT,
      RESEARCH_SYNTHESIS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    const result = await runResearchPhase(deps, params)

    expect(result.result).toBe('success')
    // At least 2 dispatches for the 2 main research steps; elicitation/critique add more
    expect(vi.mocked(dispatcher.dispatch).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('registers a research-findings artifact on success (AC5)', async () => {
    const dispatcher = makeSequentialDispatcher([
      RESEARCH_DISCOVERY_OUTPUT,
      RESEARCH_SYNTHESIS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    await runResearchPhase(deps, params)

    const artifact = await getArtifactByTypeForRun(adapter, runId, 'research', 'research-findings')
    expect(artifact).toBeDefined()
    expect(artifact?.phase).toBe('research')
    expect(artifact?.type).toBe('research-findings')
  })

  it('returns artifact_id on success (AC6)', async () => {
    const dispatcher = makeSequentialDispatcher([
      RESEARCH_DISCOVERY_OUTPUT,
      RESEARCH_SYNTHESIS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    const result = await runResearchPhase(deps, params)

    expect(result.result).toBe('success')
    expect(result.artifact_id).toBeDefined()
    expect(typeof result.artifact_id).toBe('string')
  })

  it('accumulates token usage across steps (AC6)', async () => {
    const dispatcher = makeSequentialDispatcher([
      RESEARCH_DISCOVERY_OUTPUT,
      RESEARCH_SYNTHESIS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    const result = await runResearchPhase(deps, params)

    expect(result.tokenUsage.input).toBeGreaterThan(0)
    expect(result.tokenUsage.output).toBeGreaterThan(0)
  })

  it('persists research decisions to decision store under category research (AC4)', async () => {
    const dispatcher = makeSequentialDispatcher([
      RESEARCH_DISCOVERY_OUTPUT,
      RESEARCH_SYNTHESIS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    await runResearchPhase(deps, params)

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'research')
    // Verify decisions are stored under the 'research' category
    const researchDecisions = decisions.filter((d) => d.category === 'research')
    expect(researchDecisions.length).toBeGreaterThan(0)
    // Step 2 synthesis fields (AC4 required keys)
    const decisionKeys = researchDecisions.map((d) => d.key)
    expect(decisionKeys).toContain('market_context')
    expect(decisionKeys).toContain('competitive_landscape')
    expect(decisionKeys).toContain('technical_feasibility')
    expect(decisionKeys).toContain('risk_flags')
    expect(decisionKeys).toContain('opportunity_signals')
  })

  it('returns result: failed when step 1 dispatch fails (AC7)', async () => {
    const failResult: DispatchResult<unknown> = {
      id: 'dispatch-fail',
      status: 'failed',
      exitCode: 1,
      output: '',
      parsed: null,
      parseError: 'dispatch failed',
      durationMs: 100,
      tokenEstimate: { input: 0, output: 0 },
    }
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-fail',
        status: 'failed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(failResult),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    const result = await runResearchPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.error).toBeDefined()
    expect(result.artifact_id).toBeUndefined()
  })

  it('does not dispatch step 2 if step 1 fails (AC7)', async () => {
    const failResult: DispatchResult<unknown> = {
      id: 'dispatch-fail',
      status: 'failed',
      exitCode: 1,
      output: '',
      parsed: null,
      parseError: 'dispatch failed',
      durationMs: 100,
      tokenEstimate: { input: 0, output: 0 },
    }
    const dispatchMock = vi.fn().mockReturnValue({
      id: 'dispatch-fail',
      status: 'failed' as const,
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(failResult),
    })
    const dispatcher: Dispatcher = {
      dispatch: dispatchMock,
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    await runResearchPhase(deps, params)

    // Only step 1 was attempted
    expect(dispatchMock).toHaveBeenCalledTimes(1)
  })

  it('returns tokenUsage with zeros on complete failure (AC7)', async () => {
    const deps: PhaseDeps = {
      db: adapter,
      pack: {
        ...makePack(),
        getPrompt: vi.fn().mockRejectedValue(new Error('Pack not found')),
      },
      contextCompiler: makeContextCompiler(),
      dispatcher: makeSequentialDispatcher([]),
    }
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    const result = await runResearchPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.tokenUsage).toBeDefined()
    expect(result.tokenUsage.input).toBe(0)
    expect(result.tokenUsage.output).toBe(0)
  })

  it('has no error on success (AC6)', async () => {
    const dispatcher = makeSequentialDispatcher([
      RESEARCH_DISCOVERY_OUTPUT,
      RESEARCH_SYNTHESIS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)
    const params: ResearchPhaseParams = {
      runId,
      concept: 'A collaborative project management tool',
    }

    const result = await runResearchPhase(deps, params)

    expect(result.result).toBe('success')
    expect(result.error).toBeUndefined()
  })
})
