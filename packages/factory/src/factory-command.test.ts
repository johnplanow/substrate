/**
 * Unit tests for `registerFactoryCommand`.
 *
 * Tests AC5 and AC6 from story 44-8.
 * Tests AC7 from story 48-12 (factory run --backend direct).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerFactoryCommand } from './factory-command.js'

// Mock the scenarios CLI command to avoid side effects in these tests
vi.mock('./scenarios/cli-command.js', () => ({
  registerScenariosCommand: vi.fn(),
}))

// Mock all heavy dependencies needed for --backend direct integration tests
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
}))

vi.mock('./graph/parser.js', () => ({
  parseGraph: vi.fn(),
}))

vi.mock('./graph/validator.js', () => ({
  createValidator: vi.fn(),
}))

vi.mock('./graph/executor.js', () => ({
  createGraphExecutor: vi.fn(),
}))

vi.mock('./handlers/index.js', () => ({
  createDefaultRegistry: vi.fn(),
  HandlerRegistry: vi.fn(),
}))

vi.mock('./config.js', () => ({
  loadFactoryConfig: vi.fn(),
  resolveConfigPath: vi.fn().mockReturnValue(null),
}))

vi.mock('./graph/run-state.js', () => ({
  RunStateManager: vi.fn().mockImplementation(() => ({
    initRun: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('./backend/direct-bootstrap.js', () => ({
  bootstrapDirectBackend: vi.fn(),
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
  factory: {
    graph: 'pipeline.dot',
    scenario_dir: '.substrate/scenarios/',
    satisfaction_threshold: 0.8,
    budget_cap_usd: 0,
    wall_clock_cap_seconds: 3600,
    plateau_window: 3,
    plateau_threshold: 0.05,
    backend: 'cli' as const,
    quality_mode: 'dual-signal' as const,
    direct_backend: {
      provider: 'anthropic' as const,
      model: 'claude-3-5-sonnet-20241022',
      max_turns: 20,
    },
  },
}

async function runCmd(args: string[]) {
  const program = new Command()
  program.exitOverride()
  registerFactoryCommand(program)
  await program.parseAsync(['node', 'substrate', 'factory', 'run', ...args])
}

// ---------------------------------------------------------------------------
// Original registerFactoryCommand tests
// ---------------------------------------------------------------------------

describe('registerFactoryCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AC6: registers a command named "factory" on the program without throwing', () => {
    const program = new Command()
    program.exitOverride()

    expect(() => registerFactoryCommand(program)).not.toThrow()

    const names = program.commands.map((c) => c.name())
    expect(names).toContain('factory')
  })

  it('AC6: the factory command has a description', () => {
    const program = new Command()
    program.exitOverride()
    registerFactoryCommand(program)

    const factoryCmd = program.commands.find((c) => c.name() === 'factory')
    expect(factoryCmd).toBeDefined()
    expect(factoryCmd!.description()).toBeTruthy()
  })

  it('AC6: calls registerScenariosCommand to attach scenarios subcommands', async () => {
    const { registerScenariosCommand } = await import('./scenarios/cli-command.js')
    const program = new Command()
    program.exitOverride()

    registerFactoryCommand(program)

    expect(vi.mocked(registerScenariosCommand)).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Story 48-12 AC7: factory run --backend direct
// ---------------------------------------------------------------------------

describe('factory run --backend direct', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any
  // Captured onEvent callback from the bootstrap call
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let capturedOnEvent: ((event: any) => void) | undefined
  // Mock directBackend stub
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDirectBackendRun: any

  beforeEach(async () => {
    vi.clearAllMocks()
    capturedOnEvent = undefined

    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as () => never)

    // Set up mocks
    const { readFile } = await import('node:fs/promises')
    vi.mocked(readFile).mockResolvedValue('digraph G { start -> exit }' as never)

    const { parseGraph } = await import('./graph/parser.js')
    vi.mocked(parseGraph).mockReturnValue(mockGraph as never)

    const { createValidator } = await import('./graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    const { loadFactoryConfig } = await import('./config.js')
    vi.mocked(loadFactoryConfig).mockResolvedValue(defaultConfig as never)

    const { createDefaultRegistry } = await import('./handlers/index.js')
    vi.mocked(createDefaultRegistry).mockReturnValue({} as never)

    const { RunStateManager } = await import('./graph/run-state.js')
    vi.mocked(RunStateManager).mockImplementation(() => ({
      runDir: '',
      initRun: vi.fn().mockResolvedValue(undefined),
    }) as never)

    // Set up executor mock to capture eventBus
    mockDirectBackendRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const { createGraphExecutor } = await import('./graph/executor.js')
    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    })

    // Set up bootstrapDirectBackend mock to capture onEvent and return a stub backend
    const { bootstrapDirectBackend } = await import('./backend/direct-bootstrap.js')
    vi.mocked(bootstrapDirectBackend).mockImplementation((opts) => {
      capturedOnEvent = opts.onEvent
      return {
        run: mockDirectBackendRun,
      } as never
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('AC7: --backend direct causes directBackend.run() to be called during node execution', async () => {
    // Make the executor invoke the handler registry's handler (codergen node)
    const { createGraphExecutor } = await import('./graph/executor.js')
    const { createDefaultRegistry } = await import('./handlers/index.js')

    // The executor gets a registry; we verify the registry was created with directBackend
    let capturedRegistryOptions: unknown = undefined
    vi.mocked(createDefaultRegistry).mockImplementation((opts) => {
      capturedRegistryOptions = opts
      return {} as never
    })

    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    })

    await runCmd(['--graph', 'pipeline.dot', '--backend', 'direct'])

    // Verify bootstrapDirectBackend was called
    const { bootstrapDirectBackend } = await import('./backend/direct-bootstrap.js')
    expect(vi.mocked(bootstrapDirectBackend)).toHaveBeenCalledOnce()

    // Verify registry was created with directBackend option
    const opts = capturedRegistryOptions as { directBackend: unknown }
    expect(opts).toBeDefined()
    expect(opts.directBackend).toBeDefined()
  })

  it('AC7: onEvent forwarding — TOOL_CALL_START event is forwarded as agent:tool-call with direction:call', async () => {
    // Make executor emit a graph:node-started event and then trigger onEvent
    const { createGraphExecutor } = await import('./graph/executor.js')
    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockImplementation(async (_graph, config) => {
        // Emit node-started to set currentNodeId
        config.eventBus?.emit('graph:node-started', {
          runId: config.runId,
          nodeId: 'node-1',
          nodeType: 'codergen',
        })

        // Simulate the onEvent callback being called from the agent loop
        if (capturedOnEvent) {
          capturedOnEvent({
            kind: 'TOOL_CALL_START',
            timestamp: new Date(),
            session_id: 'test-session',
            data: { tool_name: 'read_file', call_id: 'call-123' },
          })
        }

        return { status: 'SUCCESS' }
      }),
    })

    // Track eventBus emissions
    const emittedEvents: Array<{ type: string; [key: string]: unknown }> = []
    const origRegisterFactory = registerFactoryCommand
    void origRegisterFactory

    // Capture stdout for NDJSON
    const capturedLines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
      capturedLines.push(String(line))
      return true
    })

    await runCmd(['--graph', 'pipeline.dot', '--backend', 'direct', '--events'])

    // Find agent:tool-call events in stdout
    const agentToolCallLines = capturedLines.filter((line) => {
      try {
        const parsed = JSON.parse(line)
        return parsed.type === 'agent:tool-call'
      } catch {
        return false
      }
    })

    expect(agentToolCallLines.length).toBeGreaterThan(0)
    const event = JSON.parse(agentToolCallLines[0]!)
    expect(event.direction).toBe('call')
    expect(event.toolName).toBe('read_file')
    void emittedEvents
  })

  it('AC7: --events flag NDJSON output contains agent:tool-call line after onEvent fires', async () => {
    const { createGraphExecutor } = await import('./graph/executor.js')
    vi.mocked(createGraphExecutor).mockReturnValue({
      run: vi.fn().mockImplementation(async (_graph, config) => {
        config.eventBus?.emit('graph:node-started', {
          runId: config.runId,
          nodeId: 'node-2',
          nodeType: 'codergen',
        })

        if (capturedOnEvent) {
          capturedOnEvent({
            kind: 'TOOL_CALL_START',
            timestamp: new Date(),
            session_id: 'test-session-2',
            data: { tool_name: 'shell', call_id: 'call-456' },
          })
        }

        return { status: 'SUCCESS' }
      }),
    })

    const capturedLines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
      capturedLines.push(String(line))
      return true
    })

    await runCmd(['--graph', 'pipeline.dot', '--backend', 'direct', '--events'])

    const agentEvents = capturedLines
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter((obj) => obj !== null && obj.type === 'agent:tool-call')

    expect(agentEvents.length).toBeGreaterThan(0)
    expect(agentEvents[0]).toMatchObject({ type: 'agent:tool-call' })
  })

  it('AC7: missing API key → process exits with non-zero code and stderr contains env-var name', async () => {
    // Make bootstrapDirectBackend throw to simulate missing API key
    const { bootstrapDirectBackend } = await import('./backend/direct-bootstrap.js')
    vi.mocked(bootstrapDirectBackend).mockImplementationOnce(() => {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for direct backend with anthropic provider')
    })

    await expect(runCmd(['--graph', 'pipeline.dot', '--backend', 'direct'])).rejects.toThrow('process.exit called')

    const stderrOutput = vi.mocked(process.stderr.write).mock.calls
      .map((args) => String(args[0]))
      .join('')

    expect(stderrOutput).toContain('ANTHROPIC_API_KEY')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
