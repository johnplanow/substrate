/**
 * Unit tests for Story 24-1: Zero-Diff Detection Gate.
 *
 * Covers:
 *   AC1: git diff --name-only HEAD run after dev-story COMPLETE
 *   AC2: Zero diff → story escalated with reason 'zero-diff-on-complete'
 *   AC3: Non-zero diff → proceed to code-review normally
 *   AC4: Staged files (git diff --cached) also count as non-zero diff
 *   AC5: Non-COMPLETE results bypass the check
 *   AC6: story:zero-diff-escalation event emitted on zero-diff escalation
 *
 * Direct unit tests for checkGitDiffFiles() helper + orchestrator integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import { checkGitDiffFiles } from '../../agent-dispatch/dispatcher-impl.js'

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))
vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn(),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
}))
vi.mock('../../../persistence/queries/metrics.js', () => ({
  writeRunMetrics: vi.fn(),
  writeStoryMetrics: vi.fn(),
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
  aggregateTokenUsageForStory: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
}))
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('mock readFile: file not found')),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  }
})
// Controlled per-test via mockReturnValue / mockReturnValueOnce
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { execSync } from 'node:child_process'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockExecSync = vi.mocked(execSync)

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
}

function createMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
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

function createMockContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  } as unknown as ContextCompiler
}

function createMockDispatcher(): Dispatcher {
  const mockResult: DispatchResult<unknown> = {
    id: 'test-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const mockHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'test-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(mockResult),
  }
  return {
    dispatch: vi.fn().mockReturnValue(mockHandle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-zero-diff',
    gcPauseMs: 0,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = '24-1') {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Zero-Diff Test Story',
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeDevStorySuccess() {
  return {
    result: 'success' as const,
    ac_met: ['AC1'],
    ac_failures: [],
    files_modified: ['src/foo.ts'],
    tests: 'pass' as const,
    tokenUsage: { input: 200, output: 100 },
  }
}

function makeDevStoryFailure() {
  return {
    result: 'failed' as const,
    ac_met: [],
    ac_failures: ['AC1'],
    files_modified: [],
    tests: 'fail' as const,
    error: 'dev failed',
    tokenUsage: { input: 200, output: 0 },
  }
}

function makeCodeReviewShipIt() {
  return {
    verdict: 'SHIP_IT' as const,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// checkGitDiffFiles() unit tests
// ---------------------------------------------------------------------------

describe('checkGitDiffFiles()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns file list from git diff --name-only HEAD (unstaged changes)', () => {
    // First call (unstaged), second call (staged) returns empty
    mockExecSync
      .mockReturnValueOnce('src/foo.ts\nsrc/bar.ts\n')
      .mockReturnValueOnce('')

    const result = checkGitDiffFiles('/some/dir')

    expect(result).toEqual(expect.arrayContaining(['src/foo.ts', 'src/bar.ts']))
    expect(result).toHaveLength(2)
  })

  it('returns file list from git diff --cached --name-only (staged changes only)', () => {
    // First call (unstaged) returns empty, second call (staged) returns files
    mockExecSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('src/staged.ts\n')

    const result = checkGitDiffFiles('/some/dir')

    expect(result).toEqual(['src/staged.ts'])
  })

  it('deduplicates files that appear in both unstaged and staged diffs', () => {
    // Same file appears in both HEAD diff and cached diff
    mockExecSync
      .mockReturnValueOnce('src/foo.ts\n')
      .mockReturnValueOnce('src/foo.ts\nsrc/bar.ts\n')

    const result = checkGitDiffFiles('/some/dir')

    // Should only appear once even though it's in both diffs
    const fooCount = result.filter((f) => f === 'src/foo.ts').length
    expect(fooCount).toBe(1)
    expect(result).toContain('src/bar.ts')
  })

  it('returns empty array when neither diff has changes (zero-diff)', () => {
    mockExecSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')

    const result = checkGitDiffFiles('/some/dir')

    expect(result).toEqual([])
  })

  it('handles git command failure gracefully and returns empty array', () => {
    // Both calls throw (e.g., not a git repo)
    mockExecSync
      .mockImplementationOnce(() => { throw new Error('not a git repository') })
      .mockImplementationOnce(() => { throw new Error('not a git repository') })

    // Should not throw
    const result = checkGitDiffFiles('/some/dir')

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Orchestrator zero-diff integration tests
// ---------------------------------------------------------------------------

describe('orchestrator: zero-diff detection gate', () => {
  let db: BetterSqlite3Database
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let config: OrchestratorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    config = defaultConfig()
  })

  it('AC2: escalates story when dev-story reports success but git diff is empty', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('24-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    // execSync returns empty string → zero diff detected
    mockExecSync.mockReturnValue('')

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['24-1'])

    // Story should be ESCALATED, not proceed to code-review
    expect(status.stories['24-1']?.phase).toBe('ESCALATED')
    // Code review should NOT have run
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('AC6: emits orchestrator:zero-diff-escalation event on zero-diff detection', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('24-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockExecSync.mockReturnValue('')

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['24-1'])

    const mockEmit = vi.mocked(eventBus.emit)
    const zeroEvent = mockEmit.mock.calls.find(
      ([eventName]) => eventName === 'orchestrator:zero-diff-escalation',
    )
    expect(zeroEvent).toBeDefined()
    const payload = zeroEvent![1] as { storyKey: string; reason: string }
    expect(payload.storyKey).toBe('24-1')
    expect(payload.reason).toBe('zero-diff-on-complete')
  })

  it('AC3: proceeds to code-review when dev-story success has non-zero diff', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('24-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    // Non-empty diff → gate passes
    mockExecSync.mockReturnValue('src/implementation.ts\n')

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['24-1'])

    expect(status.stories['24-1']?.phase).toBe('COMPLETE')
    expect(mockRunCodeReview).toHaveBeenCalledOnce()
  })

  it('AC4: staged-only changes (git diff --cached) prevent zero-diff escalation', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('24-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    // First call (HEAD diff) returns empty, second call (staged) returns files
    mockExecSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('src/staged-change.ts\n')

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    const status = await orchestrator.run(['24-1'])

    // Staged files count — should NOT escalate
    expect(status.stories['24-1']?.phase).toBe('COMPLETE')
    expect(mockRunCodeReview).toHaveBeenCalledOnce()
  })

  it('AC5: failed dev-story result bypasses zero-diff check entirely', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('24-1'))
    mockRunDevStory.mockResolvedValue(makeDevStoryFailure())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    // Even if execSync returns empty, failed result should not hit the gate
    mockExecSync.mockReturnValue('')

    const orchestrator = createImplementationOrchestrator({
      db, pack, contextCompiler, dispatcher, eventBus, config,
    })

    await orchestrator.run(['24-1'])

    // Zero-diff-escalation event should NOT have been emitted
    const mockEmit = vi.mocked(eventBus.emit)
    const zeroEvent = mockEmit.mock.calls.find(
      ([eventName]) => eventName === 'orchestrator:zero-diff-escalation',
    )
    expect(zeroEvent).toBeUndefined()
  })
})
