/**
 * Unit tests for runSolutioningPhase().
 *
 * Covers AC1-AC9:
 *   AC1: Architecture generation sub-phase — prompt retrieval, dispatch, decision persistence
 *   AC2: Epic/story generation sub-phase — prompt retrieval, dispatch, story persistence
 *   AC3: Architecture artifact registration with correct phase/type/path
 *   AC4: Stories artifact registration with epic/story counts in summary
 *   AC5: Readiness check via QualityGate — FR-to-story coverage
 *   AC6: Retry on readiness failure — gap analysis dispatched, stories regenerated, re-checked
 *   AC7: Decision store persistence — architecture/epics/stories stored correctly
 *   AC8: Token budget compliance — both prompts within ceilings (3K arch, 4K story)
 *   AC9: Failure handling — dispatch failures, partial artifacts preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../../persistence/migrations/index.js'
import {
  createPipelineRun,
  createDecision,
  getArtifactByTypeForRun,
} from '../../../../persistence/queries/decisions.js'
import { runSolutioningPhase } from '../solutioning.js'
import type {
  PhaseDeps,
  SolutioningPhaseParams,
  ArchitectureDecision,
  EpicDefinition,
} from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'solutioning-phase-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

/**
 * Seed the database with planning-phase functional requirement decisions.
 */
function seedPlanningRequirements(db: BetterSqlite3Database, runId: string): void {
  const frs = [
    { key: 'FR-0', value: JSON.stringify({ description: 'User can create tasks with title and description', priority: 'must' }) },
    { key: 'FR-1', value: JSON.stringify({ description: 'User can assign tasks to team members', priority: 'must' }) },
    { key: 'FR-2', value: JSON.stringify({ description: 'User can set task due dates', priority: 'should' }) },
  ]
  for (const { key, value } of frs) {
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'functional-requirements',
      key,
      value,
    })
  }
}

// ---------------------------------------------------------------------------
// Sample outputs
// ---------------------------------------------------------------------------

const SAMPLE_ARCHITECTURE_DECISIONS: ArchitectureDecision[] = [
  { category: 'language', key: 'language', value: 'TypeScript ~5.9', rationale: 'Type safety' },
  { category: 'database', key: 'database', value: 'better-sqlite3 WAL mode', rationale: 'Performance' },
  { category: 'patterns', key: 'patterns', value: '["modular monolith","event bus"]' },
  { category: 'module_structure', key: 'module_structure', value: '{"modules": ["context-compiler","agent-dispatch"]}' },
]

const SAMPLE_EPICS: EpicDefinition[] = [
  {
    title: 'Task Management',
    description: 'Core task CRUD functionality',
    stories: [
      {
        key: '1-1',
        title: 'Create a task',
        description: 'Users can create tasks with title and description. Allows task creation.',
        acceptance_criteria: [
          'User can create task with title',
          'Task creation stores in database',
        ],
        priority: 'must',
      },
      {
        key: '1-2',
        title: 'Assign tasks to team members',
        description: 'Users can assign tasks to other team members. Allows task assignment.',
        acceptance_criteria: [
          'User can select assignee from list',
          'Assignment updates task record',
        ],
        priority: 'must',
      },
    ],
  },
  {
    title: 'Task Scheduling',
    description: 'Due dates and priorities',
    stories: [
      {
        key: '2-1',
        title: 'Set task due dates',
        description: 'Users can set due dates on tasks. Allows scheduling tasks.',
        acceptance_criteria: [
          'User can pick a date from calendar',
          'Due date is stored and displayed',
        ],
        priority: 'should',
      },
    ],
  },
]

function makeArchDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: 'dispatch-arch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: {
      result: 'success',
      architecture_decisions: SAMPLE_ARCHITECTURE_DECISIONS,
    },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 400, output: 150 },
    ...overrides,
  }
}

function makeStoryDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: 'dispatch-story-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: {
      result: 'success',
      epics: SAMPLE_EPICS,
    },
    parseError: null,
    durationMs: 2000,
    tokenEstimate: { input: 600, output: 300 },
    ...overrides,
  }
}

/**
 * Create a dispatcher that handles multiple sequential dispatches.
 * Results are consumed in order: first call returns results[0], etc.
 */
function makeSequentialDispatcher(results: DispatchResult<unknown>[]): Dispatcher {
  let callIndex = 0
  const dispatch = vi.fn().mockImplementation(() => {
    const result = results[callIndex] ?? results[results.length - 1]
    callIndex++
    const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
      id: result.id,
      status: 'completed',
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(result),
    }
    return handle
  })
  return {
    dispatch,
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDispatcher(result: DispatchResult<unknown>): Dispatcher {
  return makeSequentialDispatcher([result, result])
}

function makePack(
  archTemplate = 'Generate architecture for:\n\n{{requirements}}\n\nOutput YAML.',
  storyTemplate = 'Generate stories for:\n\n{{requirements}}\n\n{{architecture_decisions}}\n\n{{gap_analysis}}\n\nOutput YAML.',
): MethodologyPack {
  const getPrompt = vi.fn().mockImplementation((name: string) => {
    if (name === 'architecture') return Promise.resolve(archTemplate)
    if (name === 'story-generation') return Promise.resolve(storyTemplate)
    return Promise.resolve('')
  })
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: { architecture: 'prompts/architecture.md', 'story-generation': 'prompts/story-generation.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt,
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDeps(
  db: BetterSqlite3Database,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
): PhaseDeps {
  return {
    db,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runSolutioningPhase()', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // AC1: Architecture generation sub-phase
  // -------------------------------------------------------------------------

  describe('AC1: Architecture generation sub-phase', () => {
    it('calls pack.getPrompt("architecture") to retrieve the template', async () => {
      seedPlanningRequirements(db, runId)
      const pack = makePack()
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher, pack)

      await runSolutioningPhase(deps, { runId })

      expect(pack.getPrompt).toHaveBeenCalledWith('architecture')
    })

    it('dispatches with taskType="architecture" to claude-code agent', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'claude-code',
          taskType: 'architecture',
          outputSchema: expect.anything(),
        }),
      )
    })

    it('injects requirements into architecture prompt', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      // Architecture should be first dispatch call
      const archCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(archCall.prompt).not.toContain('{{requirements}}')
      expect(archCall.prompt).toContain('Requirements')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Epic/story generation sub-phase
  // -------------------------------------------------------------------------

  describe('AC2: Epic/story generation sub-phase', () => {
    it('calls pack.getPrompt("story-generation") to retrieve the template', async () => {
      seedPlanningRequirements(db, runId)
      const pack = makePack()
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher, pack)

      await runSolutioningPhase(deps, { runId })

      expect(pack.getPrompt).toHaveBeenCalledWith('story-generation')
    })

    it('dispatches with taskType="story-generation" to claude-code agent', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'claude-code',
          taskType: 'story-generation',
          outputSchema: expect.anything(),
        }),
      )
    })

    it('injects both requirements and architecture decisions into story prompt', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      // Story generation should be second dispatch call
      const storyCall = vi.mocked(dispatcher.dispatch).mock.calls[1][0]
      expect(storyCall.prompt).not.toContain('{{requirements}}')
      expect(storyCall.prompt).not.toContain('{{architecture_decisions}}')
      expect(storyCall.prompt).toContain('Requirements')
      expect(storyCall.prompt).toContain('Architecture Decisions')
    })

    it('returns success result with epics and stories count', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
      expect(result.epics).toBe(2)
      expect(result.stories).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Architecture artifact registration
  // -------------------------------------------------------------------------

  describe('AC3: Architecture artifact registration', () => {
    it('registers architecture artifact with correct phase, type, and path', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const artifact = db
        .prepare(
          "SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = 'solutioning' AND type = 'architecture'",
        )
        .get(runId) as { id: string; phase: string; type: string; path: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.phase).toBe('solutioning')
      expect(artifact!.type).toBe('architecture')
      expect(artifact!.path).toBe('decision-store://solutioning/architecture')
    })

    it('architecture artifact is retrievable via getArtifactByTypeForRun', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const artifact = getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')
      expect(artifact).toBeDefined()
    })

    it('artifact_ids in result includes the architecture artifact ID', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
      expect(result.artifact_ids).toBeDefined()
      expect(result.artifact_ids!.length).toBeGreaterThanOrEqual(2)

      const artifact = getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')
      expect(result.artifact_ids).toContain(artifact!.id)
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Stories artifact registration
  // -------------------------------------------------------------------------

  describe('AC4: Stories artifact registration', () => {
    it('registers stories artifact with correct phase, type, and path', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const artifact = db
        .prepare(
          "SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = 'solutioning' AND type = 'stories'",
        )
        .get(runId) as { id: string; phase: string; type: string; path: string; summary: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.phase).toBe('solutioning')
      expect(artifact!.type).toBe('stories')
      expect(artifact!.path).toBe('decision-store://solutioning/stories')
    })

    it('stories artifact summary contains epic and story counts', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const artifact = db
        .prepare("SELECT summary FROM artifacts WHERE pipeline_run_id = ? AND type = 'stories'")
        .get(runId) as { summary: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.summary).toContain('epics')
      expect(artifact!.summary).toContain('stories')
    })

    it('stories artifact is retrievable via getArtifactByTypeForRun', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const artifact = getArtifactByTypeForRun(db, runId, 'solutioning', 'stories')
      expect(artifact).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Readiness check via Quality Gates
  // -------------------------------------------------------------------------

  describe('AC5: Readiness check via QualityGate', () => {
    it('returns readiness_passed=true when all FRs are covered by stories', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
      expect(result.readiness_passed).toBe(true)
    })

    it('returns failure with gaps when FRs are not covered by stories', async () => {
      // Seed an FR that has no match in the stories
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({
          description: 'Totally unrelated requirement about quantum computing blockchain',
          priority: 'must',
        }),
      })

      // Use stories that don't mention the FR at all
      const noMatchEpics: EpicDefinition[] = [
        {
          title: 'Basic UI',
          description: 'Simple user interface',
          stories: [
            {
              key: '1-1',
              title: 'Display homepage',
              description: 'Show the homepage to visitors',
              acceptance_criteria: ['Homepage renders correctly'],
              priority: 'must',
            },
          ],
        },
      ]
      const storyResult = makeStoryDispatchResult({
        parsed: { result: 'success', epics: noMatchEpics },
      })

      // Dispatcher needs to handle: arch, story, retry-story
      // Since readiness fails once and then fails again (no new stories added), we return 'failed'
      const dispatcher = makeSequentialDispatcher([
        makeArchDispatchResult(),
        storyResult,
        // retry will get same non-matching result
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
      ])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      // The readiness check should fail due to uncovered quantum FR
      expect(result.readiness_passed).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Retry on readiness failure
  // -------------------------------------------------------------------------

  describe('AC6: Retry on readiness failure', () => {
    it('dispatches story generation a second time with gap analysis when readiness fails', async () => {
      // Seed a unique FR that won't be covered initially
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({
          description: 'Totally unrelated widget frobnicator functionality',
          priority: 'must',
        }),
      })

      const noMatchEpics: EpicDefinition[] = [
        {
          title: 'Basic',
          description: 'Basic',
          stories: [
            {
              key: '1-1',
              title: 'Some story',
              description: 'Some story description',
              acceptance_criteria: ['AC1'],
              priority: 'must',
            },
          ],
        },
      ]

      // First story dispatch returns no-match, second also no-match but we verify 3 total dispatches
      const dispatcher = makeSequentialDispatcher([
        makeArchDispatchResult(),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
      ])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      // dispatcher.dispatch should have been called 3 times:
      // 1. architecture, 2. story-generation, 3. story-generation (retry)
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
    })

    it('gap analysis prompt includes uncovered requirements', async () => {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({
          description: 'Unique xyzzy requirement that is uncovered',
          priority: 'must',
        }),
      })

      const noMatchEpics: EpicDefinition[] = [
        {
          title: 'Basic',
          description: 'Basic',
          stories: [
            {
              key: '1-1',
              title: 'Something else',
              description: 'Something else entirely',
              acceptance_criteria: ['AC1'],
              priority: 'must',
            },
          ],
        },
      ]

      const dispatcher = makeSequentialDispatcher([
        makeArchDispatchResult(),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
      ])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      // Third dispatch (retry story generation) should contain gap analysis in prompt
      const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
      expect(retryCall.prompt).toContain('Gap Analysis')
    })

    it('returns failure with readiness_passed=false when retry also fails', async () => {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({
          description: 'Perpetually uncovered quantum blockchain requirement',
          priority: 'must',
        }),
      })

      const noMatchEpics: EpicDefinition[] = [
        {
          title: 'Basic',
          description: 'Basic',
          stories: [
            {
              key: '1-1',
              title: 'Unrelated story',
              description: 'Unrelated description',
              acceptance_criteria: ['AC1'],
              priority: 'must',
            },
          ],
        },
      ]

      const dispatcher = makeSequentialDispatcher([
        makeArchDispatchResult(),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
      ])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.readiness_passed).toBe(false)
    })

    it('returns success with readiness_passed=true when retry covers all FRs', async () => {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: 'FR-0',
        value: JSON.stringify({
          description: 'User can create tasks with title and description',
          priority: 'must',
        }),
      })

      // First story dispatch does NOT cover the FR
      const noMatchEpics: EpicDefinition[] = [
        {
          title: 'Basic',
          description: 'Basic',
          stories: [
            {
              key: '1-1',
              title: 'Unrelated story',
              description: 'Completely unrelated stuff',
              acceptance_criteria: ['AC1'],
              priority: 'must',
            },
          ],
        },
      ]

      // Retry story dispatch DOES cover the FR
      const matchingEpics: EpicDefinition[] = [
        {
          title: 'Task Management',
          description: 'Task creation and management',
          stories: [
            {
              key: '1-1',
              title: 'Create tasks',
              description: 'User can create tasks with title and description',
              acceptance_criteria: ['Task creation works with title'],
              priority: 'must',
            },
          ],
        },
      ]

      const dispatcher = makeSequentialDispatcher([
        makeArchDispatchResult(),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: noMatchEpics } }),
        makeStoryDispatchResult({ parsed: { result: 'success', epics: matchingEpics } }),
      ])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
      expect(result.readiness_passed).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Decision store persistence
  // -------------------------------------------------------------------------

  describe('AC7: Decision store persistence', () => {
    it('stores architecture decisions with phase=solutioning, category=architecture', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'solutioning' AND category = 'architecture' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string; rationale: string | null }>

      expect(decisions).toHaveLength(SAMPLE_ARCHITECTURE_DECISIONS.length)
      expect(decisions[0].key).toBe('database')
      expect(decisions[0].value).toBe('better-sqlite3 WAL mode')
    })

    it('stores epic decisions with phase=solutioning, category=epics', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'solutioning' AND category = 'epics' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions).toHaveLength(2) // 2 epics in SAMPLE_EPICS
      expect(decisions[0].key).toBe('epic-1')
      const epic1 = JSON.parse(decisions[0].value) as { title: string }
      expect(epic1.title).toBe('Task Management')
    })

    it('stores story decisions with phase=solutioning, category=stories, using story_key as key', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'solutioning' AND category = 'stories' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions).toHaveLength(3) // 3 total stories in SAMPLE_EPICS
      expect(decisions[0].key).toBe('1-1')
      expect(decisions[1].key).toBe('1-2')
      expect(decisions[2].key).toBe('2-1')

      const story11 = JSON.parse(decisions[0].value) as { key: string; title: string }
      expect(story11.key).toBe('1-1')
      expect(story11.title).toBe('Create a task')
    })

    it('creates Requirement records for each story with type=functional', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const requirements = db
        .prepare(
          "SELECT * FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase' AND type = 'functional' ORDER BY created_at ASC",
        )
        .all(runId) as Array<{ description: string; priority: string; type: string }>

      expect(requirements).toHaveLength(3) // 3 total stories
      expect(requirements[0].type).toBe('functional')
    })

    it('returns architecture_decisions count matching stored decisions', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
      expect(result.architecture_decisions).toBe(SAMPLE_ARCHITECTURE_DECISIONS.length)
    })
  })

  // -------------------------------------------------------------------------
  // AC8: Token budget compliance
  // -------------------------------------------------------------------------

  describe('AC8: Token budget compliance', () => {
    it('architecture prompt succeeds within 3,000 token budget with typical requirements', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      // Should succeed (not fail with budget error)
      expect(result.result).toBe('success')
    })

    it('returns failure when architecture prompt exceeds 3,000 token budget', async () => {
      seedPlanningRequirements(db, runId)
      // Template that's way over budget
      const hugeTemplate = 'A'.repeat(12_001 * 4) + ' {{requirements}}'
      const pack = makePack(hugeTemplate)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher, pack)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('architecture_generation_failed')
      expect(result.details).toContain('token budget')
    })

    it('story generation prompt succeeds within 4,000 token budget with typical context', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
    })

    it('returns failure when story prompt exceeds 4,000 token budget', async () => {
      seedPlanningRequirements(db, runId)
      // Story template that's over budget
      const hugeStoryTemplate = 'B'.repeat(16_001 * 4) + ' {{requirements}} {{architecture_decisions}}'
      const pack = makePack(undefined, hugeStoryTemplate)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher, pack)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('story_generation_failed')
      expect(result.details).toContain('token budget')
    })

    it('passes ArchitectureOutputSchema to architecture dispatch', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const archCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(archCall.outputSchema).toBeDefined()
    })

    it('passes StoryGenerationOutputSchema to story dispatch', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const storyCall = vi.mocked(dispatcher.dispatch).mock.calls[1][0]
      expect(storyCall.outputSchema).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC9: Failure handling
  // -------------------------------------------------------------------------

  describe('AC9: Failure handling', () => {
    it('returns failure when architecture dispatch fails', async () => {
      seedPlanningRequirements(db, runId)
      const archFail = makeArchDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'architecture agent error',
      })
      const dispatcher = makeSequentialDispatcher([archFail])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('architecture_generation_failed')
    })

    it('does NOT attempt story generation when architecture fails', async () => {
      seedPlanningRequirements(db, runId)
      const archFail = makeArchDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'arch error',
      })
      const dispatcher = makeSequentialDispatcher([archFail, makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      // Should only have been called once (architecture), not for story generation
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
    })

    it('returns partial failure when story generation fails but architecture succeeds', async () => {
      seedPlanningRequirements(db, runId)
      const storyFail = makeStoryDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'story agent error',
      })
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), storyFail])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('story_generation_failed')
      // Architecture artifact should be preserved in artifact_ids
      expect(result.artifact_ids).toBeDefined()
      expect(result.artifact_ids!.length).toBeGreaterThanOrEqual(1)
    })

    it('preserves architecture artifact when only story generation fails', async () => {
      seedPlanningRequirements(db, runId)
      const storyFail = makeStoryDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'story fail',
      })
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), storyFail])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      // Architecture artifact should exist in DB even though story generation failed
      const archArtifact = getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')
      expect(archArtifact).toBeDefined()
    })

    it('returns failure when architecture dispatch times out', async () => {
      seedPlanningRequirements(db, runId)
      const archTimeout = makeArchDispatchResult({
        status: 'timeout',
        exitCode: -1,
        parsed: null,
        parseError: null,
        durationMs: 300_001,
      })
      const dispatcher = makeSequentialDispatcher([archTimeout])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('architecture_generation_failed')
      expect(result.details).toContain('timed out')
    })

    it('returns failure when story dispatch times out', async () => {
      seedPlanningRequirements(db, runId)
      const storyTimeout = makeStoryDispatchResult({
        status: 'timeout',
        exitCode: -1,
        parsed: null,
        parseError: null,
        durationMs: 300_001,
      })
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), storyTimeout])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('story_generation_failed')
      expect(result.details).toContain('timed out')
    })

    it('handles pack.getPrompt throwing an error gracefully', async () => {
      seedPlanningRequirements(db, runId)
      const pack = makePack()
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Prompt file not found'))
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher, pack)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toContain('Prompt file not found')
    })

    it('returns tokenUsage from dispatch results', async () => {
      seedPlanningRequirements(db, runId)
      const archResult = makeArchDispatchResult({
        tokenEstimate: { input: 400, output: 150 },
      })
      const storyResult = makeStoryDispatchResult({
        tokenEstimate: { input: 600, output: 300 },
      })
      const dispatcher = makeSequentialDispatcher([archResult, storyResult])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      // Total should be sum of both dispatches
      expect(result.tokenUsage.input).toBe(1000) // 400 + 600
      expect(result.tokenUsage.output).toBe(450) // 150 + 300
    })

    it('returns tokenUsage { input: 0, output: 0 } when pack.getPrompt throws', async () => {
      seedPlanningRequirements(db, runId)
      const pack = makePack()
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('file missing'))
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher, pack)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.tokenUsage.input).toBe(0)
      expect(result.tokenUsage.output).toBe(0)
    })

    it('returns failure with schema_validation_failed when architecture parsed is null', async () => {
      seedPlanningRequirements(db, runId)
      const archNullParse = makeArchDispatchResult({
        status: 'completed',
        parsed: null,
        parseError: 'YAML parse error',
      })
      const dispatcher = makeSequentialDispatcher([archNullParse])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('failed')
      expect(result.error).toBe('architecture_generation_failed')
      expect(result.details).toContain('schema validation failed')
    })
  })

  // -------------------------------------------------------------------------
  // Additional integration tests
  // -------------------------------------------------------------------------

  describe('Integration: full successful flow', () => {
    it('runs complete flow and returns all expected fields', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      const result = await runSolutioningPhase(deps, { runId })

      expect(result.result).toBe('success')
      expect(result.architecture_decisions).toBeDefined()
      expect(result.epics).toBeDefined()
      expect(result.stories).toBeDefined()
      expect(result.readiness_passed).toBe(true)
      expect(result.artifact_ids).toBeDefined()
      expect(result.artifact_ids!).toHaveLength(2) // architecture + stories
      expect(result.tokenUsage).toBeDefined()
      expect(result.tokenUsage.input).toBeGreaterThan(0)
      expect(result.tokenUsage.output).toBeGreaterThan(0)
    })

    it('dispatches exactly twice (architecture then story generation) in happy path', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)
    })

    it('architecture dispatch happens before story generation dispatch', async () => {
      seedPlanningRequirements(db, runId)
      const dispatcher = makeSequentialDispatcher([makeArchDispatchResult(), makeStoryDispatchResult()])
      const deps = makeDeps(db, dispatcher)

      await runSolutioningPhase(deps, { runId })

      const calls = vi.mocked(dispatcher.dispatch).mock.calls
      expect(calls[0][0].taskType).toBe('architecture')
      expect(calls[1][0].taskType).toBe('story-generation')
    })
  })
})
