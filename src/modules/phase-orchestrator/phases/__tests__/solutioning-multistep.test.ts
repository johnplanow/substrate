/**
 * Integration tests for multi-step solutioning phase decomposition.
 *
 * Verifies that when the manifest defines steps for the solutioning phase:
 *  - 3-step architecture generation works (context → decisions → patterns)
 *  - 2-step story generation works (epics → stories)
 *  - Readiness check still runs after multi-step story generation
 *  - Fallback to single-dispatch when no steps defined
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../../persistence/memory-adapter.js'
import { initSchema } from '../../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'
import {
  createPipelineRun,
  createDecision,
  getDecisionsByPhaseForRun,
} from '../../../../persistence/queries/decisions.js'
import { runSolutioningPhase } from '../solutioning.js'
import type { PhaseDeps, SolutioningPhaseParams } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: DatabaseAdapter }> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

async function seedPlanningDecisions(adapter: DatabaseAdapter, runId: string): Promise<void> {
  // Seed functional requirements
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'FR-0',
    value: JSON.stringify({ description: 'Users can create tasks', priority: 'must' }),
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'FR-1',
    value: JSON.stringify({ description: 'Users can view task board', priority: 'must' }),
  })
  // Seed non-functional requirements
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'non-functional-requirements',
    key: 'NFR-0',
    value: JSON.stringify({ description: 'Responses under 200ms', category: 'performance' }),
  })
}

// Architecture step outputs
const ARCH_CONTEXT_OUTPUT = {
  result: 'success' as const,
  architecture_decisions: [
    { category: 'backend', key: 'database', value: 'SQLite', rationale: 'Simple and fast' },
    { category: 'backend', key: 'api-style', value: 'REST', rationale: 'Standard' },
  ],
}

const ARCH_DECISIONS_OUTPUT = {
  result: 'success' as const,
  architecture_decisions: [
    { category: 'crosscutting', key: 'testing', value: 'Vitest', rationale: 'Fast tests' },
  ],
}

const ARCH_PATTERNS_OUTPUT = {
  result: 'success' as const,
  architecture_decisions: [
    { category: 'patterns', key: 'di', value: 'Constructor injection', rationale: 'Testable' },
  ],
}

// Story step outputs
const EPIC_DESIGN_OUTPUT = {
  result: 'success' as const,
  epics: [
    { title: 'Task Management', description: 'Core task features', fr_coverage: ['FR-0', 'FR-1'] },
  ],
}

const STORY_GEN_OUTPUT = {
  result: 'success' as const,
  epics: [
    {
      title: 'Task Management',
      description: 'Core task features',
      stories: [
        {
          key: '1-1',
          title: 'Create tasks',
          description: 'Users can create new tasks in the board',
          acceptance_criteria: [
            'User can create a task with title',
            'Task appears on the board view',
          ],
          priority: 'must' as const,
        },
        {
          key: '1-2',
          title: 'View task board',
          description: 'Users can view all tasks on a board',
          acceptance_criteria: ['Board shows all tasks grouped by status'],
          priority: 'must' as const,
        },
      ],
    },
  ],
}

function makeDispatchResult(parsed: unknown, index: number): DispatchResult<unknown> {
  return {
    id: `dispatch-${index}`,
    status: 'completed',
    exitCode: 0,
    output: 'yaml',
    parsed,
    parseError: null,
    durationMs: 500,
    tokenEstimate: { input: 100, output: 50 },
  }
}

const READINESS_OUTPUT = {
  verdict: 'READY' as const,
  coverage_score: 100,
  findings: [],
}

function makeMultiStepDispatcher(): Dispatcher {
  let callIndex = 0
  // 6 dispatches: 3 arch steps + 2 story steps + 1 readiness check
  const results = [
    ARCH_CONTEXT_OUTPUT,
    ARCH_DECISIONS_OUTPUT,
    ARCH_PATTERNS_OUTPUT,
    EPIC_DESIGN_OUTPUT,
    STORY_GEN_OUTPUT,
    READINESS_OUTPUT,
  ]

  return {
    dispatch: vi.fn().mockImplementation(() => {
      const parsed = results[callIndex] ?? results[results.length - 1]
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

function makeMultiStepPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [
        {
          name: 'solutioning',
          description: 'Architecture and stories',
          entryGates: ['prd-complete'],
          exitGates: ['architecture-complete', 'stories-complete'],
          artifacts: ['architecture', 'stories'],
          steps: [
            {
              name: 'architecture-step-1-context',
              template: 'architecture-step-1-context',
              context: [
                {
                  placeholder: 'requirements',
                  source: 'decision:planning.functional-requirements',
                },
              ],
              outputCategory: 'architecture',
            },
            {
              name: 'architecture-step-2-decisions',
              template: 'architecture-step-2-decisions',
              context: [
                {
                  placeholder: 'requirements',
                  source: 'decision:planning.functional-requirements',
                },
              ],
              outputCategory: 'architecture',
            },
            {
              name: 'architecture-step-3-patterns',
              template: 'architecture-step-3-patterns',
              context: [
                {
                  placeholder: 'architecture_decisions',
                  source: 'decision:solutioning.architecture',
                },
              ],
              outputCategory: 'architecture',
            },
            {
              name: 'stories-step-1-epics',
              template: 'stories-step-1-epics',
              context: [
                {
                  placeholder: 'requirements',
                  source: 'decision:planning.functional-requirements',
                },
              ],
              outputCategory: 'epic-design',
            },
            {
              name: 'stories-step-2-stories',
              template: 'stories-step-2-stories',
              context: [
                {
                  placeholder: 'requirements',
                  source: 'decision:planning.functional-requirements',
                },
              ],
              outputCategory: 'stories',
            },
          ],
        },
      ],
      prompts: {
        'architecture-step-1-context': 'prompts/architecture-step-1-context.md',
        'architecture-step-2-decisions': 'prompts/architecture-step-2-decisions.md',
        'architecture-step-3-patterns': 'prompts/architecture-step-3-patterns.md',
        'stories-step-1-epics': 'prompts/stories-step-1-epics.md',
        'stories-step-2-stories': 'prompts/stories-step-2-stories.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockImplementation((key: string) => {
      if (key === 'readiness-check') {
        return Promise.resolve(
          'Readiness: {{functional_requirements}} {{non_functional_requirements}} {{architecture_decisions}} {{stories}} {{ux_decisions}}'
        )
      }
      return Promise.resolve(`Template: {{requirements}} {{architecture_decisions}}`)
    }),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi
      .fn()
      .mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack: MethodologyPack
): PhaseDeps {
  return { db: adapter, pack, contextCompiler: makeContextCompiler(), dispatcher }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSolutioningPhase() multi-step path', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
    await seedPlanningDecisions(adapter, runId)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('uses multi-step path for both architecture and story generation', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    expect(result.result).toBe('success')
    // 3 arch steps + 2 story steps + 1 readiness check = 6 dispatches
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(6)
  })

  it('persists architecture decisions from all 3 arch steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    await runSolutioningPhase(deps, params)

    const allDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const archDecisions = allDecisions.filter((d) => d.category === 'architecture')
    // Step runner uses step-name-prefixed keys, so no collisions across steps:
    // Step 1 produces 2 decisions (architecture-step-1-context-0, architecture-step-1-context-1)
    // Step 2 produces 1 decision (architecture-step-2-decisions-0)
    // Step 3 produces 1 decision (architecture-step-3-patterns-0)
    // Total: 4 unique decisions
    expect(archDecisions.length).toBe(4)
  })

  it('persists epics and stories from multi-step story generation', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    await runSolutioningPhase(deps, params)

    const allSolutioningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const epicDecisions = allSolutioningDecisions.filter((d) => d.category === 'epics')
    const storyDecisions = allSolutioningDecisions.filter((d) => d.category === 'stories')

    expect(epicDecisions.length).toBeGreaterThanOrEqual(1)
    expect(storyDecisions.length).toBeGreaterThanOrEqual(2)
  })

  it('runs readiness check after multi-step story generation', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    // Readiness should have run (our stories cover the FRs via keyword match)
    expect(result.readiness_passed).toBeDefined()
  })

  it('returns story and epic counts on success', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    expect(result.result).toBe('success')
    // All 4 architecture decisions preserved (2 from step 1 + 1 from step 2 + 1 from step 3)
    expect(result.architecture_decisions).toBe(4)
    expect(result.epics).toBe(1)
    expect(result.stories).toBe(2)
  })

  it('accumulates token usage from all steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    // 6 dispatches × (100 input + 50 output) each (3 arch + 2 story + 1 readiness)
    expect(result.tokenUsage.input).toBe(600)
    expect(result.tokenUsage.output).toBe(300)
  })

  it('falls back to single-dispatch when no steps defined', async () => {
    const noStepsPack: MethodologyPack = {
      manifest: {
        name: 'test-pack',
        version: '1.0.0',
        description: 'Test',
        phases: [
          {
            name: 'solutioning',
            description: 'Solutioning',
            entryGates: ['prd-complete'],
            exitGates: ['architecture-complete'],
            artifacts: ['architecture', 'stories'],
            // No steps → single-dispatch
          },
        ],
        prompts: {
          architecture: 'prompts/architecture.md',
          'story-generation': 'prompts/story-generation.md',
        },
        constraints: {},
        templates: {},
      },
      getPhases: vi.fn().mockReturnValue([]),
      getPrompt: vi
        .fn()
        .mockResolvedValue(
          'Template: {{requirements}} {{architecture_decisions}} {{gap_analysis}}'
        ),
      getConstraints: vi.fn().mockResolvedValue([]),
      getTemplate: vi.fn().mockResolvedValue(''),
    }

    let callIndex = 0
    const singleArchOutput = {
      result: 'success',
      architecture_decisions: [
        { category: 'backend', key: 'db', value: 'SQLite', rationale: 'fast' },
      ],
    }
    const singleStoryOutput = {
      result: 'success',
      epics: [
        {
          title: 'Core',
          description: 'Core features',
          stories: [
            {
              key: '1-1',
              title: 'Create tasks',
              description: 'Task creation feature',
              acceptance_criteria: ['Users can create tasks on the board'],
              priority: 'must',
            },
          ],
        },
      ],
    }
    const results = [singleArchOutput, singleStoryOutput, READINESS_OUTPUT]

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(() => {
        const parsed = results[callIndex] ?? results[results.length - 1]
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

    // noStepsPack needs to handle the readiness-check prompt
    vi.mocked(noStepsPack.getPrompt).mockImplementation((key: string) => {
      if (key === 'readiness-check') {
        return Promise.resolve(
          'Readiness: {{functional_requirements}} {{non_functional_requirements}} {{architecture_decisions}} {{stories}} {{ux_decisions}}'
        )
      }
      return Promise.resolve(
        'Template: {{requirements}} {{architecture_decisions}} {{gap_analysis}}'
      )
    })

    const deps = makeDeps(adapter, dispatcher, noStepsPack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    expect(result.result).toBe('success')
    // Single-dispatch: 1 arch + 1 story + 1 readiness = 3 dispatches
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
    expect(noStepsPack.getPrompt).toHaveBeenCalledWith('architecture')
    expect(noStepsPack.getPrompt).toHaveBeenCalledWith('story-generation')
  })

  it('returns failure when architecture step fails', async () => {
    const pack = makeMultiStepPack()
    // Make first dispatch fail
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-0',
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeDispatchResult({ result: 'failed' }, 0)),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.error).toBe('architecture_generation_failed')
  })

  it('does not double architecture decisions when architecture generation is run twice (upsert deduplication)', async () => {
    // Run the full multi-step solutioning phase once to completion
    const pack = makeMultiStepPack()
    const dispatcher1 = makeMultiStepDispatcher()
    const deps1 = makeDeps(adapter, dispatcher1, pack)
    const params: SolutioningPhaseParams = { runId }

    await runSolutioningPhase(deps1, params)

    const allAfterFirst = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const archDecisionsAfterFirstRun = allAfterFirst.filter((d) => d.category === 'architecture')
    const countAfterFirst = archDecisionsAfterFirstRun.length

    // Simulate running architecture generation again by calling runSolutioningPhase a second
    // time on the same runId. The existing architecture artifact causes the arch sub-phase
    // to be skipped entirely (skip-on-retry guard), so decision count must stay the same.
    const dispatcher2 = makeMultiStepDispatcher()
    const deps2 = makeDeps(adapter, dispatcher2, pack)

    await runSolutioningPhase(deps2, params)

    const allAfterSecond = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const archDecisionsAfterSecondRun = allAfterSecond.filter((d) => d.category === 'architecture')
    const countAfterSecond = archDecisionsAfterSecondRun.length

    // Decision count must not increase — upsert/skip-on-retry guarantees no doubling
    expect(countAfterSecond).toBe(countAfterFirst)
    expect(countAfterSecond).toBeGreaterThan(0)
  })
})
