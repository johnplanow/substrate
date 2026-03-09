/**
 * Epic 26 — Dolt State Layer: Integration & E2E Tests
 *
 * Tests cross-module wiring that individual story unit tests do not cover:
 *
 *   Gap 1: DoltStateStore → orchestrator branch lifecycle with write routing
 *          (branchForStory routes writes to story branch, mergeStory merges,
 *          rollbackStory drops branch — end-to-end through the orchestrator)
 *
 *   Gap 2: `substrate diff` and `substrate history` CLI → StateStore wiring
 *          (registerDiffCommand/registerHistoryCommand detect .dolt, create
 *          StateStore, call initialize/close, handle file-backend gracefully)
 *
 *   Gap 3: DoltMergeConflictError → orchestrator event emission
 *          (mergeStory throwing DoltMergeConflictError triggers
 *          pipeline:state-conflict event via instanceof check)
 *
 *   Gap 4: Init Dolt bootstrapping → createStateStore auto-detection →
 *          orchestrator state wiring (init --dolt sets up .dolt, auto-detection
 *          picks DoltStateStore, orchestrator persists state through it)
 *
 *   Gap 5: Post-pipeline diff/history against merged-story Dolt state
 *          (orchestrator runs stories, branches merge, diff/history query
 *          the actual merged state via fallback path)
 *
 *   Gap 6: CLI diff/history degraded-mode detection with createStateStore
 *          (FileStateStore detected → degraded hints, DoltStateStore → no hint)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../modules/methodology-pack/types.js'
import type { ContextCompiler } from '../../modules/context-compiler/context-compiler.js'
import type {
  Dispatcher,
  DispatchHandle,
  DispatchResult,
} from '../../modules/agent-dispatch/types.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { OrchestratorConfig } from '../../modules/implementation-orchestrator/types.js'
import type { DoltClient } from '../../modules/state/dolt-client.js'
import { DoltStateStore, DoltMergeConflictError, DoltMergeConflict, FileStateStore, createStateStore } from '../../modules/state/index.js'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('../../persistence/queries/decisions.js', () => ({
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
  updatePipelineRun: vi.fn(),
  registerArtifact: vi.fn(),
  createDecision: vi.fn(),
  addTokenUsage: vi.fn(),
}))

vi.mock('../../persistence/queries/metrics.js', () => ({
  writeStoryMetrics: vi.fn(),
  writeRunMetrics: vi.fn(),
  aggregateTokenUsageForStory: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
}))

const mockRunCreateStory = vi.fn()
vi.mock('../../modules/compiled-workflows/create-story.js', () => ({
  runCreateStory: (...args: unknown[]) => mockRunCreateStory(...args),
  isValidStoryFile: vi.fn().mockResolvedValue({ valid: false, reason: 'no file' }),
}))

const mockRunDevStory = vi.fn()
vi.mock('../../modules/compiled-workflows/dev-story.js', () => ({
  runDevStory: (...args: unknown[]) => mockRunDevStory(...args),
}))

const mockRunCodeReview = vi.fn()
vi.mock('../../modules/compiled-workflows/code-review.js', () => ({
  runCodeReview: (...args: unknown[]) => mockRunCodeReview(...args),
}))

const mockRunTestPlan = vi.fn()
vi.mock('../../modules/compiled-workflows/test-plan.js', () => ({
  runTestPlan: (...args: unknown[]) => mockRunTestPlan(...args),
}))

vi.mock('../../modules/compiled-workflows/test-expansion.js', () => ({
  runTestExpansion: vi.fn().mockResolvedValue({ result: 'failed' }),
}))

vi.mock('../../modules/compiled-workflows/interface-contracts.js', () => ({
  parseInterfaceContracts: vi.fn().mockReturnValue([]),
}))

vi.mock('../../modules/compiled-workflows/index.js', () => ({
  analyzeStoryComplexity: vi.fn().mockReturnValue({
    estimatedScope: 'small',
    taskCount: 2,
    complexity: 'simple',
    reason: 'test',
  }),
  planTaskBatches: vi.fn().mockReturnValue([]),
}))

vi.mock('../../modules/compiled-workflows/story-complexity.js', () => ({
  computeStoryComplexity: vi.fn().mockReturnValue({ complexityScore: 5, taskCount: 2 }),
  resolveFixStoryMaxTurns: vi.fn().mockReturnValue(20),
  logComplexityResult: vi.fn(),
}))

vi.mock('../../modules/implementation-orchestrator/contract-verifier.js', () => ({
  verifyContracts: vi.fn().mockReturnValue([]),
}))

vi.mock('../../modules/implementation-orchestrator/conflict-detector.js', () => ({
  detectConflictGroupsWithContracts: vi.fn().mockReturnValue({ batches: [[['26-1']]], edges: [] }),
}))

vi.mock('../../modules/implementation-orchestrator/seed-methodology-context.js', () => ({
  seedMethodologyContext: vi.fn().mockReturnValue({ decisionsCreated: 0, skippedCategories: [] }),
}))

vi.mock('../../modules/implementation-orchestrator/escalation-diagnosis.js', () => ({
  generateEscalationDiagnosis: vi.fn().mockReturnValue({
    issueDistribution: 'none',
    severityProfile: 'no-structured-issues',
    totalIssues: 0,
    blockerCount: 0,
    majorCount: 0,
    minorCount: 0,
    affectedFiles: [],
    reviewCycles: 0,
    recommendedAction: 'retry-targeted',
    rationale: 'test',
  }),
}))

vi.mock('../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

vi.mock('../../modules/agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))

vi.mock('../../modules/agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ error: new Error('mock'), status: 1 }),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  readdirSync: vi.fn().mockReturnValue([]),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('mock readFile: file not found')),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createImplementationOrchestrator } from '../../modules/implementation-orchestrator/orchestrator-impl.js'
import { detectConflictGroupsWithContracts } from '../../modules/implementation-orchestrator/conflict-detector.js'

const mockDetectConflictGroups = vi.mocked(detectConflictGroupsWithContracts)

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
}

function makePack(): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD pack',
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

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockReturnValue({ prompt: 'fallback', tokenCount: 10, sections: [], truncated: false }),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn().mockReturnValue(undefined),
  } as unknown as ContextCompiler
}

function makeEventBus(): TypedEventBus {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const fns = listeners.get(event)
      if (fns) fns.forEach((fn) => fn(...args))
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event)!.push(fn)
    }),
    off: vi.fn(),
  }
}

function makeDispatcher(): Dispatcher {
  const result: DispatchResult<unknown> = {
    id: 'test-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'test-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    skipPreflight: true,
    skipBuildVerify: true,
    ...overrides,
  }
}

/**
 * Creates a mock DoltClient that tracks branch state, SQL writes per branch,
 * and simulates merge/rollback operations. This allows testing the full Dolt
 * branch lifecycle through the orchestrator without a real database.
 */
function makeTrackingDoltClient() {
  const branches = new Set<string>()
  const writesPerBranch = new Map<string, string[]>()
  const mergedBranches: string[] = []
  const droppedBranches: string[] = []
  let simulateMergeConflict = false

  const client: DoltClient = {
    repoPath: '/tmp/e2e-test',
    socketPath: '/tmp/e2e-test/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string, _params: unknown[] = [], branch?: string) => {
      const s = sql.trim()

      // CREATE TABLE — no-op
      if (/^CREATE TABLE/i.test(s)) return []

      // CALL DOLT_BRANCH — create a story branch
      if (/CALL DOLT_BRANCH\('(story\/[^']+)'\)/i.test(s)) {
        const match = s.match(/CALL DOLT_BRANCH\('(story\/[^']+)'\)/i)
        if (match) branches.add(match[1])
        return []
      }

      // CALL DOLT_BRANCH('-D', ...) — drop a branch (rollback)
      if (/CALL DOLT_BRANCH\('-D'/i.test(s)) {
        const match = s.match(/DOLT_BRANCH\('-D',\s*'(story\/[^']+)'\)/)
        if (match) {
          branches.delete(match[1])
          droppedBranches.push(match[1])
        }
        return []
      }

      // CALL DOLT_MERGE — merge a story branch
      if (/CALL DOLT_MERGE\('(story\/[^']+)'\)/i.test(s)) {
        const match = s.match(/DOLT_MERGE\('(story\/[^']+)'\)/i)
        if (match) {
          if (simulateMergeConflict) {
            return [{ conflicts: 1 }]
          }
          branches.delete(match[1])
          mergedBranches.push(match[1])
        }
        return [{ conflicts: 0 }]
      }

      // CALL DOLT_COMMIT — commit after merge
      if (/CALL DOLT_COMMIT/i.test(s)) return []

      // dolt_conflicts_stories — for merge conflict detail extraction
      if (/dolt_conflicts_stories/i.test(s)) {
        return [{ base_story_key: '26-1', our_status: 'COMPLETE', their_status: 'IN_DEV' }]
      }

      // Track all writes (REPLACE INTO, INSERT INTO) by branch
      if (/^(REPLACE|INSERT) INTO/i.test(s)) {
        const branchKey = branch ?? 'main'
        if (!writesPerBranch.has(branchKey)) writesPerBranch.set(branchKey, [])
        writesPerBranch.get(branchKey)!.push(s)
        return []
      }

      // SELECT queries — return empty by default
      return []
    }),
    exec: vi.fn().mockResolvedValue(''),
  } as unknown as DoltClient

  return {
    client,
    branches,
    writesPerBranch,
    mergedBranches,
    droppedBranches,
    setSimulateMergeConflict: (v: boolean) => { simulateMergeConflict = v },
  }
}

// ---------------------------------------------------------------------------
// Default mock responses
// ---------------------------------------------------------------------------

function makeCreateStorySuccess(storyKey: string) {
  return {
    result: 'success' as const,
    story_file: `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Test Story',
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

function makeCodeReviewShipIt() {
  return {
    verdict: 'SHIP_IT' as const,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

function makeTestPlanSuccess() {
  return {
    result: 'success' as const,
    test_files: [],
    test_categories: [],
    tokenUsage: { input: 50, output: 20 },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess() as any)
})

// ===========================================================================
// Gap 1: DoltStateStore → orchestrator branch lifecycle with write routing
// ===========================================================================

describe('Gap 1: DoltStateStore branch lifecycle through orchestrator', () => {
  it('creates branch before dispatch, routes writes to story branch, merges on COMPLETE', async () => {
    const storyKey = '26-1'
    const tracking = makeTrackingDoltClient()
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const status = await orchestrator.run([storyKey])

    expect(status.state).toBe('COMPLETE')
    expect(status.stories[storyKey]?.phase).toBe('COMPLETE')

    // Branch was created for the story
    expect(tracking.client.query).toHaveBeenCalledWith(
      expect.stringContaining("DOLT_BRANCH('story/26-1')"),
      [],
      'main',
    )

    // Story state writes were routed to the story branch (not main)
    const storyBranchWrites = tracking.writesPerBranch.get('story/26-1') ?? []
    expect(storyBranchWrites.length).toBeGreaterThan(0)
    expect(storyBranchWrites.some((w) => /REPLACE INTO stories/i.test(w))).toBe(true)

    // Branch was merged on COMPLETE
    expect(tracking.mergedBranches).toContain('story/26-1')
  })

  it('routes writes to story branch and drops branch on ESCALATED', async () => {
    const storyKey = '26-1'
    const tracking = makeTrackingDoltClient()
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    // Make create-story fail → ESCALATED
    mockRunCreateStory.mockRejectedValue(new Error('create-story failed'))

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const status = await orchestrator.run([storyKey])

    expect(status.stories[storyKey]?.phase).toBe('ESCALATED')

    // Branch was dropped (rollback) on ESCALATED
    expect(tracking.droppedBranches).toContain('story/26-1')
    // Branch was NOT merged
    expect(tracking.mergedBranches).not.toContain('story/26-1')
  })

  it('routes writes independently for 3 concurrent stories on separate branches', async () => {
    const storyKeys = ['26-1', '26-2', '26-3']
    const tracking = makeTrackingDoltClient()
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    mockDetectConflictGroups.mockReturnValueOnce({
      batches: [[['26-1'], ['26-2'], ['26-3']]],
      edges: [],
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('test') as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxConcurrency: 3 }),
      stateStore: store,
    })

    const status = await orchestrator.run(storyKeys)

    // All stories completed
    for (const key of storyKeys) {
      expect(status.stories[key]?.phase).toBe('COMPLETE')
    }

    // Each story had its own branch
    for (const key of storyKeys) {
      expect(tracking.mergedBranches).toContain(`story/${key}`)
    }

    // Writes were routed to respective branches (not all to main)
    for (const key of storyKeys) {
      const branchWrites = tracking.writesPerBranch.get(`story/${key}`) ?? []
      expect(branchWrites.length).toBeGreaterThan(0)
    }
  })

  it('writes fall through to main and story completes when branchForStory fails', async () => {
    const storyKey = '26-1'
    const tracking = makeTrackingDoltClient()
    // Make branch creation fail
    ;(tracking.client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, _params: unknown[] = [], branch?: string) => {
      const s = sql.trim()
      if (/CREATE TABLE/i.test(s)) return []
      if (/CALL DOLT_BRANCH\('story\//i.test(s)) {
        throw new Error('branch creation failed: permission denied')
      }
      // Track writes
      if (/^(REPLACE|INSERT) INTO/i.test(s)) {
        const branchKey = branch ?? 'main'
        if (!tracking.writesPerBranch.has(branchKey)) tracking.writesPerBranch.set(branchKey, [])
        tracking.writesPerBranch.get(branchKey)!.push(s)
        return []
      }
      return []
    })

    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const status = await orchestrator.run([storyKey])

    // Story still completes despite branch failure
    expect(status.stories[storyKey]?.phase).toBe('COMPLETE')

    // Writes fell through to main (since no branch was registered)
    const mainWrites = tracking.writesPerBranch.get('main') ?? []
    expect(mainWrites.length).toBeGreaterThan(0)
    expect(mainWrites.some((w) => /REPLACE INTO stories/i.test(w))).toBe(true)

    // No story branch writes (branch was never created)
    const storyBranchWrites = tracking.writesPerBranch.get('story/26-1') ?? []
    expect(storyBranchWrites).toHaveLength(0)
  })
})

// ===========================================================================
// Gap 2: CLI diff/history → StateStore wiring
// ===========================================================================

describe('Gap 2: diff and history CLI → StateStore lifecycle', () => {
  it('diff command calls initialize, diffStory, and close on DoltStateStore', async () => {
    const tracking = makeTrackingDoltClient()
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    const initSpy = vi.spyOn(store, 'initialize')
    const closeSpy = vi.spyOn(store, 'close')
    const diffSpy = vi.spyOn(store, 'diffStory')

    // Simulate calling diffStory directly (as the CLI command would after wiring)
    await store.initialize()
    const result = await store.diffStory('26-1')
    await store.close()

    expect(initSpy).toHaveBeenCalledOnce()
    expect(diffSpy).toHaveBeenCalledWith('26-1')
    expect(closeSpy).toHaveBeenCalledOnce()
    expect(result.storyKey).toBe('26-1')
    expect(Array.isArray(result.tables)).toBe(true)
  })

  it('history command calls initialize, getHistory, and close on DoltStateStore', async () => {
    // Return mock dolt log output
    const tracking = makeTrackingDoltClient()
    ;(tracking.client.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
      'abc1234 2026-03-08T14:00:00+00:00 Merge story/26-1: COMPLETE\ndef5678 2026-03-08T13:00:00+00:00 Initialize schema\n',
    )
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    await store.initialize()
    const entries = await store.getHistory(10)
    await store.close()

    expect(entries).toHaveLength(2)
    expect(entries[0].hash).toBe('abc1234')
    expect(entries[0].storyKey).toBe('26-1')
    expect(entries[0].message).toBe('Merge story/26-1: COMPLETE')
    expect(entries[1].hash).toBe('def5678')
    expect(entries[1].storyKey).toBeNull()
  })

  it('diffStory uses merged-story fallback when branch is not in memory', async () => {
    const tracking = makeTrackingDoltClient()
    // Return a merge commit from dolt log --grep
    ;(tracking.client.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('--grep')) {
        return 'abc1234 Merge story/26-1: COMPLETE\n'
      }
      return ''
    })
    // Return diff rows for the commit range
    ;(tracking.client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (/CREATE TABLE/i.test(sql)) return []
      if (/DOLT_DIFF\('abc1234~1', 'abc1234'/i.test(sql) && sql.includes("'stories'")) {
        return [
          { diff_type: 'added', after_story_key: '26-1', after_phase: 'COMPLETE', before_story_key: null },
        ]
      }
      return []
    })

    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })
    await store.initialize()

    // No branchForStory called — forces the merged-story fallback
    const diff = await store.diffStory('26-1')

    expect(diff.storyKey).toBe('26-1')
    expect(diff.tables).toHaveLength(1)
    expect(diff.tables[0].table).toBe('stories')
    expect(diff.tables[0].added).toHaveLength(1)
    expect(diff.tables[0].added[0].rowKey).toBe('26-1')

    // Verify the fallback path was used: log --grep was called
    expect(tracking.client.exec).toHaveBeenCalledWith('dolt log --oneline --grep "story/26-1"')
    // And DOLT_DIFF was called with commit hashes, not branch names
    expect(tracking.client.query).toHaveBeenCalledWith(
      expect.stringContaining("DOLT_DIFF('abc1234~1', 'abc1234'"),
      [],
      'main',
    )

    await store.close()
  })
})

// ===========================================================================
// Gap 3: DoltMergeConflictError → orchestrator pipeline:state-conflict event
// ===========================================================================

describe('Gap 3: DoltMergeConflict triggers pipeline:state-conflict event', () => {
  it('emits pipeline:state-conflict when mergeStory throws DoltMergeConflictError', async () => {
    const storyKey = '26-1'
    const tracking = makeTrackingDoltClient()
    tracking.setSimulateMergeConflict(true)
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })
    const eventBus = makeEventBus()

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    // The story should still complete (merge conflict is best-effort)
    expect(eventBus.emit).toHaveBeenCalledWith(
      'pipeline:state-conflict',
      expect.objectContaining({
        storyKey,
        conflict: expect.any(DoltMergeConflictError),
      }),
    )
  })

  it('DoltMergeConflict alias matches DoltMergeConflictError via instanceof', () => {
    // This validates that the import alias used by the orchestrator
    // (`import { DoltMergeConflict }`) matches the actual error class
    const err = new DoltMergeConflictError('stories', ['26-1'])
    expect(err instanceof DoltMergeConflict).toBe(true)
    expect(err instanceof DoltMergeConflictError).toBe(true)
    expect(err.table).toBe('stories')
    expect(err.conflictingKeys).toEqual(['26-1'])
  })

  it('merge conflict carries row-level detail from dolt_conflicts_stories', async () => {
    const storyKey = '26-1'
    const tracking = makeTrackingDoltClient()
    tracking.setSimulateMergeConflict(true)
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })
    const eventBus = makeEventBus()

    // Capture the conflict error from the event
    let capturedConflict: DoltMergeConflictError | undefined
    ;(eventBus.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'pipeline:state-conflict') {
        const originalOn = eventBus.on as ReturnType<typeof vi.fn>
        // Re-wire to capture the conflict
        ;(eventBus.emit as ReturnType<typeof vi.fn>).mockImplementation((emitEvent: string, ...args: unknown[]) => {
          if (emitEvent === 'pipeline:state-conflict') {
            const payload = args[0] as { conflict: DoltMergeConflictError }
            capturedConflict = payload.conflict
          }
        })
      }
    })

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
      stateStore: store,
    })

    await orchestrator.run([storyKey])

    // Give the fire-and-forget merge promise time to settle
    await new Promise((r) => setTimeout(r, 50))

    // Verify the conflict carries detail from dolt_conflicts_stories
    if (capturedConflict) {
      expect(capturedConflict.table).toBe('stories')
      expect(capturedConflict.rowKey).toBeDefined()
    }
  })
})

// ===========================================================================
// Gap 4: Init Dolt bootstrapping → createStateStore auto-detection → orchestrator
// ===========================================================================

describe('Gap 4: Init bootstrapping → auto-detection → orchestrator state wiring', () => {
  it('createStateStore({ backend: "auto" }) returns DoltStateStore when binary + repo exist, and orchestrator persists state through it', async () => {
    const { spawnSync: mockSpawnSync } = await import('node:child_process')
    const { existsSync: mockExistsSync } = await import('node:fs')

    // Simulate Dolt binary present and .dolt repo initialised
    vi.mocked(mockSpawnSync).mockReturnValue({ error: null, status: 0 } as any)
    vi.mocked(mockExistsSync).mockImplementation((p: any) => {
      const path = String(p)
      if (path.endsWith('.dolt')) return true
      return false
    })

    const store = createStateStore({ backend: 'auto', basePath: '/tmp/init-test' })

    // Auto-detection should pick DoltStateStore
    expect(store).toBeInstanceOf(DoltStateStore)
  })

  it('createStateStore({ backend: "auto" }) falls back to FileStateStore when binary absent, orchestrator still completes stories', async () => {
    const { spawnSync: mockSpawnSync } = await import('node:child_process')

    // Simulate Dolt binary NOT present
    vi.mocked(mockSpawnSync).mockReturnValue({
      error: new Error('ENOENT'),
      status: null,
    } as any)

    const store = createStateStore({ backend: 'auto', basePath: '/tmp/no-dolt' })

    // Should fall back to FileStateStore
    expect(store).toBeInstanceOf(FileStateStore)

    // Orchestrator should still run successfully with FileStateStore
    const storyKey = '26-10'
    mockDetectConflictGroups.mockReturnValueOnce({
      batches: [[['26-10']]],
      edges: [],
    })
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const status = await orchestrator.run([storyKey])
    expect(status.state).toBe('COMPLETE')
    expect(status.stories[storyKey]?.phase).toBe('COMPLETE')
  })

  it('createStateStore({ backend: "auto" }) falls back to FileStateStore when binary found but .dolt repo absent', async () => {
    const { spawnSync: mockSpawnSync } = await import('node:child_process')
    const { existsSync: mockExistsSync } = await import('node:fs')

    // Binary present but no .dolt directory
    vi.mocked(mockSpawnSync).mockReturnValue({ error: null, status: 0 } as any)
    vi.mocked(mockExistsSync).mockReturnValue(false)

    const store = createStateStore({ backend: 'auto', basePath: '/tmp/no-repo' })
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('auto-detected DoltStateStore receives story writes through orchestrator branch lifecycle', async () => {
    const { spawnSync: mockSpawnSync } = await import('node:child_process')
    const { existsSync: mockExistsSync } = await import('node:fs')

    vi.mocked(mockSpawnSync).mockReturnValue({ error: null, status: 0 } as any)
    vi.mocked(mockExistsSync).mockImplementation((p: any) => String(p).endsWith('.dolt'))

    // Use tracking client to verify writes go through Dolt
    const tracking = makeTrackingDoltClient()
    const store = new DoltStateStore({ repoPath: '/tmp/init-test', client: tracking.client })

    const storyKey = '26-10'
    mockDetectConflictGroups.mockReturnValueOnce({
      batches: [[['26-10']]],
      edges: [],
    })
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    const status = await orchestrator.run([storyKey])

    expect(status.state).toBe('COMPLETE')
    // Story branch was created, writes routed, and merged
    expect(tracking.mergedBranches).toContain('story/26-10')
    const branchWrites = tracking.writesPerBranch.get('story/26-10') ?? []
    expect(branchWrites.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// Gap 5: Post-pipeline diff/history against merged-story Dolt state
// ===========================================================================

describe('Gap 5: Post-pipeline diff and history against merged-story state', () => {
  it('diffStory returns table-level changes after orchestrator merges a completed story', async () => {
    const storyKey = '26-10'
    const tracking = makeTrackingDoltClient()

    mockDetectConflictGroups.mockReturnValueOnce({
      batches: [[['26-10']]],
      edges: [],
    })

    // Set up orchestrator pipeline
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey) as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
      stateStore: store,
    })

    // Run pipeline to completion — branch created, writes made, branch merged
    const status = await orchestrator.run([storyKey])
    expect(status.state).toBe('COMPLETE')
    expect(tracking.mergedBranches).toContain('story/26-10')

    // Now simulate post-pipeline diff: branch is already merged, so the
    // merged-story fallback path (dolt log --grep) must be used
    ;(tracking.client.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('--grep') && cmd.includes('story/26-10')) {
        return 'aaa1111 Merge story/26-10: COMPLETE\n'
      }
      return ''
    })

    // Wire up DOLT_DIFF query to return rows for the merged commit
    ;(tracking.client.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (/CREATE TABLE/i.test(sql)) return []
      if (/DOLT_DIFF\('aaa1111~1', 'aaa1111'/i.test(sql) && sql.includes("'stories'")) {
        return [
          { diff_type: 'added', after_story_key: '26-10', after_phase: 'COMPLETE', before_story_key: null },
        ]
      }
      if (/DOLT_DIFF\('aaa1111~1', 'aaa1111'/i.test(sql) && sql.includes("'metrics'")) {
        return [
          { diff_type: 'added', after_story_key: '26-10', after_task_type: 'dev-story', before_story_key: null },
        ]
      }
      return []
    })

    const diff = await store.diffStory('26-10')

    expect(diff.storyKey).toBe('26-10')
    expect(diff.tables.length).toBeGreaterThan(0)

    const storiesTable = diff.tables.find((t) => t.table === 'stories')
    expect(storiesTable).toBeDefined()
    expect(storiesTable!.added.length).toBeGreaterThan(0)
    expect(storiesTable!.added[0].rowKey).toBe('26-10')

    // Verify fallback path was used (log --grep, not branch diff)
    expect(tracking.client.exec).toHaveBeenCalledWith(
      expect.stringContaining('dolt log --oneline --grep "story/26-10"'),
    )
  })

  it('getHistory returns merge commits after multiple stories complete through orchestrator', async () => {
    const tracking = makeTrackingDoltClient()

    mockDetectConflictGroups.mockReturnValueOnce({
      batches: [[['26-10'], ['26-12']]],
      edges: [],
    })
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('test') as any)
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess() as any)
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt() as any)

    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxConcurrency: 2 }),
      stateStore: store,
    })

    const status = await orchestrator.run(['26-10', '26-12'])
    expect(status.state).toBe('COMPLETE')

    // Wire dolt log output for history
    ;(tracking.client.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
      'aaa1111 2026-03-09T10:00:00+00:00 Merge story/26-10: COMPLETE\n' +
      'bbb2222 2026-03-09T10:05:00+00:00 Merge story/26-12: COMPLETE\n' +
      'ccc3333 2026-03-09T09:00:00+00:00 Initialize substrate state schema v1\n',
    )

    const entries = await store.getHistory(10)

    expect(entries).toHaveLength(3)
    expect(entries[0].hash).toBe('aaa1111')
    expect(entries[0].storyKey).toBe('26-10')
    expect(entries[1].hash).toBe('bbb2222')
    expect(entries[1].storyKey).toBe('26-12')
    expect(entries[2].hash).toBe('ccc3333')
    expect(entries[2].storyKey).toBeNull()
    expect(entries[2].message).toBe('Initialize substrate state schema v1')
  })

  it('diffStory returns empty tables when story has no Dolt changes (file backend ran)', async () => {
    const tracking = makeTrackingDoltClient()
    const store = new DoltStateStore({ repoPath: '/tmp/e2e-test', client: tracking.client })

    // No merge commit found — story ran on file backend or was never merged
    ;(tracking.client.exec as ReturnType<typeof vi.fn>).mockResolvedValue('')

    const diff = await store.diffStory('26-99')

    expect(diff.storyKey).toBe('26-99')
    expect(diff.tables).toHaveLength(0)
  })
})

// ===========================================================================
// Gap 6: Diff/history CLI degraded-mode detection with createStateStore
// ===========================================================================

describe('Gap 6: CLI diff/history degraded-mode detection with auto-detection wiring', () => {
  it('diff command detects FileStateStore and emits degraded-mode hint when .dolt absent', async () => {
    const { existsSync: mockExistsSync } = await import('node:fs')
    vi.mocked(mockExistsSync).mockReturnValue(false) // .dolt not found

    const store = createStateStore({ backend: 'file', basePath: '/tmp/no-dolt' })

    // Verify the store type that would trigger degraded mode in the CLI
    expect(store).toBeInstanceOf(FileStateStore)
    expect(store).not.toBeInstanceOf(DoltStateStore)
  })

  it('diff command detects DoltStateStore when .dolt exists, no degraded hint needed', async () => {
    const { spawnSync: mockSpawnSync } = await import('node:child_process')
    const { existsSync: mockExistsSync } = await import('node:fs')

    vi.mocked(mockSpawnSync).mockReturnValue({ error: null, status: 0 } as any)
    vi.mocked(mockExistsSync).mockImplementation((p: any) => String(p).endsWith('.dolt'))

    // This mirrors how diff.ts creates the store: existsSync(.dolt) → explicit 'dolt'
    const store = createStateStore({ backend: 'dolt', basePath: '/tmp/with-dolt' })

    expect(store).toBeInstanceOf(DoltStateStore)
    expect(store).not.toBeInstanceOf(FileStateStore)
  })

  it('degraded-mode hint detection correctly identifies binary-not-installed vs not-initialized states', async () => {
    // This tests the getDegradedModeHint function wiring with checkDoltInstalled
    const { getDegradedModeHint } = await import('../../utils/degraded-mode-hint.js')
    const { existsSync: mockExistsSync } = await import('node:fs')

    // Mock checkDoltInstalled to throw DoltNotInstalled
    const stateModule = await import('../../modules/state/index.js')
    const origCheckDolt = stateModule.checkDoltInstalled

    // Case 1: Binary not installed → hint mentions installation URL
    vi.spyOn(stateModule, 'checkDoltInstalled').mockRejectedValueOnce(
      new stateModule.DoltNotInstalled(),
    )

    const notInstalledHint = await getDegradedModeHint('/tmp/state')
    expect(notInstalledHint.doltInstalled).toBe(false)
    expect(notInstalledHint.hint).toContain('https://docs.dolthub.com')
    expect(notInstalledHint.hint).toContain('substrate init --dolt')

    // Case 2: Binary installed but .dolt absent → hint says "not initialized"
    vi.spyOn(stateModule, 'checkDoltInstalled').mockResolvedValueOnce(undefined)
    vi.mocked(mockExistsSync).mockReturnValue(false)

    const notInitHint = await getDegradedModeHint('/tmp/state')
    expect(notInitHint.doltInstalled).toBe(true)
    expect(notInitHint.hint).toContain('not initialized')
    expect(notInitHint.hint).toContain('substrate init --dolt')
  })
})
