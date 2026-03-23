/**
 * Unit tests for `substrate factory run` CLI subcommand.
 *
 * AC4 — `--graph pipeline.dot` with valid graph runs without throwing.
 * AC5 — no `--graph`, config returns factory.graph, executor runs with that path.
 * AC6 — no `--graph`, no config factory.graph, process.stderr + process.exit(1).
 * AC7 — `--events` flag causes event bus listeners to write JSON lines to stdout.
 *
 * Story 44-9.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerFactoryCommand } from '../factory-command.js'

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports in vitest)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

vi.mock('../graph/parser.js', () => ({
  parseGraph: vi.fn(),
}))

vi.mock('../graph/validator.js', () => ({
  createValidator: vi.fn(),
}))

vi.mock('../graph/executor.js', () => ({
  createGraphExecutor: vi.fn(),
}))

vi.mock('../handlers/index.js', () => ({
  createDefaultRegistry: vi.fn(),
  HandlerRegistry: vi.fn(),
}))

vi.mock('../config.js', () => ({
  loadFactoryConfig: vi.fn(),
}))

vi.mock('../scenarios/cli-command.js', () => ({
  registerScenariosCommand: vi.fn(),
}))

vi.mock('../graph/run-state.js', () => ({
  RunStateManager: vi.fn().mockImplementation(() => ({
    initRun: vi.fn().mockResolvedValue(undefined),
    writeNodeArtifacts: vi.fn().mockResolvedValue(undefined),
    writeScenarioIteration: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock graph with start and exit nodes */
const mockGraph = {
  nodes: new Map([
    ['start', { id: 'start', type: 'start', label: 'Start' }],
    ['exit', { id: 'exit', type: 'exit', label: 'Exit' }],
  ]),
  edges: [],
  startNode: () => ({ id: 'start', type: 'start', label: 'Start' }),
  exitNode: () => ({ id: 'exit', type: 'exit', label: 'Exit' }),
}

/** Default config with no factory graph set */
const defaultConfig = {
  config_format_version: '1',
  global: { log_level: 'info', max_concurrent_tasks: 4, budget_cap_tokens: 0, budget_cap_usd: 0 },
  providers: {},
  factory: undefined,
}

/**
 * Create a fresh Commander root program with the factory command registered.
 * Uses `['node', 'substrate', 'factory', 'run', ...args]` pattern per codebase convention.
 */
async function runCmd(args: string[]) {
  const program = new Command()
  program.exitOverride()
  registerFactoryCommand(program)
  await program.parseAsync(['node', 'substrate', 'factory', 'run', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('substrate factory run command', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any

  beforeEach(async () => {
    vi.clearAllMocks()

    // Spy on stderr/stdout/exit to capture output and prevent actual exit
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as () => never)

    // Default happy-path mocks
    const { readFile } = await import('node:fs/promises')
    vi.mocked(readFile).mockResolvedValue('digraph G { start -> exit }')

    const { parseGraph } = await import('../graph/parser.js')
    vi.mocked(parseGraph).mockReturnValue(mockGraph as never)

    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    const { createGraphExecutor } = await import('../graph/executor.js')
    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    })

    const { createDefaultRegistry } = await import('../handlers/index.js')
    vi.mocked(createDefaultRegistry).mockReturnValue({} as never)

    // Re-initialize RunStateManager mock (vi.restoreAllMocks in afterEach resets vi.fn() impls)
    const { RunStateManager } = await import('../graph/run-state.js')
    vi.mocked(RunStateManager).mockImplementation(() => ({
      runDir: '',
      initRun: vi.fn().mockResolvedValue(undefined),
      writeNodeArtifacts: vi.fn().mockResolvedValue(undefined),
      writeScenarioIteration: vi.fn().mockResolvedValue(undefined),
    }))

    const { loadFactoryConfig } = await import('../config.js')
    vi.mocked(loadFactoryConfig).mockResolvedValue(defaultConfig as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC4: --graph flag with valid graph runs without throwing
  // -------------------------------------------------------------------------

  it('AC4: --graph pipeline.dot with mocked parser/executor runs without throwing', async () => {
    await expect(runCmd(['--graph', 'pipeline.dot'])).resolves.not.toThrow()
  })

  it('AC4: calls parseGraph with the DOT file content', async () => {
    const { parseGraph } = await import('../graph/parser.js')

    await runCmd(['--graph', 'pipeline.dot'])

    expect(vi.mocked(parseGraph)).toHaveBeenCalledWith('digraph G { start -> exit }')
  })

  it('AC4: calls createGraphExecutor and runs the graph', async () => {
    const { createGraphExecutor } = await import('../graph/executor.js')

    await runCmd(['--graph', 'pipeline.dot'])

    expect(vi.mocked(createGraphExecutor)).toHaveBeenCalled()
    expect(vi.mocked(createGraphExecutor)().run).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC5: no --graph flag, config returns factory.graph
  // -------------------------------------------------------------------------

  it('AC5: no --graph flag uses factory.graph from config', async () => {
    const { loadFactoryConfig } = await import('../config.js')
    vi.mocked(loadFactoryConfig).mockResolvedValue({
      ...defaultConfig,
      factory: {
        graph: 'pipeline.dot',
        scenario_dir: '.substrate/scenarios/',
        satisfaction_threshold: 0.8,
        budget_cap_usd: 0,
        wall_clock_cap_seconds: 0,
        plateau_window: 3,
        plateau_threshold: 0.05,
        backend: 'cli' as const,
      },
    } as never)

    const { parseGraph } = await import('../graph/parser.js')
    const { createGraphExecutor } = await import('../graph/executor.js')

    await runCmd([])

    expect(vi.mocked(parseGraph)).toHaveBeenCalled()
    expect(vi.mocked(createGraphExecutor)().run).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC6: no --graph, no factory.graph, exits with error
  // -------------------------------------------------------------------------

  it('AC6: no --graph and no factory.graph in config prints error and exits with 1', async () => {
    const { readFile } = await import('node:fs/promises')
    // Make pipeline.dot auto-detect fail too
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    )

    await expect(runCmd([])).rejects.toThrow('process.exit called')

    expect(stderrSpy).toHaveBeenCalledWith('Error: No graph file specified\n')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  // -------------------------------------------------------------------------
  // AC7: --events flag emits JSON lines to stdout
  // -------------------------------------------------------------------------

  it('AC7: --events flag attaches event listeners that write JSON to stdout', async () => {
    const { createGraphExecutor } = await import('../graph/executor.js')

    // Mock executor to emit a graph event via the eventBus passed in config
    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockImplementation(async (_graph, config) => {
        config.eventBus?.emit('graph:node-started', {
          runId: config.runId,
          nodeId: 'node-1',
          nodeType: 'start',
        })
        return { status: 'SUCCESS' }
      }),
    })

    await runCmd(['--graph', 'pipeline.dot', '--events'])

    // Find JSON lines written to stdout
    const jsonLines = vi.mocked(process.stdout.write).mock.calls
      .map((args) => String(args[0]))
      .filter((line) => {
        try {
          JSON.parse(line)
          return true
        } catch {
          return false
        }
      })

    expect(jsonLines.length).toBeGreaterThan(0)

    const event = JSON.parse(jsonLines[0]!)
    expect(event.type).toBe('graph:node-started')
    expect(event.nodeId).toBe('node-1')
  })

  it('AC7: without --events flag, no NDJSON event lines are written to stdout', async () => {
    const { createGraphExecutor } = await import('../graph/executor.js')

    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockImplementation(async (_graph, config) => {
        config.eventBus?.emit('graph:node-started', {
          runId: config.runId,
          nodeId: 'node-1',
          nodeType: 'start',
        })
        return { status: 'SUCCESS' }
      }),
    })

    await runCmd(['--graph', 'pipeline.dot'])

    // Only non-JSON lines should be written (start confirmation message)
    const jsonLines = vi.mocked(process.stdout.write).mock.calls
      .map((args) => String(args[0]))
      .filter((line) => {
        try {
          JSON.parse(line)
          return true
        } catch {
          return false
        }
      })

    expect(jsonLines.length).toBe(0)
  })
})
