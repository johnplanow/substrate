/**
 * Unit tests for PlanGenerator
 *
 * Covers AC1, AC4, AC5, AC7, AC8, AC9, AC10
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock child_process execFile — must return a fake ChildProcess with stdin.end()
const mockExecFile = vi.fn()
const fakeChild = { stdin: { end: vi.fn() } }
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => { mockExecFile(...args); return fakeChild },
}))

// Mock fs functions
const mockReaddirSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockRenameSync = vi.fn()
const mockUnlinkSync = vi.fn()

vi.mock('fs', () => ({
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}))

// Mock js-yaml
vi.mock('js-yaml', () => ({
  dump: vi.fn((obj: unknown) => `yaml: ${JSON.stringify(obj)}`),
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

// Note: util.promisify no longer mocked — plan-generator uses execFileCloseStdin
// which calls execFile directly with a callback

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PlanGenerator, PlanError } from '../plan-generator.js'
import type { PlanGeneratorOptions } from '../plan-generator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<{
  id: string
  supportsPlanGeneration: boolean
  buildPlanningCommand: ReturnType<typeof vi.fn>
  parsePlanOutput: ReturnType<typeof vi.fn>
}> = {}) {
  const {
    id = 'claude-code',
    supportsPlanGeneration = true,
    buildPlanningCommand = vi.fn().mockReturnValue({
      binary: 'claude',
      args: ['-p', 'test prompt', '--output-format', 'json'],
      cwd: '/tmp',
    }),
    parsePlanOutput = vi.fn().mockReturnValue({
      success: true,
      tasks: [
        { title: 'Setup auth', description: 'Set up authentication', dependencies: [] },
        { title: 'Add login page', description: 'Create login form', dependencies: ['setup-auth'] },
      ],
    }),
  } = overrides

  return {
    id,
    displayName: id,
    adapterVersion: '1.0.0',
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, supportsHeadless: true }),
    buildCommand: vi.fn(),
    buildPlanningCommand,
    parseOutput: vi.fn(),
    parsePlanOutput,
    estimateTokens: vi.fn().mockReturnValue({ input: 100, output: 50, total: 150 }),
    getCapabilities: vi.fn().mockReturnValue({
      supportsJsonOutput: true,
      supportsStreaming: true,
      supportsSubscriptionBilling: true,
      supportsApiBilling: true,
      supportsPlanGeneration,
      maxContextTokens: 200000,
      supportedTaskTypes: ['coding'],
      supportedLanguages: ['*'],
    }),
  }
}

function makeRegistry(adapters: ReturnType<typeof makeAdapter>[] = []) {
  const adapterMap = new Map(adapters.map((a) => [a.id, a]))
  return {
    get: vi.fn((id: string) => adapterMap.get(id)),
    getAll: vi.fn(() => Array.from(adapterMap.values())),
    getPlanningCapable: vi.fn(() =>
      Array.from(adapterMap.values()).filter((a) => a.getCapabilities().supportsPlanGeneration),
    ),
    register: vi.fn(),
    discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 1, failedCount: 0, results: [] }),
  }
}

function makeOptions(overrides: Partial<PlanGeneratorOptions> = {}): PlanGeneratorOptions {
  const adapter = makeAdapter()
  const registry = makeRegistry([adapter])
  return {
    adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
    projectRoot: '/test/project',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default fs mocks
    mockReaddirSync.mockImplementation((path: string, opts?: unknown) => {
      if (String(path).includes('src') || (opts as { recursive?: boolean })?.recursive) {
        return ['index.ts', 'utils.ts', 'auth.ts']
      }
      return [
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false },
        { name: 'README.md', isDirectory: () => false },
      ]
    })
    mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'test-project' }))
    mockWriteFileSync.mockImplementation(() => undefined)
    mockRenameSync.mockImplementation(() => undefined)

    // Default execFile mock (success) — uses native callback signature (err, stdout, stderr)
    mockExecFile.mockImplementation(
      (_binary: string, _args: unknown[], _opts: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '{"tasks":[{"title":"Setup auth","description":"Set up auth"}]}', '')
      },
    )
  })

  // -------------------------------------------------------------------------
  // AC1: Basic plan generation
  // -------------------------------------------------------------------------

  describe('AC1: generate() — basic plan generation', () => {
    it('returns success with outputPath and taskCount', async () => {
      const adapter = makeAdapter({
        parsePlanOutput: vi.fn().mockReturnValue({
          success: true,
          tasks: [
            { title: 'Task One', description: 'Do thing one', dependencies: [] },
            { title: 'Task Two', description: 'Do thing two', dependencies: [] },
          ],
        }),
      })
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add authentication',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(true)
      expect(result.outputPath).toBe('/tmp/plan.json')
      expect(result.taskCount).toBe(2)
    })

    it('writes temp file and renames atomically', async () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      await generator.generate({ goal: 'add auth', outputPath: '/tmp/plan.json' })

      expect(mockWriteFileSync).toHaveBeenCalledOnce()
      expect(mockRenameSync).toHaveBeenCalledOnce()
      const tmpPath = mockWriteFileSync.mock.calls[0][0] as string
      expect(tmpPath).toMatch(/\/tmp\/plan\.json\.tmp\.\d+/)
      expect(mockRenameSync.mock.calls[0][1]).toBe('/tmp/plan.json')
    })

    it('writes JSON for .json output path', async () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      await generator.generate({ goal: 'add auth', outputPath: '/tmp/plan.json' })

      const content = mockWriteFileSync.mock.calls[0][1] as string
      expect(() => JSON.parse(content)).not.toThrow()
    })

    it('writes YAML for .yaml output path', async () => {
      const { dump } = await import('js-yaml')
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      await generator.generate({ goal: 'add auth', outputPath: '/tmp/plan.yaml' })

      expect(dump).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Adapter selection
  // -------------------------------------------------------------------------

  describe('AC4: adapter selection', () => {
    it('uses specified adapterId when registered and supports planning', async () => {
      const codexAdapter = makeAdapter({ id: 'codex' })
      const claudeAdapter = makeAdapter({ id: 'claude-code' })
      const registry = makeRegistry([codexAdapter, claudeAdapter])

      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
        adapterId: 'codex',
      })

      await generator.generate({ goal: 'fix tests', outputPath: '/tmp/plan.json' })

      expect(codexAdapter.buildPlanningCommand).toHaveBeenCalled()
      expect(claudeAdapter.buildPlanningCommand).not.toHaveBeenCalled()
    })

    it('throws PlanError when specified adapterId is not registered', async () => {
      const registry = makeRegistry([])
      registry.get = vi.fn().mockReturnValue(undefined)

      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
        adapterId: 'unknown-adapter',
      })

      const result = await generator.generate({
        goal: 'add feature',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Adapter 'unknown-adapter' is not available")
    })

    it('throws PlanError when specified adapter does not support plan generation', async () => {
      const noplanAdapter = makeAdapter({ id: 'noplanner', supportsPlanGeneration: false })
      const registry = makeRegistry([noplanAdapter])

      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
        adapterId: 'noplanner',
      })

      const result = await generator.generate({
        goal: 'add feature',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('does not support plan generation')
    })

    it('auto-selects first planning-capable adapter when adapterId is omitted', async () => {
      const adapter1 = makeAdapter({ id: 'adapter-1' })
      const adapter2 = makeAdapter({ id: 'adapter-2' })
      const registry = makeRegistry([adapter1, adapter2])

      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      await generator.generate({ goal: 'add feature', outputPath: '/tmp/plan.json' })

      expect(adapter1.buildPlanningCommand).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Project context collection
  // -------------------------------------------------------------------------

  describe('AC5: collectProjectContext() via generate()', () => {
    it('includes project root, directory listing, and package name in context', async () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/my/project',
      })

      await generator.generate({ goal: 'add feature', outputPath: '/tmp/plan.json' })

      const buildCall = adapter.buildPlanningCommand.mock.calls[0]
      const planRequest = buildCall[0] as { goal: string; context?: string }
      expect(planRequest.context).toContain('Project root: /my/project')
      expect(planRequest.context).toContain('test-project') // from package.json mock
    })

    it('includes detected file extensions when src/ is scannable', async () => {
      mockReaddirSync.mockImplementation((path: string, opts?: unknown) => {
        if (String(path).includes('src') || (opts as { recursive?: boolean })?.recursive) {
          return ['index.ts', 'utils.js', 'styles.css']
        }
        return [{ name: 'src', isDirectory: () => true }]
      })

      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/my/project',
      })

      await generator.generate({ goal: 'add feature', outputPath: '/tmp/plan.json' })

      const buildCall = adapter.buildPlanningCommand.mock.calls[0]
      const planRequest = buildCall[0] as { goal: string; context?: string }
      expect(planRequest.context).toContain('.ts')
    })

    it('still returns partial context when src/ read fails', async () => {
      mockReaddirSync.mockImplementation((path: string) => {
        if (String(path).includes('src')) {
          throw new Error('ENOENT: no such file or directory')
        }
        return [{ name: 'README.md', isDirectory: () => false }]
      })

      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/my/project',
      })

      // Should not throw
      const result = await generator.generate({ goal: 'add feature', outputPath: '/tmp/plan.json' })
      expect(result.success).toBe(true)

      const buildCall = adapter.buildPlanningCommand.mock.calls[0]
      const planRequest = buildCall[0] as { goal: string; context?: string }
      // Should still have project root
      expect(planRequest.context).toContain('Project root:')
    })

    it('does not throw when package.json is missing', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory')
      })

      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/my/project',
      })

      const result = await generator.generate({ goal: 'add feature', outputPath: '/tmp/plan.json' })
      expect(result.success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Error handling
  // -------------------------------------------------------------------------

  describe('AC7: error handling', () => {
    it('returns failure when parsePlanOutput returns success: false', async () => {
      const adapter = makeAdapter({
        parsePlanOutput: vi.fn().mockReturnValue({
          success: false,
          tasks: [],
          error: 'Plan output missing tasks array',
        }),
      })
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add auth',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Plan output missing tasks array')
      // No file written
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('returns timeout error when execFile times out', async () => {
      const timeoutError = new Error('Command timed out') as NodeJS.ErrnoException
      timeoutError.code = 'ETIMEDOUT'
      mockExecFile.mockImplementation(
        (_binary: string, _args: unknown[], _opts: unknown, callback: (err: NodeJS.ErrnoException, stdout: string, stderr: string) => void) => {
          callback(timeoutError, '', '')
        },
      )

      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add auth',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
    })

    it('cleans up tmp file when rename fails', async () => {
      mockRenameSync.mockImplementation(() => {
        throw new Error('ENOENT: cross-device rename')
      })

      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add auth',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(false)
      expect(mockUnlinkSync).toHaveBeenCalled()
    })

    it('passes non-zero exit code to parsePlanOutput', async () => {
      const nonZeroError = new Error('Process failed') as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      nonZeroError.code = 1
      mockExecFile.mockImplementation(
        (_binary: string, _args: unknown[], _opts: unknown, callback: (err: NodeJS.ErrnoException, stdout: string, stderr: string) => void) => {
          callback(nonZeroError, '', 'adapter error')
        },
      )

      const parsePlanOutput = vi.fn().mockReturnValue({
        success: false,
        tasks: [],
        error: 'adapter error',
      })
      const adapter = makeAdapter({ parsePlanOutput })
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add auth',
        outputPath: '/tmp/plan.json',
      })

      expect(parsePlanOutput).toHaveBeenCalledWith('', 'adapter error', 1)
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // AC8: Dry-run
  // -------------------------------------------------------------------------

  describe('AC8: dry-run mode', () => {
    it('returns dryRunPrompt without invoking execFile', async () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add logging',
        outputPath: '/tmp/plan.json',
        dryRun: true,
      })

      expect(result.success).toBe(true)
      expect(result.dryRunPrompt).toBeDefined()
      expect(mockExecFile).not.toHaveBeenCalled()
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC9: TaskGraph conversion
  // -------------------------------------------------------------------------

  describe('AC9: convertToTaskGraph()', () => {
    it('produces valid TaskGraphFile with required fields', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const planResult = {
        success: true,
        tasks: [
          { title: 'Setup Auth', description: 'Set up authentication layer', dependencies: [] },
          { title: 'Add Login Page', description: 'Create login UI', dependencies: [], complexity: 3 },
        ],
      }

      const graph = generator.convertToTaskGraph(planResult, 'add authentication to my app')

      expect(graph.version).toBe('1')
      expect(graph.session.name).toBe('add authentication to my app')
      expect(Object.keys(graph.tasks)).toHaveLength(2)

      const firstKey = Object.keys(graph.tasks)[0]
      const firstTask = graph.tasks[firstKey]
      expect(firstTask.name).toBe('Setup Auth')
      expect(firstTask.prompt).toBeTruthy()
      expect(firstTask.type).toBe('coding')
      expect(firstTask.depends_on).toEqual([])
    })

    it('truncates session name to 80 characters', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const longGoal = 'a'.repeat(100)
      const graph = generator.convertToTaskGraph({ success: true, tasks: [] }, longGoal)

      expect(graph.session.name).toHaveLength(80)
    })

    it('generates slug keys from task titles', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const graph = generator.convertToTaskGraph(
        {
          success: true,
          tasks: [{ title: 'Add User Authentication!', description: 'Auth task', dependencies: [] }],
        },
        'add auth',
      )

      const keys = Object.keys(graph.tasks)
      expect(keys[0]).toMatch(/^[a-z0-9-]+$/)
      expect(keys[0]).toContain('add-user-authentication')
    })

    it('removes invalid depends_on references with a warning', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const graph = generator.convertToTaskGraph(
        {
          success: true,
          tasks: [
            { title: 'Task A', description: 'First task', dependencies: [] },
            { title: 'Task B', description: 'Second task', dependencies: ['nonexistent-key'] },
          ],
        },
        'goal',
      )

      // task-b's depends_on should be empty after removing invalid reference
      const taskBKey = Object.keys(graph.tasks).find((k) => k.includes('task-b'))
      expect(graph.tasks[taskBKey!].depends_on).toEqual([])
    })

    it('resolves depends_on human-readable titles to slugified keys', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      // AI returns human-readable title in depends_on, not the slugified key
      const graph = generator.convertToTaskGraph(
        {
          success: true,
          tasks: [
            { title: 'Identify Entry Point', description: 'Find main file', dependencies: [] },
            { title: 'Install Express.js', description: 'Add Express', dependencies: ['Identify Entry Point'] },
          ],
        },
        'add hello world endpoint',
      )

      const installKey = Object.keys(graph.tasks).find((k) => k.includes('install'))
      expect(installKey).toBeDefined()
      // Should resolve "Identify Entry Point" → "identify-entry-point"
      expect(graph.tasks[installKey!].depends_on).toEqual(['identify-entry-point'])
    })

    it('uses title as prompt when description is empty', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const graph = generator.convertToTaskGraph(
        {
          success: true,
          tasks: [{ title: 'My Task Title', description: '', dependencies: [] }],
        },
        'goal',
      )

      const firstKey = Object.keys(graph.tasks)[0]
      expect(graph.tasks[firstKey].prompt).toBe('My Task Title')
    })

    it('sets budget_usd from complexity when provided', () => {
      const adapter = makeAdapter()
      const registry = makeRegistry([adapter])
      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const graph = generator.convertToTaskGraph(
        {
          success: true,
          tasks: [{ title: 'Task', description: 'Desc', dependencies: [], complexity: 5 }],
        },
        'goal',
      )

      const firstKey = Object.keys(graph.tasks)[0]
      expect(graph.tasks[firstKey].budget_usd).toBe(0.5)
    })
  })

  // -------------------------------------------------------------------------
  // AC10: No planning-capable adapter
  // -------------------------------------------------------------------------

  describe('AC10: no planning-capable adapter', () => {
    it('returns failure with descriptive error when no planning adapters are available', async () => {
      const registry = makeRegistry([])
      registry.getPlanningCapable = vi.fn().mockReturnValue([])

      const generator = new PlanGenerator({
        adapterRegistry: registry as unknown as import('../../../adapters/adapter-registry.js').AdapterRegistry,
        projectRoot: '/test/project',
      })

      const result = await generator.generate({
        goal: 'add feature',
        outputPath: '/tmp/plan.json',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('No planning-capable adapter is available')
      expect(result.error).toContain('substrate adapters')
    })
  })

  // -------------------------------------------------------------------------
  // PlanError class
  // -------------------------------------------------------------------------

  describe('PlanError', () => {
    it('has name PlanError and stores code', () => {
      const err = new PlanError('test message', 'TEST_CODE')
      expect(err.name).toBe('PlanError')
      expect(err.message).toBe('test message')
      expect(err.code).toBe('TEST_CODE')
      expect(err).toBeInstanceOf(Error)
    })

    it('works without code', () => {
      const err = new PlanError('test message')
      expect(err.code).toBeUndefined()
    })
  })
})
