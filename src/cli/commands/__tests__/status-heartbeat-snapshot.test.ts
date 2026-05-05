// @vitest-environment node
/**
 * Unit tests for the `substrate status` heartbeat per_story_state snapshot feature.
 *
 * Story 66-2 (AC4d, AC5): status command JSON output includes
 * `latest_heartbeat_per_story_state` key reflecting the most recently received
 * heartbeat's per_story_state field.
 *
 * obs_2026-05-03_022 fix #2.
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
  mockExistsSync,
  mockReadFileSync,
} = vi.hoisted(() => {
  const mockManifestRead = vi.fn()
  const mockRunManifestConstructor = vi.fn().mockImplementation(() => ({
    read: mockManifestRead,
  }))
  const mockFsReadFile = vi.fn()
  // existsSync defaults to true (current-run-id file found, heartbeat file found)
  const mockExistsSync = vi.fn().mockReturnValue(true)
  // readFileSync defaults to '' (empty current-run-id → UUID regex fails → fallback)
  const mockReadFileSync = vi.fn().mockReturnValue('')
  return { mockManifestRead, mockRunManifestConstructor, mockFsReadFile, mockExistsSync, mockReadFileSync }
})

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted)
// ---------------------------------------------------------------------------

vi.mock('@substrate-ai/sdlc', () => ({
  RunManifest: mockRunManifestConstructor,
  rollupFindingCounts: vi.fn().mockReturnValue({ errors: 0, warnings: 0, infos: 0 }),
  rollupProbeAuthorMetrics: vi.fn().mockReturnValue({ dispatched: false, authoredProbesFailed: 0 }),
  rollupFindingsByAuthor: vi.fn().mockReturnValue({}),
}))

vi.mock('fs/promises', () => ({
  readFile: mockFsReadFile,
}))

// Mock fs (sync) — existsSync and readFileSync are controlled per-test
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
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

vi.mock('../../../modules/state/index.js', () => ({
  createStateStore: vi.fn(),
  WorkGraphRepository: vi.fn().mockImplementation(() => ({
    getReadyStories: vi.fn().mockResolvedValue([]),
    getBlockedStories: vi.fn().mockResolvedValue([]),
  })),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  getStoryMetricsForRun: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getLatestRun: vi.fn().mockResolvedValue(undefined),
  getPipelineRunById: vi.fn(),
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
import { getPipelineRunById } from '../../../persistence/queries/decisions.js'

/** Build a minimal RunManifestData with a single complete story */
function makeManifestData(): RunManifestData {
  return {
    run_id: 'test-run-66-2',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {
      '66-2-d': { status: 'dispatched', phase: 'IN_DEV', started_at: '2026-01-01T00:00:00Z' },
    },
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:01:00Z',
  }
}

/** Build a minimal PipelineRun row */
function makeRun(id = 'test-run-66-2', status = 'running') {
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

/** Capture process.stdout.write output */
function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = []
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
// Tests: Story 66-2 AC4d — status JSON surfaces latest_heartbeat_per_story_state
// ---------------------------------------------------------------------------

describe('Story 66-2 AC4d: status JSON surfaces latest_heartbeat_per_story_state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getPipelineRunById).mockResolvedValue(makeRun() as any)
    mockManifestRead.mockResolvedValue(makeManifestData())
    mockAdapter.query.mockResolvedValue([])
    // Reset fs mocks to safe defaults
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('')
  })

  it('AC4d: status JSON includes latest_heartbeat_per_story_state when sidecar file is present', async () => {
    // Arrange: heartbeat sidecar file exists with valid per_story_state data
    const heartbeatSnapshot = {
      '66-2-d': { phase: 'IN_DEV', status: 'dispatched' },
    }
    mockExistsSync.mockImplementation((path: unknown) => {
      // Return true for all paths (including both doltDir check and heartbeat sidecar)
      return true
    })
    mockReadFileSync.mockImplementation((path: unknown) => {
      const pathStr = String(path)
      if (pathStr.includes('latest-heartbeat-per-story-state')) {
        return JSON.stringify(heartbeatSnapshot)
      }
      // Empty string for other paths (current-run-id → UUID check fails → fallback to getPipelineRunById)
      return ''
    })

    const { output, restore } = captureStdout()
    try {
      const exitCode = await runStatusAction({
        outputFormat: 'json',
        runId: 'test-run-66-2',
        projectRoot: '/tmp/test-project',
      })
      expect(exitCode).toBe(0)

      const json = JSON.parse(output.join(''))
      // AC4d: field must be present in the output
      expect(json.data.latest_heartbeat_per_story_state).toBeDefined()

      // Field should reflect the heartbeat snapshot
      const hbState = json.data.latest_heartbeat_per_story_state as Record<string, { phase: string; status: string }>
      expect(hbState['66-2-d']).toBeDefined()
      expect(hbState['66-2-d']!.phase).toBe('IN_DEV')
      expect(hbState['66-2-d']!.status).toBe('dispatched')
    } finally {
      restore()
    }
  })

  it('AC4d: status JSON includes empty latest_heartbeat_per_story_state when sidecar file absent', async () => {
    // Arrange: heartbeat sidecar file does NOT exist
    mockExistsSync.mockImplementation((path: unknown) => {
      const pathStr = String(path)
      if (pathStr.includes('latest-heartbeat-per-story-state')) {
        return false
      }
      return true
    })
    mockReadFileSync.mockReturnValue('')

    const { output, restore } = captureStdout()
    try {
      const exitCode = await runStatusAction({
        outputFormat: 'json',
        runId: 'test-run-66-2',
        projectRoot: '/tmp/test-project',
      })
      expect(exitCode).toBe(0)

      const json = JSON.parse(output.join(''))
      // AC4d: field must still be present, but as empty object
      expect(json.data.latest_heartbeat_per_story_state).toBeDefined()
      expect(typeof json.data.latest_heartbeat_per_story_state).toBe('object')
      expect(Object.keys(json.data.latest_heartbeat_per_story_state as object)).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('AC4d: status JSON includes empty latest_heartbeat_per_story_state when sidecar file is malformed', async () => {
    // Arrange: sidecar file exists but contains invalid JSON
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation((path: unknown) => {
      const pathStr = String(path)
      if (pathStr.includes('latest-heartbeat-per-story-state')) {
        return 'not-valid-json{{'
      }
      return ''
    })

    const { output, restore } = captureStdout()
    try {
      const exitCode = await runStatusAction({
        outputFormat: 'json',
        runId: 'test-run-66-2',
        projectRoot: '/tmp/test-project',
      })
      expect(exitCode).toBe(0)

      const json = JSON.parse(output.join(''))
      // Field must still appear (as empty object) — malformed JSON is caught gracefully
      expect(json.data.latest_heartbeat_per_story_state).toBeDefined()
      expect(Object.keys(json.data.latest_heartbeat_per_story_state as object)).toHaveLength(0)
    } finally {
      restore()
    }
  })
})
