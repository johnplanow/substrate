// @vitest-environment node
/**
 * Unit tests for health command manifest-read path — Story 52-6.
 *
 * AC2: health reads supervisor ownership and per-story counts from manifest
 * AC4: health falls back to existing process inspection when no manifest
 * AC5: per-story progress counts are consistent with manifest data
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
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-health-project'),
}))

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
  }
})

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getLatestRun: vi.fn().mockResolvedValue(undefined),
  getPipelineRunById: vi.fn(),
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

import { getAutoHealthData } from '../health.js'
import { getPipelineRunById } from '../../../persistence/queries/decisions.js'

function makeManifestData(overrides: Partial<RunManifestData> = {}): RunManifestData {
  return {
    run_id: 'test-health-run-id',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: 12345,
    supervisor_session_id: 'sess-abc',
    per_story_state: {
      '1-1': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
    },
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
    ...overrides,
  }
}

function makeRun(id = 'test-health-run-id', status = 'running') {
  return {
    id,
    status,
    methodology: 'bmad',
    current_phase: 'implementation',
    config_json: null,
    token_usage_json: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: new Date().toISOString(), // fresh timestamp (not stale)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('health command — manifest-read path (Story 52-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: DB returns a running run
    vi.mocked(getPipelineRunById).mockResolvedValue(makeRun() as ReturnType<typeof makeRun>)
    // Default: no current-run-id file
    mockFsReadFile.mockRejectedValue(new Error('ENOENT'))
    mockAdapter.query.mockResolvedValue([])
  })

  describe('AC2: manifest available — supervisor ownership and per-story counts', () => {
    it('health output includes supervisor PID from manifest (AC2)', async () => {
      // Arrange
      const manifestData = makeManifestData({
        supervisor_pid: 12345,
        supervisor_session_id: 'sess-abc',
      })
      mockManifestRead.mockResolvedValue(manifestData)

      // Act
      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: 12345, child_pids: [], zombies: [] },
      })

      // Assert
      expect(health.manifest_supervisor).toBeDefined()
      expect(health.manifest_supervisor?.pid).toBe(12345)
      expect(health.manifest_supervisor?.session_id).toBe('sess-abc')
    })

    it('health output includes supervisor session_id from manifest', async () => {
      const manifestData = makeManifestData({
        supervisor_pid: 99999,
        supervisor_session_id: 'my-session-xyz',
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: null, child_pids: [], zombies: [] },
      })

      expect(health.manifest_supervisor?.pid).toBe(99999)
      expect(health.manifest_supervisor?.session_id).toBe('my-session-xyz')
    })

    it('per-story counts in health output match manifest per_story_state (AC2, AC5)', async () => {
      const manifestData = makeManifestData({
        per_story_state: {
          '1-1': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
          '1-2': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
          '1-3': { status: 'escalated', phase: 'ESCALATED', started_at: '2026-01-01T00:00:00Z' },
          '1-4': { status: 'dispatched', phase: 'IN_DEV', started_at: '2026-01-01T00:00:00Z' },
          '1-5': { status: 'pending', phase: 'PENDING', started_at: '2026-01-01T00:00:00Z' },
          '1-6': { status: 'failed', phase: 'FAILED', started_at: '2026-01-01T00:00:00Z' },
        },
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: 12345, child_pids: [], zombies: [] },
      })

      expect(health.stories.completed).toBe(2)  // '1-1', '1-2'
      expect(health.stories.escalated).toBe(1)  // '1-3'
      expect(health.stories.active).toBe(1)      // '1-4' (dispatched → active)
      expect(health.stories.pending).toBe(1)     // '1-5' (pending → pending)
      expect(health.stories.failed).toBe(1)      // '1-6' (failed → failed)
    })

    it('null supervisor_pid in manifest results in manifest_supervisor.pid === null', async () => {
      const manifestData = makeManifestData({
        supervisor_pid: null,
        supervisor_session_id: null,
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: null, child_pids: [], zombies: [] },
      })

      expect(health.manifest_supervisor).toBeDefined()
      expect(health.manifest_supervisor?.pid).toBeNull()
      expect(health.manifest_supervisor?.session_id).toBeNull()
    })
  })

  describe('AC4: manifest null — falls back to existing process inspection', () => {
    it('health falls back to existing Dolt/process approach when manifest read throws', async () => {
      // Arrange: manifest read fails
      mockRunManifestConstructor.mockImplementationOnce(() => ({
        read: vi.fn().mockRejectedValue(new Error('manifest file not found')),
      }))

      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: 5678, child_pids: [], zombies: [] },
      })

      // Should still return a valid health object
      expect(health.verdict).toBe('HEALTHY')
      expect(health.run_id).toBe('test-health-run-id')
      // manifest_supervisor not set (no manifest)
      expect(health.manifest_supervisor).toBeUndefined()
    })

    it('health falls back to token_usage_json counts when manifest is absent', async () => {
      // Arrange: manifest read fails; token_usage_json has story data
      mockRunManifestConstructor.mockImplementationOnce(() => ({
        read: vi.fn().mockRejectedValue(new Error('ENOENT')),
      }))

      vi.mocked(getPipelineRunById).mockResolvedValue({
        ...makeRun(),
        token_usage_json: JSON.stringify({
          stories: {
            '1-1': { phase: 'COMPLETE', reviewCycles: 1 },
            '1-2': { phase: 'ESCALATED', reviewCycles: 3 },
          },
        }),
      } as ReturnType<typeof makeRun>)

      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: null, child_pids: [], zombies: [] },
      })

      // Should use token_usage_json counts as fallback
      expect(health.stories.completed).toBe(1)
      expect(health.stories.escalated).toBe(1)
    })
  })

  describe('AC5: consistent story counts', () => {
    it('all status categories are reported without contradictions', async () => {
      const manifestData = makeManifestData({
        per_story_state: {
          '52-1': { status: 'complete', phase: 'COMPLETE', started_at: '2026-01-01T00:00:00Z' },
          '52-2': { status: 'escalated', phase: 'ESCALATED', started_at: '2026-01-01T00:00:00Z' },
          '52-3': { status: 'in-review', phase: 'IN_REVIEW', started_at: '2026-01-01T00:00:00Z' },
        },
      })
      mockManifestRead.mockResolvedValue(manifestData)

      const health = await getAutoHealthData({
        runId: 'test-health-run-id',
        projectRoot: '/tmp/test-health-project',
        _processInfoOverride: { orchestrator_pid: 12345, child_pids: [], zombies: [] },
      })

      // Total from manifest = 3 stories
      const totalFromManifest = 3
      const totalFromHealth =
        health.stories.completed +
        health.stories.escalated +
        health.stories.active +
        (health.stories.pending ?? 0) +
        (health.stories.failed ?? 0)

      expect(totalFromHealth).toBe(totalFromManifest)
    })
  })
})
