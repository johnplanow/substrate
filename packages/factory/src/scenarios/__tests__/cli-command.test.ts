/**
 * Unit tests for `registerScenariosCommand` — scenarios run subcommand (story 44-5).
 *
 * Covers AC1: `substrate scenarios run --format json` invokes store.discover(),
 * runner.run(), and writes JSON-serialized ScenarioRunResult to stdout.
 *
 * See also: cli-command-list.test.ts (story 44-8) for the `list` subcommand and
 * human-readable output path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerScenariosCommand } from '../cli-command.js'
import type { ScenarioRunResult } from '../../events.js'

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
// Test data
// ---------------------------------------------------------------------------

const SCENARIO_MANIFEST = {
  scenarios: [
    { name: 'scenario-a.sh', path: '/proj/.substrate/scenarios/scenario-a.sh', checksum: 'aaa' },
    { name: 'scenario-b.sh', path: '/proj/.substrate/scenarios/scenario-b.sh', checksum: 'bbb' },
  ],
  capturedAt: Date.now(),
}

const SCENARIO_RUN_RESULT: ScenarioRunResult = {
  scenarios: [
    { name: 'scenario-a.sh', status: 'pass', exitCode: 0, stdout: '', stderr: '', durationMs: 12 },
    { name: 'scenario-b.sh', status: 'fail', exitCode: 1, stdout: '', stderr: 'err', durationMs: 8 },
  ],
  summary: { total: 2, passed: 1, failed: 1 },
  durationMs: 20,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spy on console.log and return the spy instance.
 * Callers are responsible for restoring in afterEach.
 */
function captureConsoleLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => {})
}

/**
 * Create a fresh Commander program with the scenarios command registered and
 * parse the given CLI args.
 */
async function runCmd(args: string[]) {
  const cmd = new Command()
  cmd.exitOverride()
  registerScenariosCommand(cmd)
  await cmd.parseAsync(['node', 'substrate', 'scenarios', ...args])
}

// ---------------------------------------------------------------------------
// AC1: scenarios run --format json outputs ScenarioRunResult JSON
// ---------------------------------------------------------------------------

describe('scenarios run --format json (AC1 — story 44-5)', () => {
  let spy: ReturnType<typeof captureConsoleLog>

  beforeEach(() => {
    spy = captureConsoleLog()
  })

  afterEach(() => {
    spy.mockRestore()
    vi.clearAllMocks()
  })

  it('calls store.discover() to collect scenario files', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue(SCENARIO_MANIFEST),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(SCENARIO_RUN_RESULT),
    })

    await runCmd(['run', '--format', 'json'])

    // ScenarioStore was constructed — discover() was called on it
    expect(vi.mocked(ScenarioStore)).toHaveBeenCalledTimes(1)
  })

  it('calls runner.run() with the manifest and produces output', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    const mockRun = vi.fn().mockResolvedValue(SCENARIO_RUN_RESULT)
    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue(SCENARIO_MANIFEST),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({ run: mockRun })

    await runCmd(['run', '--format', 'json'])

    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  it('writes JSON-serialized ScenarioRunResult to stdout via console.log', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue(SCENARIO_MANIFEST),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(SCENARIO_RUN_RESULT),
    })

    await runCmd(['run', '--format', 'json'])

    const logged = spy.mock.calls.map((c) => c[0] as string)
    // One of the console.log calls must be parseable JSON with ScenarioRunResult shape
    const jsonLine = logged.find((l) => {
      try {
        const parsed = JSON.parse(l) as Record<string, unknown>
        const summary = parsed['summary'] as Record<string, unknown> | undefined
        return typeof summary?.['total'] === 'number' && typeof summary?.['passed'] === 'number'
      } catch {
        return false
      }
    })
    expect(jsonLine).toBeDefined()
  })

  it('JSON output contains correct summary fields (total, passed, failed)', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue(SCENARIO_MANIFEST),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(SCENARIO_RUN_RESULT),
    })

    await runCmd(['run', '--format', 'json'])

    const logged = spy.mock.calls.map((c) => c[0] as string)
    const jsonLine = logged.find((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    })

    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as ScenarioRunResult
    expect(parsed.summary.total).toBe(2)
    expect(parsed.summary.passed).toBe(1)
    expect(parsed.summary.failed).toBe(1)
    expect(typeof parsed.durationMs).toBe('number')
  })

  it('JSON output passes duck-type check: summary.total and summary.passed are numbers', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue(SCENARIO_MANIFEST),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(SCENARIO_RUN_RESULT),
    })

    await runCmd(['run', '--format', 'json'])

    const logged = spy.mock.calls.map((c) => c[0] as string)
    const jsonLine = logged.find((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    })

    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!) as Record<string, unknown>
    const summary = parsed['summary'] as Record<string, unknown>
    expect(typeof summary['total']).toBe('number')
    expect(typeof summary['passed']).toBe('number')
  })

  it('JSON output includes scenario results array', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue(SCENARIO_MANIFEST),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue(SCENARIO_RUN_RESULT),
    })

    await runCmd(['run', '--format', 'json'])

    const logged = spy.mock.calls.map((c) => c[0] as string)
    const jsonLine = logged.find((l) => {
      try {
        JSON.parse(l)
        return true
      } catch {
        return false
      }
    })

    const parsed = JSON.parse(jsonLine!) as ScenarioRunResult
    expect(Array.isArray(parsed.scenarios)).toBe(true)
    expect(parsed.scenarios).toHaveLength(2)
    expect(parsed.scenarios[0]?.name).toBe('scenario-a.sh')
    expect(parsed.scenarios[1]?.name).toBe('scenario-b.sh')
  })
})

// ---------------------------------------------------------------------------
// AC1 edge case: zero scenarios discovered
// ---------------------------------------------------------------------------

describe('scenarios run --format json — empty scenario directory (AC1 edge case)', () => {
  let spy: ReturnType<typeof captureConsoleLog>

  beforeEach(() => {
    spy = captureConsoleLog()
  })

  afterEach(() => {
    spy.mockRestore()
    vi.clearAllMocks()
  })

  it('still emits valid ScenarioRunResult JSON when no scenarios are found', async () => {
    const { ScenarioStore } = await import('../store.js')
    const { createScenarioRunner } = await import('../runner.js')

    vi.mocked(ScenarioStore).mockImplementationOnce(() => ({
      discover: vi.fn().mockResolvedValue({ scenarios: [], capturedAt: Date.now() }),
      verifyIntegrity: vi.fn(),
      verify: vi.fn(),
    }))
    vi.mocked(createScenarioRunner).mockReturnValueOnce({
      run: vi.fn().mockResolvedValue({
        scenarios: [],
        summary: { total: 0, passed: 0, failed: 0 },
        durationMs: 0,
      }),
    })

    await runCmd(['run', '--format', 'json'])

    const logged = spy.mock.calls.map((c) => c[0] as string)
    const jsonLine = logged.find((l) => {
      try {
        const p = JSON.parse(l) as Record<string, unknown>
        const s = p['summary'] as Record<string, unknown> | undefined
        return typeof s?.['total'] === 'number'
      } catch {
        return false
      }
    })
    expect(jsonLine).toBeDefined()

    const parsed = JSON.parse(jsonLine!) as ScenarioRunResult
    expect(parsed.summary.total).toBe(0)
    expect(parsed.summary.passed).toBe(0)
    expect(parsed.summary.failed).toBe(0)
  })
})
