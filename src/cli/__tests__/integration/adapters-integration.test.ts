/**
 * Integration tests for `adt adapters` commands
 *
 * Tests the full command pipeline with a real Commander program
 * and a mocked AdapterRegistry. Verifies real CLI routing and
 * output parsing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerAdaptersCommand } from '../../commands/adapters.js'
import type { DiscoveryReport } from '../../../adapters/adapter-registry.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Output capture helpers (same pattern as unit tests)
// ---------------------------------------------------------------------------

let capturedOutput: string
let capturedExitCode: number

function setupCapture(): void {
  capturedOutput = ''
  capturedExitCode = -1
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    capturedOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    capturedExitCode = typeof code === 'number' ? code : 0
    throw new Error(`process.exit(${String(code)})`)
  })
}

// ---------------------------------------------------------------------------
// Mock report fixtures
// ---------------------------------------------------------------------------

const HEALTHY_REPORT: DiscoveryReport = {
  registeredCount: 2,
  failedCount: 1,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: true,
      healthResult: {
        healthy: true,
        version: '1.0.0',
        cliPath: '/usr/local/bin/claude',
        detectedBillingModes: ['subscription'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: true,
      healthResult: {
        healthy: true,
        version: '0.2.0',
        cliPath: '/usr/local/bin/codex',
        detectedBillingModes: ['api'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'gemini',
      displayName: 'Gemini CLI',
      registered: false,
      healthResult: {
        healthy: false,
        error: 'Gemini CLI not available: command not found',
        supportsHeadless: false,
      },
    },
  ],
}

function createMockRegistry(report: DiscoveryReport): AdapterRegistry {
  return {
    discoverAndRegister: vi.fn().mockResolvedValue(report),
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry
}

async function runIntegrated(
  args: string[],
  registry: AdapterRegistry
): Promise<{ output: string; exitCode: number }> {
  setupCapture()
  const program = new Command()
  program.exitOverride()
  registerAdaptersCommand(program, '0.1.0', registry)

  try {
    await program.parseAsync(['node', 'adt', ...args])
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('process.exit(')) {
      // swallow
    } else {
      const cmdErr = err as { code?: string }
      if (cmdErr.code !== 'commander.helpDisplayed') {
        throw err
      }
    }
  }

  return { output: capturedOutput, exitCode: capturedExitCode }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('adapters list - integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes to list command and calls discoverAndRegister', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    await runIntegrated(['adapters', 'list'], registry)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const discoverFn = vi.mocked(registry.discoverAndRegister)
    expect(discoverFn).toHaveBeenCalledOnce()
  })

  it('produces table output for adapters list', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { output } = await runIntegrated(['adapters', 'list'], registry)
    expect(output).toContain('Claude Code')
    expect(output).toContain('available')
    expect(output).toContain('unavailable')
  })

  it('produces valid JSON output with --output-format json', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { output } = await runIntegrated(['adapters', 'list', '--output-format', 'json'], registry)
    const parsed = JSON.parse(output) as { data: unknown[]; command: string }
    expect(parsed.command).toBe('adt adapters list')
    expect(Array.isArray(parsed.data)).toBe(true)
    expect(parsed.data).toHaveLength(3)
  })

  it('JSON output contains timestamp and version fields', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { output } = await runIntegrated(['adapters', 'list', '--output-format', 'json'], registry)
    const parsed = JSON.parse(output) as { timestamp: string; version: string }
    expect(typeof parsed.timestamp).toBe('string')
    expect(typeof parsed.version).toBe('string')
  })

  it('exit code 0 with healthy adapters', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { exitCode } = await runIntegrated(['adapters', 'list'], registry)
    expect(exitCode).toBe(0)
  })
})

describe('adapters check - integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes to check command and calls discoverAndRegister', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    await runIntegrated(['adapters', 'check'], registry)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const discoverFn = vi.mocked(registry.discoverAndRegister)
    expect(discoverFn).toHaveBeenCalledOnce()
  })

  it('produces health table with billing mode and headless columns', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { output } = await runIntegrated(['adapters', 'check'], registry)
    expect(output).toContain('Billing Mode')
    expect(output).toContain('Headless')
    expect(output).toContain('healthy')
    expect(output).toContain('unhealthy')
  })

  it('exit code 1 when some adapters unhealthy', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT) // has 1 failed
    const { exitCode } = await runIntegrated(['adapters', 'check'], registry)
    expect(exitCode).toBe(1)
  })

  it('JSON output contains AdapterHealthResult fields for each adapter', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { output } = await runIntegrated(
      ['adapters', 'check', '--output-format', 'json'],
      registry
    )
    const parsed = JSON.parse(output) as {
      data: { adapterId: string; healthy: boolean; supportsHeadless: boolean; detectedBillingModes: string[] }[]
    }
    expect(parsed.data[0]).toHaveProperty('adapterId')
    expect(parsed.data[0]).toHaveProperty('healthy')
    expect(parsed.data[0]).toHaveProperty('supportsHeadless')
    expect(parsed.data[0]).toHaveProperty('detectedBillingModes')
  })

  it('JSON output is parseable by downstream tools (valid UTF-8 JSON)', async () => {
    const registry = createMockRegistry(HEALTHY_REPORT)
    const { output } = await runIntegrated(
      ['adapters', 'check', '--output-format', 'json'],
      registry
    )
    expect((): void => { JSON.parse(output) }).not.toThrow()
    expect(output.endsWith('\n')).toBe(true)
  })
})

describe('adapters no-install scenario - integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('list shows unavailable adapters in table when none installed', async () => {
    const noneReport: DiscoveryReport = {
      registeredCount: 0,
      failedCount: 3,
      results: [
        {
          adapterId: 'claude-code',
          displayName: 'Claude Code',
          registered: false,
          healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
        },
        {
          adapterId: 'codex',
          displayName: 'Codex CLI',
          registered: false,
          healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
        },
        {
          adapterId: 'gemini',
          displayName: 'Gemini CLI',
          registered: false,
          healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
        },
      ],
    }

    const registry = createMockRegistry(noneReport)
    const { output, exitCode } = await runIntegrated(['adapters', 'list'], registry)
    // list always shows the table even if all unavailable
    expect(output).toContain('unavailable')
    expect(exitCode).toBe(0)
  })

  it('check shows install hints and exits 2 when no adapters installed', async () => {
    const noneReport: DiscoveryReport = {
      registeredCount: 0,
      failedCount: 3,
      results: [
        {
          adapterId: 'claude-code',
          displayName: 'Claude Code',
          registered: false,
          healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
        },
        {
          adapterId: 'codex',
          displayName: 'Codex CLI',
          registered: false,
          healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
        },
        {
          adapterId: 'gemini',
          displayName: 'Gemini CLI',
          registered: false,
          healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
        },
      ],
    }

    const registry = createMockRegistry(noneReport)
    const { output, exitCode } = await runIntegrated(['adapters', 'check'], registry)
    expect(output).toContain('No adapters found')
    expect(exitCode).toBe(2)
  })
})

describe('program setup includes adapters command', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registerAdaptersCommand adds adapters to program', () => {
    const program = new Command()
    program.exitOverride()
    registerAdaptersCommand(program, '0.1.0', createMockRegistry(HEALTHY_REPORT))

    const adaptersCmd = program.commands.find((c) => c.name() === 'adapters')
    expect(adaptersCmd).toBeDefined()
  })

  it('adapters command has list and check subcommands after registration', () => {
    const program = new Command()
    program.exitOverride()
    registerAdaptersCommand(program, '0.1.0', createMockRegistry(HEALTHY_REPORT))

    const adaptersCmd = program.commands.find((c) => c.name() === 'adapters')
    expect(adaptersCmd).toBeDefined()
    const subNames = adaptersCmd?.commands.map((c) => c.name()) ?? []
    expect(subNames).toContain('list')
    expect(subNames).toContain('check')
  })
})
