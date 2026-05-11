/**
 * Tests for merge-to-main.ts — merge-to-main phase handler.
 *
 * Tests all merge strategies (AC8a–AC8e):
 *   a. FF-merge happy path: branch ahead of main → FF succeeds → cleanup called
 *   b. 3-way merge path: main moved during story → 3-way succeeds → cleanup called
 *   c. Conflict path: main edited same lines → merge fails → worktree preserved,
 *      story ESCALATED with merge-conflict-detected reason
 *   d. Sequential merge serialization: two concurrent calls serialize correctly
 *   e. Event emission: pipeline:merge-conflict-detected includes correct conflictingFiles
 *
 * References:
 *  - Story 75-1: worktree creation phase (creates the branch merged here)
 *  - Story 75-2: merge-to-main phase architecture (this file)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// execSync mock — must be declared before module imports
// ---------------------------------------------------------------------------

// Track execSync call sequence and configure per-call responses
type ExecSyncConfig =
  | { mode: 'success'; output?: string }
  | { mode: 'throw'; error: Error }

const execSyncCallQueue: ExecSyncConfig[] = []
let execSyncCalls: string[] = []

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((file: string, args?: string[], _opts?: object): string => {
    // Reconstruct a human-readable command string for assertion convenience
    const cmd = [file, ...(args ?? [])].join(' ')
    execSyncCalls.push(cmd)
    const config = execSyncCallQueue.shift()
    if (config === undefined) {
      // Default: success with empty output
      return ''
    }
    if (config.mode === 'throw') {
      throw config.error
    }
    return config.output ?? ''
  }),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { runMergeToMain, createMergeQueue } from '../merge-to-main.js'
import type { MergeToMainParams, MergeToMainResult } from '../merge-to-main.js'
import type { GitWorktreeManager } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock GitWorktreeManager */
function createMockWorktreeManager(): GitWorktreeManager & {
  cleanupWorktreeCallArgs: string[]
  cleanupWorktreeShouldThrow?: Error
} {
  const callArgs: string[] = []
  let shouldThrow: Error | undefined
  return {
    cleanupWorktreeCallArgs: callArgs,
    get cleanupWorktreeShouldThrow() { return shouldThrow },
    set cleanupWorktreeShouldThrow(e: Error | undefined) { shouldThrow = e },
    cleanupWorktree: vi.fn(async (taskId: string) => {
      callArgs.push(taskId)
      if (shouldThrow) throw shouldThrow
    }),
    createWorktree: vi.fn(),
    cleanupAllWorktrees: vi.fn(),
    getWorktreePath: vi.fn(() => '/tmp/worktree'),
    verifyGitVersion: vi.fn(),
    detectConflicts: vi.fn(),
    mergeWorktree: vi.fn(),
    listWorktrees: vi.fn(),
    // IBaseService
    initialize: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as GitWorktreeManager & { cleanupWorktreeCallArgs: string[]; cleanupWorktreeShouldThrow?: Error }
}

/** Create a mock TypedEventBus */
function createMockEventBus(): { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() }
}

/** Build a standard set of MergeToMainParams */
function makeParams(
  overrides?: Partial<MergeToMainParams>,
): MergeToMainParams & { worktreeManager: ReturnType<typeof createMockWorktreeManager> } {
  const worktreeManager = createMockWorktreeManager()
  return {
    storyKey: '75-2',
    branchName: 'substrate/story-75-2',
    startBranch: 'main',
    worktreeManager,
    eventBus: createMockEventBus() as never,
    projectRoot: '/tmp/repo',
    ...overrides,
  } as MergeToMainParams & { worktreeManager: ReturnType<typeof createMockWorktreeManager> }
}

/** Queue a successful execSync response */
function queueSuccess(output = ''): void {
  execSyncCallQueue.push({ mode: 'success', output })
}

/** Queue a throwing execSync response */
function queueThrow(msg = 'git error'): void {
  const err = new Error(msg)
  ;(err as NodeJS.ErrnoException).status = 128
  execSyncCallQueue.push({ mode: 'throw', error: err })
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  execSyncCallQueue.length = 0
  execSyncCalls = []
  vi.clearAllMocks()
})

afterEach(() => {
  // Drain any leftover queue entries to prevent cross-test leakage
  execSyncCallQueue.length = 0
})

// ---------------------------------------------------------------------------
// AC8a: FF-merge happy path
// ---------------------------------------------------------------------------

describe('AC8a: FF-merge happy path', () => {
  it('calls cleanupWorktree on successful FF merge; cleanupWorktree owns branch deletion (no explicit branch -d from merge-to-main)', async () => {
    const params = makeParams()

    // FF merge succeeds (exit 0)
    queueSuccess()

    const result = await runMergeToMain(params)

    expect(result.success).toBe(true)
    expect(result.reason).toBeUndefined()

    // cleanupWorktree called with storyKey as taskId — this is the SINGLE
    // source of truth for both worktree dir removal AND branch deletion
    // (v0.20.88 cleanup of obs_028 follow-up: pre-fix, merge-to-main ran an
    // additional `git branch -d` after cleanupWorktree, which always failed
    // with "branch not found" and produced noisy warnings).
    expect(params.worktreeManager.cleanupWorktreeCallArgs).toContain('75-2')

    // merge-to-main no longer issues `git branch -d` directly
    const deleteBranchCall = execSyncCalls.find((c) => c.includes('branch -d'))
    expect(deleteBranchCall).toBeUndefined()
  })

  it('FF merge invokes git merge --ff-only with the correct branch name', async () => {
    const params = makeParams()

    queueSuccess()
    queueSuccess()

    await runMergeToMain(params)

    const ffCall = execSyncCalls.find((c) => c.includes('--ff-only'))
    expect(ffCall).toBeDefined()
    expect(ffCall).toContain('substrate/story-75-2')
  })

  it('does NOT emit pipeline:merge-conflict-detected on FF success', async () => {
    const eventBus = createMockEventBus()
    const params = makeParams({ eventBus: eventBus as never })

    queueSuccess()
    queueSuccess()

    await runMergeToMain(params)

    const conflictEmit = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => call[0] === 'pipeline:merge-conflict-detected',
    )
    expect(conflictEmit).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC8b: 3-way merge path
// ---------------------------------------------------------------------------

describe('AC8b: 3-way merge path — main moved during story', () => {
  it('falls back to 3-way merge when FF fails and 3-way succeeds', async () => {
    const params = makeParams()

    // FF merge FAILS (branch diverged)
    queueThrow('fatal: Not possible to fast-forward, aborting.')
    // 3-way merge succeeds
    queueSuccess()
    // Branch delete succeeds
    queueSuccess()

    const result = await runMergeToMain(params)

    expect(result.success).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('calls cleanupWorktree after successful 3-way merge; cleanupWorktree owns branch deletion (no explicit branch -d from merge-to-main)', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueSuccess() // 3-way succeeds

    await runMergeToMain(params)

    expect(params.worktreeManager.cleanupWorktreeCallArgs).toContain('75-2')

    // merge-to-main no longer issues `git branch -d` directly (v0.20.88)
    const deleteBranchCall = execSyncCalls.find((c) => c.includes('branch -d'))
    expect(deleteBranchCall).toBeUndefined()
  })

  it('3-way merge uses git merge --no-edit (not --ff-only)', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueSuccess() // 3-way succeeds
    queueSuccess() // branch delete

    await runMergeToMain(params)

    const threeWayCall = execSyncCalls.find((c) => c.includes('--no-edit'))
    expect(threeWayCall).toBeDefined()
    expect(threeWayCall).not.toContain('--ff-only')
  })
})

// ---------------------------------------------------------------------------
// AC8c: Conflict path
// ---------------------------------------------------------------------------

describe('AC8c: Conflict path — both branches edit same lines', () => {
  it('returns success=false with reason merge-conflict-detected on conflict', async () => {
    const params = makeParams()

    // FF fails
    queueThrow('ff failed')
    // 3-way fails (conflict)
    queueThrow('CONFLICT (content): Merge conflict in shared.ts')
    // git diff --name-only --diff-filter=U
    queueSuccess('shared.ts\n')
    // git merge --abort
    queueSuccess()

    const result: MergeToMainResult = await runMergeToMain(params)

    expect(result.success).toBe(false)
    expect(result.reason).toBe('merge-conflict-detected')
  })

  it('does NOT call cleanupWorktree on conflict', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('shared.ts\n')
    queueSuccess()

    await runMergeToMain(params)

    expect(params.worktreeManager.cleanupWorktreeCallArgs).toHaveLength(0)
  })

  it('does NOT call git branch -d on conflict', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('shared.ts\n')
    queueSuccess()

    await runMergeToMain(params)

    const deleteBranchCall = execSyncCalls.find((c) => c.includes('branch -d'))
    expect(deleteBranchCall).toBeUndefined()
  })

  it('aborts the in-progress merge on conflict', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('shared.ts\n')
    queueSuccess() // git merge --abort

    await runMergeToMain(params)

    const abortCall = execSyncCalls.find((c) => c.includes('merge --abort'))
    expect(abortCall).toBeDefined()
  })

  it('populates conflictingFiles from git diff --name-only --diff-filter=U', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('shared.ts\nother.ts\n')
    queueSuccess()

    const result = await runMergeToMain(params)

    expect(result.conflictingFiles).toEqual(['shared.ts', 'other.ts'])
  })

  it('handles single conflicting file correctly', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('only-file.ts\n')
    queueSuccess()

    const result = await runMergeToMain(params)

    expect(result.conflictingFiles).toEqual(['only-file.ts'])
  })
})

// ---------------------------------------------------------------------------
// AC8d: Sequential merge serialization
// ---------------------------------------------------------------------------

describe('AC8d: Sequential merge serialization', () => {
  it('serializes two concurrent calls through the createMergeQueue mutex', async () => {
    // createMergeQueue implements the same Promise-chain mutex used by the
    // orchestrator's enqueueMerge. Two concurrent calls to the returned function
    // must execute strictly sequentially — the second starts only after the first
    // fully resolves (including all async cleanup operations).
    const enqueueMerge = createMergeQueue()
    const log: string[] = []

    const params1 = makeParams({ storyKey: '75-2', branchName: 'substrate/story-75-2' })
    const params2 = makeParams({ storyKey: '75-3', branchName: 'substrate/story-75-3' })

    // First merge introduces a 10ms async pause inside cleanupWorktree.
    // Without the mutex, p2's cleanup would start during that 10ms window
    // and the log would interleave: [start-75-2, start-75-3, end-75-2, end-75-3].
    // With the mutex, p2 waits for p1 to fully complete first.
    ;(params1.worktreeManager.cleanupWorktree as ReturnType<typeof vi.fn>).mockImplementation(
      async (taskId: string) => {
        log.push(`cleanup-start-${taskId}`)
        await new Promise<void>((r) => setTimeout(r, 10))
        log.push(`cleanup-end-${taskId}`)
      },
    )
    ;(params2.worktreeManager.cleanupWorktree as ReturnType<typeof vi.fn>).mockImplementation(
      async (taskId: string) => {
        log.push(`cleanup-start-${taskId}`)
        log.push(`cleanup-end-${taskId}`)
      },
    )

    // Queue git commands for two sequential FF merges
    queueSuccess() // p1: FF merge
    queueSuccess() // p1: branch delete
    queueSuccess() // p2: FF merge
    queueSuccess() // p2: branch delete

    // Launch both simultaneously through the shared queue
    const [r1, r2] = await Promise.all([enqueueMerge(params1), enqueueMerge(params2)])

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)

    // Serialized: p1 fully completes (including its 10ms async cleanup)
    // before p2's cleanup even starts.
    expect(log).toEqual([
      'cleanup-start-75-2',
      'cleanup-end-75-2',
      'cleanup-start-75-3',
      'cleanup-end-75-3',
    ])
  })
})

// ---------------------------------------------------------------------------
// AC8e: Event emission
// ---------------------------------------------------------------------------

describe('AC8e: Event emission — pipeline:merge-conflict-detected', () => {
  it('emits pipeline:merge-conflict-detected on conflict with correct fields', async () => {
    const eventBus = createMockEventBus()
    const params = makeParams({
      storyKey: '75-2',
      branchName: 'substrate/story-75-2',
      eventBus: eventBus as never,
    })

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('shared.ts\nutils.ts\n')
    queueSuccess()

    await runMergeToMain(params)

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const conflictCall = emitCalls.find((call: unknown[]) => call[0] === 'pipeline:merge-conflict-detected')
    expect(conflictCall).toBeDefined()

    const payload = conflictCall![1] as {
      storyKey: string
      branchName: string
      conflictingFiles: string[]
    }
    expect(payload.storyKey).toBe('75-2')
    expect(payload.branchName).toBe('substrate/story-75-2')
    expect(payload.conflictingFiles).toEqual(['shared.ts', 'utils.ts'])
  })

  it('does NOT emit pipeline:merge-conflict-detected on FF success', async () => {
    const eventBus = createMockEventBus()
    const params = makeParams({ eventBus: eventBus as never })

    queueSuccess()
    queueSuccess()

    await runMergeToMain(params)

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const conflictCall = emitCalls.find((call: unknown[]) => call[0] === 'pipeline:merge-conflict-detected')
    expect(conflictCall).toBeUndefined()
  })

  it('does NOT emit pipeline:merge-conflict-detected on 3-way success', async () => {
    const eventBus = createMockEventBus()
    const params = makeParams({ eventBus: eventBus as never })

    queueThrow('ff failed')
    queueSuccess() // 3-way succeeds
    queueSuccess() // branch delete

    await runMergeToMain(params)

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const conflictCall = emitCalls.find((call: unknown[]) => call[0] === 'pipeline:merge-conflict-detected')
    expect(conflictCall).toBeUndefined()
  })

  it('includes empty conflictingFiles array when git diff --name-only returns empty', async () => {
    const eventBus = createMockEventBus()
    const params = makeParams({ eventBus: eventBus as never })

    queueThrow('ff failed')
    queueThrow('conflict')
    queueSuccess('') // empty diff output
    queueSuccess()

    await runMergeToMain(params)

    const emitCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const conflictCall = emitCalls.find((call: unknown[]) => call[0] === 'pipeline:merge-conflict-detected')
    expect(conflictCall).toBeDefined()

    const payload = conflictCall![1] as { conflictingFiles: string[] }
    expect(payload.conflictingFiles).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles worktree cleanup failure gracefully (merge still succeeds; cleanupWorktree owns branch deletion so its failure also covers branch-delete failure)', async () => {
    const params = makeParams()
    // Make cleanupWorktree throw
    params.worktreeManager.cleanupWorktreeShouldThrow = new Error('cleanup failed')

    queueSuccess() // FF succeeds

    // Should not throw — cleanup failure is best-effort. cleanupWorktree
    // also handles branch deletion internally, so a single failure path
    // covers both worktree-dir cleanup AND branch-delete failure (the
    // pre-v0.20.88 separate `git branch -d` test below was redundant +
    // tested a code path that no longer exists).
    const result = await runMergeToMain(params)
    expect(result.success).toBe(true)
  })

  it('handles git diff --name-only failure gracefully during conflict', async () => {
    const params = makeParams()

    queueThrow('ff failed')
    queueThrow('conflict')
    queueThrow('git diff failed') // diff command fails
    queueSuccess() // merge --abort

    const result = await runMergeToMain(params)

    // Should still return conflict result with empty files list
    expect(result.success).toBe(false)
    expect(result.reason).toBe('merge-conflict-detected')
    expect(result.conflictingFiles).toEqual([])
  })
})
