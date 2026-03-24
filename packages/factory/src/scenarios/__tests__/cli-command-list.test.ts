/**
 * Unit tests for `scenarios list` and `scenarios run` CLI subcommands.
 *
 * Tests AC1–AC4 from story 44-8.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerScenariosCommand } from '../cli-command.js'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any imports resolve
// ---------------------------------------------------------------------------

vi.mock('../store.js', () => ({
  ScenarioStore: vi.fn().mockImplementation(() => ({
    discover: vi.fn().mockResolvedValue({
      scenarios: [],
      capturedAt: Date.now(),
    }),
  })),
}))

vi.mock('../runner.js', () => ({
  createScenarioRunner: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({
      scenarios: [],
      summary: { total: 0, passed: 0, failed: 0 },
      durationMs: 0,
    }),
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spy on process.stdout.write and return the spy instance.
 * Callers are responsible for restoring in afterEach.
 */
function captureStdoutWrite() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
}

/**
 * Extract lines written to the spy, stripping trailing newlines.
 */
function getWrittenLines(spy: ReturnType<typeof captureStdoutWrite>): string[] {
  return spy.mock.calls.map((c) => String(c[0]).replace(/\n$/, ''))
}

/**
 * Create a fresh Commander program with the scenarios command registered and
 * parse the given CLI args.
 */
async function runCmd(args: string[]) {
  const cmd = new Command()
  cmd.exitOverride() // prevent process.exit() in tests
  registerScenariosCommand(cmd)
  await cmd.parseAsync(['node', 'substrate', 'scenarios', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scenarios list subcommand', () => {
  let spy: ReturnType<typeof captureStdoutWrite>

  beforeEach(() => {
    spy = captureStdoutWrite()
  })

  afterEach(() => {
    spy.mockRestore()
    vi.clearAllMocks()
  })

  it('AC1: prints filename and checksum tab-separated for each scenario', async () => {
    const { ScenarioStore } = await import('../store.js')
    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue({
        scenarios: [
          { name: 'scenario-a.sh', path: '/abs/path/scenario-a.sh', checksum: 'abc123' },
          { name: 'scenario-b.py', path: '/abs/path/scenario-b.py', checksum: 'def456' },
        ],
        capturedAt: Date.now(),
      }),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))

    await runCmd(['list'])

    const logged = getWrittenLines(spy)
    expect(logged).toContain('scenario-a.sh\tabc123')
    expect(logged).toContain('scenario-b.py\tdef456')
  })

  it('AC2: prints "No scenarios found" when directory is empty or missing', async () => {
    const { ScenarioStore } = await import('../store.js')
    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue({
        scenarios: [],
        capturedAt: Date.now(),
      }),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))

    await runCmd(['list'])

    const logged = getWrittenLines(spy)
    expect(logged).toContain('No scenarios found in .substrate/scenarios/')
  })

  it('AC1 (single entry): prints exactly one tab-separated line for a single scenario', async () => {
    const { ScenarioStore } = await import('../store.js')
    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue({
        scenarios: [
          { name: 'scenario-only.ts', path: '/abs/scenario-only.ts', checksum: 'deadbeef' },
        ],
        capturedAt: Date.now(),
      }),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))

    await runCmd(['list'])

    const logged = getWrittenLines(spy)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toBe('scenario-only.ts\tdeadbeef')
  })
})

describe('AC7: top-level scenarios run backward compatibility', () => {
  let spy: ReturnType<typeof captureStdoutWrite>

  beforeEach(() => {
    spy = captureStdoutWrite()
  })

  afterEach(() => {
    spy.mockRestore()
    vi.clearAllMocks()
  })

  it(
    'AC7: scenarios run at top-level still works when factory scenarios is also registered on the same program',
    async () => {
      const { ScenarioStore } = await import('../store.js')
      const { createScenarioRunner } = await import('../runner.js')

      vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
        discover: vi.fn().mockResolvedValue({
          scenarios: [{ name: 's.sh', path: '/abs/s.sh', checksum: 'aaa' }],
          capturedAt: Date.now(),
        }),
        verifyIntegrity: vi.fn(),
        verify: vi.fn(),
      }))

      vi.mocked(createScenarioRunner).mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({
          summary: { total: 1, passed: 1, failed: 0 },
          scenarios: [
            { name: 's.sh', status: 'pass', exitCode: 0, stdout: '', stderr: '', durationMs: 5 },
          ],
          durationMs: 10,
        }),
      })

      // Simulate dual registration: scenarios at top-level (story 44-5)
      // AND under factory (story 44-8) — mirrors createProgram() in src/cli/index.ts
      const program = new Command()
      program.exitOverride()
      registerScenariosCommand(program) // top-level (AC7 path, story 44-5)
      const factoryCmd = program.command('factory').description('Factory commands')
      registerScenariosCommand(factoryCmd) // under factory (story 44-8 path)

      // Invoke the top-level path — must still work per AC7
      await program.parseAsync(['node', 'substrate', 'scenarios', 'run'])

      const logged = getWrittenLines(spy)
      expect(logged.some((l) => l.includes('Scenarios:'))).toBe(true)
      expect(logged.some((l) => l.includes('[PASS]'))).toBe(true)
    },
  )
})

describe('scenarios run subcommand', () => {
  let spy: ReturnType<typeof captureStdoutWrite>

  beforeEach(() => {
    spy = captureStdoutWrite()
  })

  afterEach(() => {
    spy.mockRestore()
    vi.clearAllMocks()
  })

  it('AC3: prints human-readable summary with PASS/FAIL lines', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue({
        scenarios: [
          { name: 's.sh', path: '/abs/s.sh', checksum: 'aaa' },
          { name: 'f.sh', path: '/abs/f.sh', checksum: 'bbb' },
        ],
        capturedAt: Date.now(),
      }),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))

    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue({
        summary: { total: 2, passed: 1, failed: 1 },
        scenarios: [
          { name: 's.sh', status: 'pass', exitCode: 0, stdout: '', stderr: '', durationMs: 5 },
          { name: 'f.sh', status: 'fail', exitCode: 1, stdout: '', stderr: 'err', durationMs: 5 },
        ],
        durationMs: 10,
      }),
    })

    await runCmd(['run'])

    const logged = getWrittenLines(spy)
    expect(logged.some((l) => l.includes('Scenarios: 1 passed, 1 failed, 2 total'))).toBe(true)
    expect(logged.some((l) => l.includes('[PASS]') && l.includes('s.sh'))).toBe(true)
    expect(logged.some((l) => l.includes('[FAIL]') && l.includes('f.sh'))).toBe(true)
  })

  it('AC4: --format json emits valid JSON containing summary.total', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue({
        scenarios: [{ name: 's.sh', path: '/abs/s.sh', checksum: 'aaa' }],
        capturedAt: Date.now(),
      }),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))

    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue({
        summary: { total: 1, passed: 1, failed: 0 },
        scenarios: [
          { name: 's.sh', status: 'pass', exitCode: 0, stdout: '', stderr: '', durationMs: 3 },
        ],
        durationMs: 5,
      }),
    })

    await runCmd(['run', '--format', 'json'])

    const logged = getWrittenLines(spy)
    // At least one call must be parseable JSON with summary.total
    const jsonLine = logged.find((l) => {
      try {
        const parsed = JSON.parse(l) as { summary?: { total?: number } }
        return typeof parsed.summary?.total === 'number'
      } catch {
        return false
      }
    })
    expect(jsonLine).toBeDefined()
    const result = JSON.parse(jsonLine!) as { summary: { total: number }; durationMs: number }
    expect(result.summary.total).toBe(1)
    expect(typeof result.durationMs).toBe('number')
  })
})
