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
// H0.1: the orchestrator checkpoints dirty worktrees on failure paths.
// Default: nothing dirty (no-changes) so existing tests are unaffected;
// checkpoint-specific tests override this.
const mockCheckpointStoryWorktree = vi.fn()
vi.mock('../../compiled-workflows/git-helpers.js', () => ({
  // H5.5: branch-HEAD recovery — default: nothing recoverable.
  recoverStoryFileFromBranch: vi.fn().mockResolvedValue(undefined),
  commitDevStoryOutput: (...args: unknown[]) => mockCommitDevStoryOutput(...args),
  getGitChangedFiles: (...args: unknown[]) => mockGetGitChangedFiles(...args),
  checkpointStoryWorktree: (...args: unknown[]) => mockCheckpointStoryWorktree(...args),
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
    // H7 review (bug_007): gh pr create / git push now use execFileSync (argv).
    execFileSync: vi.fn((file: string, args?: string[], opts?: { encoding?: string }) => {
      const isUtf8 = opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
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
  // H1.7: pre-existing tracked files touched by the story (tripwire input).
  checkGitModifiedTrackedFiles: vi.fn().mockReturnValue([]),
}))
vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi.fn().mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))

// Tier A verification pipeline always passes
// A0.3 (acceptance-gate): controllable trusted-tree loaders. Default `absent`
// = acceptance not configured, so every pre-A0.3 test is unaffected. The pure
// coverage/frontmatter functions come through REAL (nothing to game in ledger
// arithmetic — mocking them would test the mock).
const mockLoadJourneyRegistry = vi.fn().mockResolvedValue({ status: 'absent' })
const mockLoadJourneyDeferrals = vi.fn().mockResolvedValue({ status: 'ok', deferrals: [] })
const mockLoadAcceptanceContract = vi.fn().mockResolvedValue({ status: 'absent' })
vi.mock('@substrate-ai/sdlc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@substrate-ai/sdlc')>()
  return {
    createDefaultVerificationPipeline: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({
        verdict: 'pass',
        findings: [],
        summary: { error: 0, warn: 0, info: 0 },
      }),
    })),
    toSdlcEventBus: vi.fn((eb: unknown) => eb),
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
        patchStoryState: vi.fn().mockResolvedValue(undefined),
      })),
    },
    // A0.3: real pure functions + controllable loaders
    parseStoryFrontmatter: actual.parseStoryFrontmatter,
    computeJourneyCoverage: actual.computeJourneyCoverage,
    summarizeCoverage: actual.summarizeCoverage,
    JOURNEY_DEFERRALS_PATH: actual.JOURNEY_DEFERRALS_PATH,
    loadJourneyRegistryFromTrustedTree: (...args: unknown[]) => mockLoadJourneyRegistry(...args),
    loadJourneyDeferralsFromTrustedTree: (...args: unknown[]) => mockLoadJourneyDeferrals(...args),
    loadAcceptanceContractFromTrustedTree: (...args: unknown[]) => mockLoadAcceptanceContract(...args),
    ACCEPTANCE_CONTRACT_PROFILE_PATH: actual.ACCEPTANCE_CONTRACT_PROFILE_PATH,
  }
})

// ---------------------------------------------------------------------------
// Imports — must come AFTER vi.mock calls
// ---------------------------------------------------------------------------

import { execSync as mockedExecSync, execFileSync as mockedExecFileSync } from 'node:child_process'
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
    // H1.8: worktree mode enforces artifact containment for ABSOLUTE paths.
    // A relative path is inside the worktree by construction (the agent's cwd),
    // which sidesteps this harness's two different mock-worktree path shapes
    // and keeps the 58-9d fraud-success guard bypassed as before.
    story_file: `${storyKey}-story.md`,
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
    // Disclose the same file the ground-truth diff mock reports (checkGitDiffFiles
    // → src/some-modified-file.ts) so the H7 disclosure gate (committed impl
    // files must be disclosed) does not fire on the happy path.
    files_modified: ['src/foo.ts', 'src/some-modified-file.ts'],
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

  beforeEach(async () => {
    vi.clearAllMocks()
    mockEnqueueMerge.mockReset()
    // A0.3: restore acceptance-loader defaults (absent = not configured) so
    // registry-bearing tests don't leak into later tests.
    mockLoadJourneyRegistry.mockReset()
    mockLoadJourneyRegistry.mockResolvedValue({ status: 'absent' })
    mockLoadJourneyDeferrals.mockReset()
    mockLoadJourneyDeferrals.mockResolvedValue({ status: 'ok', deferrals: [] })
    mockLoadAcceptanceContract.mockReset()
    // Default: a contract EXISTS (cli render declared) so coverage tests
    // exercise the pure unclaimed/unwalked semantics; the unrunnable test
    // overrides this to 'absent'.
    mockLoadAcceptanceContract.mockResolvedValue({
      status: 'ok',
      contract: { surfaces: { cli: { render: 'echo {artifacts}' } } },
    })
    // clearAllMocks clears CALLS not IMPLEMENTATIONS — per-test
    // checkGitDiffFiles overrides (H1.4/H7 tests) otherwise leak into every
    // test that runs after them. Restore the module-factory default here.
    const dispatcherMod = await import('../../agent-dispatch/dispatcher-impl.js')
    vi.mocked(dispatcherMod.checkGitDiffFiles).mockReturnValue(['src/some-modified-file.ts'])
    // Tests that override the execSync implementation (AC13 same-sha, H0.1
    // fall-through) would otherwise leak it into later tests —
    // clearAllMocks() clears calls but NOT implementations. Restore the
    // happy-path default every test.
    ;(mockedExecFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_file: string, _args?: string[], opts?: { encoding?: string }) =>
        opts?.encoding === 'utf-8' || opts?.encoding === 'utf8' ? '' : Buffer.from(''),
    )
    ;(mockedExecSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, opts?: { encoding?: string }) => {
        const isUtf8 = opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
        if (typeof cmd === 'string' && cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          return isUtf8 ? 'main\n' : Buffer.from('main\n')
        }
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse substrate/story-')) {
          return isUtf8 ? 'branchsha-advanced\n' : Buffer.from('branchsha-advanced\n')
        }
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse main')) {
          return isUtf8 ? 'startsha-unchanged\n' : Buffer.from('startsha-unchanged\n')
        }
        if (typeof cmd === 'string' && cmd.includes('--numstat')) {
          return isUtf8 ? '12\t3\tsrc/some-modified-file.ts\n' : Buffer.from('12\t3\tsrc/some-modified-file.ts\n')
        }
        return isUtf8 ? '' : Buffer.from('')
      },
    )
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
    // H0.1: default — nothing dirty to checkpoint. Checkpoint-path tests
    // override this to return a committed checkpoint.
    mockCheckpointStoryWorktree.mockResolvedValue({ status: 'no-changes' })
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
      // H0.1: commitDevStoryOutput now fires at dev-story end (commit-first)
      // AND at finalize — return no-changes for both so this test still
      // drives the finalize no-changes branch.
      mockCommitDevStoryOutput.mockResolvedValue({
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
      // H0.1: both the commit-first call and the finalize call fail — the
      // finalize `failed` branch escalates dev-story-commit-failed.
      mockCommitDevStoryOutput.mockResolvedValue({
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

  // ------------------------------------------------------------------------
  // H0.1 (hardening program) — commit-first + failure-path checkpoints
  // ------------------------------------------------------------------------

  describe('H0.1: commit-first discipline + wip checkpoints', () => {
    it('commits dev-story output to the branch BEFORE code-review runs (commit-first), then again at finalize', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      // Two commit sites: dev-story end (commit-first) + finalize.
      expect(mockCommitDevStoryOutput).toHaveBeenCalledTimes(2)
      // The FIRST commit call must precede the code-review dispatch — that is
      // the whole point: the branch is durable before anything else runs.
      const firstCommitOrder = mockCommitDevStoryOutput.mock.invocationCallOrder[0]!
      const reviewOrder = mockRunCodeReview.mock.invocationCallOrder[0]!
      expect(firstCommitOrder).toBeLessThan(reviewOrder)
    })

    it('falls back to a wip checkpoint when hooks reject the commit-first feat commit, and escalates dev-story-commit-failed at finalize when unresolved', async () => {
      const worktreeManager = createMockWorktreeManager()
      // commit-first: hooks reject; finalize: tree clean (no-changes) — the
      // hook complaint was never resolved.
      mockCommitDevStoryOutput
        .mockResolvedValueOnce({ status: 'failed', stderr: 'husky - pre-commit hook exited with code 1' })
        .mockResolvedValueOnce({ status: 'no-changes', reason: 'staging-produced-no-diff' })
      mockCheckpointStoryWorktree.mockResolvedValue({ status: 'committed', sha: 'wip-sha-1' })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      // Work was preserved as a hook-bypassed checkpoint...
      const checkpointReasons = mockCheckpointStoryWorktree.mock.calls.map((c) => String(c[1]))
      expect(checkpointReasons.some((r) => r.includes('deliverable commit rejected by hooks'))).toBe(true)
      // ...but the hook rejection blocks the merge and escalates.
      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('dev-story-commit-failed')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('checkpoints the worktree when a story escalates (emitEscalation path)', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockRunDevStory.mockRejectedValueOnce(new Error('agent exploded mid-dispatch'))
      mockCheckpointStoryWorktree.mockResolvedValue({ status: 'committed', sha: 'wip-sha-2' })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      // emitEscalation checkpointed the worktree with the escalation reason.
      expect(mockCheckpointStoryWorktree).toHaveBeenCalled()
      const [cpStoryKey, cpReason, cpDir] = mockCheckpointStoryWorktree.mock.calls[0] ?? []
      expect(cpStoryKey).toBe('e2e-1')
      expect(String(cpReason)).toContain('escalation:')
      expect(typeof cpDir).toBe('string')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('H1.8 (live-capture regression): create-story artifact outside the worktree escalates create-story-outside-project', async () => {
      const worktreeManager = createMockWorktreeManager()
      // The 2026-07-05 live capture: agent wrote to $HOME/_bmad-output/…
      mockRunCreateStory.mockResolvedValueOnce({
        ...makeCreateStorySuccess('e2e-1'),
        story_file: '/home/jplanow/_bmad-output/implementation-artifacts/e2e-1-add-farewell.md',
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('create-story-outside-project')
      expect(mockRunDevStory).not.toHaveBeenCalled()
    })

    it('H7: a RELATIVE story_file that escapes the worktree also escalates (H1.8 bypass fix)', async () => {
      const worktreeManager = createMockWorktreeManager({ worktreePath: '/wt/story-e2e-1' })
      // Relative traversal that resolves OUTSIDE the worktree — pre-fix this
      // skipped the isAbsolute()-gated containment check entirely.
      mockRunCreateStory.mockResolvedValueOnce({
        ...makeCreateStorySuccess('e2e-1'),
        story_file: '../../_bmad-output/implementation-artifacts/e2e-1.md',
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('create-story-outside-project')
      expect(mockRunDevStory).not.toHaveBeenCalled()
    })

    it('H7: a RELATIVE story_file INSIDE the worktree still passes (no false positive)', async () => {
      const worktreeManager = createMockWorktreeManager({ worktreePath: '/wt/story-e2e-1' })
      mockRunCreateStory.mockResolvedValueOnce({
        ...makeCreateStorySuccess('e2e-1'),
        story_file: '_bmad-output/implementation-artifacts/e2e-1.md',
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      // Relative-inside resolves within the worktree — the containment gate
      // must NOT fire; the story proceeds to dev-story.
      expect(status.stories['e2e-1']?.error).not.toBe('create-story-outside-project')
    })

    it('H1.4 (finding #13 regression): success story whose diff is spec-file-only escalates no-implementation', async () => {
      const worktreeManager = createMockWorktreeManager()
      // Ground-truth diff = ONLY the story spec artifact. Dev self-reports
      // success + tests pass (the vacuous "239 tests pass" shape).
      const checkGitDiffFilesMock = vi.mocked(
        (await import('../../agent-dispatch/dispatcher-impl.js')).checkGitDiffFiles,
      )
      checkGitDiffFilesMock.mockReturnValue([
        '_bmad-output/implementation-artifacts/e2e-1-mock.md',
      ])

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('no-implementation')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      // restore the module-wide default for subsequent tests
      checkGitDiffFilesMock.mockReturnValue(['src/some-modified-file.ts'])
    })

    it('H0.5 (finding #20): names parent-tree leaked files in the escalation when main is dirty', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockRunDevStory.mockRejectedValueOnce(new Error('agent died mid-dispatch'))
      // checkGitDiffFiles (mocked module-wide) reports the PARENT tree dirty —
      // the field-#20 shape: work landed in main, not the worktree.

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const warnCall = (emitMock.mock.calls as Array<[string, unknown]>).find(
        ([event, payload]) =>
          event === 'orchestrator:story-warn' &&
          String((payload as { msg?: string }).msg).includes('PARENT-TREE LEAK'),
      )
      expect(warnCall).toBeDefined()
      const msg = String((warnCall![1] as { msg: string }).msg)
      expect(msg).toContain('src/some-modified-file.ts')
      expect(msg).toContain('reconcile-from-disk')
    })

    it('checkpoints partial output when dev-story returns non-success before heading into review', async () => {
      const worktreeManager = createMockWorktreeManager()
      mockRunDevStory.mockResolvedValueOnce({ ...makeDevStorySuccess(), result: 'failed' as const })
      mockCheckpointStoryWorktree.mockResolvedValue({ status: 'committed', sha: 'wip-sha-3' })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      const checkpointReasons = mockCheckpointStoryWorktree.mock.calls.map((c) => String(c[1]))
      expect(checkpointReasons.some((r) => r.includes('dev-story partial output'))).toBe(true)
    })

    it('H0.2 (finding #1 regression): auto-approved story at cycle limit commits and merges exactly like SHIP_IT', async () => {
      const worktreeManager = createMockWorktreeManager()
      // Reviewer never converges past NEEDS_MINOR_FIXES → cycle limit →
      // final fix dispatch → auto-approve. Pre-H0.2 this path returned
      // without ever reaching the commit/merge block (income-sources
      // finding #1: outcome 'recovered', worktree dirty, branch at base).
      mockRunCodeReview.mockResolvedValue({
        verdict: 'NEEDS_MINOR_FIXES' as const,
        issues: 1,
        issue_list: [{ severity: 'minor', description: 'nit', file: 'src/mock.ts' }],
        tokenUsage: { input: 150, output: 50 },
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, maxReviewCycles: 2 }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      // The auto-approved story went through the SAME finalization: substrate
      // auto-commit fired and merge-to-main was enqueued.
      expect(mockCommitDevStoryOutput).toHaveBeenCalled()
      expect(mockEnqueueMerge).toHaveBeenCalledTimes(1)
    })

    it('proceeds to merge when finalize finds a clean tree but the branch already advanced past baseline (commit-first fall-through)', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      // `git rev-parse HEAD` (worktree cwd) — baseline capture gets 'base-sha';
      // the finalize advanced-check gets 'advanced-sha'. All other rev-parse
      // patterns keep their happy-path values.
      let headCalls = 0
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        const isUtf8 = opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
        const str = (v: string) => (isUtf8 ? `${v}\n` : Buffer.from(`${v}\n`))
        if (typeof cmd === 'string' && cmd.includes('git rev-parse --abbrev-ref HEAD')) return str('main')
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse substrate/story-')) return str('branchsha-advanced')
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse main')) return str('startsha-unchanged')
        if (typeof cmd === 'string' && cmd.startsWith('git rev-parse HEAD')) {
          headCalls += 1
          return str(headCalls === 1 ? 'base-sha' : 'advanced-sha')
        }
        if (typeof cmd === 'string' && cmd.includes('--numstat')) return str('12\t3\tsrc/some-modified-file.ts')
        return isUtf8 ? '' : Buffer.from('')
      })

      const worktreeManager = createMockWorktreeManager()
      // commit-first commits; finalize finds nothing left to commit.
      mockCommitDevStoryOutput
        .mockResolvedValueOnce({ status: 'committed', sha: 'feat-sha-early', filesStaged: ['src/mock.ts'] })
        .mockResolvedValueOnce({ status: 'no-changes', reason: 'staging-produced-no-diff' })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      // No dev-story-no-commit escalation — the work is on the branch.
      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------------------------
  // H3.1 + H3.2 — finalization modes + lifecycle events
  // ------------------------------------------------------------------------

  describe('H3.1/H3.2: finalization modes + lifecycle events', () => {
    /** Collect emitted event payloads by name from the fake event bus. */
    function emitted(name: string): unknown[] {
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      return emit.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
    }

    it('merge mode (default): emits story-committed, story-merged, story-finalized{mode:merge} around enqueueMerge', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).toHaveBeenCalledTimes(1)
      expect(emitted('orchestrator:story-committed')).toEqual([
        { storyKey: 'e2e-1', sha: 'autocommit-sha-abc123', branch: `${BRANCH_PREFIX}e2e-1` },
      ])
      expect(emitted('orchestrator:story-merged')).toEqual([
        { storyKey: 'e2e-1', sha: 'autocommit-sha-abc123', branch: `${BRANCH_PREFIX}e2e-1` },
      ])
      expect(emitted('orchestrator:story-finalized')).toEqual([
        { storyKey: 'e2e-1', mode: 'merge', branch: `${BRANCH_PREFIX}e2e-1`, sha: 'autocommit-sha-abc123' },
      ])
    })

    it('branch mode: story COMPLETE, enqueueMerge NOT called, worktree removed with keepBranch, finalized{mode:branch}', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, finalizationMode: 'branch' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      // Nothing self-merges — the branch is the deliverable.
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      expect(worktreeManager.cleanupWorktree).toHaveBeenCalledWith('e2e-1', { keepBranch: true })
      expect(emitted('orchestrator:story-committed')).toHaveLength(1)
      expect(emitted('orchestrator:story-merged')).toHaveLength(0)
      expect(emitted('orchestrator:story-finalized')).toEqual([
        { storyKey: 'e2e-1', mode: 'branch', branch: `${BRANCH_PREFIX}e2e-1`, sha: 'autocommit-sha-abc123' },
      ])
    })

    it('pr mode: pushes the branch, opens a PR, and emits finalized{mode:pr, prUrl}', async () => {
      const childProc = await import('node:child_process')
      const mockExecFile = childProc.execFileSync as ReturnType<typeof vi.fn>
      mockExecFile.mockImplementation((file: string, args?: string[]) => {
        if (file === 'gh' && args?.includes('create')) return 'https://github.com/acme/repo/pull/42\n'
        return '' // git push etc.
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, finalizationMode: 'pr' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      expect(worktreeManager.cleanupWorktree).toHaveBeenCalledWith('e2e-1', { keepBranch: true })
      expect(emitted('orchestrator:story-finalized')).toEqual([
        {
          storyKey: 'e2e-1',
          mode: 'pr',
          branch: `${BRANCH_PREFIX}e2e-1`,
          sha: 'autocommit-sha-abc123',
          prUrl: 'https://github.com/acme/repo/pull/42',
        },
      ])
    })

    it('pr mode degrades to branch semantics when git push fails: still COMPLETE, finalized without prUrl', async () => {
      const childProc = await import('node:child_process')
      const mockExecFile = childProc.execFileSync as ReturnType<typeof vi.fn>
      mockExecFile.mockImplementation((file: string, args?: string[]) => {
        if (file === 'git' && args?.[0] === 'push') throw new Error('fatal: no configured push destination')
        return ''
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, finalizationMode: 'pr' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      // PR failure never blocks the story — the branch is intact.
      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      expect(worktreeManager.cleanupWorktree).toHaveBeenCalledWith('e2e-1', { keepBranch: true })
      const finalized = emitted('orchestrator:story-finalized') as Array<{ mode: string; prUrl?: string }>
      expect(finalized).toHaveLength(1)
      expect(finalized[0]!.mode).toBe('pr')
      expect(finalized[0]!.prUrl).toBeUndefined()
    })
  })

  // ------------------------------------------------------------------------
  // H3.3 — merge preconditions + strategy threading + fatal start-branch
  // ------------------------------------------------------------------------

  describe('H3.3: merge strategy threading + fatal start-branch capture', () => {
    it('threads mergeStrategy ff-only (default) into enqueueMerge params', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      const params = mockEnqueueMerge.mock.calls[0]![0] as { mergeStrategy?: string }
      expect(params.mergeStrategy).toBe('ff-only')
    })

    it('threads mergeStrategy three-way from config into enqueueMerge params', async () => {
      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, mergeStrategy: 'three-way' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      await orchestrator.run(['e2e-1'])

      const params = mockEnqueueMerge.mock.calls[0]![0] as { mergeStrategy?: string }
      expect(params.mergeStrategy).toBe('three-way')
    })

    it('escalates with parent-tree-dirtied-by-run naming files when the merge phase reports it', async () => {
      mockEnqueueMerge.mockResolvedValue({
        success: false,
        reason: 'parent-tree-dirtied-by-run',
        dirtiedFiles: ['src/shared.ts'],
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
      expect(status.stories['e2e-1']?.error).toBe('parent-tree-dirtied-by-run')
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find((c) => c[0] === 'orchestrator:story-escalated')
      expect(esc).toBeDefined()
      const payload = esc![1] as { issues: string[] }
      expect(payload.issues.join(' ')).toContain('src/shared.ts')
    })

    it('escalates with ff-only-merge-not-possible and names the three-way remedy', async () => {
      mockEnqueueMerge.mockResolvedValue({
        success: false,
        reason: 'ff-only-merge-not-possible',
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
      expect(status.stories['e2e-1']?.error).toBe('ff-only-merge-not-possible')
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find((c) => c[0] === 'orchestrator:story-escalated')
      const payload = esc![1] as { issues: string[] }
      expect(payload.issues.join(' ')).toContain('merge_strategy: three-way')
    })

    it('AC3: start-branch capture failure is FATAL at run start (no dispatch) when worktrees are active', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      mockExec.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          throw new Error('fatal: not a git repository')
        }
        return ''
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.state).toBe('FAILED')
      // Nothing was dispatched — the failure happened before any story work.
      expect(mockRunCreateStory).not.toHaveBeenCalled()
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('H3.4: epic gate failure escalates epic-gate-failed and blocks the merge (branch preserved)', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      const baseImpl = mockExec.getMockImplementation()!
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        if (typeof cmd === 'string' && cmd === 'run-epic-gate') {
          const err = new Error('gate failed') as Error & { stdout?: string; stderr?: string }
          err.stdout = ''
          err.stderr = 'GATE-RED: epic suite failing'
          throw err
        }
        return baseImpl(cmd, opts)
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, epicGateCommand: 'run-epic-gate' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('epic-gate-failed')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find((c) => c[0] === 'orchestrator:story-escalated')
      const payload = esc![1] as { issues: string[] }
      expect(payload.issues.join(' ')).toContain('GATE-RED')
    })

    it('H3.4: epic gate pass lets the last story merge normally', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      const baseImpl = mockExec.getMockImplementation()!
      const gateCalls: string[] = []
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        if (typeof cmd === 'string' && cmd === 'run-epic-gate') {
          gateCalls.push(cmd)
          return ''
        }
        return baseImpl(cmd, opts)
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, epicGateCommand: 'run-epic-gate' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(gateCalls).toHaveLength(1)
      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).toHaveBeenCalledTimes(1)
    })

    it('H3.4: branch mode skips the epic gate entirely', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      const baseImpl = mockExec.getMockImplementation()!
      const gateCalls: string[] = []
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        if (typeof cmd === 'string' && cmd === 'run-epic-gate') {
          gateCalls.push(cmd)
          return ''
        }
        return baseImpl(cmd, opts)
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, epicGateCommand: 'run-epic-gate', finalizationMode: 'branch' }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(gateCalls).toHaveLength(0)
      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
    })

    it('H7: undisclosed committed implementation file blocks the merge (disclosure gate)', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      // Ground truth (baseline..HEAD) reports a file the dev agent did NOT
      // disclose in files_modified — the smuggle shape.
      const dispatcherMod = await import('../../agent-dispatch/dispatcher-impl.js')
      const checkGitDiffFilesMock = vi.mocked(dispatcherMod.checkGitDiffFiles)
      checkGitDiffFilesMock.mockReturnValue(['src/foo.ts', 'src/backdoor.ts'])
      const baseImpl = mockExec.getMockImplementation()!
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        if (typeof cmd === 'string' && cmd.includes('diff --name-only')) {
          return (opts?.encoding ? '' : Buffer.from(''))
        }
        return baseImpl(cmd, opts)
      })
      // Dev discloses only foo.ts.
      mockRunDevStory.mockResolvedValue({ ...makeDevStorySuccess(), files_modified: ['src/foo.ts'] })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('undisclosed-files-in-merge')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find((c) => c[0] === 'orchestrator:story-escalated')
      expect((esc![1] as { issues: string[] }).issues.join(' ')).toContain('src/backdoor.ts')
    })

    it('H7 hotfix (live-smoke): ABSOLUTE disclosed paths reconcile to relative git — no false undisclosed escalation', async () => {
      const worktreeManager = createMockWorktreeManager({ worktreePath: '/wt/story-e2e-1' })
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      const dispatcherMod = await import('../../agent-dispatch/dispatcher-impl.js')
      // Ground truth (git) is worktree-RELATIVE.
      vi.mocked(dispatcherMod.checkGitDiffFiles).mockReturnValue(['src/greeter/__init__.py'])
      const baseImpl = mockExec.getMockImplementation()!
      mockExec.mockImplementation((cmd: string, opts?: { encoding?: string }) => {
        if (typeof cmd === 'string' && cmd.includes('diff --name-only')) return opts?.encoding ? '' : Buffer.from('')
        return baseImpl(cmd, opts)
      })
      // Real-agent shape: dev discloses the SAME file as an ABSOLUTE worktree path.
      mockRunDevStory.mockResolvedValue({
        ...makeDevStorySuccess(),
        files_modified: ['/wt/story-e2e-1/src/greeter/__init__.py'],
      })

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      // The absolute disclosure must reconcile to the relative git path — the
      // story merges, NOT escalates undisclosed-files-in-merge.
      expect(status.stories['e2e-1']?.error).not.toBe('undisclosed-files-in-merge')
      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
    })

    it('H7 review (bug_012): auth failure surfacing during code-review escalates auth-failure (not code-review-exception)', async () => {
      // Pre-fix, H0.4's auth-halt was only wired into create-story/dev-story —
      // an auth death during code-review escalated as a generic exception and
      // the run never halted (the resume-case cascade).
      mockRunCodeReview.mockRejectedValueOnce(new Error('API Error: Invalid API key · Please run /login'))

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('ESCALATED')
      expect(status.stories['e2e-1']?.error).toBe('auth-failure')
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find(
        (c) => c[0] === 'orchestrator:story-escalated' && (c[1] as { lastVerdict?: string })?.lastVerdict === 'auth-failure',
      )
      expect(esc).toBeDefined()
    })

    it('AC3: start-branch capture failure stays non-fatal under --no-worktree', async () => {
      const childProc = await import('node:child_process')
      const mockExec = childProc.execSync as ReturnType<typeof vi.fn>
      mockExec.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          throw new Error('fatal: not a git repository')
        }
        return ''
      })

      const worktreeManager = createMockWorktreeManager()
      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: true }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })

      const status = await orchestrator.run(['e2e-1'])

      expect(status.stories['e2e-1']?.phase).toBe('COMPLETE')
    })
  })

  // ------------------------------------------------------------------------
  // A0.3 (acceptance-gate) — epic-close journey coverage audit
  // ------------------------------------------------------------------------

  describe('A0.3: journey coverage audit at epic close', () => {
    const REGISTRY_OK = {
      status: 'ok' as const,
      registry: {
        version: 1,
        journeys: [
          {
            id: 'UJ-1',
            title: 'Operator sees the report',
            criticality: 'critical' as const,
            surfaces: ['cli' as const],
            epic: 9,
            end_states: [{ id: 'UJ-1.a', given: 'g', walk: 'w', then: 't' }],
          },
        ],
      },
    }

    function makeOrchestrator(configOverrides?: Partial<OrchestratorConfig>) {
      const worktreeManager = createMockWorktreeManager()
      return createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus,
        config: baseConfig({ noWorktree: false, ...configOverrides }),
        projectRoot: '/path/to/project',
        worktreeManager,
      })
    }

    it('BLOCKING + unclaimed: the UJ-2 class — last story of the epic escalates journey-unclaimed, no merge', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1')) // untagged

      const status = await makeOrchestrator({ acceptanceMode: 'blocking' }).run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('ESCALATED')
      expect(status.stories['9-1']?.error).toBe('journey-unclaimed')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find(
        (c) => c[0] === 'orchestrator:story-escalated' && (c[1] as { lastVerdict?: string })?.lastVerdict === 'journey-unclaimed',
      )
      expect(esc).toBeDefined()
      const issues = (esc![1] as { issues: string[] }).issues.join(' ')
      expect(issues).toContain('UJ-1')
      expect(issues).toContain('NO story claims it')
      expect(issues).toContain('substrate acceptance defer')
    })

    it('BLOCKING + claimed-but-unwalked: escalates journey-unwalked (walk verdicts arrive with epic A2)', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockRunCreateStory.mockResolvedValue({ ...makeCreateStorySuccess('9-1'), journeys: ['UJ-1'] })

      const status = await makeOrchestrator({ acceptanceMode: 'blocking' }).run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('ESCALATED')
      expect(status.stories['9-1']?.error).toBe('journey-unwalked')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('ADVISORY (default): unclaimed journey warns via acceptance-coverage event, story still merges', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1'))

      const status = await makeOrchestrator().run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const coverage = emit.mock.calls.filter((c) => c[0] === 'orchestrator:acceptance-coverage')
      expect(coverage.length).toBeGreaterThan(0)
      const epicAudit = coverage.find((c) => (c[1] as { scope: string }).scope === 'epic-9')
      expect(epicAudit).toBeDefined()
      const payload = epicAudit![1] as { mode: string; entries: { journeyId: string; state: string }[] }
      expect(payload.mode).toBe('advisory')
      expect(payload.entries).toEqual([expect.objectContaining({ journeyId: 'UJ-1', state: 'unclaimed' })])
    })

    it('BLOCKING + deferred: operator deferral converts the violation to deferred — story merges', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockLoadJourneyDeferrals.mockResolvedValue({
        status: 'ok',
        deferrals: [{ journey: 'UJ-1', reason: 'post-MVP' }],
      })
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1'))

      const status = await makeOrchestrator({ acceptanceMode: 'blocking' }).run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('COMPLETE')
      expect(mockEnqueueMerge).toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const epicAudit = emit.mock.calls.find(
        (c) => c[0] === 'orchestrator:acceptance-coverage' && (c[1] as { scope: string }).scope === 'epic-9',
      )
      expect((epicAudit![1] as { entries: { state: string }[] }).entries[0]?.state).toBe('deferred')
    })

    it('run-end sweep: emits a final-scope coverage event covering epicless journeys', async () => {
      mockLoadJourneyRegistry.mockResolvedValue({
        status: 'ok',
        registry: {
          version: 1,
          journeys: [
            {
              id: 'UJ-7',
              title: 'Epicless journey (final-close audit only)',
              criticality: 'standard' as const,
              surfaces: ['cli' as const],
              end_states: [{ id: 'UJ-7.a', given: 'g', walk: 'w', then: 't' }],
            },
          ],
        },
      })
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1'))

      const status = await makeOrchestrator().run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('COMPLETE')
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const finalAudit = emit.mock.calls.find(
        (c) => c[0] === 'orchestrator:acceptance-coverage' && (c[1] as { scope: string }).scope === 'final',
      )
      expect(finalAudit).toBeDefined()
      const payload = finalAudit![1] as { entries: { journeyId: string; state: string }[]; summary: Record<string, number> }
      expect(payload.entries).toEqual([expect.objectContaining({ journeyId: 'UJ-7', state: 'unclaimed' })])
      expect(payload.summary['unclaimed']).toBe(1)
    })

    it('A1.1 BLOCKING + claimed journey + NO contract: escalates acceptance-unrunnable (claimed journeys can never be walked)', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockLoadAcceptanceContract.mockResolvedValue({ status: 'absent' })
      mockRunCreateStory.mockResolvedValue({ ...makeCreateStorySuccess('9-1'), journeys: ['UJ-1'] })

      const status = await makeOrchestrator({ acceptanceMode: 'blocking' }).run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('ESCALATED')
      expect(status.stories['9-1']?.error).toBe('acceptance-unrunnable')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      const esc = emit.mock.calls.find(
        (c) => c[0] === 'orchestrator:story-escalated' && (c[1] as { lastVerdict?: string })?.lastVerdict === 'acceptance-unrunnable',
      )
      expect((esc![1] as { issues: string[] }).issues.join(' ')).toContain('no acceptance: contract block')
    })

    it('A1.1 BLOCKING + UNCLAIMED + no contract: unclaimed stays the more specific verdict (contract-independent)', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockLoadAcceptanceContract.mockResolvedValue({ status: 'absent' })
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1')) // untagged

      const status = await makeOrchestrator({ acceptanceMode: 'blocking' }).run(['9-1'])

      expect(status.stories['9-1']?.error).toBe('journey-unclaimed')
    })

    it('A1.1 BLOCKING + INVALID committed registry: escalates acceptance-unrunnable naming the validation issues', async () => {
      mockLoadJourneyRegistry.mockResolvedValue({
        status: 'invalid',
        issues: [{ path: 'journeys.0.end_states', message: 'a journey must declare at least one end_state — a journey with none is unjudgeable' }],
      })
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1'))

      const status = await makeOrchestrator({ acceptanceMode: 'blocking' }).run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('ESCALATED')
      expect(status.stories['9-1']?.error).toBe('acceptance-unrunnable')
      expect(mockEnqueueMerge).not.toHaveBeenCalled()
    })

    it('acceptance.mode off: no audit, no coverage events', async () => {
      mockLoadJourneyRegistry.mockResolvedValue(REGISTRY_OK)
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('9-1'))

      const status = await makeOrchestrator({ acceptanceMode: 'off' }).run(['9-1'])

      expect(status.stories['9-1']?.phase).toBe('COMPLETE')
      expect(mockLoadJourneyRegistry).not.toHaveBeenCalled()
      const emit = eventBus.emit as ReturnType<typeof vi.fn>
      expect(emit.mock.calls.some((c) => c[0] === 'orchestrator:acceptance-coverage')).toBe(false)
    })
  })
})
