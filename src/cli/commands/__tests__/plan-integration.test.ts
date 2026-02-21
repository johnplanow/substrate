/**
 * Integration tests for `substrate plan` command (AC1, AC9)
 *
 * Uses temp directory and validates TaskGraphFile output via TaskGraphFileSchema.
 * Uses real fs (no fs mock) and mocks only child_process + adapter registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync as realWriteFileSync, readFileSync as realReadFileSync, existsSync as realExistsSync } from 'fs'
import { join } from 'path'
import { tmpdir as osTmpdir } from 'os'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const intMocks = vi.hoisted(() => {
  const mockExecFile = vi.fn()
  const mockBuildPlanningCommand = vi.fn()
  const mockParsePlanOutput = vi.fn()
  const mockDiscoverAndRegister = vi.fn()
  const mockGetPlanningCapable = vi.fn()

  return {
    mockExecFile,
    mockBuildPlanningCommand,
    mockParsePlanOutput,
    mockDiscoverAndRegister,
    mockGetPlanningCapable,
  }
})

// Mock child_process execFile
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => intMocks.mockExecFile(...args),
}))

// Mock util.promisify
vi.mock('util', () => ({
  promisify: (_fn: unknown) => {
    return async (...args: unknown[]) => {
      return new Promise((resolve, reject) => {
        intMocks.mockExecFile(...args, (err: unknown, result: unknown) => {
          if (err) reject(err)
          else resolve(result)
        })
      })
    }
  },
}))

// Mock AdapterRegistry using hoisted mocks
vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: intMocks.mockDiscoverAndRegister,
    get: vi.fn().mockReturnValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: intMocks.mockGetPlanningCapable,
    register: vi.fn(),
  })),
}))

// Mock js-yaml
vi.mock('js-yaml', () => ({
  dump: vi.fn((obj: unknown) => JSON.stringify(obj, null, 2)),
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

// Mock emitEvent
vi.mock('../../formatters/streaming.js', () => ({
  emitEvent: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runPlanAction } from '../plan.js'
import { TaskGraphFileSchema } from '../../../modules/task-graph/schemas.js'
import { parseGraphFile } from '../../../modules/task-graph/task-parser.js'
import { validateGraph } from '../../../modules/task-graph/task-validator.js'
import { AdapterRegistry } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan integration', () => {
  let tmpDir: string
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  function getMockAdapter() {
    return {
      id: 'claude-code',
      displayName: 'Claude Code',
      adapterVersion: '1.0.0',
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, supportsHeadless: true }),
      buildCommand: vi.fn(),
      buildPlanningCommand: intMocks.mockBuildPlanningCommand,
      parseOutput: vi.fn(),
      parsePlanOutput: intMocks.mockParsePlanOutput,
      estimateTokens: vi.fn(),
      getCapabilities: vi.fn().mockReturnValue({
        supportsPlanGeneration: true,
        supportsJsonOutput: true,
        supportsStreaming: true,
        supportsSubscriptionBilling: true,
        supportsApiBilling: true,
        maxContextTokens: 200000,
        supportedTaskTypes: ['coding'],
        supportedLanguages: ['*'],
      }),
    }
  }

  beforeEach(() => {
    // Create temp dir with a minimal package.json
    tmpDir = mkdtempSync(join(osTmpdir(), 'substrate-plan-integ-'))
    realWriteFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project' }))

    // Restore AdapterRegistry mock implementation (vi.restoreAllMocks may have cleared it)
    vi.mocked(AdapterRegistry).mockImplementation(() => ({
      discoverAndRegister: intMocks.mockDiscoverAndRegister,
      get: vi.fn().mockReturnValue(undefined),
      getAll: vi.fn().mockReturnValue([]),
      getPlanningCapable: intMocks.mockGetPlanningCapable,
      register: vi.fn(),
    }) as unknown as InstanceType<typeof AdapterRegistry>)

    // Set up adapter mock returns
    intMocks.mockBuildPlanningCommand.mockReturnValue({
      binary: 'echo',
      args: ['{}'],
      cwd: tmpDir,
    })

    intMocks.mockParsePlanOutput.mockReturnValue({
      success: true,
      tasks: [
        {
          title: 'Add Authentication Module',
          description: 'Create authentication system with JWT',
          dependencies: [],
          complexity: 5,
        },
        {
          title: 'Write Auth Tests',
          description: 'Write unit tests for authentication',
          dependencies: [],
        },
      ],
    })

    intMocks.mockDiscoverAndRegister.mockResolvedValue({
      registeredCount: 1,
      failedCount: 0,
      results: [],
    })

    intMocks.mockGetPlanningCapable.mockReturnValue([getMockAdapter()])

    // execFile succeeds
    intMocks.mockExecFile.mockImplementation(
      (
        _binary: string,
        _args: unknown[],
        _opts: unknown,
        callback: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, {
          stdout: JSON.stringify({
            tasks: [
              {
                title: 'Add Authentication Module',
                description: 'Create authentication system with JWT',
                complexity: 5,
                dependencies: [],
              },
              {
                title: 'Write Auth Tests',
                description: 'Write unit tests for authentication',
                dependencies: [],
              },
            ],
          }),
          stderr: '',
        })
      },
    )

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    // Restore only the process spies we created, not module mocks
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('AC1: generates a valid TaskGraphFile and writes it to disk', async () => {
    const outputPath = join(tmpDir, 'plan.json')

    const exitCode = await runPlanAction({
      goal: 'add tests',
      outputPath,
      dryRun: false,
      outputFormat: 'human',
      projectRoot: tmpDir,
    })

    expect(exitCode).toBe(0)
    expect(realExistsSync(outputPath)).toBe(true)

    const content = realReadFileSync(outputPath, 'utf-8')
    const parsed = JSON.parse(content) as unknown

    // Validate against TaskGraphFileSchema
    const result = TaskGraphFileSchema.safeParse(parsed)
    expect(result.success).toBe(true)

    if (result.success) {
      expect(result.data.version).toBe('1')
      expect(result.data.session.name).toBeTruthy()
      expect(Object.keys(result.data.tasks).length).toBeGreaterThan(0)

      // All tasks must have name, prompt, type
      for (const [, task] of Object.entries(result.data.tasks)) {
        expect(task.name).toBeTruthy()
        expect(task.prompt).toBeTruthy()
        expect(['coding', 'testing', 'docs', 'debugging', 'refactoring']).toContain(task.type)
      }
    }
  })

  it('AC9: output file is valid for substrate start (parseGraphFile + validateGraph)', async () => {
    const outputPath = join(tmpDir, 'plan-ac9.json')

    const exitCode = await runPlanAction({
      goal: 'add tests',
      outputPath,
      dryRun: false,
      outputFormat: 'human',
      projectRoot: tmpDir,
    })

    expect(exitCode).toBe(0)
    expect(realExistsSync(outputPath)).toBe(true)

    // Simulate substrate start validation
    const raw = parseGraphFile(outputPath)
    const validation = validateGraph(raw)

    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    expect(validation.graph).toBeDefined()
    expect(Object.keys(validation.graph!.tasks).length).toBeGreaterThan(0)
  })

  it('AC1: exit code is 0 on success', async () => {
    const outputPath = join(tmpDir, 'plan3.json')

    const exitCode = await runPlanAction({
      goal: 'add auth',
      outputPath,
      dryRun: false,
      outputFormat: 'human',
      projectRoot: tmpDir,
    })

    expect(exitCode).toBe(0)
  })
})
