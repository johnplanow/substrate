/**
 * Unit tests for codebase-aware plan command (Story 7-2)
 *
 * Tests the new --codebase, --context-depth, --agent-count flags added to plan.ts.
 * Covers AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC10.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

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

  class ScanError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.name = 'ScanError'
      this.code = code
    }
  }

  const mockScanCodebase = vi.fn()

  return { mockGenerate, MockPlanGenerator, PlanError, ScanError, mockScanCodebase }
})

vi.mock('../../../modules/plan-generator/plan-generator.js', () => ({
  PlanGenerator: mocks.MockPlanGenerator,
  PlanError: mocks.PlanError,
}))

vi.mock('../../../modules/plan-generator/codebase-scanner.js', () => ({
  scanCodebase: (...args: unknown[]) => mocks.mockScanCodebase(...args),
  ScanError: mocks.ScanError,
}))

const mockRegistryInstance = {
  discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 2, failedCount: 0, results: [] }),
  get: vi.fn(),
  getAll: vi.fn().mockReturnValue([
    {
      id: 'claude',
      displayName: 'Claude Code',
      getCapabilities: vi.fn().mockReturnValue({
        supportedTaskTypes: ['coding', 'testing', 'debugging'],
        supportsSubscriptionBilling: true,
        supportsApiBilling: false,
        supportsPlanGeneration: true,
        supportsJsonOutput: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        supportedLanguages: ['*'],
      }),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, supportsHeadless: true }),
    },
    {
      id: 'codex',
      displayName: 'Codex CLI',
      getCapabilities: vi.fn().mockReturnValue({
        supportedTaskTypes: ['coding', 'refactoring'],
        supportsSubscriptionBilling: false,
        supportsApiBilling: true,
        supportsPlanGeneration: true,
        supportsJsonOutput: true,
        supportsStreaming: false,
        maxContextTokens: 100000,
        supportedLanguages: ['*'],
      }),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, supportsHeadless: true }),
    },
  ]),
  getPlanningCapable: vi.fn().mockReturnValue([]),
  register: vi.fn(),
}

vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => mockRegistryInstance),
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
    goal: 'Add authentication',
    outputPath: 'adt-plan.json',
    dryRun: false,
    outputFormat: 'human',
    projectRoot: '/test/project',
    contextDepth: 2,
    ...overrides,
  }
}

function makeCodebaseContext(overrides = {}) {
  return {
    rootPath: '/test/project',
    detectedLanguages: ['TypeScript', 'JavaScript'],
    techStack: [
      { name: 'Node.js', source: 'package.json' },
      { name: 'TypeScript', version: '^5.0.0', source: 'package.json' },
    ],
    topLevelDirs: ['src', 'test'],
    keyFiles: [
      { relativePath: 'package.json', contentSummary: '{}', skipped: false },
      { relativePath: 'tsconfig.json', contentSummary: '{}', skipped: false },
    ],
    dependencies: {
      runtime: { commander: '^12.0.0' },
      development: { vitest: '^1.0.0' },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan command — codebase-aware (Story 7-2)', () => {
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

    // Default: scanCodebase returns a valid context
    mocks.mockScanCodebase.mockResolvedValue(makeCodebaseContext())

    // Re-initialize MockPlanGenerator
    mocks.MockPlanGenerator.mockImplementation(() => ({
      generate: mocks.mockGenerate,
    }))

    // Re-attach getAll mock
    mockRegistryInstance.getAll.mockReturnValue([
      {
        id: 'claude',
        displayName: 'Claude Code',
        getCapabilities: vi.fn().mockReturnValue({
          supportedTaskTypes: ['coding', 'testing', 'debugging'],
          supportsSubscriptionBilling: true,
          supportsApiBilling: false,
          supportsPlanGeneration: true,
          supportsJsonOutput: true,
          supportsStreaming: true,
          maxContextTokens: 200000,
          supportedLanguages: ['*'],
        }),
        healthCheck: vi.fn().mockResolvedValue({ healthy: true, supportsHeadless: true }),
      },
      {
        id: 'codex',
        displayName: 'Codex CLI',
        getCapabilities: vi.fn().mockReturnValue({
          supportedTaskTypes: ['coding', 'refactoring'],
          supportsSubscriptionBilling: false,
          supportsApiBilling: true,
          supportsPlanGeneration: true,
          supportsJsonOutput: true,
          supportsStreaming: false,
          maxContextTokens: 100000,
          supportedLanguages: ['*'],
        }),
        healthCheck: vi.fn().mockResolvedValue({ healthy: true, supportsHeadless: true }),
      },
    ])

    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  // -------------------------------------------------------------------------
  // AC6: --goal required with --codebase
  // -------------------------------------------------------------------------

  it('AC6: --codebase without --goal → exit 2, stderr contains --goal is required', async () => {
    const code = await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: '' }),
    )

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
    const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
    expect(stderrCalls.some((s) => s.includes('--goal is required'))).toBe(true)
  })

  it('AC6: --codebase with --goal → proceeds normally', async () => {
    const code = await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth' }),
    )

    expect(code).toBe(PLAN_EXIT_SUCCESS)
  })

  // -------------------------------------------------------------------------
  // AC7: codebase path validation errors
  // -------------------------------------------------------------------------

  it('AC7: ScanError SCAN_PATH_NOT_FOUND → exit 2, stderr contains Codebase path not found', async () => {
    mocks.mockScanCodebase.mockRejectedValue(
      new mocks.ScanError('Codebase path not found: /bad/path', 'SCAN_PATH_NOT_FOUND'),
    )

    const code = await runPlanAction(
      makeOptions({ codebasePath: '/bad/path', goal: 'Add auth' }),
    )

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
    const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
    expect(stderrCalls.some((s) => s.includes('Codebase path not found'))).toBe(true)
  })

  it('AC7: ScanError SCAN_PATH_NOT_DIR → exit 2, stderr contains Codebase path is not a directory', async () => {
    mocks.mockScanCodebase.mockRejectedValue(
      new mocks.ScanError('Codebase path is not a directory: /bad/file.txt', 'SCAN_PATH_NOT_DIR'),
    )

    const code = await runPlanAction(
      makeOptions({ codebasePath: '/bad/file.txt', goal: 'Add auth' }),
    )

    expect(code).toBe(PLAN_EXIT_USAGE_ERROR)
    const stderrCalls = stderrWrite.mock.calls.map((c) => String(c[0]))
    expect(stderrCalls.some((s) => s.includes('Codebase path is not a directory'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC1: scanCodebase called with correct args
  // -------------------------------------------------------------------------

  it('AC1: --codebase ./proj --goal "Add auth" → scanCodebase called with codebasePath and default depth 2', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth', contextDepth: 2 }),
    )

    expect(mocks.mockScanCodebase).toHaveBeenCalledWith('/some/project', { contextDepth: 2 })
  })

  it('AC1: without --codebase → scanCodebase NOT called', async () => {
    await runPlanAction(makeOptions({ goal: 'Add auth' }))

    expect(mocks.mockScanCodebase).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC2: --context-depth passed to scanCodebase
  // -------------------------------------------------------------------------

  it('AC2: --context-depth 3 → scanCodebase called with contextDepth: 3', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth', contextDepth: 3 }),
    )

    expect(mocks.mockScanCodebase).toHaveBeenCalledWith('/some/project', { contextDepth: 3 })
  })

  it('AC2: --context-depth 0 → scanCodebase called with contextDepth: 0', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth', contextDepth: 0 }),
    )

    expect(mocks.mockScanCodebase).toHaveBeenCalledWith('/some/project', { contextDepth: 0 })
  })

  // -------------------------------------------------------------------------
  // AC3: --agent-count passed to PlanGenerator
  // -------------------------------------------------------------------------

  it('AC3: --agent-count 3 → PlanGenerator constructed with agentCount: 3', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth', agentCount: 3 }),
    )

    const constructorCall = mocks.MockPlanGenerator.mock.calls[mocks.MockPlanGenerator.mock.calls.length - 1][0] as {
      agentCount?: number
    }
    expect(constructorCall.agentCount).toBe(3)
  })

  // -------------------------------------------------------------------------
  // AC5: available agents from registry
  // -------------------------------------------------------------------------

  it('AC5: two registered adapters → PlanGenerator constructed with availableAgents of length 2', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth' }),
    )

    const constructorCall = mocks.MockPlanGenerator.mock.calls[mocks.MockPlanGenerator.mock.calls.length - 1][0] as {
      availableAgents?: unknown[]
    }
    expect(Array.isArray(constructorCall.availableAgents)).toBe(true)
    expect(constructorCall.availableAgents!.length).toBe(2)
  })

  // -------------------------------------------------------------------------
  // AC8: --description only (no --codebase) → backward compatibility
  // -------------------------------------------------------------------------

  it('AC8: invocation with only goal (no --codebase) → scanCodebase NOT called, behavior unchanged', async () => {
    const code = await runPlanAction(makeOptions({ goal: 'add tests' }))

    expect(code).toBe(PLAN_EXIT_SUCCESS)
    expect(mocks.mockScanCodebase).not.toHaveBeenCalled()

    const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    expect(stdoutCalls.some((s) => s.includes('Generating plan for:'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC10: human format prints codebase context extracted
  // -------------------------------------------------------------------------

  it('AC10: --output-format human with codebase → stdout contains "Codebase context extracted:"', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth', outputFormat: 'human' }),
    )

    const stdoutCalls = stdoutWrite.mock.calls.map((c) => String(c[0]))
    expect(stdoutCalls.some((s) => s.includes('Codebase context extracted:'))).toBe(true)
  })

  it('AC10: --output-format json with codebase → CLIJsonOutput contains codebase_context key', async () => {
    await runPlanAction(
      makeOptions({ codebasePath: '/some/project', goal: 'Add auth', outputFormat: 'json' }),
    )

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
    const parsed = JSON.parse(jsonCall!.trim()) as { data: Record<string, unknown> }
    expect(parsed.data.codebase_context).toBeDefined()
  })

  it('AC10: --output-format json without codebase → CLIJsonOutput does not contain codebase_context key', async () => {
    await runPlanAction(makeOptions({ goal: 'Add auth', outputFormat: 'json' }))

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
    const parsed = JSON.parse(jsonCall!.trim()) as { data: Record<string, unknown> }
    expect(parsed.data.codebase_context).toBeUndefined()
  })
})
