// @vitest-environment node
/**
 * Unit tests for status command manifest-read path — Story 52-6.
 *
 * AC1: status reads per-story state from manifest.per_story_state
 * AC4: falls back to existing wg_stories query when manifest is null
 * AC5: per-story counts match manifest data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RunManifestData } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockManifestRead,
  mockRunManifestConstructor,
  mockFsReadFile,
} = vi.hoisted(() => {
  const mockManifestRead = vi.fn()
  const mockRunManifestConstructor = vi.fn().mockImplementation(() => ({
    read: mockManifestRead,
  }))
  const mockFsReadFile = vi.fn()
  return { mockManifestRead, mockRunManifestConstructor, mockFsReadFile }
})

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock('@substrate-ai/sdlc', () => ({
  RunManifest: mockRunManifestConstructor,
}))

vi.mock('fs/promises', () => ({
  readFile: mockFsReadFile,
}))

// Mock DB adapter
const mockAdapter = {
  query: vi.fn().mockResolvedValue([]),
  exec: vi.fn().mockResolvedValue(undefined),
  transaction: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  backendType: 'sqlite' as const,
}

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapter),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

// Mock WorkGraphRepository
vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(),
  WorkGraphRepository: vi.fn().mockImplementation(() => ({
    getReadyStories: vi.fn().mockResolvedValue([]),
    getBlockedStories: vi.fn().mockResolvedValue([]),
  })),
}))

// Mock fs (sync) for current-run-id check in status.ts
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(''),
}))

// Mock story metrics and token queries
vi.mock('../../../persistence/queries/metrics.js', () => ({
  getStoryMetricsForRun: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getLatestRun: vi.fn().mockResolvedValue(undefined),
  getPipelineRunById: vi.fn(),
  // getTokenUsageSummary returns TokenUsageSummary[] (an array)
  getTokenUsageSummary: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { runStatusAction } from '../status.js'
import { getPipelineRunById, getLatestRun } from '../../../persistence/queries/decisions.js'

/** Build a stub RunManifestData with the given per_story_state */
function makeManifestData(
  perStoryState: RunManifestData['per_story_state'],
): RunManifestData {
  return {
    run_id: 'test-run-id',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: perStoryState,
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
  }
}

/** Build a minimal PipelineRun row */
function makeRun(id = 'test-run-id', status = 'running') {
  return {
    id,
    status,
    methodology: 'bmad',
    current_phase: 'implementation',
    config_json: JSON.stringify({ phaseHistory: [] }),
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
  }
}

// Capture stdout writes
function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
    output.push(String(data))
    return true
  })
  return {
    output,
    restore: () => spy.mockRestore(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('status command — manifest-read path (Story 52-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: DB returns a run
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getPipelineRunById).mockResolvedValue(makeRun() as any)
    vi.mocked(getLatestRun).mockResolvedValue(undefined)
    // Default: fs readFile (fs/promises) throws ENOENT — no current-run-id
    mockFsReadFile.mockRejectedValue(new Error('ENOENT'))
    // Default adapter queries return empty array
    mockAdapter.query.mockResolvedValue([])
  })

  describe('AC1, AC5: manifest available — workGraph built from per_story_state', () => {
    it('derives per-story counts (1 complete, 1 dispatched, 1 escalated) from manifest', async () => {
      // Arrange: manifest with 3 stories
      const manifestData = makeManifestData({
        '1-1': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' },
        '1-2': { status: 'dispatched', phase: 'IN_DEV', started_at: '2026-01-01T00:05:00Z' },
        '1-3': { status: 'escalated', phase: 'ESCALATED', started_at: '2026-01-01T00:03:00Z', completed_at: '2026-01-01T00:08:00Z' },
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const { output, restore } = captureStdout()
      try {
        const exitCode = await runStatusAction({
          outputFormat: 'json',
          runId: 'test-run-id',
          projectRoot: '/tmp/test-project',
        })
        expect(exitCode).toBe(0)

        // Combine all output and parse
        // Note: formatOutput wraps in { success: true, data: ... }
        const json = JSON.parse(output.join(''))
        expect(json.data.workGraph).not.toBeNull()
        expect(json.data.workGraph.summary.complete).toBe(1)   // '1-1' complete
        expect(json.data.workGraph.summary.inProgress).toBe(1)  // '1-2' dispatched → inProgress
        expect(json.data.workGraph.summary.escalated).toBe(1)   // '1-3' escalated
      } finally {
        restore()
      }
    })

    it('maps all manifest status strings correctly', async () => {
      // Arrange: manifest covering all status types
      const manifestData = makeManifestData({
        'a': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
        'b': { status: 'failed', phase: 'FAILED', started_at: '2026-01-01T00:00:00Z' },
        'c': { status: 'verification-failed', phase: 'FAILED', started_at: '2026-01-01T00:00:00Z' },
        'd': { status: 'escalated', phase: 'ESCALATED', started_at: '2026-01-01T00:00:00Z' },
        'e': { status: 'pending', phase: 'PENDING', started_at: '2026-01-01T00:00:00Z' },
        'f': { status: 'gated', phase: 'GATED', started_at: '2026-01-01T00:00:00Z' },
        'g': { status: 'in-review', phase: 'IN_REVIEW', started_at: '2026-01-01T00:00:00Z' },
        'h': { status: 'recovered', phase: 'RECOVERED', started_at: '2026-01-01T00:00:00Z' },
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const { output, restore } = captureStdout()
      try {
        await runStatusAction({
          outputFormat: 'json',
          runId: 'test-run-id',
          projectRoot: '/tmp/test-project',
        })
        const json = JSON.parse(output.join(''))
        // Note: formatOutput wraps in { success: true, data: ... }
        const summary = json.data.workGraph.summary
        expect(summary.complete).toBe(1)    // 'a'
        expect(summary.failed).toBe(2)      // 'b', 'c'
        expect(summary.escalated).toBe(1)   // 'd'
        expect(summary.ready).toBe(2)       // 'e' (pending), 'f' (gated)
        expect(summary.inProgress).toBe(2)  // 'g' (in-review), 'h' (recovered)
      } finally {
        restore()
      }
    })
  })

  describe('AC4: manifest null — falls back to wg_stories query', () => {
    it('queries wg_stories when RunManifest constructor throws', async () => {
      // Arrange: make RunManifest.read() throw (simulates missing manifest)
      mockRunManifestConstructor.mockImplementationOnce(() => ({
        read: vi.fn().mockRejectedValue(new Error('manifest not found')),
      }))

      // Track if wg_stories was queried
      let wgStoriesQueried = false
      mockAdapter.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('wg_stories')) {
          wgStoriesQueried = true
        }
        return []
      })

      const { output, restore } = captureStdout()
      try {
        await runStatusAction({
          outputFormat: 'json',
          runId: 'test-run-id',
          projectRoot: '/tmp/test-project',
        })
      } finally {
        restore()
      }

      // Verify wg_stories was queried as fallback
      expect(wgStoriesQueried).toBe(true)
    })

    it('queries wg_stories when RunManifest constructor is not called (no run ID scenario)', async () => {
      // Arrange: no run found from DB, no manifest
      vi.mocked(getPipelineRunById).mockResolvedValue(undefined)
      // No manifest constructor call expected since run is undefined

      let wgStoriesQueried = false
      mockAdapter.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('wg_stories')) {
          wgStoriesQueried = true
        }
        return []
      })

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        await runStatusAction({
          outputFormat: 'human',
          runId: 'test-run-id',
          projectRoot: '/tmp/test-project',
        })
      } finally {
        stderrSpy.mockRestore()
      }

      // wg_stories is still queried when no manifest (run is undefined case)
      expect(wgStoriesQueried).toBe(true)
    })
  })

  describe('AC5: consistent story counts', () => {
    it('workGraph counts exactly match manifest per_story_state entries', async () => {
      const manifestData = makeManifestData({
        '52-1': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
        '52-2': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
        '52-3': { status: 'escalated', phase: 'ESCALATED', started_at: '2026-01-01T00:00:00Z' },
        '52-4': { status: 'in-review', phase: 'IN_REVIEW', started_at: '2026-01-01T00:00:00Z' },
        '52-5': { status: 'pending', phase: 'PENDING', started_at: '2026-01-01T00:00:00Z' },
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const { output, restore } = captureStdout()
      try {
        await runStatusAction({
          outputFormat: 'json',
          runId: 'test-run-id',
          projectRoot: '/tmp/test-project',
        })
        const json = JSON.parse(output.join(''))
        // Note: formatOutput wraps in { success: true, data: ... }
        const summary = json.data.workGraph.summary
        // Verify exact match with manifest entries
        expect(summary.complete).toBe(2)   // 52-1, 52-2
        expect(summary.escalated).toBe(1)  // 52-3
        expect(summary.inProgress).toBe(1) // 52-4 (in-review → inProgress)
        expect(summary.ready).toBe(1)      // 52-5 (pending → ready)
        // No failed stories
        expect(summary.failed ?? 0).toBe(0)
      } finally {
        restore()
      }
    })
  })
})
