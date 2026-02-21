/**
 * Unit tests for `src/cli/commands/plan.ts`
 *
 * Covers AC1-AC10 at the CLI layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// Mock PlanGenerator — use vi.hoisted to avoid hoisting issues
const mocks = vi.hoisted(() => {
  const mockGenerate = vi.fn()
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
  return { mockGenerate, MockPlanGenerator, PlanError }
})

vi.mock('../../../modules/plan-generator/plan-generator.js', () => ({
  PlanGenerator: mocks.MockPlanGenerator,
  PlanError: mocks.PlanError,
}))

vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 1, failedCount: 0, results: [] }),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
    register: vi.fn(),
  })),
}))

const mockEmitEvent = vi.fn()
vi.mock('../../formatters/streaming.js', () => ({
  emitEvent: (...args: unknown[]) => mockEmitEvent(...args),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const mockExistsSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: vi.fn().mockReturnValue(''),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runPlanAction, PLAN_EXIT_SUCCESS, PLAN_EXIT_ERROR, PLAN_EXIT_USAGE_ERROR } from '../plan.js'
import type { PlanActionOptions } from '../plan.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<PlanActionOptions> = {}): PlanActionOptions {
  return {
    goal: 'add authentication',
    outputPath: 'adt-plan.json',
    dryRun: false,
    outputFormat: 'human',
    projectRoot: '/test/project',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanAction', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    // Default: output dir exists
    mockExistsSync.mockReturnValue(true)

    // Default: generate succeeds
    mocks.mockGenerate.mockResolvedValue({
      success: true,
      outputPath: '/cwd/adt-plan.json',
      taskCount: 3,
    })

    // Reinitialize MockPlanGenerator mock with mockGenerate
    mocks.MockPlanGenerator.mockImplementation(() => ({
      generate: mocks.mockGenerate,
    }))

    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  // -------------------------------------------------------------------------
  // AC1: Successful plan generation
  // -------------------------------------------------------------------------

  it('AC1: valid goal → returns exit 0, prints progress and success messages', async () => {
    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_SUCCESS)
    const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    expect(stdoutCalls.some((s) => s.includes('Generating plan for:'))).toBe(true)
    expect(stdoutCalls.some((s) => s.includes('Plan written to:'))).toBe(true)
  })

  it('AC1: passes goal and resolved output path to PlanGenerator.generate()', async () => {
    await runPlanAction(makeOptions({ goal: 'add tests', outputPath: 'my-plan.json' }))

    expect(mocks.mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'add tests',
        dryRun: false,
      }),
    )
  })

  // -------------------------------------------------------------------------
  // AC2: Output file flag
  // -------------------------------------------------------------------------

  it('AC2: missing output dir → exit 2, error message printed', async () => {
    mockExistsSync.mockReturnValue(false)

    const code = await runPlanAction(
      makeOptions({ outputPath: '/nonexistent/subdir/plan.json' }),
    )

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
    const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
    expect(stderrCalls.some((s) => s.includes('Output directory does not exist'))).toBe(true)
  })

  it('AC2: relative output path is resolved to absolute path', async () => {
    await runPlanAction(makeOptions({ outputPath: 'my-plan.json' }))

    const generateCall = mocks.mockGenerate.mock.calls[0][0] as { outputPath: string }
    expect(generateCall.outputPath).toMatch(/^\//)
    expect(generateCall.outputPath).toContain('my-plan.json')
  })

  // -------------------------------------------------------------------------
  // AC3: Model flag
  // -------------------------------------------------------------------------

  it('AC3: --model is passed to PlanGenerator constructor', async () => {
    await runPlanAction(makeOptions({ model: 'claude-opus-4-5' }))

    const constructorCall = mocks.MockPlanGenerator.mock.calls[mocks.MockPlanGenerator.mock.calls.length - 1][0] as {
      model?: string
    }
    expect(constructorCall.model).toBe('claude-opus-4-5')
  })

  it('AC3: no --model → PlanGenerator constructed without model', async () => {
    await runPlanAction(makeOptions())

    const constructorCall = mocks.MockPlanGenerator.mock.calls[mocks.MockPlanGenerator.mock.calls.length - 1][0] as {
      model?: string
    }
    expect(constructorCall.model).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC4: Adapter flag
  // -------------------------------------------------------------------------

  it('AC4: --adapter is passed to PlanGenerator constructor as adapterId', async () => {
    await runPlanAction(makeOptions({ adapterId: 'codex' }))

    const constructorCall = mocks.MockPlanGenerator.mock.calls[mocks.MockPlanGenerator.mock.calls.length - 1][0] as {
      adapterId?: string
    }
    expect(constructorCall.adapterId).toBe('codex')
  })

  // -------------------------------------------------------------------------
  // AC6: Output format
  // -------------------------------------------------------------------------

  it('AC6: human format → prints progress and completion messages', async () => {
    await runPlanAction(makeOptions({ outputFormat: 'human' }))

    const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    expect(stdoutCalls.some((s) => s.includes('Generating plan for:'))).toBe(true)
    expect(stdoutCalls.some((s) => s.includes('Plan written to:'))).toBe(true)
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('AC6: json format → emits CLIJsonOutput envelope, no progress text', async () => {
    await runPlanAction(makeOptions({ outputFormat: 'json' }))

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
    const parsed = JSON.parse(jsonCall!.trim()) as { data: { taskCount: number } }
    expect(parsed.data.taskCount).toBe(3)
    expect(stdoutCalls.some((s) => s.includes('Generating plan for:'))).toBe(false)
    expect(stdoutCalls.some((s) => s.includes('Plan written to:'))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // AC7: Generation failure
  // -------------------------------------------------------------------------

  it('AC7: generate() returns success: false → stderr error, exit 1', async () => {
    mocks.mockGenerate.mockResolvedValue({ success: false, error: 'adapter crashed' })

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_ERROR)
    const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
    expect(stderrCalls.some((s) => s.includes('Plan generation failed:'))).toBe(true)
    expect(stderrCalls.some((s) => s.includes('adapter crashed'))).toBe(true)
  })

  it('AC7: no adapter error message → exit 2', async () => {
    mocks.mockGenerate.mockResolvedValue({
      success: false,
      error: "No planning-capable adapter is available. Run 'substrate adapters' to check adapter status.",
    })

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
  })

  it('AC7: adapter not available error message → exit 2', async () => {
    mocks.mockGenerate.mockResolvedValue({
      success: false,
      error: "Adapter 'codex' is not available or does not support plan generation",
    })

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
  })

  // -------------------------------------------------------------------------
  // AC8: Dry-run
  // -------------------------------------------------------------------------

  it('AC8: dry-run → dryRunPrompt printed, exit 0', async () => {
    mocks.mockGenerate.mockResolvedValue({
      success: true,
      dryRunPrompt: 'claude -p "planning prompt..."',
    })

    const code = await runPlanAction(makeOptions({ dryRun: true }))

    expect(code).toBe(PLAN_EXIT_SUCCESS)
    const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    expect(stdoutCalls.some((s) => s.includes('claude -p'))).toBe(true)
    expect(stdoutCalls.some((s) => s.includes('Plan written to:'))).toBe(false)
  })

  it('AC8: dry-run skips output dir existence check', async () => {
    mockExistsSync.mockReturnValue(false) // would normally fail
    mocks.mockGenerate.mockResolvedValue({
      success: true,
      dryRunPrompt: 'claude -p "..."',
    })

    const code = await runPlanAction(
      makeOptions({ dryRun: true, outputPath: '/nonexistent/plan.json' }),
    )

    expect(code).toBe(PLAN_EXIT_SUCCESS)
  })

  // -------------------------------------------------------------------------
  // AC10: No adapter available
  // -------------------------------------------------------------------------

  it('AC10: PlanError thrown with NO_PLANNING_ADAPTER code → exit 2', async () => {
    mocks.MockPlanGenerator.mockImplementationOnce(() => ({
      generate: vi.fn().mockRejectedValue(
        new mocks.PlanError(
          "No planning-capable adapter is available. Run 'substrate adapters' to check adapter status.",
          'NO_PLANNING_ADAPTER',
        ),
      ),
    }))

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
  })

  it('AC10: PlanError with ADAPTER_NOT_AVAILABLE code → exit 2', async () => {
    mocks.MockPlanGenerator.mockImplementationOnce(() => ({
      generate: vi.fn().mockRejectedValue(
        new mocks.PlanError(
          "Adapter 'codex' is not available or does not support plan generation",
          'ADAPTER_NOT_AVAILABLE',
        ),
      ),
    }))

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
  })

  // -------------------------------------------------------------------------
  // Unexpected error
  // -------------------------------------------------------------------------

  it('unexpected exception → stderr message, exit 1', async () => {
    mocks.MockPlanGenerator.mockImplementationOnce(() => ({
      generate: vi.fn().mockRejectedValue(new Error('unexpected crash')),
    }))

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_ERROR)
    const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
    expect(stderrCalls.some((s) => s.includes('unexpected crash'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // discoverAndRegister failure
  // -------------------------------------------------------------------------

  it('discoverAndRegister error → stderr message, exit 1', async () => {
    const { AdapterRegistry } = await import('../../../adapters/adapter-registry.js')
    vi.mocked(AdapterRegistry).mockImplementationOnce(() => ({
      discoverAndRegister: vi.fn().mockRejectedValue(new Error('registry failure')),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getPlanningCapable: vi.fn().mockReturnValue([]),
      register: vi.fn(),
    }) as unknown as InstanceType<typeof AdapterRegistry>)

    const code = await runPlanAction(makeOptions())

    expect(code).toBe(PLAN_EXIT_ERROR)
  })
})
