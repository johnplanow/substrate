/**
 * Unit tests for `src/cli/commands/adapters.ts`
 *
 * Tests list and check subcommands with mocked AdapterRegistry.
 * Verifies output format, exit codes, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerAdaptersCommand, EXIT_CODE_SUCCESS, EXIT_CODE_ERROR, EXIT_CODE_NO_ADAPTERS } from '../adapters.js'
import type { AdapterRegistry, DiscoveryReport } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Helpers to capture output and exit codes
// ---------------------------------------------------------------------------

let stdoutOutput: string
let lastExitCode: number

function captureOutput(): void {
  stdoutOutput = ''
  lastExitCode = -1
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    stdoutOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    lastExitCode = typeof code === 'number' ? code : 0
    throw new Error(`process.exit(${String(code)})`)
  })
}

function getOutput(): string {
  return stdoutOutput
}

function getExitCode(): number {
  return lastExitCode
}

// ---------------------------------------------------------------------------
// Mock AdapterRegistry factory
// ---------------------------------------------------------------------------

function createMockRegistry(report: Partial<DiscoveryReport>): AdapterRegistry {
  const fullReport: DiscoveryReport = {
    registeredCount: 0,
    failedCount: 0,
    results: [],
    ...report,
  }
  return {
    discoverAndRegister: vi.fn().mockResolvedValue(fullReport),
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry
}

const ALL_HEALTHY_REPORT: DiscoveryReport = {
  registeredCount: 3,
  failedCount: 0,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: true,
      healthResult: {
        healthy: true,
        version: '1.2.3',
        cliPath: '/usr/bin/claude',
        detectedBillingModes: ['subscription', 'api'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: true,
      healthResult: {
        healthy: true,
        version: '0.1.0',
        cliPath: '/usr/bin/codex',
        detectedBillingModes: ['api'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'gemini',
      displayName: 'Gemini CLI',
      registered: true,
      healthResult: {
        healthy: true,
        version: '2.0.0',
        cliPath: '/usr/bin/gemini',
        detectedBillingModes: ['api'],
        supportsHeadless: true,
      },
    },
  ],
}

const MIXED_REPORT: DiscoveryReport = {
  registeredCount: 1,
  failedCount: 2,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: true,
      healthResult: {
        healthy: true,
        version: '1.2.3',
        cliPath: '/usr/bin/claude',
        detectedBillingModes: ['subscription'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: false,
      healthResult: {
        healthy: false,
        error: 'Codex CLI not available: codex: command not found',
        supportsHeadless: false,
      },
    },
    {
      adapterId: 'gemini',
      displayName: 'Gemini CLI',
      registered: false,
      healthResult: {
        healthy: false,
        error: 'Gemini CLI not available: gemini: command not found',
        supportsHeadless: false,
      },
    },
  ],
}

const NONE_INSTALLED_REPORT: DiscoveryReport = {
  registeredCount: 0,
  failedCount: 3,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: false,
      healthResult: {
        healthy: false,
        error: 'Claude CLI not available: command not found',
        supportsHeadless: false,
      },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: false,
      healthResult: {
        healthy: false,
        error: 'Codex CLI not available: command not found',
        supportsHeadless: false,
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function runCommand(args: string[], registry: AdapterRegistry): Promise<void> {
  const program = new Command()
  program.exitOverride() // prevent commander from calling process.exit
  registerAdaptersCommand(program, '0.1.0', registry)
  try {
    await program.parseAsync(['node', 'adt', ...args])
  } catch (err) {
    // Swallow process.exit mock throws and commander ExitOverride
    if (err instanceof Error && err.message.startsWith('process.exit(')) {
      return
    }
    // Re-throw if it's a commander exit override with non-zero code
    const cmdErr = err as { code?: string; exitCode?: number }
    if (cmdErr.code === 'commander.helpDisplayed' || cmdErr.code === 'commander.version') {
      return
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adapters list command', () => {
  beforeEach(() => {
    captureOutput()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('outputs table with all adapters when all healthy', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'list'], registry)

    const output = getOutput()
    expect(output).toContain('Claude Code')
    expect(output).toContain('Codex CLI')
    expect(output).toContain('Gemini CLI')
    expect(output).toContain('available')
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('shows unavailable status for missing adapters', async () => {
    const registry = createMockRegistry(MIXED_REPORT)
    await runCommand(['adapters', 'list'], registry)

    const output = getOutput()
    expect(output).toContain('available')
    expect(output).toContain('unavailable')
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('shows all adapters as unavailable when none installed', async () => {
    const registry = createMockRegistry(NONE_INSTALLED_REPORT)
    await runCommand(['adapters', 'list'], registry)

    const output = getOutput()
    // list command still shows all adapters in table (as unavailable)
    expect(output).toContain('unavailable')
    expect(output).toContain('claude-code')
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('outputs valid JSON with --output-format json', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'list', '--output-format', 'json'], registry)

    const output = getOutput()
    expect((): void => { JSON.parse(output) }).not.toThrow()
    const parsed = JSON.parse(output) as { data: unknown[]; timestamp: string; version: string; command: string }
    expect(parsed.command).toBe('adt adapters list')
    expect(parsed.version).toBe('0.1.0')
    expect(Array.isArray(parsed.data)).toBe(true)
    expect(parsed.data).toHaveLength(3)
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('JSON output includes adapter details', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'list', '--output-format', 'json'], registry)

    const parsed = JSON.parse(getOutput()) as { data: { adapterId: string; healthy: boolean }[] }
    const claudeEntry = parsed.data.find((d) => d.adapterId === 'claude-code')
    expect(claudeEntry).toBeDefined()
    expect(claudeEntry?.healthy).toBe(true)
  })

  it('table output includes adapter name, status, path, and version columns', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'list'], registry)

    const output = getOutput()
    expect(output).toContain('Name')
    expect(output).toContain('Status')
    expect(output).toContain('Path')
    expect(output).toContain('Version')
  })

  it('shows error details with --verbose flag', async () => {
    const registry = createMockRegistry(MIXED_REPORT)
    await runCommand(['adapters', 'list', '--verbose'], registry)

    const output = getOutput()
    expect(output).toContain('Error')
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('handles empty results array gracefully', async () => {
    const registry = createMockRegistry({ registeredCount: 0, failedCount: 0, results: [] })
    await runCommand(['adapters', 'list'], registry)

    // When results is empty, show no adapters message
    const output = getOutput()
    expect(output).toContain('No adapters found')
    expect(getExitCode()).toBe(EXIT_CODE_NO_ADAPTERS)
  })
})

describe('adapters check command', () => {
  beforeEach(() => {
    captureOutput()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('outputs health table with all healthy adapters', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'check'], registry)

    const output = getOutput()
    expect(output).toContain('Claude Code')
    expect(output).toContain('Codex CLI')
    expect(output).toContain('Gemini CLI')
    expect(output).toContain('healthy')
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('shows unhealthy status for missing adapters and exits with code 1', async () => {
    const registry = createMockRegistry(MIXED_REPORT)
    await runCommand(['adapters', 'check'], registry)

    const output = getOutput()
    expect(output).toContain('healthy')
    expect(output).toContain('unhealthy')
    expect(getExitCode()).toBe(EXIT_CODE_ERROR)
  })

  it('reports no adapters found message when none installed', async () => {
    const registry = createMockRegistry(NONE_INSTALLED_REPORT)
    await runCommand(['adapters', 'check'], registry)

    const output = getOutput()
    expect(output).toContain('No adapters found')
    expect(output).toContain('Claude Code')
    expect(getExitCode()).toBe(EXIT_CODE_NO_ADAPTERS)
  })

  it('reports billing mode in table output', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'check'], registry)

    const output = getOutput()
    expect(output).toContain('Billing Mode')
    expect(output).toContain('subscription')
  })

  it('reports supportsHeadless in table output', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'check'], registry)

    const output = getOutput()
    expect(output).toContain('Headless')
    expect(output).toContain('yes')
  })

  it('outputs valid JSON with --output-format json flag', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'check', '--output-format', 'json'], registry)

    const output = getOutput()
    expect((): void => { JSON.parse(output) }).not.toThrow()
    const parsed = JSON.parse(output) as {
      data: { adapterId: string; healthy: boolean; supportsHeadless: boolean }[]
      command: string
      timestamp: string
      version: string
    }
    expect(parsed.command).toBe('adt adapters check')
    expect(Array.isArray(parsed.data)).toBe(true)
    expect(getExitCode()).toBe(EXIT_CODE_SUCCESS)
  })

  it('JSON output includes AdapterHealthResult fields', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'check', '--output-format', 'json'], registry)

    const parsed = JSON.parse(getOutput()) as {
      data: {
        adapterId: string
        healthy: boolean
        supportsHeadless: boolean
        detectedBillingModes: string[]
        version: string
        cliPath: string
      }[]
    }
    const entry = parsed.data[0]
    expect(entry).toHaveProperty('adapterId')
    expect(entry).toHaveProperty('healthy')
    expect(entry).toHaveProperty('supportsHeadless')
    expect(entry).toHaveProperty('detectedBillingModes')
    expect(entry).toHaveProperty('version')
    expect(entry).toHaveProperty('cliPath')
  })

  it('JSON output exits with code 2 when no adapters installed', async () => {
    const registry = createMockRegistry(NONE_INSTALLED_REPORT)
    await runCommand(['adapters', 'check', '--output-format', 'json'], registry)

    expect(getExitCode()).toBe(EXIT_CODE_NO_ADAPTERS)
  })

  it('JSON output exits with code 1 when some adapters unhealthy', async () => {
    const registry = createMockRegistry(MIXED_REPORT)
    await runCommand(['adapters', 'check', '--output-format', 'json'], registry)

    expect(getExitCode()).toBe(EXIT_CODE_ERROR)
  })

  it('shows error details with --verbose flag', async () => {
    const registry = createMockRegistry(MIXED_REPORT)
    await runCommand(['adapters', 'check', '--verbose'], registry)

    const output = getOutput()
    expect(output).toContain('Error')
    expect(output).toContain('command not found')
  })

  it('health table has required columns', async () => {
    const registry = createMockRegistry(ALL_HEALTHY_REPORT)
    await runCommand(['adapters', 'check'], registry)

    const output = getOutput()
    expect(output).toContain('Adapter')
    expect(output).toContain('Status')
    expect(output).toContain('Billing Mode')
    expect(output).toContain('Headless')
    expect(output).toContain('Version')
  })
})

describe('adapters command help', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers adapters command on the program', () => {
    const program = new Command()
    program.exitOverride()
    registerAdaptersCommand(program, '0.1.0', createMockRegistry(ALL_HEALTHY_REPORT))

    const adaptersCmd = program.commands.find((c) => c.name() === 'adapters')
    expect(adaptersCmd).toBeDefined()
  })

  it('registers list and check subcommands', () => {
    const program = new Command()
    program.exitOverride()
    registerAdaptersCommand(program, '0.1.0', createMockRegistry(ALL_HEALTHY_REPORT))

    const adaptersCmd = program.commands.find((c) => c.name() === 'adapters')
    expect(adaptersCmd).toBeDefined()

    // adaptersCmd is guaranteed defined by expect above; non-null assertion is safe here
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const subcommandNames = adaptersCmd!.commands.map((c) => c.name())
    expect(subcommandNames).toContain('list')
    expect(subcommandNames).toContain('check')
  })

  it('list command accepts --output-format flag', () => {
    const program = new Command()
    program.exitOverride()
    registerAdaptersCommand(program, '0.1.0', createMockRegistry(ALL_HEALTHY_REPORT))

    const adaptersCmd = program.commands.find((c) => c.name() === 'adapters')
    const listCmd = adaptersCmd?.commands.find((c) => c.name() === 'list')
    expect(listCmd).toBeDefined()

    const outputFormatOpt = listCmd?.options.find((o) => o.long === '--output-format')
    expect(outputFormatOpt).toBeDefined()
  })

  it('check command accepts --verbose flag', () => {
    const program = new Command()
    program.exitOverride()
    registerAdaptersCommand(program, '0.1.0', createMockRegistry(ALL_HEALTHY_REPORT))

    const adaptersCmd = program.commands.find((c) => c.name() === 'adapters')
    const checkCmd = adaptersCmd?.commands.find((c) => c.name() === 'check')
    expect(checkCmd).toBeDefined()

    const verboseOpt = checkCmd?.options.find((o) => o.long === '--verbose')
    expect(verboseOpt).toBeDefined()
  })
})

describe('exit codes', () => {
  beforeEach(() => {
    captureOutput()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exits 0 when all adapters healthy (list)', async () => {
    await runCommand(['adapters', 'list'], createMockRegistry(ALL_HEALTHY_REPORT))
    expect(getExitCode()).toBe(0)
  })

  it('exits 0 when all adapters healthy (check)', async () => {
    await runCommand(['adapters', 'check'], createMockRegistry(ALL_HEALTHY_REPORT))
    expect(getExitCode()).toBe(0)
  })

  it('exits 1 when some adapters unhealthy (check)', async () => {
    await runCommand(['adapters', 'check'], createMockRegistry(MIXED_REPORT))
    expect(getExitCode()).toBe(1)
  })

  it('exits 0 when list shows unavailable adapters (all unavailable is still a valid list)', async () => {
    await runCommand(['adapters', 'list'], createMockRegistry(NONE_INSTALLED_REPORT))
    // list always exits 0 unless results is literally empty (no adapters defined at all)
    expect(getExitCode()).toBe(0)
  })

  it('exits 2 when no adapters installed (check)', async () => {
    await runCommand(['adapters', 'check'], createMockRegistry(NONE_INSTALLED_REPORT))
    expect(getExitCode()).toBe(2)
  })
})
