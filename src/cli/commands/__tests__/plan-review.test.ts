/**
 * Unit tests for plan review and approval flow (Story 7-3).
 *
 * Tests the interactive review, --auto-approve, --dry-run, plan list, and
 * plan show functionality added by Story 7-3.
 *
 * Covers AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockListPlans = vi.fn()
  const mockGetPlanByPrefix = vi.fn()
  const mockCreatePlan = vi.fn()
  const mockCreatePlanVersion = vi.fn()
  const mockUpdatePlanStatus = vi.fn()
  const mockRunMigrations = vi.fn()
  const mockDbOpen = vi.fn()
  const mockDbClose = vi.fn()
  const mockDbGet = vi.fn()
  const mockEmitEvent = vi.fn()
  const mockGenerate = vi.fn()
  const mockFormatPlanForDisplay = vi.fn().mockReturnValue('=== Generated Plan ===\nTask count: 3\n======================')
  const MockPlanGenerator = vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  }))
  class PlanError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.name = 'PlanError'
      this.code = code
    }
  }

  return {
    mockListPlans,
    mockGetPlanByPrefix,
    mockCreatePlan,
    mockCreatePlanVersion,
    mockUpdatePlanStatus,
    mockRunMigrations,
    mockDbOpen,
    mockDbClose,
    mockDbGet,
    mockEmitEvent,
    mockGenerate,
    mockFormatPlanForDisplay,
    MockPlanGenerator,
    PlanError,
  }
})

// Mock PlanGenerator
vi.mock('../../../modules/plan-generator/plan-generator.js', () => ({
  PlanGenerator: mocks.MockPlanGenerator,
  PlanError: mocks.PlanError,
}))

// Mock persistence queries
vi.mock('../../../persistence/queries/plans.js', () => ({
  createPlan: (...args: unknown[]) => mocks.mockCreatePlan(...args),
  updatePlanStatus: (...args: unknown[]) => mocks.mockUpdatePlanStatus(...args),
  listPlans: (...args: unknown[]) => mocks.mockListPlans(...args),
  getPlanByPrefix: (...args: unknown[]) => mocks.mockGetPlanByPrefix(...args),
  getPlanById: vi.fn(),
}))

// Mock plan-versions queries
vi.mock('../../../persistence/queries/plan-versions.js', () => ({
  createPlanVersion: (...args: unknown[]) => mocks.mockCreatePlanVersion(...args),
  getPlanVersion: vi.fn(),
  getPlanVersionHistory: vi.fn(),
  getLatestPlanVersion: vi.fn(),
}))

// Mock DatabaseWrapper
vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mocks.mockDbOpen,
    close: mocks.mockDbClose,
    get db() {
      return mocks.mockDbGet()
    },
  })),
}))

// Mock runMigrations
vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: (...args: unknown[]) => mocks.mockRunMigrations(...args),
}))

// Mock plan-formatter — use actual implementations for formatPlanList and formatPlanDetail
// so pre-existing tests that check real output continue to pass.
vi.mock('../../formatters/plan-formatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../formatters/plan-formatter.js')>()
  return {
    ...actual,
    formatPlanForDisplay: (...args: unknown[]) => mocks.mockFormatPlanForDisplay(...args as Parameters<typeof actual.formatPlanForDisplay>),
  }
})

// Mock emitEvent
vi.mock('../../formatters/streaming.js', () => ({
  emitEvent: (...args: unknown[]) => mocks.mockEmitEvent(...args),
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

// Mock AdapterRegistry
vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: vi.fn().mockResolvedValue({}),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
    get: vi.fn(),
  })),
}))

// Mock codebase-scanner
vi.mock('../../../modules/plan-generator/codebase-scanner.js', () => ({
  scanCodebase: vi.fn(),
  ScanError: class ScanError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.name = 'ScanError'
      this.code = code
    }
  },
}))

// Mock fs
const mockExistsSync = vi.fn().mockReturnValue(true)
const mockMkdirSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockReadFileSync = vi.fn().mockReturnValue('mocked-plan-content')
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: vi.fn().mockReturnValue([]),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// Mock readline
const mockRlQuestion = vi.fn()
const mockRlClose = vi.fn()
vi.mock('readline', () => ({
  createInterface: vi.fn().mockImplementation(() => ({
    question: mockRlQuestion,
    close: mockRlClose,
  })),
}))

// Mock crypto
const mockRandomUUID = vi.fn().mockReturnValue('test-uuid-1234-5678-90ab-cdef01234567')
vi.mock('crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}))

// Mock js-yaml
vi.mock('js-yaml', () => ({
  dump: vi.fn().mockReturnValue('mocked-yaml-content'),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  runPlanListAction,
  runPlanShowAction,
  runPlanReviewAction,
  promptApproval,
  PLAN_EXIT_SUCCESS,
  PLAN_EXIT_ERROR,
  PLAN_EXIT_USAGE_ERROR,
} from '../plan.js'
import type { PlanListOptions, PlanShowOptions, PlanActionOptions } from '../plan.js'
import type { Plan } from '../../../persistence/queries/plans.js'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const makePlan = (overrides: Partial<Plan> = {}): Plan => ({
  id: 'abc12345-6789-0000-0000-000000000001',
  description: 'Add authentication to the app',
  task_count: 3,
  estimated_cost_usd: 0.45,
  planning_agent: 'claude',
  plan_yaml: 'version: "1"\nsession:\n  name: test\ntasks: {}',
  status: 'approved',
  created_at: '2026-02-20T12:00:00.000Z',
  updated_at: '2026-02-20T12:01:00.000Z',
  ...overrides,
})

const makeReviewOptions = (overrides: Partial<PlanActionOptions> = {}): PlanActionOptions => ({
  goal: 'add auth',
  outputPath: 'plan.json',
  dryRun: false,
  outputFormat: 'human',
  projectRoot: '/test/project',
  contextDepth: 2,
  ...overrides,
})

const makeListOptions = (overrides: Partial<PlanListOptions> = {}): PlanListOptions => ({
  outputFormat: 'human',
  projectRoot: '/test/project',
  ...overrides,
})

const makeShowOptions = (overrides: Partial<PlanShowOptions> = {}): PlanShowOptions => ({
  outputFormat: 'human',
  projectRoot: '/test/project',
  ...overrides,
})

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('plan review and approval (Story 7-3)', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>
  const originalIsTTY = process.stdin.isTTY

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockRandomUUID.mockReturnValue('test-uuid-1234-5678-90ab-cdef01234567')
    mocks.mockDbGet.mockReturnValue({})
    mockReadFileSync.mockReturnValue('mocked-plan-content')

    // Default: PlanGenerator.generate() succeeds
    mocks.mockGenerate.mockResolvedValue({
      success: true,
      outputPath: '/cwd/plan.json',
      taskCount: 3,
    })
    mocks.MockPlanGenerator.mockImplementation(() => ({
      generate: mocks.mockGenerate,
    }))

    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true })
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  })

  // -------------------------------------------------------------------------
  // promptApproval
  // -------------------------------------------------------------------------

  describe('promptApproval', () => {
    it('AC2: non-TTY stdin → writes error to stderr, returns reject', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true })

      const result = await promptApproval()

      expect(result).toBe('reject')
      const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
      expect(stderrCalls.some((s) => s.includes('--auto-approve'))).toBe(true)
    })

    it('AC2: TTY stdin with "a" → returns approve', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
      mockRlQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
        callback('a')
      })

      const result = await promptApproval()
      expect(result).toBe('approve')
    })

    it('AC2: TTY stdin with "A" → returns approve', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
      mockRlQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
        callback('A')
      })

      const result = await promptApproval()
      expect(result).toBe('approve')
    })

    it('AC2: TTY stdin with "r" → returns reject', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
      mockRlQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
        callback('r')
      })

      const result = await promptApproval()
      expect(result).toBe('reject')
    })

    it('AC2: TTY stdin with "R" → returns reject', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
      mockRlQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
        callback('R')
      })

      const result = await promptApproval()
      expect(result).toBe('reject')
    })
  })

  // -------------------------------------------------------------------------
  // runPlanReviewAction
  // -------------------------------------------------------------------------

  describe('runPlanReviewAction', () => {
    it('AC4: --dry-run → prints "Dry run complete", no DB calls', async () => {
      mocks.mockGenerate.mockResolvedValue({
        success: true,
        dryRunPrompt: 'echo "dry-run"',
      })

      const code = await runPlanReviewAction(makeReviewOptions({ dryRun: true }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes('Dry run complete'))).toBe(true)
      expect(mocks.mockCreatePlan).not.toHaveBeenCalled()
      expect(mocks.mockUpdatePlanStatus).not.toHaveBeenCalled()
    })

    it('AC4: --dry-run → calls PlanGenerator.generate() with dryRun: true', async () => {
      mocks.mockGenerate.mockResolvedValue({
        success: true,
        dryRunPrompt: 'echo "dry-run"',
      })

      await runPlanReviewAction(makeReviewOptions({ dryRun: true }))

      expect(mocks.mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      )
    })

    it('AC3: --auto-approve → prints auto-approved, calls updatePlanStatus with approved', async () => {
      const code = await runPlanReviewAction(makeReviewOptions({ autoApprove: true }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes('Plan auto-approved'))).toBe(true)
      expect(mocks.mockCreatePlan).toHaveBeenCalled()
      expect(mocks.mockUpdatePlanStatus).toHaveBeenCalledWith(
        expect.anything(),
        'test-uuid-1234-5678-90ab-cdef01234567',
        'approved',
      )
    })

    it('AC3: --auto-approve → calls PlanGenerator.generate() with real goal', async () => {
      await runPlanReviewAction(makeReviewOptions({ autoApprove: true, goal: 'real goal' }))

      expect(mocks.mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ goal: 'real goal' }),
      )
    })

    it('AC5: approval emits plan:approved event with taskCount', async () => {
      const code = await runPlanReviewAction(makeReviewOptions({ autoApprove: true }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      expect(mocks.mockEmitEvent).toHaveBeenCalledWith(
        'plan:approved',
        expect.objectContaining({ taskCount: expect.any(Number) }),
      )
    })

    it('AC5: approval saves plan to DB with real taskCount from generation', async () => {
      mocks.mockGenerate.mockResolvedValue({
        success: true,
        outputPath: '/cwd/plan.json',
        taskCount: 7,
      })

      await runPlanReviewAction(makeReviewOptions({ autoApprove: true }))

      expect(mocks.mockCreatePlan).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ task_count: 7 }),
      )
    })

    it('AC6: rejection → prints "Plan rejected", emits plan:rejected event', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
      mockRlQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
        callback('r')
      })

      const code = await runPlanReviewAction(makeReviewOptions({ autoApprove: false }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes('Plan rejected'))).toBe(true)
      expect(mocks.mockUpdatePlanStatus).toHaveBeenCalledWith(
        expect.anything(),
        'test-uuid-1234-5678-90ab-cdef01234567',
        'rejected',
      )
      expect(mocks.mockEmitEvent).toHaveBeenCalledWith(
        'plan:rejected',
        { reason: 'user_rejected' },
      )
    })

    it('AC9: --output-format json → emits JSON envelope, no readline', async () => {
      const code = await runPlanReviewAction(makeReviewOptions({ outputFormat: 'json' }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      const jsonCall = stdoutCalls.find((s) => {
        try {
          const parsed = JSON.parse(s.trim()) as Record<string, unknown>
          return parsed.success === true && parsed.command === 'plan'
        } catch {
          return false
        }
      })
      expect(jsonCall).toBeDefined()
      // Verify the envelope has real data from generation
      const parsed = JSON.parse(jsonCall!.trim()) as { data: { taskCount: number } }
      expect(parsed.data.taskCount).toBe(3)
      // readline should not have been called
      expect(mockRlQuestion).not.toHaveBeenCalled()
    })

    it('AC9: --output-format json envelope includes planningAgent', async () => {
      const code = await runPlanReviewAction(makeReviewOptions({ outputFormat: 'json' }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      const jsonCall = stdoutCalls.find((s) => {
        try {
          const parsed = JSON.parse(s.trim()) as Record<string, unknown>
          return parsed.command === 'plan'
        } catch {
          return false
        }
      })
      expect(jsonCall).toBeDefined()
      const parsed = JSON.parse(jsonCall!.trim()) as { data: { planningAgent: string } }
      expect(parsed.data.planningAgent).toBe('policy-routed')
    })

    it('AC1: human format → calls formatPlanForDisplay before approval prompt', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
      mockRlQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
        callback('r')
      })

      const code = await runPlanReviewAction(makeReviewOptions({ autoApprove: false }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      expect(mocks.mockFormatPlanForDisplay).toHaveBeenCalled()
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes('=== Generated Plan ==='))).toBe(true)
    })

    it('AC1: --auto-approve → formatPlanForDisplay called before auto-approval', async () => {
      const code = await runPlanReviewAction(makeReviewOptions({ autoApprove: true }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      expect(mocks.mockFormatPlanForDisplay).toHaveBeenCalled()
    })

    it('generation failure → returns error exit code', async () => {
      mocks.mockGenerate.mockResolvedValue({
        success: false,
        error: 'adapter crashed',
      })

      const code = await runPlanReviewAction(makeReviewOptions())

      expect(code).toBe(PLAN_EXIT_ERROR)
    })

    it('uses adapterId as planningAgent when provided', async () => {
      await runPlanReviewAction(makeReviewOptions({ autoApprove: true, adapterId: 'my-adapter' }))

      expect(mocks.mockCreatePlan).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ planning_agent: 'my-adapter' }),
      )
    })

    it('savePlan calls createPlanVersion with version 1 after createPlan', async () => {
      await runPlanReviewAction(makeReviewOptions({ autoApprove: true }))

      expect(mocks.mockCreatePlanVersion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          plan_id: 'test-uuid-1234-5678-90ab-cdef01234567',
          version: 1,
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // runPlanListAction
  // -------------------------------------------------------------------------

  describe('runPlanListAction', () => {
    it('AC7: human format → calls listPlans(), prints formatted output', async () => {
      const plans = [makePlan()]
      mocks.mockListPlans.mockReturnValue(plans)

      const code = await runPlanListAction(makeListOptions())

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      expect(mocks.mockListPlans).toHaveBeenCalled()
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      // Should include column headers
      expect(stdoutCalls.some((s) => s.includes('ID'))).toBe(true)
      expect(stdoutCalls.some((s) => s.includes('STATUS'))).toBe(true)
    })

    it('AC7: empty list → prints "No plans found."', async () => {
      mocks.mockListPlans.mockReturnValue([])

      const code = await runPlanListAction(makeListOptions())

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes('No plans found.'))).toBe(true)
    })

    it('AC7: json format → emits CLIJsonOutput envelope with data array', async () => {
      const plans = [makePlan()]
      mocks.mockListPlans.mockReturnValue(plans)

      const code = await runPlanListAction(makeListOptions({ outputFormat: 'json' }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      const jsonCall = stdoutCalls.find((s) => {
        try {
          const parsed = JSON.parse(s.trim()) as Record<string, unknown>
          return parsed.command === 'plan list' && Array.isArray(parsed.data)
        } catch {
          return false
        }
      })
      expect(jsonCall).toBeDefined()
    })

    it('AC7: json format includes success: true', async () => {
      mocks.mockListPlans.mockReturnValue([makePlan()])

      await runPlanListAction(makeListOptions({ outputFormat: 'json' }))

      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      const jsonCall = stdoutCalls.find((s) => s.includes('"success"'))
      expect(jsonCall).toBeDefined()
      const parsed = JSON.parse(jsonCall!.trim()) as Record<string, unknown>
      expect(parsed.success).toBe(true)
    })

    it('AC7: runMigrations called with db instance', async () => {
      mocks.mockListPlans.mockReturnValue([])

      await runPlanListAction(makeListOptions())

      expect(mocks.mockRunMigrations).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // runPlanShowAction
  // -------------------------------------------------------------------------

  describe('runPlanShowAction', () => {
    it('AC8: found plan → calls getPlanByPrefix(), prints plan detail', async () => {
      const plan = makePlan()
      mocks.mockGetPlanByPrefix.mockReturnValue(plan)

      const code = await runPlanShowAction('abc12345', makeShowOptions())

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      expect(mocks.mockGetPlanByPrefix).toHaveBeenCalledWith(expect.anything(), 'abc12345')
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes(plan.id))).toBe(true)
    })

    it('AC8: plan not found → exit code 2, error to stderr', async () => {
      mocks.mockGetPlanByPrefix.mockReturnValue(undefined)

      const code = await runPlanShowAction('notfound', makeShowOptions())

      expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
      const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
      expect(stderrCalls.some((s) => s.includes('No plan found'))).toBe(true)
    })

    it('AC8: json format → emits CLIJsonOutput with Plan data', async () => {
      const plan = makePlan()
      mocks.mockGetPlanByPrefix.mockReturnValue(plan)

      const code = await runPlanShowAction('abc12345', makeShowOptions({ outputFormat: 'json' }))

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      const jsonCall = stdoutCalls.find((s) => {
        try {
          const parsed = JSON.parse(s.trim()) as Record<string, unknown>
          return parsed.command === 'plan show'
        } catch {
          return false
        }
      })
      expect(jsonCall).toBeDefined()
      const parsed = JSON.parse(jsonCall!.trim()) as Record<string, unknown>
      expect(parsed.success).toBe(true)
      expect(parsed.data).toMatchObject({ id: plan.id })
    })

    it('AC8: human format shows plan YAML content', async () => {
      const plan = makePlan()
      mocks.mockGetPlanByPrefix.mockReturnValue(plan)

      const code = await runPlanShowAction('abc12345', makeShowOptions())

      expect(code).toBe(PLAN_EXIT_SUCCESS)
      const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
      expect(stdoutCalls.some((s) => s.includes(plan.plan_yaml))).toBe(true)
    })

    it('AC8: runMigrations called', async () => {
      mocks.mockGetPlanByPrefix.mockReturnValue(makePlan())

      await runPlanShowAction('abc', makeShowOptions())

      expect(mocks.mockRunMigrations).toHaveBeenCalled()
    })
  })
})
