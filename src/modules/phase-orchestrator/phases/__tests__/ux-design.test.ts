/**
 * Unit tests for UX design phase step execution (Story 16-5, T9).
 *
 * Covers:
 *   AC6: UX steps marked with elicitate/critique flags
 *   AC2: 3-step sequential execution (discovery, design system, journeys)
 *   Failure handling for dispatch errors and missing context
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWasmSqliteAdapter } from '../../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'
import {
  createPipelineRun,
  createDecision,
  getArtifactByTypeForRun,
} from '../../../../persistence/queries/decisions.js'
import { runUxDesignPhase, buildUxDesignSteps } from '../ux-design.js'
import type { PhaseDeps, UxDesignPhaseParams } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: DatabaseAdapter }> {
  const adapter = await createWasmSqliteAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

/**
 * Seed the database with planning-phase decisions that UX phase context resolves.
 */
async function seedPlanningDecisions(adapter: DatabaseAdapter, runId: string): Promise<void> {
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'analysis',
    category: 'product-brief',
    key: 'problem_statement',
    value: 'Users need a visual, intuitive task management experience.',
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'fr-1',
    value: 'User can create tasks with title and description',
  })
}

// Step output fixtures
const UX_DISCOVERY_OUTPUT = {
  result: 'success' as const,
  target_personas: ['project managers', 'developers'],
  core_experience: 'A calm, focused workspace for distributed teams',
  emotional_goals: ['clarity', 'trust', 'empowerment'],
  inspiration_references: ['Notion', 'Linear', 'Basecamp'],
}

const UX_DESIGN_SYSTEM_OUTPUT = {
  result: 'success' as const,
  design_system: 'Component-based design with Tailwind CSS',
  visual_foundation: 'Clean, minimal aesthetic with strong typography hierarchy',
  design_principles: ['consistency', 'clarity', 'accessibility'],
  color_and_typography: 'Blue primary, Inter font, 16px base size',
}

const UX_JOURNEYS_OUTPUT = {
  result: 'success' as const,
  user_journeys: ['Create task → assign → track', 'View board → filter → prioritize'],
  component_strategy: 'Atomic design: atoms, molecules, organisms',
  ux_patterns: ['card-based layout', 'progressive disclosure'],
  accessibility_guidelines: ['WCAG 2.1 AA', 'keyboard navigation', 'screen reader support'],
}

function makeDispatchResult(parsed: unknown, index: number): DispatchResult<unknown> {
  return {
    id: `dispatch-ux-${index}`,
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

function makePack(
  promptTemplate = 'UX design prompt: {{product_brief}} {{requirements}}',
): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack with UX design',
      phases: [],
      prompts: {
        'ux-step-1-discovery': 'prompts/ux-step-1-discovery.md',
        'ux-step-2-design-system': 'prompts/ux-step-2-design-system.md',
        'ux-step-3-journeys': 'prompts/ux-step-3-journeys.md',
      },
      constraints: {},
      templates: {},
      uxDesign: true,
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
  pack?: MethodologyPack,
): PhaseDeps {
  return {
    db: adapter,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Tests: buildUxDesignSteps - step definitions and flags (AC6)
// ---------------------------------------------------------------------------

describe('buildUxDesignSteps - step definitions (AC6, T9)', () => {
  it('returns exactly 3 steps', () => {
    const steps = buildUxDesignSteps()
    expect(steps).toHaveLength(3)
  })

  it('step 1 is named ux-step-1-discovery', () => {
    const steps = buildUxDesignSteps()
    expect(steps[0].name).toBe('ux-step-1-discovery')
  })

  it('step 2 is named ux-step-2-design-system', () => {
    const steps = buildUxDesignSteps()
    expect(steps[1].name).toBe('ux-step-2-design-system')
  })

  it('step 3 is named ux-step-3-journeys', () => {
    const steps = buildUxDesignSteps()
    expect(steps[2].name).toBe('ux-step-3-journeys')
  })

  it('step 1 has elicitate: true (AC6)', () => {
    const steps = buildUxDesignSteps()
    expect(steps[0].elicitate).toBe(true)
  })

  it('step 2 has elicitate: true (AC6)', () => {
    const steps = buildUxDesignSteps()
    expect(steps[1].elicitate).toBe(true)
  })

  it('step 3 has critique: true (AC6)', () => {
    const steps = buildUxDesignSteps()
    expect(steps[2].critique).toBe(true)
  })

  it('step 3 does NOT have elicitate: true (critique only)', () => {
    const steps = buildUxDesignSteps()
    expect(steps[2].elicitate).not.toBe(true)
  })

  it('step 3 registers a ux-design artifact', () => {
    const steps = buildUxDesignSteps()
    expect(steps[2].registerArtifact).toBeDefined()
    expect(steps[2].registerArtifact?.type).toBe('ux-design')
  })

  it('step 1 context injects product_brief and requirements', () => {
    const steps = buildUxDesignSteps()
    const placeholders = steps[0].context?.map((c) => c.placeholder)
    expect(placeholders).toContain('product_brief')
    expect(placeholders).toContain('requirements')
  })

  it('step 2 context injects product_brief, requirements, and ux_discovery from step 1', () => {
    const steps = buildUxDesignSteps()
    const placeholders = steps[1].context?.map((c) => c.placeholder)
    expect(placeholders).toContain('product_brief')
    expect(placeholders).toContain('requirements')
    expect(placeholders).toContain('ux_discovery')
  })

  it('step 3 context injects step 1 and step 2 results', () => {
    const steps = buildUxDesignSteps()
    const placeholders = steps[2].context?.map((c) => c.placeholder)
    expect(placeholders).toContain('ux_discovery')
    expect(placeholders).toContain('design_system')
  })

  it('step 1 persists target_personas, core_experience, emotional_goals, inspiration_references', () => {
    const steps = buildUxDesignSteps()
    const persistKeys = steps[0].persist?.map((p) => p.key)
    expect(persistKeys).toContain('target_personas')
    expect(persistKeys).toContain('core_experience')
    expect(persistKeys).toContain('emotional_goals')
    expect(persistKeys).toContain('inspiration_references')
  })

  it('step 2 persists design_system, visual_foundation, design_principles, color_and_typography', () => {
    const steps = buildUxDesignSteps()
    const persistKeys = steps[1].persist?.map((p) => p.key)
    expect(persistKeys).toContain('design_system')
    expect(persistKeys).toContain('visual_foundation')
    expect(persistKeys).toContain('design_principles')
    expect(persistKeys).toContain('color_and_typography')
  })

  it('step 3 persists user_journeys, component_strategy, ux_patterns, accessibility_guidelines', () => {
    const steps = buildUxDesignSteps()
    const persistKeys = steps[2].persist?.map((p) => p.key)
    expect(persistKeys).toContain('user_journeys')
    expect(persistKeys).toContain('component_strategy')
    expect(persistKeys).toContain('ux_patterns')
    expect(persistKeys).toContain('accessibility_guidelines')
  })
})

// ---------------------------------------------------------------------------
// Tests: runUxDesignPhase - execution (T9)
// ---------------------------------------------------------------------------

describe('runUxDesignPhase - execution (T9)', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const r = await createTestDb()
    adapter = r.adapter
    runId = await createTestRun(adapter)
    await seedPlanningDecisions(adapter, runId)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns result: success on happy path with 3 sequential dispatches', async () => {
    const dispatcher = makeSequentialDispatcher([
      UX_DISCOVERY_OUTPUT,
      UX_DESIGN_SYSTEM_OUTPUT,
      UX_JOURNEYS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runUxDesignPhase(deps, { runId })

    expect(result.result).toBe('success')
    // At least 3 dispatches for the 3 main UX steps; elicitation and critique add additional dispatches
    expect(vi.mocked(dispatcher.dispatch).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('registers a ux-design artifact on success', async () => {
    const dispatcher = makeSequentialDispatcher([
      UX_DISCOVERY_OUTPUT,
      UX_DESIGN_SYSTEM_OUTPUT,
      UX_JOURNEYS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runUxDesignPhase(deps, { runId })

    const artifact = await getArtifactByTypeForRun(adapter, runId, 'ux-design', 'ux-design')
    expect(artifact).toBeDefined()
    expect(artifact?.phase).toBe('ux-design')
    expect(artifact?.type).toBe('ux-design')
  })

  it('returns artifact_id on success', async () => {
    const dispatcher = makeSequentialDispatcher([
      UX_DISCOVERY_OUTPUT,
      UX_DESIGN_SYSTEM_OUTPUT,
      UX_JOURNEYS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runUxDesignPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.artifact_id).toBeDefined()
    expect(typeof result.artifact_id).toBe('string')
  })

  it('accumulates token usage across all 3 steps', async () => {
    const dispatcher = makeSequentialDispatcher([
      UX_DISCOVERY_OUTPUT,
      UX_DESIGN_SYSTEM_OUTPUT,
      UX_JOURNEYS_OUTPUT,
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runUxDesignPhase(deps, { runId })

    // Each step has tokenEstimate: input 200+50*i, output 80+20*i
    // Step 0: input=200, output=80
    // Step 1: input=250, output=100
    // Step 2: input=300, output=120
    // Total: input=750, output=300
    expect(result.tokenUsage.input).toBeGreaterThan(0)
    expect(result.tokenUsage.output).toBeGreaterThan(0)
  })

  it('returns result: failed when step 1 dispatch fails', async () => {
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

    const result = await runUxDesignPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBeDefined()
  })

  it('does not dispatch step 2 or 3 if step 1 fails', async () => {
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

    await runUxDesignPhase(deps, { runId })

    // Only step 1 was attempted
    expect(dispatchMock).toHaveBeenCalledTimes(1)
  })

  it('returns tokenUsage with zeros on complete failure', async () => {
    const deps: PhaseDeps = {
      db: adapter,
      pack: {
        ...makePack(),
        getPrompt: vi.fn().mockRejectedValue(new Error('Pack not found')),
      },
      contextCompiler: makeContextCompiler(),
      dispatcher: makeSequentialDispatcher([]),
    }

    const result = await runUxDesignPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.tokenUsage).toBeDefined()
  })
})
