/**
 * Unit tests for `substrate worktrees` command
 *
 * Tests cover:
 *  - AC1: Table output with correct columns
 *  - AC2: JSON output format with --output-format json and --json shorthand
 *  - AC3: Empty worktrees displays "No active worktrees" and exits 0
 *  - AC4: Filtering by task status with --status flag
 *  - AC5: Sorting by different keys (created, task-id, status)
 *  - AC6: Task status integration (default status for worktrees)
 *
 * GitWorktreeManager is mocked to avoid real git operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildWorktreeDisplayInfo,
  sortWorktrees,
  filterWorktreesByStatus,
  formatWorktreesTable,
  worktreeToJsonEntry,
  listWorktreesAction,
  WORKTREES_EXIT_SUCCESS,
  WORKTREES_EXIT_ERROR,
} from '../../commands/worktrees.js'
import type { WorktreeDisplayInfo } from '../../types/worktree-output.js'
import type { WorktreeInfo } from '../../../modules/git-worktree/git-worktree-manager.js'

// ---------------------------------------------------------------------------
// Mock the git-worktree-manager-impl to avoid real git ops
// ---------------------------------------------------------------------------

const mockListWorktrees = vi.fn<() => Promise<WorktreeInfo[]>>()

vi.mock('../../../modules/git-worktree/git-worktree-manager-impl.js', () => ({
  createGitWorktreeManager: vi.fn(() => ({
    listWorktrees: mockListWorktrees,
  })),
}))

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE_1 = new Date('2024-01-15T10:00:00Z')
const FIXED_DATE_2 = new Date('2024-01-16T12:00:00Z')
const FIXED_DATE_3 = new Date('2024-01-14T08:00:00Z')

const SAMPLE_WORKTREE_INFO_1: WorktreeInfo = {
  taskId: 'task-001',
  branchName: 'substrate/task-task-001',
  worktreePath: '/project/.substrate-worktrees/task-001',
  createdAt: FIXED_DATE_1,
}

const SAMPLE_WORKTREE_INFO_2: WorktreeInfo = {
  taskId: 'task-002',
  branchName: 'substrate/task-task-002',
  worktreePath: '/project/.substrate-worktrees/task-002',
  createdAt: FIXED_DATE_2,
}

const SAMPLE_WORKTREE_INFO_3: WorktreeInfo = {
  taskId: 'task-003',
  branchName: 'substrate/task-task-003',
  worktreePath: '/project/.substrate-worktrees/task-003',
  createdAt: FIXED_DATE_3,
}

// ---------------------------------------------------------------------------
// Output capture helper
// ---------------------------------------------------------------------------

let capturedStdout: string
let capturedStderr: string

function setupCapture(): void {
  capturedStdout = ''
  capturedStderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    capturedStdout += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    capturedStderr += typeof data === 'string' ? data : data.toString()
    return true
  })
}

// ---------------------------------------------------------------------------
// buildWorktreeDisplayInfo tests
// ---------------------------------------------------------------------------

describe('buildWorktreeDisplayInfo', () => {
  it('creates display info with default running status', () => {
    const info = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1)
    expect(info.taskId).toBe('task-001')
    expect(info.branchName).toBe('substrate/task-task-001')
    expect(info.worktreePath).toBe('/project/.substrate-worktrees/task-001')
    expect(info.taskStatus).toBe('running')
    expect(info.createdAt).toBe(FIXED_DATE_1)
    expect(info.completedAt).toBeUndefined()
  })

  it('creates display info with specified task status', () => {
    const info = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'completed', new Date('2024-01-15T11:00:00Z'))
    expect(info.taskStatus).toBe('completed')
    expect(info.completedAt).toBeDefined()
    expect(info.completedAt?.toISOString()).toBe('2024-01-15T11:00:00.000Z')
  })

  it('creates display info with pending status', () => {
    const info = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_2, 'pending')
    expect(info.taskStatus).toBe('pending')
  })

  it('creates display info with failed status', () => {
    const info = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_3, 'failed')
    expect(info.taskStatus).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// sortWorktrees tests
// ---------------------------------------------------------------------------

describe('sortWorktrees', () => {
  let worktrees: WorktreeDisplayInfo[]

  beforeEach(() => {
    worktrees = [
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1),    // task-001, 2024-01-15
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_2),    // task-002, 2024-01-16
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_3),    // task-003, 2024-01-14
    ]
  })

  it('sorts by created time newest first (default)', () => {
    const sorted = sortWorktrees(worktrees, 'created')
    expect(sorted[0]?.taskId).toBe('task-002') // 2024-01-16 newest
    expect(sorted[1]?.taskId).toBe('task-001') // 2024-01-15
    expect(sorted[2]?.taskId).toBe('task-003') // 2024-01-14 oldest
  })

  it('sorts by task-id alphabetically ascending', () => {
    const sorted = sortWorktrees(worktrees, 'task-id')
    expect(sorted[0]?.taskId).toBe('task-001')
    expect(sorted[1]?.taskId).toBe('task-002')
    expect(sorted[2]?.taskId).toBe('task-003')
  })

  it('sorts by status alphabetically', () => {
    const mixed = [
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'running'),
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_2, 'completed'),
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_3, 'failed'),
    ]
    const sorted = sortWorktrees(mixed, 'status')
    expect(sorted[0]?.taskStatus).toBe('completed')  // c < f < r
    expect(sorted[1]?.taskStatus).toBe('failed')
    expect(sorted[2]?.taskStatus).toBe('running')
  })

  it('does not mutate the original array', () => {
    const original = [...worktrees]
    sortWorktrees(worktrees, 'created')
    expect(worktrees[0]?.taskId).toBe(original[0]?.taskId)
  })
})

// ---------------------------------------------------------------------------
// filterWorktreesByStatus tests
// ---------------------------------------------------------------------------

describe('filterWorktreesByStatus', () => {
  let worktrees: WorktreeDisplayInfo[]

  beforeEach(() => {
    worktrees = [
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'running'),
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_2, 'completed'),
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_3, 'running'),
    ]
  })

  it('filters by running status', () => {
    const filtered = filterWorktreesByStatus(worktrees, 'running')
    expect(filtered).toHaveLength(2)
    expect(filtered[0]?.taskId).toBe('task-001')
    expect(filtered[1]?.taskId).toBe('task-003')
  })

  it('filters by completed status', () => {
    const filtered = filterWorktreesByStatus(worktrees, 'completed')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.taskId).toBe('task-002')
  })

  it('returns empty array when no matches', () => {
    const filtered = filterWorktreesByStatus(worktrees, 'failed')
    expect(filtered).toHaveLength(0)
  })

  it('filters by pending status', () => {
    const withPending = [
      ...worktrees,
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'pending'),
    ]
    const filtered = filterWorktreesByStatus(withPending, 'pending')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.taskStatus).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// formatWorktreesTable tests
// ---------------------------------------------------------------------------

describe('formatWorktreesTable', () => {
  it('includes expected column headers', () => {
    const worktreeList = [buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1)]
    const output = formatWorktreesTable(worktreeList)
    expect(output).toContain('Task ID')
    expect(output).toContain('Branch')
    expect(output).toContain('Path')
    expect(output).toContain('Status')
    expect(output).toContain('Created')
  })

  it('includes worktree data in output', () => {
    const worktreeList = [buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'running')]
    const output = formatWorktreesTable(worktreeList)
    expect(output).toContain('task-001')
    expect(output).toContain('substrate/task-task-001')
    expect(output).toContain('/project/.substrate-worktrees/task-001')
    expect(output).toContain('running')
  })

  it('includes separator row between header and data', () => {
    const worktreeList = [buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1)]
    const output = formatWorktreesTable(worktreeList)
    expect(output).toContain('-+-')
  })

  it('handles multiple worktrees', () => {
    const worktreeList = [
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'running'),
      buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_2, 'completed'),
    ]
    const output = formatWorktreesTable(worktreeList)
    expect(output).toContain('task-001')
    expect(output).toContain('task-002')
    expect(output).toContain('running')
    expect(output).toContain('completed')
  })
})

// ---------------------------------------------------------------------------
// worktreeToJsonEntry tests
// ---------------------------------------------------------------------------

describe('worktreeToJsonEntry', () => {
  it('converts WorktreeDisplayInfo to JSON entry', () => {
    const displayInfo = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'running')
    const entry = worktreeToJsonEntry(displayInfo)
    expect(entry.taskId).toBe('task-001')
    expect(entry.branchName).toBe('substrate/task-task-001')
    expect(entry.worktreePath).toBe('/project/.substrate-worktrees/task-001')
    expect(entry.taskStatus).toBe('running')
    expect(entry.createdAt).toBe(FIXED_DATE_1.toISOString())
    expect(entry.completedAt).toBeNull()
  })

  it('includes completedAt when task is completed', () => {
    const completedAt = new Date('2024-01-15T11:00:00Z')
    const displayInfo = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1, 'completed', completedAt)
    const entry = worktreeToJsonEntry(displayInfo)
    expect(entry.completedAt).toBe(completedAt.toISOString())
  })

  it('JSON entry has all required fields from AC2', () => {
    const displayInfo = buildWorktreeDisplayInfo(SAMPLE_WORKTREE_INFO_1)
    const entry = worktreeToJsonEntry(displayInfo)
    expect(entry).toHaveProperty('taskId')
    expect(entry).toHaveProperty('branchName')
    expect(entry).toHaveProperty('worktreePath')
    expect(entry).toHaveProperty('taskStatus')
    expect(entry).toHaveProperty('createdAt')
    expect(entry).toHaveProperty('completedAt')
  })
})

// ---------------------------------------------------------------------------
// listWorktreesAction tests
// ---------------------------------------------------------------------------

type JsonOutputData = {
  data: { taskId: string; branchName: string; worktreePath: string; taskStatus: string; createdAt: string; completedAt: string | null }[]
  command: string
  timestamp: string
  version: string
}

describe('listWorktreesAction', () => {
  beforeEach(() => {
    setupCapture()
    mockListWorktrees.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // AC3: Empty worktrees handling
  it('displays "No active worktrees" when no worktrees exist', async () => {
    mockListWorktrees.mockResolvedValue([])
    const exitCode = await listWorktreesAction({
      outputFormat: 'table',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(capturedStdout).toContain('No active worktrees')
    expect(exitCode).toBe(WORKTREES_EXIT_SUCCESS)
  })

  // AC3: Empty case exits with code 0
  it('exits with code 0 for empty worktrees', async () => {
    mockListWorktrees.mockResolvedValue([])
    const exitCode = await listWorktreesAction({
      outputFormat: 'table',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(exitCode).toBe(0)
  })

  // AC1: Table output with headers
  it('displays table with headers for single worktree', async () => {
    mockListWorktrees.mockResolvedValue([SAMPLE_WORKTREE_INFO_1])
    const exitCode = await listWorktreesAction({
      outputFormat: 'table',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(capturedStdout).toContain('Task ID')
    expect(capturedStdout).toContain('Branch')
    expect(capturedStdout).toContain('Path')
    expect(capturedStdout).toContain('Status')
    expect(capturedStdout).toContain('Created')
    expect(capturedStdout).toContain('task-001')
    expect(exitCode).toBe(WORKTREES_EXIT_SUCCESS)
  })

  // AC1: Multiple worktrees in table
  it('displays all worktrees in table output', async () => {
    mockListWorktrees.mockResolvedValue([SAMPLE_WORKTREE_INFO_1, SAMPLE_WORKTREE_INFO_2])
    await listWorktreesAction({
      outputFormat: 'table',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(capturedStdout).toContain('task-001')
    expect(capturedStdout).toContain('task-002')
  })

  // AC2: JSON output format
  it('outputs valid JSON with --output-format json', async () => {
    mockListWorktrees.mockResolvedValue([SAMPLE_WORKTREE_INFO_1])
    await listWorktreesAction({
      outputFormat: 'json',
      sort: 'created',
      projectRoot: '/project',
      version: '0.1.0',
    })
    expect((): void => { JSON.parse(capturedStdout) }).not.toThrow()
    const parsed = JSON.parse(capturedStdout) as JsonOutputData
    expect(parsed.command).toBe('substrate worktrees')
    expect(Array.isArray(parsed.data)).toBe(true)
    expect(parsed.data).toHaveLength(1)
  })

  // AC2: JSON output structure
  it('JSON output has required fields per AC2', async () => {
    mockListWorktrees.mockResolvedValue([SAMPLE_WORKTREE_INFO_1])
    await listWorktreesAction({
      outputFormat: 'json',
      sort: 'created',
      projectRoot: '/project',
    })
    const parsed = JSON.parse(capturedStdout) as JsonOutputData
    const entry = parsed.data[0]
    expect(entry).toBeDefined()
    expect(entry?.taskId).toBe('task-001')
    expect(entry?.branchName).toBe('substrate/task-task-001')
    expect(entry).toHaveProperty('worktreePath')
    expect(entry).toHaveProperty('taskStatus')
    expect(entry).toHaveProperty('createdAt')
    expect(entry).toHaveProperty('completedAt')
  })

  // AC2: JSON output ends with newline (jq compatibility)
  it('JSON output ends with newline for downstream tools', async () => {
    mockListWorktrees.mockResolvedValue([SAMPLE_WORKTREE_INFO_1])
    await listWorktreesAction({
      outputFormat: 'json',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(capturedStdout.endsWith('\n')).toBe(true)
  })

  // AC3: Empty worktrees in JSON format
  it('outputs empty JSON array for no worktrees with json format', async () => {
    mockListWorktrees.mockResolvedValue([])
    await listWorktreesAction({
      outputFormat: 'json',
      sort: 'created',
      projectRoot: '/project',
    })
    const parsed = JSON.parse(capturedStdout) as JsonOutputData
    expect(parsed.data).toHaveLength(0)
  })

  // AC4: Status filtering
  it('filters worktrees by running status', async () => {
    mockListWorktrees.mockResolvedValue([
      SAMPLE_WORKTREE_INFO_1,  // will be 'running' by default
      SAMPLE_WORKTREE_INFO_2,  // will be 'running' by default
    ])
    await listWorktreesAction({
      outputFormat: 'table',
      status: 'running',
      sort: 'created',
      projectRoot: '/project',
    })
    // Both are running, both should appear
    expect(capturedStdout).toContain('task-001')
    expect(capturedStdout).toContain('task-002')
  })

  it('shows empty message when no worktrees match status filter', async () => {
    mockListWorktrees.mockResolvedValue([SAMPLE_WORKTREE_INFO_1]) // will be 'running'
    await listWorktreesAction({
      outputFormat: 'table',
      status: 'completed',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(capturedStdout).toContain('No active worktrees')
  })

  // AC5: Sorting
  it('sorts worktrees by created time (newest first) by default', async () => {
    mockListWorktrees.mockResolvedValue([
      SAMPLE_WORKTREE_INFO_3,  // 2024-01-14 (oldest)
      SAMPLE_WORKTREE_INFO_1,  // 2024-01-15
      SAMPLE_WORKTREE_INFO_2,  // 2024-01-16 (newest)
    ])
    await listWorktreesAction({
      outputFormat: 'json',
      sort: 'created',
      projectRoot: '/project',
    })
    const parsed = JSON.parse(capturedStdout) as JsonOutputData
    expect(parsed.data[0]?.taskId).toBe('task-002')  // newest first
    expect(parsed.data[2]?.taskId).toBe('task-003')  // oldest last
  })

  it('sorts worktrees by task-id alphabetically', async () => {
    mockListWorktrees.mockResolvedValue([
      SAMPLE_WORKTREE_INFO_2,  // task-002
      SAMPLE_WORKTREE_INFO_3,  // task-003
      SAMPLE_WORKTREE_INFO_1,  // task-001
    ])
    await listWorktreesAction({
      outputFormat: 'json',
      sort: 'task-id',
      projectRoot: '/project',
    })
    const parsed = JSON.parse(capturedStdout) as JsonOutputData
    expect(parsed.data[0]?.taskId).toBe('task-001')
    expect(parsed.data[1]?.taskId).toBe('task-002')
    expect(parsed.data[2]?.taskId).toBe('task-003')
  })

  // Error handling
  it('returns error code when listWorktrees throws', async () => {
    mockListWorktrees.mockRejectedValue(new Error('git not found'))
    const exitCode = await listWorktreesAction({
      outputFormat: 'table',
      sort: 'created',
      projectRoot: '/project',
    })
    expect(exitCode).toBe(WORKTREES_EXIT_ERROR)
    expect(capturedStderr).toContain('Error')
  })
})
