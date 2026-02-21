/**
 * Unit tests for the plan refine command.
 *
 * Covers:
 * - Success case: updated plan displayed, approve prompt shown
 * - PlanGenerationError → exit 2, error message printed
 * - Plan not found → exit 2 with message
 * - Empty feedback → exit 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockDbOpen = vi.fn()
  const mockDbClose = vi.fn()
  const MockDatabaseWrapper = vi.fn().mockImplementation(() => ({
    open: mockDbOpen,
    close: mockDbClose,
    get db() { return {} },
  }))
  const mockRefine = vi.fn()
  const MockPlanRefiner = vi.fn().mockImplementation(() => ({
    refine: mockRefine,
  }))
  return { mockDbOpen, mockDbClose, MockDatabaseWrapper, mockRefine, MockPlanRefiner }
})

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: mocks.MockDatabaseWrapper,
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

vi.mock('../../../modules/plan-generator/plan-refiner.js', () => ({
  PlanRefiner: mocks.MockPlanRefiner,
  computePlanDiff: vi.fn(),
  countTasksInYaml: vi.fn().mockReturnValue(3),
}))

vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 1 }),
    getAll: vi.fn().mockReturnValue([]),
  })),
}))

vi.mock('../../../modules/plan-generator/plan-generator.js', () => ({
  PlanGenerator: vi.fn().mockImplementation(() => ({
    generate: vi.fn(),
  })),
  PlanError: class PlanError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.name = 'PlanError'
      this.code = code
    }
  },
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../formatters/plan-formatter.js', () => ({
  formatPlanVersionForDisplay: vi.fn().mockReturnValue('=== Plan (current version) ==='),
  formatPlanForDisplay: vi.fn().mockReturnValue('=== Plan ==='),
  formatPlanList: vi.fn(),
  formatPlanDetail: vi.fn(),
}))

// Mock promptApproval
vi.mock('../plan.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../plan.js')>()
  return {
    ...original,
    promptApproval: vi.fn().mockResolvedValue('approve'),
  }
})

import { runPlanRefineAction } from '../plan-refine.js'

const { mockRefine } = mocks

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanRefineAction', () => {
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

  it('returns exit 2 when feedback is empty', async () => {
    const exitCode = await runPlanRefineAction({
      planId: 'plan-1',
      feedback: '   ',
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = stderrSpy.mock.calls.flat().join('')
    expect(stderrOutput).toContain('feedback text is required')
  })

  it('success case: displays updated plan and shows approve prompt', async () => {
    mockRefine.mockResolvedValue({
      updatedYaml: 'version: "1"\nsession:\n  name: test\ntasks:\n  task-a:\n    name: A\n    prompt: Do\n    type: coding\n    depends_on: []',
      newVersion: 2,
      taskCount: 3,
    })

    const exitCode = await runPlanRefineAction({
      planId: 'plan-1',
      feedback: 'add more tasks',
      projectRoot: '/fake/root',
      outputFormat: 'human',
      autoApprove: true,
    })

    expect(exitCode).toBe(0)
    expect(mockRefine).toHaveBeenCalledWith('plan-1', 'add more tasks', expect.any(Function))

    const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
    expect(stdoutOutput).toContain('Plan ID: plan-1')
    expect(stdoutOutput).toContain('v2')
  })

  it('returns exit 2 when plan not found', async () => {
    mockRefine.mockRejectedValue(new Error('Plan not found: plan-xyz'))

    const exitCode = await runPlanRefineAction({
      planId: 'plan-xyz',
      feedback: 'some feedback',
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = stderrSpy.mock.calls.flat().join('')
    expect(stderrOutput).toContain('Plan not found: plan-xyz')
  })

  it('returns exit 2 when planning agent fails', async () => {
    const { PlanError } = await import('../../../modules/plan-generator/plan-generator.js')
    mockRefine.mockRejectedValue(new PlanError('adapter timed out'))

    const exitCode = await runPlanRefineAction({
      planId: 'plan-1',
      feedback: 'some feedback',
      projectRoot: '/fake/root',
      outputFormat: 'human',
    })

    expect(exitCode).toBe(2)
    const stderrOutput = stderrSpy.mock.calls.flat().join('')
    expect(stderrOutput).toContain('adapter timed out')
  })

  it('outputs JSON when outputFormat is json', async () => {
    mockRefine.mockResolvedValue({
      updatedYaml: 'version: "1"\nsession:\n  name: test\ntasks: {}',
      newVersion: 2,
      taskCount: 0,
    })

    const exitCode = await runPlanRefineAction({
      planId: 'plan-1',
      feedback: 'add tasks',
      projectRoot: '/fake/root',
      outputFormat: 'json',
    })

    expect(exitCode).toBe(0)
    const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
    const parsed = JSON.parse(stdoutOutput)
    expect(parsed.success).toBe(true)
    expect(parsed.data.planId).toBe('plan-1')
    expect(parsed.data.newVersion).toBe(2)
  })
})
