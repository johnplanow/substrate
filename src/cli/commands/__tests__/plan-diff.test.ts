/**
 * Unit tests for the plan diff command.
 *
 * Covers:
 * - computePlanDiff: identical YAMLs → empty diff result
 * - computePlanDiff: added task detected correctly
 * - computePlanDiff: removed task detected correctly
 * - computePlanDiff: modified task (changed agent) detected correctly
 * - runPlanDiffAction: missing version → exit 2
 * - runPlanDiffAction: identical versions → prints "No differences found"
 * - runPlanDiffAction: JSON output format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockDbOpen = vi.fn()
  const mockDbClose = vi.fn()
  const mockDb = { db: {} }
  const MockDatabaseWrapper = vi.fn().mockImplementation(() => ({
    open: mockDbOpen,
    close: mockDbClose,
    get db() { return mockDb.db },
  }))
  return { mockDbOpen, mockDbClose, mockDb, MockDatabaseWrapper }
})

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: mocks.MockDatabaseWrapper,
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

const mockGetPlanVersion = vi.fn()
vi.mock('../../../persistence/queries/plan-versions.js', () => ({
  getPlanVersion: (...args: unknown[]) => mockGetPlanVersion(...args),
  createPlanVersion: vi.fn(),
  getPlanVersionHistory: vi.fn().mockReturnValue([]),
  getLatestPlanVersion: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { computePlanDiff, runPlanDiffAction } from '../plan-diff.js'

// ---------------------------------------------------------------------------
// Test YAML fixtures
// ---------------------------------------------------------------------------

const YAML_V1 = `
version: "1"
session:
  name: test
tasks:
  task-a:
    name: Task A
    description: First task
    prompt: Do task A
    type: coding
    depends_on: []
    agent: claude
  task-b:
    name: Task B
    description: Second task
    prompt: Do task B
    type: testing
    depends_on:
      - task-a
`

const YAML_V2_ADDED_TASK = `
version: "1"
session:
  name: test
tasks:
  task-a:
    name: Task A
    description: First task
    prompt: Do task A
    type: coding
    depends_on: []
    agent: claude
  task-b:
    name: Task B
    description: Second task
    prompt: Do task B
    type: testing
    depends_on:
      - task-a
  task-c:
    name: Task C
    description: Third task
    prompt: Do task C
    type: coding
    depends_on: []
`

const YAML_V2_REMOVED_TASK = `
version: "1"
session:
  name: test
tasks:
  task-a:
    name: Task A
    description: First task
    prompt: Do task A
    type: coding
    depends_on: []
    agent: claude
`

const YAML_V2_MODIFIED_AGENT = `
version: "1"
session:
  name: test
tasks:
  task-a:
    name: Task A
    description: First task
    prompt: Do task A
    type: coding
    depends_on: []
    agent: codex
  task-b:
    name: Task B
    description: Second task
    prompt: Do task B
    type: testing
    depends_on:
      - task-a
`

// ---------------------------------------------------------------------------
// computePlanDiff tests (pure function, no mocks needed)
// ---------------------------------------------------------------------------

describe('computePlanDiff (pure function)', () => {
  it('returns empty diff for identical YAMLs', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V1)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  it('detects added task correctly', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_ADDED_TASK)
    expect(diff.added).toContain('task-c')
    expect(diff.removed).toHaveLength(0)
  })

  it('detects removed task correctly', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_REMOVED_TASK)
    expect(diff.removed).toContain('task-b')
    expect(diff.added).toHaveLength(0)
  })

  it('detects modified task (changed agent) correctly', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_MODIFIED_AGENT)
    expect(diff.modified).toHaveLength(1)
    expect(diff.modified[0].taskId).toBe('task-a')
    const agentChange = diff.modified[0].changes.find((c) => c.field === 'agent')
    expect(agentChange).toBeDefined()
    expect(agentChange?.from).toBe('claude')
    expect(agentChange?.to).toBe('codex')
  })
})

// ---------------------------------------------------------------------------
// runPlanDiffAction tests (mocked DB)
// ---------------------------------------------------------------------------

describe('runPlanDiffAction', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.clearAllMocks()
    // Reset mock implementations
    mocks.mockDbOpen.mockReturnValue(undefined)
    mocks.mockDbClose.mockReturnValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('returns exit 2 when fromVersion not found', async () => {
    mockGetPlanVersion.mockReturnValue(undefined)

    const exitCode = await runPlanDiffAction({
      planId: 'plan-1',
      fromVersion: 1,
      toVersion: 2,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = (stderrSpy.mock.calls.flat().join(''))
    expect(stderrOutput).toContain('Version v1 not found')
  })

  it('returns exit 2 when toVersion not found', async () => {
    mockGetPlanVersion
      .mockReturnValueOnce({ plan_id: 'plan-1', version: 1, task_graph_yaml: YAML_V1 })
      .mockReturnValueOnce(undefined)

    const exitCode = await runPlanDiffAction({
      planId: 'plan-1',
      fromVersion: 1,
      toVersion: 2,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = (stderrSpy.mock.calls.flat().join(''))
    expect(stderrOutput).toContain('Version v2 not found')
  })

  it('prints "No differences found" for identical versions', async () => {
    mockGetPlanVersion.mockReturnValue({
      plan_id: 'plan-1',
      version: 1,
      task_graph_yaml: YAML_V1,
      feedback_used: null,
      planning_cost_usd: 0,
      created_at: '2026-01-01',
    })

    const exitCode = await runPlanDiffAction({
      planId: 'plan-1',
      fromVersion: 1,
      toVersion: 2,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)
    const stdoutOutput = (stdoutSpy.mock.calls.flat().join(''))
    expect(stdoutOutput).toContain('No differences found between v1 and v2')
  })

  it('outputs JSON diff when outputFormat is json', async () => {
    mockGetPlanVersion
      .mockReturnValueOnce({
        plan_id: 'plan-1', version: 1, task_graph_yaml: YAML_V1,
        feedback_used: null, planning_cost_usd: 0, created_at: '2026-01-01',
      })
      .mockReturnValueOnce({
        plan_id: 'plan-1', version: 2, task_graph_yaml: YAML_V2_ADDED_TASK,
        feedback_used: 'added task c', planning_cost_usd: 0, created_at: '2026-01-01',
      })

    const exitCode = await runPlanDiffAction({
      planId: 'plan-1',
      fromVersion: 1,
      toVersion: 2,
      projectRoot: '/fake/root',
      outputFormat: 'json',
    })

    expect(exitCode).toBe(0)
    const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
    const parsed = JSON.parse(stdoutOutput)
    expect(parsed.added).toContain('task-c')
  })

  it('shows human-readable diff for differing versions', async () => {
    mockGetPlanVersion
      .mockReturnValueOnce({
        plan_id: 'plan-1', version: 1, task_graph_yaml: YAML_V1,
        feedback_used: null, planning_cost_usd: 0, created_at: '2026-01-01',
      })
      .mockReturnValueOnce({
        plan_id: 'plan-1', version: 2, task_graph_yaml: YAML_V2_ADDED_TASK,
        feedback_used: 'added task c', planning_cost_usd: 0, created_at: '2026-01-01',
      })

    const exitCode = await runPlanDiffAction({
      planId: 'plan-1',
      fromVersion: 1,
      toVersion: 2,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)
    const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
    expect(stdoutOutput).toContain('task-c')
    expect(stdoutOutput).toContain('added')
  })
})
