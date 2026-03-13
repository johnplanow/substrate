/**
 * Unit tests for readiness verdict handling in runSolutioningPhase().
 *
 * T11: Covers all three verdict paths:
 *   - READY: solutioning-readiness gate satisfied, minor findings warned, proceeds
 *   - NOT_READY: solutioning phase fails, findings stored in decision store, events emitted
 *   - NEEDS_WORK (no blockers): proceeds with warnings, no retry triggered
 *   - NEEDS_WORK (with blockers): tested in solutioning-retry.test.ts
 *
 * Relates to AC7 (NOT_READY handling) and AC8 (READY handling).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../../persistence/migrations/index.js'
import { SqliteDatabaseAdapter } from '../../../../persistence/sqlite-adapter.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'
import {
  createPipelineRun,
  createDecision,
} from '../../../../persistence/queries/decisions.js'
import { runSolutioningPhase } from '../solutioning.js'
import type {
  PhaseDeps,
  ArchitectureDecision,
  EpicDefinition,
} from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../../core/event-bus.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'solutioning-verdict-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  const adapter = new SqliteDatabaseAdapter(db)
  return { db, adapter, tmpDir }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

async function seedPlanningRequirements(adapter: DatabaseAdapter, runId: string): Promise<void> {
  const frs = [
    {
      key: 'FR-0',
      value: JSON.stringify({ description: 'User can create tasks with title and description', priority: 'must' }),
    },
    {
      key: 'FR-1',
      value: JSON.stringify({ description: 'User can assign tasks to team members', priority: 'must' }),
    },
  ]
  for (const { key, value } of frs) {
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'functional-requirements',
      key,
      value,
    })
  }
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_ARCHITECTURE_DECISIONS: ArchitectureDecision[] = [
  { category: 'language', key: 'language', value: 'TypeScript ~5.9', rationale: 'Type safety' },
  { category: 'database', key: 'database', value: 'better-sqlite3 WAL mode', rationale: 'Performance' },
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
        acceptance_criteria: ['User can create task with title', 'Task creation stores in database'],
        priority: 'must',
      },
      {
        key: '1-2',
        title: 'Assign tasks to team members',
        description: 'Users can assign tasks. Allows task assignment to members.',
        acceptance_criteria: ['User can select assignee from list', 'Assignment updates task record'],
        priority: 'must',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeArchDispatchResult(overrides: Partial<DispatchResult<unknown>> = {}): DispatchResult<unknown> {
  return {
    id: 'dispatch-arch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', architecture_decisions: SAMPLE_ARCHITECTURE_DECISIONS },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 400, output: 150 },
    ...overrides,
  }
}

function makeStoryDispatchResult(overrides: Partial<DispatchResult<unknown>> = {}): DispatchResult<unknown> {
  return {
    id: 'dispatch-story-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', epics: SAMPLE_EPICS },
    parseError: null,
    durationMs: 2000,
    tokenEstimate: { input: 600, output: 300 },
    ...overrides,
  }
}

function makeReadinessDispatchResult(
  verdict: 'READY' | 'NEEDS_WORK' | 'NOT_READY' = 'READY',
  blockerCount = 0,
  majorCount = 0,
  minorCount = 0,
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  const findings: Array<{
    category: string
    severity: string
    description: string
    affected_items: string[]
  }> = []

  for (let i = 0; i < blockerCount; i++) {
    findings.push({
      category: 'fr_coverage',
      severity: 'blocker',
      description: `FR-${i} is not covered by any story`,
      affected_items: [`FR-${i}`],
    })
  }
  for (let i = 0; i < majorCount; i++) {
    findings.push({
      category: 'story_quality',
      severity: 'major',
      description: `Story ${i + 1}-1 ACs are not in Given/When/Then format`,
      affected_items: [`${i + 1}-1`],
    })
  }
  for (let i = 0; i < minorCount; i++) {
    findings.push({
      category: 'ux_alignment',
      severity: 'minor',
      description: `Story ${i + 1}-1 does not reference UX component choice`,
      affected_items: [`${i + 1}-1`, 'ux-component-001'],
    })
  }

  const coverageScore = verdict === 'READY' ? 100 : verdict === 'NEEDS_WORK' ? 70 : 30

  return {
    id: 'dispatch-readiness-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { verdict, coverage_score: coverageScore, findings },
    parseError: null,
    durationMs: 500,
    tokenEstimate: { input: 200, output: 100 },
    ...overrides,
  }
}

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

const DEFAULT_READINESS_TEMPLATE =
  'Check readiness:\nFR: {{functional_requirements}}\nNFR: {{non_functional_requirements}}\nArch: {{architecture_decisions}}\nStories: {{stories}}\n{{ux_decisions}}'

function makePack(
  archTemplate = 'Generate architecture for:\n\n{{requirements}}\n\nOutput YAML.',
  storyTemplate = 'Generate stories for:\n\n{{requirements}}\n\n{{architecture_decisions}}\n\n{{gap_analysis}}\n\nOutput YAML.',
  readinessTemplate = DEFAULT_READINESS_TEMPLATE,
): MethodologyPack {
  const getPrompt = vi.fn().mockImplementation((name: string) => {
    if (name === 'architecture') return Promise.resolve(archTemplate)
    if (name === 'story-generation') return Promise.resolve(storyTemplate)
    if (name === 'readiness-check') return Promise.resolve(readinessTemplate)
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

function makeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
  eventBus?: TypedEventBus,
): PhaseDeps {
  return {
    db: adapter,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
    eventBus,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Verdict handling: READY path (AC8)', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns result=success and readiness_passed=true when verdict is READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
  })

  it('emits solutioning:readiness-check event with READY verdict when event bus is provided', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({ verdict: 'READY', runId }),
    )
  })

  it('emits readiness-check event with correct coverageScore (100) for READY verdict', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({ coverageScore: 100, blockerCount: 0 }),
    )
  })

  it('does NOT emit solutioning:readiness-failed event for READY verdict', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const failedEvents = emitCalls.filter((call) => call[0] === 'solutioning:readiness-failed')
    expect(failedEvents).toHaveLength(0)
  })

  it('proceeds without error when READY verdict has no findings', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY', 0, 0, 0),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
  })

  it('proceeds and returns success even when READY verdict has minor findings', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY', 0, 0, 2), // 2 minor findings
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    // Minor findings do not block the pipeline
    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
  })

  it('emits readiness-check event with correct findingCount for minor findings', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY', 0, 0, 2), // 2 minor findings
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({ verdict: 'READY', findingCount: 2, blockerCount: 0 }),
    )
  })

  it('does not emit event when eventBus is not provided', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    // No eventBus in deps
    const deps = makeDeps(adapter, dispatcher)

    // Should not throw when eventBus is undefined
    const result = await runSolutioningPhase(deps, { runId })
    expect(result.result).toBe('success')
  })

  it('returns artifact_ids with both arch and story artifacts', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.artifact_ids).toBeDefined()
    expect(result.artifact_ids!.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// NOT_READY path (AC7)
// ---------------------------------------------------------------------------

describe('Verdict handling: NOT_READY path (AC7)', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns result=failed and readiness_passed=false when verdict is NOT_READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.readiness_passed).toBe(false)
  })

  it('returns error=readiness_not_ready when verdict is NOT_READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.error).toBe('readiness_not_ready')
  })

  it('details field describes the failure with blocker count and coverage score', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2), // 2 blockers, coverage 30%
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.details).toContain('NOT_READY')
    expect(result.details).toContain('30')
  })

  it('stores NOT_READY findings in decision store with category=readiness-findings', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2), // 2 blocker findings
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const findings = db
      .prepare(
        "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'solutioning' AND category = 'readiness-findings' ORDER BY key ASC",
      )
      .all(runId) as Array<{ key: string; value: string }>

    expect(findings).toHaveLength(2)
    expect(findings[0].key).toBe('finding-1')
    expect(findings[1].key).toBe('finding-2')
  })

  it('stored NOT_READY findings are valid JSON with expected fields', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 1, 0, 0), // 1 blocker
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const finding = db
      .prepare(
        "SELECT value FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings' AND key = 'finding-1'",
      )
      .get(runId) as { value: string } | undefined

    expect(finding).toBeDefined()
    const parsed = JSON.parse(finding!.value) as {
      category: string
      severity: string
      description: string
    }
    expect(parsed.category).toBe('fr_coverage')
    expect(parsed.severity).toBe('blocker')
    expect(parsed.description).toBeTruthy()
  })

  it('emits solutioning:readiness-check event with NOT_READY verdict', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({ verdict: 'NOT_READY', runId }),
    )
  })

  it('emits solutioning:readiness-failed event with findings when NOT_READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 1),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-failed',
      expect.objectContaining({
        runId,
        verdict: 'NOT_READY',
        findings: expect.arrayContaining([
          expect.objectContaining({ severity: 'blocker' }),
        ]),
      }),
    )
  })

  it('readiness-check event has correct blockerCount for NOT_READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 3), // 3 blockers
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({ blockerCount: 3 }),
    )
  })

  it('populates gaps from fr_coverage findings in NOT_READY result', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 1), // 1 blocker with fr_coverage category
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.gaps).toBeDefined()
    expect(result.gaps!.length).toBeGreaterThan(0)
    expect(result.gaps![0]).toContain('FR-0')
  })

  it('does not proceed to implementation when NOT_READY (dispatches only 3 times: arch, story, readiness)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // Only 3 dispatches: architecture + story generation + readiness check
    // NOT_READY should not trigger any retry or implementation dispatch
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// NEEDS_WORK (no blockers) path — proceeds with warnings
// ---------------------------------------------------------------------------

describe('Verdict handling: NEEDS_WORK without blockers path', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns result=success when NEEDS_WORK has no blocker findings', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 0, 2, 0), // 2 major findings, no blockers
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
  })

  it('does not trigger retry when NEEDS_WORK has no blockers (3 dispatches total)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 0, 1, 1), // major + minor, no blockers
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // No retry: arch + story + readiness = 3 dispatches
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })

  it('emits solutioning:readiness-check event with NEEDS_WORK verdict and blockerCount=0', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 0, 1, 0), // 1 major, no blockers
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({ verdict: 'NEEDS_WORK', blockerCount: 0 }),
    )
  })

  it('does NOT emit solutioning:readiness-failed event when NEEDS_WORK without blockers', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 0, 1, 0), // 1 major, no blockers
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const failedEvents = emitCalls.filter((call) => call[0] === 'solutioning:readiness-failed')
    expect(failedEvents).toHaveLength(0)
  })

  it('does NOT store findings in decision store when NEEDS_WORK without blockers', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 0, 1, 0), // 1 major, no blockers
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const findings = db
      .prepare(
        "SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings'",
      )
      .all(runId) as Array<{ key: string }>

    expect(findings).toHaveLength(0)
  })
})
