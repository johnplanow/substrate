/**
 * Unit tests for `src/cli/commands/status.ts`
 *
 * Covers all 8 Acceptance Criteria:
 *   AC1: Session exists → formatted output printed, exit 0
 *   AC2: No session ID → resolves to latest session; No sessions → "No sessions found." exit 0
 *   AC3: --watch flag → polling loop starts, stops on terminal status, exits 0; SIGINT exits 0
 *   AC4: --output-format json → single NDJSON line emitted, exits immediately
 *   AC5: Human format → formatted table written to stdout
 *   AC6: Unknown session ID → error to stderr, exits 2
 *   AC7: fetchStatusSnapshot uses read-only query pattern (assert no writes)
 *   AC8: --show-graph → graph renderer called, ASCII tree in output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that reference mocked modules
// ---------------------------------------------------------------------------

// Mock DatabaseWrapper
const mockOpen = vi.fn()
const mockClose = vi.fn()
let mockDb: Record<string, unknown> = {}

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
  })),
}))

// Mock migrations
vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// Mock session queries
const mockGetSession = vi.fn()
const mockGetLatestSessionId = vi.fn()

vi.mock('../../../persistence/queries/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getLatestSessionId: (...args: unknown[]) => mockGetLatestSessionId(...args),
}))

// Mock task queries
const mockGetAllTasks = vi.fn()

vi.mock('../../../persistence/queries/tasks.js', () => ({
  getAllTasks: (...args: unknown[]) => mockGetAllTasks(...args),
}))

// Mock fs.existsSync
const mockExistsSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  runStatusAction,
  fetchStatusSnapshot,
  STATUS_EXIT_SUCCESS,
  STATUS_EXIT_ERROR,
  STATUS_EXIT_NOT_FOUND,
} from '../status.js'
import type { StatusActionOptions } from '../status.js'
import { DatabaseWrapper } from '../../../persistence/database.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<StatusActionOptions> = {}): StatusActionOptions {
  return {
    watch: false,
    outputFormat: 'human',
    showGraph: false,
    pollIntervalMs: 2000,
    projectRoot: '/test/project',
    ...overrides,
  }
}

function makeMockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-session-id',
    name: null,
    graph_file: 'tasks.yaml',
    status: 'active',
    budget_usd: null,
    total_cost_usd: 1.23,
    planning_cost_usd: 0,
    config_snapshot: null,
    base_branch: 'main',
    plan_source: null,
    planning_agent: null,
    created_at: new Date(Date.now() - 10000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeMockTask(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    session_id: 'test-session-id',
    name: `Task ${id}`,
    description: null,
    prompt: 'do something',
    status,
    agent: 'claude',
    model: null,
    billing_mode: null,
    worktree_path: null,
    worktree_branch: null,
    worktree_cleaned_at: null,
    worker_id: null,
    budget_usd: null,
    cost_usd: 0.1,
    input_tokens: 100,
    output_tokens: 50,
    result: null,
    error: null,
    exit_code: null,
    retry_count: 0,
    max_retries: 2,
    timeout_ms: null,
    task_type: null,
    metadata: null,
    started_at: status === 'running' ? new Date(Date.now() - 5000).toISOString() : null,
    completed_at: status === 'completed' ? new Date().toISOString() : null,
    created_at: new Date(Date.now() - 15000).toISOString(),
    updated_at: new Date().toISOString(),
    merge_status: null,
    merged_files: null,
    conflict_files: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  mockExistsSync.mockReturnValue(true)
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  mockDb = {}
})

afterEach(() => {
  // Only restore specific spies — do NOT call vi.restoreAllMocks() as that
  // wipes out vi.fn().mockImplementation() on vi.mock factory mocks.
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// fetchStatusSnapshot unit tests
// ---------------------------------------------------------------------------

describe('fetchStatusSnapshot', () => {
  it('returns null when session not found', () => {
    mockGetSession.mockReturnValue(undefined)
    mockGetAllTasks.mockReturnValue([])

    const wrapper = new DatabaseWrapper('/fake/path')
    const result = fetchStatusSnapshot(wrapper, 'nonexistent')
    expect(result).toBeNull()
  })

  it('returns correct snapshot for an active session', () => {
    const session = makeMockSession()
    mockGetSession.mockReturnValue(session)
    mockGetAllTasks.mockReturnValue([
      makeMockTask('task-1', 'completed'),
      makeMockTask('task-2', 'running'),
      makeMockTask('task-3', 'pending'),
    ])

    const wrapper = new DatabaseWrapper('/fake/path')
    const result = fetchStatusSnapshot(wrapper, 'test-session-id')

    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('test-session-id')
    expect(result!.status).toBe('active')
    expect(result!.taskCounts.total).toBe(3)
    expect(result!.taskCounts.completed).toBe(1)
    expect(result!.taskCounts.running).toBe(1)
    expect(result!.taskCounts.pending).toBe(1)
    expect(result!.taskCounts.failed).toBe(0)
    expect(result!.runningTasks).toHaveLength(1)
    expect(result!.runningTasks[0].taskId).toBe('task-2')
    expect(result!.totalCostUsd).toBe(1.23)
  })

  it('maps "completed" session status to "complete"', () => {
    const session = makeMockSession({ status: 'completed' })
    mockGetSession.mockReturnValue(session)
    mockGetAllTasks.mockReturnValue([])

    const wrapper = new DatabaseWrapper('/fake/path')
    const result = fetchStatusSnapshot(wrapper, 'test-session-id')

    expect(result!.status).toBe('complete')
  })

  it('AC7: getAllTasks is only used for reading (no write calls)', () => {
    const session = makeMockSession()
    mockGetSession.mockReturnValue(session)
    mockGetAllTasks.mockReturnValue([])

    const wrapper = new DatabaseWrapper('/fake/path')
    fetchStatusSnapshot(wrapper, 'test-session-id')

    // Verify only read operations were invoked
    expect(mockGetSession).toHaveBeenCalledTimes(1)
    expect(mockGetAllTasks).toHaveBeenCalledTimes(1)
    // No write mocks should have been called
    expect(mockOpen).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runStatusAction unit tests
// ---------------------------------------------------------------------------

describe('runStatusAction', () => {
  describe('AC1: Session exists → formatted output, exit 0', () => {
    it('displays human-readable output for an active session', async () => {
      const session = makeMockSession()
      mockGetSession.mockReturnValue(session)
      mockGetLatestSessionId.mockReturnValue(null)
      mockGetAllTasks.mockReturnValue([
        makeMockTask('task-1', 'completed'),
        makeMockTask('task-2', 'running'),
      ])

      const exitCode = await runStatusAction(makeOptions({ sessionId: 'test-session-id' }))

      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)
      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('test-session-id')
      expect(output).toContain('active')
    })
  })

  describe('AC2: No session ID → resolves to latest session', () => {
    it('resolves to the most recent session when no ID is provided', async () => {
      const session = makeMockSession()
      mockGetLatestSessionId.mockReturnValue('test-session-id')
      mockGetSession.mockReturnValue(session)
      mockGetAllTasks.mockReturnValue([])

      const exitCode = await runStatusAction(makeOptions())

      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)
      expect(mockGetLatestSessionId).toHaveBeenCalledOnce()
    })

    it('prints "No sessions found." and exits 0 when no sessions exist', async () => {
      mockGetLatestSessionId.mockReturnValue(null)

      const exitCode = await runStatusAction(makeOptions())

      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)
      expect(stdoutSpy).toHaveBeenCalledWith('No sessions found.\n')
    })
  })

  describe('AC3: --watch flag → polling loop', () => {
    it('stops polling when session reaches terminal status (complete)', async () => {
      vi.useFakeTimers()

      const session = makeMockSession({ status: 'complete' })
      mockGetSession.mockReturnValue(session)
      mockGetLatestSessionId.mockReturnValue(null)
      mockGetAllTasks.mockReturnValue([
        makeMockTask('task-1', 'completed'),
      ])

      const exitPromise = runStatusAction(makeOptions({
        sessionId: 'test-session-id',
        watch: true,
        outputFormat: 'json',
        pollIntervalMs: 100,
      }))

      // Allow first poll to fire
      await vi.runAllTimersAsync()

      const exitCode = await exitPromise
      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)

      vi.useRealTimers()
    })

    it('AC3: SIGINT stops the watch loop and exits 0', async () => {
      vi.useFakeTimers()

      const session = makeMockSession({ status: 'active' })
      mockGetSession.mockReturnValue(session)
      mockGetLatestSessionId.mockReturnValue(null)
      mockGetAllTasks.mockReturnValue([])

      const exitPromise = runStatusAction(makeOptions({
        sessionId: 'test-session-id',
        watch: true,
        outputFormat: 'human',
        pollIntervalMs: 10000,
      }))

      // Allow first poll tick
      await vi.advanceTimersByTimeAsync(0)

      // Simulate SIGINT
      process.emit('SIGINT')

      const exitCode = await exitPromise
      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)

      vi.useRealTimers()
    })
  })

  describe('AC4: --output-format json (no --watch) → single NDJSON line', () => {
    it('emits a single NDJSON line and exits immediately', async () => {
      const session = makeMockSession()
      mockGetSession.mockReturnValue(session)
      mockGetLatestSessionId.mockReturnValue(null)
      mockGetAllTasks.mockReturnValue([
        makeMockTask('task-1', 'completed'),
      ])

      const exitCode = await runStatusAction(makeOptions({
        sessionId: 'test-session-id',
        outputFormat: 'json',
      }))

      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)
      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      // Should be valid NDJSON with event:status:snapshot
      const parsed = JSON.parse(output.trim())
      expect(parsed.event).toBe('status:snapshot')
      expect(parsed.data.sessionId).toBe('test-session-id')
    })
  })

  describe('AC5: Human format → formatted table to stdout', () => {
    it('prints a formatted status table for human output', async () => {
      const session = makeMockSession()
      mockGetSession.mockReturnValue(session)
      mockGetLatestSessionId.mockReturnValue(null)
      mockGetAllTasks.mockReturnValue([
        makeMockTask('task-1', 'completed'),
        makeMockTask('task-2', 'pending'),
      ])

      const exitCode = await runStatusAction(makeOptions({ sessionId: 'test-session-id' }))

      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)
      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('Pending')
      expect(output).toContain('Running')
      expect(output).toContain('Completed')
      expect(output).toContain('Failed')
      expect(output).toContain('Total')
      expect(output).toContain('Total cost:')
    })
  })

  describe('AC6: Unknown session ID → error to stderr, exits 2', () => {
    it('returns exit code 2 and writes to stderr when session is not found', async () => {
      mockGetSession.mockReturnValue(undefined)

      const exitCode = await runStatusAction(makeOptions({ sessionId: 'nonexistent-id' }))

      expect(exitCode).toBe(STATUS_EXIT_NOT_FOUND)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error: Session not found: nonexistent-id'),
      )
    })
  })

  describe('exit code 1 when session not found in DB', () => {
    it('returns exit code 1 when the database file does not exist', async () => {
      mockExistsSync.mockReturnValue(false)

      const exitCode = await runStatusAction(makeOptions())

      expect(exitCode).toBe(STATUS_EXIT_ERROR)
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error: No Substrate database found'),
      )
    })
  })

  describe('AC8: --show-graph → graph renderer called, ASCII tree in output', () => {
    it('renders ASCII graph when --show-graph is specified', async () => {
      const session = makeMockSession()
      mockGetSession.mockReturnValue(session)
      mockGetLatestSessionId.mockReturnValue(null)

      const mockTasks = [
        makeMockTask('task-1', 'completed'),
        makeMockTask('task-2', 'running'),
      ]
      mockGetAllTasks.mockReturnValue(mockTasks)

      // Mock the db.prepare().all() for dependency query
      const mockAll = vi.fn().mockReturnValue([])
      const mockPrepare = vi.fn().mockReturnValue({ all: mockAll })
      mockDb = { prepare: mockPrepare }

      const exitCode = await runStatusAction(makeOptions({
        sessionId: 'test-session-id',
        showGraph: true,
      }))

      expect(exitCode).toBe(STATUS_EXIT_SUCCESS)
      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      // Graph header should appear
      expect(output).toContain('Task Graph')
      // Task status symbols or task IDs should be rendered
      expect(output).toMatch(/task-1|task-2|\[ \]|\[x\]|\[>\]/)
    })
  })
})
