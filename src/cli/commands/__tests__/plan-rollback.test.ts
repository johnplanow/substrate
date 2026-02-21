/**
 * Unit tests for the plan rollback command.
 *
 * Covers:
 * - Plan not found → exit 2
 * - Target version not found → exit 2
 * - Already at target version → exit 0, message printed
 * - Successful rollback → new version row created, current_version updated, event emitted
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockDbOpen = vi.fn()
  const mockDbClose = vi.fn()
  const mockDbRef = { db: {} as Record<string, unknown> }
  const MockDatabaseWrapper = vi.fn().mockImplementation(() => ({
    open: mockDbOpen,
    close: mockDbClose,
    get db() { return mockDbRef.db },
  }))
  return { mockDbOpen, mockDbClose, mockDbRef, MockDatabaseWrapper }
})

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: mocks.MockDatabaseWrapper,
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

const mockGetPlan = vi.fn()
const mockUpdatePlan = vi.fn()
vi.mock('../../../persistence/queries/plans.js', () => ({
  getPlan: (...args: unknown[]) => mockGetPlan(...args),
  updatePlan: (...args: unknown[]) => mockUpdatePlan(...args),
  getPlanById: vi.fn(),
  updatePlanStatus: vi.fn(),
  listPlans: vi.fn(),
  createPlan: vi.fn(),
}))

const mockGetPlanVersion = vi.fn()
const mockCreatePlanVersion = vi.fn()
vi.mock('../../../persistence/queries/plan-versions.js', () => ({
  getPlanVersion: (...args: unknown[]) => mockGetPlanVersion(...args),
  createPlanVersion: (...args: unknown[]) => mockCreatePlanVersion(...args),
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

// Mock formatPlanVersionForDisplay
vi.mock('../../formatters/plan-formatter.js', () => ({
  formatPlanVersionForDisplay: vi.fn().mockReturnValue('=== Plan (current version) ==='),
  formatPlanForDisplay: vi.fn().mockReturnValue('=== Plan ==='),
  formatPlanList: vi.fn(),
  formatPlanDetail: vi.fn(),
}))

// Mock promptApproval to always return 'approve' in tests
vi.mock('../plan.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../plan.js')>()
  return {
    ...original,
    promptApproval: vi.fn().mockResolvedValue('approve'),
  }
})

import { runPlanRollbackAction } from '../plan-rollback.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanRollbackAction', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.clearAllMocks()
    mocks.mockDbOpen.mockReturnValue(undefined)
    mocks.mockDbClose.mockReturnValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('returns exit 2 when plan not found', async () => {
    mockGetPlan.mockReturnValue(undefined)

    const exitCode = await runPlanRollbackAction({
      planId: 'nonexistent-plan',
      toVersion: 1,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = stderrSpy.mock.calls.flat().join('')
    expect(stderrOutput).toContain('Plan not found: nonexistent-plan')
  })

  it('returns exit 2 when target version not found', async () => {
    mockGetPlan.mockReturnValue({
      id: 'plan-1',
      description: 'test',
      status: 'draft',
      current_version: 3,
      planning_agent: 'claude',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    mockGetPlanVersion.mockReturnValue(undefined)

    const exitCode = await runPlanRollbackAction({
      planId: 'plan-1',
      toVersion: 1,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = stderrSpy.mock.calls.flat().join('')
    expect(stderrOutput).toContain('Version v1 not found')
  })

  it('returns exit 0 and prints message when already at target version', async () => {
    mockGetPlan.mockReturnValue({
      id: 'plan-1',
      description: 'test',
      status: 'draft',
      current_version: 2,
      planning_agent: 'claude',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    mockGetPlanVersion.mockReturnValue({
      plan_id: 'plan-1',
      version: 2,
      task_graph_yaml: 'yaml',
      feedback_used: null,
      planning_cost_usd: 0,
      created_at: '2026-01-01',
    })

    const exitCode = await runPlanRollbackAction({
      planId: 'plan-1',
      toVersion: 2,
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(0)
    const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
    expect(stdoutOutput).toContain('already at v2')
  })

  it('successful rollback creates new version, updates current_version, emits event', async () => {
    const planId = 'plan-rollback-success'
    mockGetPlan.mockReturnValue({
      id: planId,
      description: 'test',
      status: 'draft',
      current_version: 3,
      planning_agent: 'claude',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    mockGetPlanVersion.mockReturnValue({
      plan_id: planId,
      version: 1,
      task_graph_yaml: 'version: "1"\nsession:\n  name: test\ntasks: {}',
      feedback_used: null,
      planning_cost_usd: 0,
      created_at: '2026-01-01',
    })

    const events: { event: string; payload: Record<string, unknown> }[] = []
    const exitCode = await runPlanRollbackAction(
      {
        planId,
        toVersion: 1,
        projectRoot: '/fake/root',
        outputFormat: 'human',
        autoApprove: true,
      },
      (event, payload) => {
        events.push({ event, payload })
      },
    )

    expect(exitCode).toBe(0)

    // New version should be created
    expect(mockCreatePlanVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        plan_id: planId,
        version: 4,  // fromVersion (3) + 1
        feedback_used: 'rollback to v1',
      }),
    )

    // Plan record should be updated
    expect(mockUpdatePlan).toHaveBeenCalledWith(
      expect.anything(),
      planId,
      expect.objectContaining({
        current_version: 4,
        status: 'draft',
      }),
    )

    // Event should be emitted
    const rollbackEvent = events.find((e) => e.event === 'plan:rolled-back')
    expect(rollbackEvent).toBeDefined()
    expect(rollbackEvent?.payload.planId).toBe(planId)
    expect(rollbackEvent?.payload.fromVersion).toBe(3)
    expect(rollbackEvent?.payload.toVersion).toBe(1)
    expect(rollbackEvent?.payload.newVersion).toBe(4)
  })

  it('outputs JSON when outputFormat is json', async () => {
    const planId = 'plan-json-rollback'
    mockGetPlan.mockReturnValue({
      id: planId,
      description: 'test',
      status: 'draft',
      current_version: 2,
      planning_agent: 'claude',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    mockGetPlanVersion.mockReturnValue({
      plan_id: planId,
      version: 1,
      task_graph_yaml: 'yaml',
      feedback_used: null,
      planning_cost_usd: 0,
      created_at: '2026-01-01',
    })

    const exitCode = await runPlanRollbackAction({
      planId,
      toVersion: 1,
      projectRoot: '/fake/root',
      outputFormat: 'json',
    })

    expect(exitCode).toBe(0)
    const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
    const parsed = JSON.parse(stdoutOutput)
    expect(parsed.success).toBe(true)
    expect(parsed.data.planId).toBe(planId)
    expect(parsed.data.fromVersion).toBe(2)
    expect(parsed.data.toVersion).toBe(1)
    expect(parsed.data.newVersion).toBe(3)
  })
})
