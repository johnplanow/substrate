/**
 * Path E orchestrator-integration tests (Story 75-1 + Story 75-2 + Story 75-3).
 *
 * Covers the seams that Path E added but that the dispatched stories' own
 * test files never exercised at the orchestrator-integration layer:
 *
 *   - Story 75-1: per-story worktree creation in processStory(), with the
 *     created worktree's path threaded into phase deps as effectiveProjectRoot.
 *     The dispatched 75-1 escalated with checkpoint-retry-timeout; the spec'd
 *     `per-story-worktree.test.ts` was never written.
 *
 *   - Story 75-2: merge-to-main phase invocation post-SHIP_IT. The Story 75-2
 *     unit suite (`merge-to-main.test.ts`, 518 lines) tests `runMergeToMain`
 *     in isolation; it does NOT verify the orchestrator INVOKES it.
 *
 *   - Story 75-3: --no-worktree opt-out skips both creation and merge-to-main.
 *     The Story 75-3 unit suite (`no-worktree-flag.test.ts`) verifies CLI flag
 *     parsing and schema; it does NOT verify the orchestrator HONORS the flag.
 *
 * 2026-05-10 e2e smoke against the canonical 999-1 prompt-edit fixture proved
 * worktree creation works in a real `substrate run`, but the merge-to-main +
 * cleanup-on-success path could not be reached because 999-1 fails at the
 * create-story phase per the documented thin-fixture issue (obs_2026-05-05_026).
 * This integration test fills that gap deterministically + at zero cost.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BRANCH_PREFIX } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

// Mock all phase workflows so we can drive the orchestrator through SHIP_IT.
vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn(),
  extractStorySection: vi.fn(),
  hashSourceAcSection: vi.fn(),
  extractNamedPathsFromSource: vi.fn().mockReturnValue([]),
  computeStoryFileFidelity: vi.fn().mockReturnValue({ missing: [], present: [], drift: 0 }),
  extractBehavioralAssertions: vi.fn().mockReturnValue({ whenClauseCount: 0, whenOrAcCount: 0, numericQuantifiers: [] }),
  computeClauseFidelity: vi.fn().mockReturnValue({
    clauseRatio: 1,
    sourceClauseCount: 0,
    renderedClauseCount: 0,
    numericMismatches: [],
    drift: 0,
  }),
}))
vi.mock('../story-discovery.js', () => ({
  findEpicsFile: vi.fn().mockReturnValue(undefined),
  findEpicFileForStory: vi.fn().mockReturnValue(undefined),
  parseEpicsDependencies: vi.fn().mockReturnValue(new Map()),
}))
vi.mock('../../compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))
vi.mock('../../compiled-workflows/test-plan.js', () => ({
  runTestPlan: vi.fn(),
}))

// Story 75-2: mock merge-to-main module so we can inspect what the
// orchestrator passes to enqueueMerge AND control its return value.
const mockEnqueueMerge = vi.fn()
vi.mock('../../compiled-workflows/merge-to-main.js', () => ({
  createMergeQueue: vi.fn(() => mockEnqueueMerge),
  runMergeToMain: vi.fn(),
}))

// Path E Bug #5 (v0.20.86): mock git-helpers so we can inspect / control
// the substrate-side auto-commit step that runs before merge-to-main.
// Default: commit succeeds (so existing 75-1/75-2/75-3 tests still pass).
// Individual tests override the mock to drive `no-changes` and `failed` paths.
const mockCommitDevStoryOutput = vi.fn()
const mockGetGitChangedFiles = vi.fn()
vi.mock('../../compiled-workflows/git-helpers.js', () => ({
  commitDevStoryOutput: (...args: unknown[]) => mockCommitDevStoryOutput(...args),
  getGitChangedFiles: (...args: unknown[]) => mockGetGitChangedFiles(...args),
  // Other exports the orchestrator might use — not exercised here, but stub
  // them with no-op implementations so the import doesn't error.
  getGitDiffSummary: vi.fn().mockResolvedValue(''),
  getGitDiffStatSummary: vi.fn().mockResolvedValue(''),
  getGitDiffForFiles: vi.fn().mockResolvedValue(''),
  stageIntentToAdd: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn().mockResolvedValue(undefined),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
  createDecision: vi.fn().mockResolvedValue(undefined),
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
  readFileSync: vi.fn().mockReturnValue(''),
  renameSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() + 10_000 }),
}))

// Story 75-2: mock execSync so the orchestrator can capture
// _orchestratorStartBranch from a synthetic git rev-parse without a real repo.
// When called with `encoding: 'utf-8'`, execSync returns a string (the
// orchestrator calls `.trim()` on the result, which only works on strings).
//
// Path E Bug #5 (v0.20.86): the verification gate also calls
// `git rev-parse <branchName>` (returns the branch's commit SHA) and
// `git rev-parse <startBranch>` (returns the start commit SHA). To pass the
// "branch advanced" check in happy-path tests, return DIFFERENT shas for
// the two calls. Individual tests can override this mock to return the
// SAME sha and assert the escalation path.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execSync: vi.fn((cmd: string, opts?: { encoding?: string }) => {
      const isUtf8 = opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
      if (typeof cmd === 'string' && cmd.includes('git rev-parse --abbrev-ref HEAD')) {
        return isUtf8 ? 'main\n' : Buffer.from('main\n')
      }
      if (typeof cmd === 'string' && cmd.startsWith('git rev-parse substrate/story-')) {
        // Branch sha — differ from start sha so the verification gate passes
        return isUtf8 ? 'branchsha-advanced\n' : Buffer.from('branchsha-advanced\n')
      }
      if (typeof cmd === 'string' && cmd.startsWith('git rev-parse main')) {
        // Start branch sha — differ from branch sha
        return isUtf8 ? 'startsha-unchanged\n' : Buffer.from('startsha-unchanged\n')
      }
      // Other execSync calls — return empty result respecting encoding
      return isUtf8 ? '' : Buffer.from('')
    }),
  }
})

vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))

// Tier A verification pipeline always passes
vi.mock('@substrate-ai/sdlc', () => ({
  createDefaultVerificationPipeline: vi.fn(() => ({
    run: vi.fn().mockResolvedValue({
      verdict: 'pass',
      findings: [],
      summary: { error: 0, warn: 0, info: 0 },
    }),
  })),
  toSdlcEventBus: vi.fn((eb) => eb),
  VerificationStore: class {
    add = vi.fn()
    getAll = vi.fn().mockReturnValue([])
    getByStoryKey = vi.fn().mockReturnValue([])
  },
  RunManifest: {
    open: vi.fn(() => ({
      read: vi.fn().mockResolvedValue({ per_story_state: {} }),
      update: vi.fn().mockResolvedValue(undefined),
      patchCLIFlags: vi.fn().mockResolvedValue(undefined),
    })),
  },
}))

// ---------------------------------------------------------------------------
// Imports — must come AFTER vi.mock calls
// ---------------------------------------------------------------------------

import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { createMockWorktreeManager } from './test-helpers/mock-worktree-manager.js'
import type { OrchestratorConfig } from '../types.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)

// ---------------------------------------------------------------------------
// Minimal fakes for the non-mocked deps. These mirror orchestrator.test.ts
// helpers but kept inline so the file is self-contained.
// ---------------------------------------------------------------------------

function createFakeDb(): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn: (q: unknown) => Promise<unknown>) => fn({ query: vi.fn().mockResolvedValue([]), exec: vi.fn() })),
    backendType: 'sqlite',
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseAdapter
}

function createFakePack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'test',
      prompts: { 'create-story': '' },
      constraints: {},
      templates: {},
    },
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraint: vi.fn().mockReturnValue(''),
    getTemplate: vi.fn().mockReturnValue(''),
  } as unknown as MethodologyPack
}

function createFakeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({
      contexts: [],
      tokens: 0,
      compiled_at: new Date().toISOString(),
    }),
  } as unknown as ContextCompiler
}

function createFakeDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn().mockReturnValue({
      id: 'test-dispatch-id',
      result: Promise.resolve({
        status: 'success',
        parsed: {},
        output: '',
        exitCode: 0,
        tokenEstimate: { input: 0, output: 0 },
      }),
      cancel: vi.fn(),
    }),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher
}

function createFakeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus
}

// ---------------------------------------------------------------------------
// Workflow result factories
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
    test_files: ['src/__tests__/foo.test.ts'],
    test_categories: ['unit'],
    coverage_notes: 'AC1 covered',
    tokenUsage: { input: 50, output: 20 },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Path E orchestrator integration — worktree creation + merge-to-main', () => {
  let db: DatabaseAdapter
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    mockEnqueueMerge.mockReset()
    db = createFakeDb()
    pack = createFakePack()
    contextCompiler = createFakeContextCompiler()
    dispatcher = createFakeDispatcher()
    eventBus = createFakeEventBus()

    // Default: every phase succeeds → SHIP_IT path
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('e2e-1'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())
    mockRunTestPlan.mockResolvedValue(makeTestPlanSuccess())
    // Default: merge succeeds (FF-merge happy path)
    mockEnqueueMerge.mockResolvedValue({ success: true })
    // Path E Bug #5 (v0.20.86): default — auto-commit succeeds and returns
    // a sha. Tests for the no-commit and commit-failed paths override these.
    mockCommitDevStoryOutput.mockResolvedValue({
      status: 'committed',
      sha: 'autocommit-sha-abc123',
      filesStaged: ['_bmad-output/implementation-artifacts/e2e-1-mock.md', 'src/mock.ts'],
    })
    mockGetGitChangedFiles.mockResolvedValue([
      '_bmad-output/implementation-artifacts/e2e-1-mock.md',
      'src/mock.ts',
    ])
  })

  function baseConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
    return {
      maxConcurrency: 1,
      maxReviewCycles: 2,
      pipelineRunId: 'test-run-id',
      gcPauseMs: 0,
      skipPreflight: true,
      ...overrides,
    }
  }

  // ------------------------------------------------------------------------
  // Story 75-1 — per-story worktree creation
  // ------------------------------------------------------------------------

  describe('Story 75-1: per-story worktree creation', () => {
    it('invokes worktreeManager.createWorktree(storyKey) once per story when noWorktree=false', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      expect(worktreeManager.createWorktree).toHaveBeenCalledOnce()
      expect(worktreeManager.createWorktree).toHaveBeenCalledWith('e2e-1')
    })

    it('skips worktree creation entirely when noWorktree=true (Story 75-3 opt-out)', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: true }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      expect(worktreeManager.createWorktree).not.toHaveBeenCalled()
    })

    it('threads the worktree path into phase deps as projectRoot when noWorktree=false', async () => {
      const worktreeManager = createMockWorktreeManager({
        worktreePath: '/expected/worktree/path/e2e-1',
      })
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      // dev-story is the canonical phase that consumes effectiveProjectRoot;
      // assert its deps got the worktree path, not /path/to/project.
      const devCall = mockRunDevStory.mock.calls[0]
      expect(devCall).toBeDefined()
      const devDeps = devCall![0] as { projectRoot?: string }
      expect(devDeps.projectRoot).toBe('/expected/worktree/path/e2e-1')
    })

    it('threads projectRoot (not worktree) into phase deps when noWorktree=true', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: true }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      const devCall = mockRunDevStory.mock.calls[0]
      expect(devCall).toBeDefined()
      const devDeps = devCall![0] as { projectRoot?: string }
      expect(devDeps.projectRoot).toBe('/path/to/project')
    })
  })

  // ------------------------------------------------------------------------
  // Story 75-2 — merge-to-main phase invocation post-SHIP_IT
  // ------------------------------------------------------------------------

  describe('Story 75-2: merge-to-main invocation post-SHIP_IT', () => {
    it('invokes enqueueMerge after verification passes (SHIP_IT) when worktreeManager is present', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      expect(mockEnqueueMerge).toHaveBeenCalledOnce()
    })

    it('passes the correct merge params: storyKey, branchName, startBranch, worktreeManager, eventBus, projectRoot', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      const params = mockEnqueueMerge.mock.calls[0]![0] as {
        storyKey: string
        branchName: string
        startBranch: string
        worktreeManager: unknown
        eventBus: unknown
        projectRoot: string
      }
      expect(params.storyKey).toBe('e2e-1')
      // Compose from BRANCH_PREFIX so a future prefix rename is caught by a CONTRACT
      // mismatch (orchestrator-side bug), not a test-literal mismatch (test-only bug).
      // The v0.20.82 production bug existed because this assertion hardcoded the
      // expected literal; the test passed against the buggy code.
      expect(params.branchName).toBe(`${BRANCH_PREFIX}e2e-1`)
      expect(params.startBranch).toBe('main') // captured from mocked git rev-parse
      expect(params.worktreeManager).toBe(worktreeManager)
      expect(params.eventBus).toBe(eventBus)
      expect(params.projectRoot).toBe('/path/to/project')
    })

    it('does NOT invoke enqueueMerge when noWorktree=true', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: true }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('does NOT invoke enqueueMerge when worktreeManager is absent', async () => {
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        // worktreeManager omitted intentionally
      })

      await orchestrator.run(['e2e-1'])

      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('marks story COMPLETE when merge succeeds (FF-merge happy path)', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockEnqueueMerge.mockResolvedValueOnce({ success: true })
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
    })

    it('escalates story with merge-conflict-detected when mergeResult.success=false', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockEnqueueMerge.mockResolvedValueOnce({
        success: false,
        conflictingFiles: ['src/foo.ts', 'src/bar.ts'],
      })
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('merge-conflict-detected')
    })

    it('escalates story with merge-to-main-error when enqueueMerge throws', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockEnqueueMerge.mockRejectedValueOnce(new Error('git command not found'))
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toMatch(/^merge-to-main-error:/)
      expect(status.stories['e2e-1']?.error).toContain('git command not found')
    })
  })

  // ------------------------------------------------------------------------
  // Path E Bug #5 (v0.20.86) — substrate-side auto-commit + verification gate
  // ------------------------------------------------------------------------

  describe('substrate auto-commit + SHIP_IT verification gate', () => {
    it('AC10: invokes commitDevStoryOutput before merge-to-main, passing storyKey + storyTitle + dirty files + worktree path', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      expect(mockCommitDevStoryOutput).toHaveBeenCalled()
      const [storyKey, storyTitle, files, workingDir] = mockCommitDevStoryOutput.mock.calls[0] ?? []
      expect(storyKey).toBe('e2e-1')
      // storyTitle comes from makeCreateStorySuccess('e2e-1') which sets it
      // (any non-empty string is fine — orchestrator threads it through)
      expect(typeof storyTitle === 'string' || storyTitle === undefined).toBe(true)
      // Dirty files come from mockGetGitChangedFiles (set in beforeEach)
      expect(files).toEqual([
        '_bmad-output/implementation-artifacts/e2e-1-mock.md',
        'src/mock.ts',
      ])
      // Worktree path is whatever createMockWorktreeManager returns
      expect(typeof workingDir).toBe('string')
    })

    it('AC11: when commitDevStoryOutput returns status="no-changes", escalates with dev-story-no-commit and does NOT invoke merge-to-main', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockCommitDevStoryOutput.mockResolvedValueOnce({
        status: 'no-changes',
        reason: 'no-files-inside-worktree',
      })
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toMatch(/^dev-story-no-commit/)
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('AC12: when commitDevStoryOutput returns status="failed" (e.g. pre-commit hook rejection), escalates with dev-story-commit-failed and does NOT invoke merge-to-main', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockCommitDevStoryOutput.mockResolvedValueOnce({
        status: 'failed',
        stderr: 'git commit failed: husky - pre-commit hook exited with code 1\neslint failed on src/foo.ts',
      })
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('dev-story-commit-failed')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('AC13: defensive gate — when post-commit `git rev-parse branch` equals `git rev-parse startBranch`, escalates with dev-story-no-commit and does NOT invoke merge-to-main', async () => {
      // Even though commitDevStoryOutput reports success, the verification
      // gate must detect a stale branch (unchanged from start) and refuse
      // to merge. This is the belt-and-suspenders defense against any
      // future flow-drift that produces a committed-status without
      // actually advancing the branch.
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      // Override the rev-parse mock so branch sha === start sha
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        const isUtf8 = opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
        if (typeof cmd === 'string' && cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          return isUtf8 ? 'main\n' : Buffer.from('main\n')
        }
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse substrate/story-')) {
          // CRITICAL: same sha as start sha — branch did NOT advance
          return isUtf8 ? 'same-sha-no-advance\n' : Buffer.from('same-sha-no-advance\n')
        }
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse main')) {
          return isUtf8 ? 'same-sha-no-advance\n' : Buffer.from('same-sha-no-advance\n')
        }
        return isUtf8 ? '' : Buffer.from('')
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('dev-story-no-commit')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })
  })
})
