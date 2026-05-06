/**
 * Integration test for cross-story race recovery — Story 70-1 (AC10).
 *
 * Uses a real temporary git fixture to validate:
 *   - CommittedAtResolver correctly resolves feat(story-X): commit timestamps
 *   - detectStaleVerifications detects the race with real timestamps
 *   - runStaleVerificationRecovery runs recovery and transitions story A to complete
 *
 * Per Story 65-5/67-2/69-2 discipline: real git init in isolated tmpdir; real commit
 * history; verification pipeline mocked so tests don't require a real build environment.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockPipelineRun, mockCreatePipeline } = vi.hoisted(() => {
  const mockPipelineRun = vi.fn()
  const mockCreatePipeline = vi.fn(() => ({
    run: mockPipelineRun,
    register: vi.fn(),
  }))
  return { mockPipelineRun, mockCreatePipeline }
})

// ---------------------------------------------------------------------------
// Mock verification pipeline — tests run without a real build environment
// ---------------------------------------------------------------------------

vi.mock('@substrate-ai/sdlc/verification/verification-pipeline.js', async () => {
  return {
    createDefaultVerificationPipeline: mockCreatePipeline,
  }
})

// Alternatively, mock the internal path used by the sdlc package
vi.mock('../../packages/sdlc/src/verification/verification-pipeline.js', async () => {
  return {
    createDefaultVerificationPipeline: mockCreatePipeline,
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { RunManifest } from '@substrate-ai/sdlc'
import {
  detectStaleVerifications,
  runStaleVerificationRecovery,
  CommittedAtResolver,
} from '@substrate-ai/sdlc'
import type { BatchEntry, StaleVerificationRecoveryInput } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Initialize a real git repo in the given directory.
 */
function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email test@example.com', { cwd: dir })
  execSync('git config user.name test', { cwd: dir })
  execSync('git commit --allow-empty -qm "initial"', { cwd: dir })
}

/**
 * Write a per-run manifest to the canonical .substrate/runs/<runId>.json path.
 */
async function writeRunManifest(
  dir: string,
  runId: string,
  perStoryState: Record<string, unknown>,
): Promise<void> {
  const runsDir = join(dir, '.substrate', 'runs')
  await mkdir(runsDir, { recursive: true })
  const manifest = {
    run_id: runId,
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: perStoryState,
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: new Date(Date.now() - 120_000).toISOString(),
    updated_at: new Date().toISOString(),
  }
  await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(manifest, null, 2))
}

function makeBusMock() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeAdapterMock() {
  return {
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    backendType: 'memory' as const,
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('cross-story race recovery integration', () => {
  let tmpDir: string

  afterEach(async () => {
    vi.clearAllMocks()
    try {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('detects race with real git commits and recovers story A to complete', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cross-story-race-test-'))

    // Initialize a real git repo
    initGitRepo(tmpDir)

    // Story keys must match the feat(story-<key>): commit pattern used by CommittedAtResolver.
    // Use '70-A' and '70-B' so the git log grep matches the commits below.
    const STORY_A_KEY = '70-A'
    const STORY_B_KEY = '70-B'

    // Create the shared test file and story A's commit
    await writeFile(join(tmpDir, 'shared.test.ts'), '// shared test file\n')
    execSync('git add .', { cwd: tmpDir })
    execSync(`git commit -qm "feat(story-${STORY_A_KEY}): implement story A"`, { cwd: tmpDir })
    const aCommitDate = execSync(
      `git log --format=%cI --grep="feat(story-${STORY_A_KEY}):" -1`,
      { cwd: tmpDir, encoding: 'utf-8' },
    ).trim()
    expect(aCommitDate).toMatch(/\d{4}-\d{2}-\d{2}/)

    // Story B commits AFTER story A
    await writeFile(join(tmpDir, 'shared.test.ts'), '// shared test file\n// B change\n')
    execSync('git add .', { cwd: tmpDir })
    execSync(`git commit -qm "feat(story-${STORY_B_KEY}): implement story B"`, { cwd: tmpDir })
    const bCommitDate = execSync(
      `git log --format=%cI --grep="feat(story-${STORY_B_KEY}):" -1`,
      { cwd: tmpDir, encoding: 'utf-8' },
    ).trim()
    expect(bCommitDate).toMatch(/\d{4}-\d{2}-\d{2}/)

    // Both commit dates must be resolvable
    expect(aCommitDate.length).toBeGreaterThan(0)
    expect(bCommitDate.length).toBeGreaterThan(0)

    // Verify CommittedAtResolver works correctly with the real commits
    const aResolved = CommittedAtResolver(STORY_A_KEY, tmpDir)
    const bResolved = CommittedAtResolver(STORY_B_KEY, tmpDir)
    expect(aResolved).toBe(aCommitDate)
    expect(bResolved).toBe(bCommitDate)

    // Set up A's verifiedAt: backdated 10 seconds before B committed.
    // This simulates A verifying BEFORE B's commit landed (the race condition).
    const aVerifiedAt = new Date(new Date(bCommitDate).getTime() - 10_000).toISOString()

    // Set up the run manifest with the correct story keys
    const runId = 'integration-run-001'
    await writeRunManifest(tmpDir, runId, {
      [STORY_A_KEY]: {
        status: 'complete',
        phase: 'DONE',
        started_at: new Date(Date.now() - 120_000).toISOString(),
        completed_at: aVerifiedAt, // A's recorded verification time (before B committed)
        dev_story_signals: { files_modified: ['shared.test.ts'] },
        verification_result: {
          storyKey: STORY_A_KEY,
          checks: [{ checkName: 'BuildCheck', status: 'pass', details: 'ok', duration_ms: 100 }],
          status: 'pass',
          duration_ms: 100,
        },
      },
      [STORY_B_KEY]: {
        status: 'complete',
        phase: 'DONE',
        started_at: new Date(Date.now() - 60_000).toISOString(),
        completed_at: bCommitDate,
        dev_story_signals: { files_modified: ['shared.test.ts'] }, // B also touched shared.test.ts
      },
    })

    // Direct stale detection with pre-resolved data
    const batchForDetection: BatchEntry[] = [
      {
        storyKey: STORY_A_KEY,
        verifiedAt: aVerifiedAt,
        committedAt: aCommitDate,
        modifiedFiles: ['shared.test.ts'],
        testFiles: [],
      },
      {
        storyKey: STORY_B_KEY,
        committedAt: bCommitDate,
        modifiedFiles: ['shared.test.ts'],
      },
    ]

    // Confirm the race detection works with real timestamps
    const staleKeys = detectStaleVerifications(batchForDetection, {})
    expect(staleKeys).toContain(STORY_A_KEY)

    // Now run the full recovery using the RunManifest and real git repo
    const runsDir = join(tmpDir, '.substrate', 'runs')
    const runManifest = new RunManifest(runId, runsDir)

    // Fresh verification passes (mocked — no real build environment)
    mockPipelineRun.mockResolvedValue({
      storyKey: STORY_A_KEY,
      checks: [{ checkName: 'BuildCheck', status: 'pass', details: 'ok', duration_ms: 50 }],
      status: 'pass',
      duration_ms: 50,
    })

    const bus = makeBusMock()

    // Recovery batch: A has backdated verifiedAt; B provides its modifiedFiles.
    // The recovery function resolves committedAt for each story via git log using
    // the canonical feat(story-<key>): pattern.
    const recoveryBatch: BatchEntry[] = [
      {
        storyKey: STORY_A_KEY,
        verifiedAt: aVerifiedAt, // backdated: 10s before B committed
      },
      {
        storyKey: STORY_B_KEY,
        modifiedFiles: ['shared.test.ts'], // explicit — manifest fallback also works
      },
    ]

    const input: StaleVerificationRecoveryInput = {
      runId,
      batch: recoveryBatch,
      workingDir: tmpDir,
      bus: bus as never,
      manifest: runManifest,
      adapter: makeAdapterMock() as never,
    }

    const result = await runStaleVerificationRecovery(input)

    // Recovery should have found stale story A and re-verified it
    expect(result.noStale).toBe(false)
    expect(result.recovered).toContain(STORY_A_KEY)
    expect(result.stillFailed).toHaveLength(0)

    // pipeline:cross-story-race-recovered event must be emitted
    expect(bus.emit).toHaveBeenCalledWith(
      'pipeline:cross-story-race-recovered',
      expect.objectContaining({ runId, storyKey: STORY_A_KEY }),
    )

    // Read the manifest and verify A is now marked complete
    const updatedData = await runManifest.read()
    const storyAState = updatedData.per_story_state[STORY_A_KEY]
    expect(storyAState?.status).toBe('complete')
  })
})
