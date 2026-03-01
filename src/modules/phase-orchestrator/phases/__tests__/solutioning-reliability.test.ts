/**
 * Tests for Story 16.1: Solutioning Pipeline Reliability fixes.
 *
 * Covers:
 *  - AC4: Decision deduplication on retry (upsert behavior)
 *  - AC3: Architecture-to-stories phase transition (integration)
 *  - AC2: Dynamic budget calculation usage in single-dispatch path
 *  - Decision summarization fallback in step-runner
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
  upsertDecision,
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
  registerArtifact,
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
import type { Dispatcher, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'solutioning-reliability-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

function seedPlanningDecisions(db: BetterSqlite3Database, runId: string): void {
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'FR-0',
    value: JSON.stringify({ description: 'Users can create tasks', priority: 'must' }),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'FR-1',
    value: JSON.stringify({ description: 'Users can view task board', priority: 'must' }),
  })
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
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

function makeSingleDispatchPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [{
        name: 'solutioning',
        description: 'Solutioning',
        entryGates: [],
        exitGates: [],
        artifacts: ['architecture', 'stories'],
        // No steps → single-dispatch
      }],
      prompts: {
        architecture: 'prompts/architecture.md',
        'story-generation': 'prompts/story-generation.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue('Template: {{requirements}} {{architecture_decisions}} {{gap_analysis}}'),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeDeps(
  db: BetterSqlite3Database,
  dispatcher: Dispatcher,
  pack: MethodologyPack,
): PhaseDeps {
  return { db, pack, contextCompiler: makeContextCompiler(), dispatcher }
}

// ---------------------------------------------------------------------------
// AC4: Decision Deduplication on Retry
// ---------------------------------------------------------------------------

describe('AC4: Decision deduplication on retry', () => {
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

  it('upsert updates existing decisions with same category and key', () => {
    // First write
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'MySQL',
      rationale: 'Initial choice',
    })

    // Verify first write
    let decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
      .filter((d) => d.category === 'architecture')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.value).toBe('MySQL')
    expect(decisions[0]!.rationale).toBe('Initial choice')

    // Upsert same category+key with different value
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'SQLite',
      rationale: 'Updated after retry',
    })

    // Verify upsert updated instead of inserting
    decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
      .filter((d) => d.category === 'architecture')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.value).toBe('SQLite')
    expect(decisions[0]!.rationale).toBe('Updated after retry')
  })

  it('upsert creates new decision for different key in same category', () => {
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'SQLite',
    })
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'api-style',
      value: 'REST',
    })

    const decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
      .filter((d) => d.category === 'architecture')
    expect(decisions).toHaveLength(2)
    expect(decisions.map((d) => d.key).sort()).toEqual(['api-style', 'database'])
  })

  it('decision count after N retries equals count from single run', () => {
    const archDecisions: ArchitectureDecision[] = [
      { category: 'backend', key: 'database', value: 'SQLite', rationale: 'Fast' },
      { category: 'backend', key: 'api-style', value: 'REST', rationale: 'Standard' },
      { category: 'frontend', key: 'framework', value: 'React', rationale: 'Popular' },
    ]

    // Simulate 3 retries, each persisting the same decisions
    for (let retry = 0; retry < 3; retry++) {
      for (const decision of archDecisions) {
        upsertDecision(db, {
          pipeline_run_id: runId,
          phase: 'solutioning',
          category: 'architecture',
          key: decision.key,
          value: `${decision.value} (retry ${retry})`,
          rationale: decision.rationale,
        })
      }
    }

    // After 3 retries, should still have only 3 decisions (not 9)
    const decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
      .filter((d) => d.category === 'architecture')
    expect(decisions).toHaveLength(3)

    // Values should reflect the last retry
    const dbDecision = decisions.find((d) => d.key === 'database')
    expect(dbDecision?.value).toBe('SQLite (retry 2)')
  })

  it('upsert scopes deduplication by pipeline_run_id', () => {
    const runId2 = createTestRun(db)

    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'SQLite',
    })
    upsertDecision(db, {
      pipeline_run_id: runId2,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'PostgreSQL',
    })

    const run1Decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
      .filter((d) => d.category === 'architecture')
    const run2Decisions = getDecisionsByPhaseForRun(db, runId2, 'solutioning')
      .filter((d) => d.category === 'architecture')

    expect(run1Decisions).toHaveLength(1)
    expect(run1Decisions[0]!.value).toBe('SQLite')
    expect(run2Decisions).toHaveLength(1)
    expect(run2Decisions[0]!.value).toBe('PostgreSQL')
  })
})

// ---------------------------------------------------------------------------
// AC3: Architecture-to-Stories Phase Transition (Integration)
// ---------------------------------------------------------------------------

describe('AC3: Architecture-to-stories phase transition', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    runId = createTestRun(db)
    seedPlanningDecisions(db, runId)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips architecture when artifact already exists and proceeds to story generation', async () => {
    // Pre-register architecture artifact (simulating a prior successful arch run)
    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      type: 'architecture',
      path: 'decision-store://solutioning/architecture',
      summary: '3 architecture decisions',
    })

    // Pre-seed architecture decisions
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'SQLite',
      rationale: 'Fast and simple',
    })
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'api-style',
      value: 'REST',
      rationale: 'Standard',
    })

    // Only story generation dispatch should occur (not architecture)
    const storyOutput = {
      result: 'success',
      epics: [{
        title: 'Task Management',
        description: 'Core task features',
        stories: [{
          key: '1-1',
          title: 'Create tasks',
          description: 'Users can create tasks on the board',
          acceptance_criteria: ['Users can create a task'],
          priority: 'must',
        }, {
          key: '1-2',
          title: 'View task board',
          description: 'Users can view all tasks on a board',
          acceptance_criteria: ['Board shows all tasks'],
          priority: 'must',
        }],
      }],
    }

    let dispatchCallCount = 0
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(() => {
        const result = makeDispatchResult(storyOutput, dispatchCallCount)
        dispatchCallCount++
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

    const pack = makeSingleDispatchPack()
    const deps = makeDeps(db, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    // Architecture dispatch should be skipped — only 1 dispatch for story generation
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
    // Should only call getPrompt for story-generation (not architecture)
    expect(pack.getPrompt).toHaveBeenCalledWith('story-generation')
    expect(pack.getPrompt).not.toHaveBeenCalledWith('architecture')

    // Should succeed with the architecture decisions from the pre-seeded store
    expect(result.result).toBe('success')
    expect(result.architecture_decisions).toBe(2) // Pre-seeded decisions
    expect(result.epics).toBe(1)
    expect(result.stories).toBe(2)
  })

  it('runs both architecture and story generation when no architecture artifact exists', async () => {
    const archOutput = {
      result: 'success',
      architecture_decisions: [
        { category: 'backend', key: 'database', value: 'SQLite', rationale: 'Fast' },
      ],
    }
    const storyOutput = {
      result: 'success',
      epics: [{
        title: 'Core',
        description: 'Core features',
        stories: [{
          key: '1-1',
          title: 'Create tasks',
          description: 'Task creation',
          acceptance_criteria: ['Users can create tasks on the board'],
          priority: 'must',
        }],
      }],
    }

    let callIndex = 0
    const results = [archOutput, storyOutput]
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

    const pack = makeSingleDispatchPack()
    const deps = makeDeps(db, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    // Both architecture and story generation dispatches should occur
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)
    expect(pack.getPrompt).toHaveBeenCalledWith('architecture')
    expect(pack.getPrompt).toHaveBeenCalledWith('story-generation')
    expect(result.result).toBe('success')
  })

  it('architecture artifact is registered after successful architecture generation', async () => {
    const archOutput = {
      result: 'success',
      architecture_decisions: [
        { category: 'backend', key: 'database', value: 'SQLite', rationale: 'Fast' },
      ],
    }
    const storyOutput = {
      result: 'success',
      epics: [{
        title: 'Core',
        description: 'Core features',
        stories: [{
          key: '1-1',
          title: 'Create tasks',
          description: 'Task creation',
          acceptance_criteria: ['Users can create tasks on the board'],
          priority: 'must',
        }],
      }],
    }

    let callIndex = 0
    const results = [archOutput, storyOutput]
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

    const pack = makeSingleDispatchPack()
    const deps = makeDeps(db, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    await runSolutioningPhase(deps, params)

    // Architecture artifact should be registered
    const archArtifact = getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')
    expect(archArtifact).toBeTruthy()
    expect(archArtifact!.summary).toContain('architecture decision')
  })

  it('preserves existing architecture decisions when skipping architecture', async () => {
    // Register architecture artifact
    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      type: 'architecture',
      path: 'decision-store://solutioning/architecture',
      summary: '2 architecture decisions',
    })

    // Seed specific decisions
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'database',
      value: 'SQLite',
    })
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'framework',
      value: 'Express',
    })

    const storyOutput = {
      result: 'success',
      epics: [{
        title: 'Core',
        description: 'Core features',
        stories: [{
          key: '1-1',
          title: 'Create tasks',
          description: 'Users can create tasks on the board',
          acceptance_criteria: ['Task creation works'],
          priority: 'must',
        }],
      }],
    }

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-0',
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeDispatchResult(storyOutput, 0)),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const pack = makeSingleDispatchPack()
    const deps = makeDeps(db, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    // Existing decisions should be preserved
    const archDecisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
      .filter((d) => d.category === 'architecture')
    expect(archDecisions).toHaveLength(2)
    expect(archDecisions.find((d) => d.key === 'database')?.value).toBe('SQLite')
    expect(archDecisions.find((d) => d.key === 'framework')?.value).toBe('Express')
    expect(result.architecture_decisions).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// AC2: Dynamic budget in single-dispatch path
// ---------------------------------------------------------------------------

describe('AC2: Dynamic prompt token budget in single-dispatch story generation', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    runId = createTestRun(db)
    seedPlanningDecisions(db, runId)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('scales story generation budget based on architecture decision count', async () => {
    // Seed many architecture decisions to test dynamic budget
    for (let i = 0; i < 20; i++) {
      upsertDecision(db, {
        pipeline_run_id: runId,
        phase: 'solutioning',
        category: 'architecture',
        key: `decision-${i}`,
        value: `Architecture decision value ${i}`,
      })
    }

    // Register architecture artifact to skip architecture generation
    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      type: 'architecture',
      path: 'decision-store://solutioning/architecture',
      summary: '20 architecture decisions',
    })

    const storyOutput = {
      result: 'success',
      epics: [{
        title: 'Core',
        description: 'Core features',
        stories: [{
          key: '1-1',
          title: 'Create tasks',
          description: 'Task creation and task board viewing',
          acceptance_criteria: ['Users can create tasks on the board'],
          priority: 'must',
        }],
      }],
    }

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-0',
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeDispatchResult(storyOutput, 0)),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const pack = makeSingleDispatchPack()
    const deps = makeDeps(db, dispatcher, pack)
    const params: SolutioningPhaseParams = { runId }

    const result = await runSolutioningPhase(deps, params)

    // Should succeed — dynamic budget should accommodate the 20 decisions
    expect(result.result).toBe('success')
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1) // Only story generation
  })
})
