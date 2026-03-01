/**
 * Unit tests for `substrate auto supervisor` command (Story 17-1).
 *
 * Tests the supervisor state machine using injected mock dependencies to avoid
 * real process manipulation, real timers, or real DB access.
 *
 * Coverage:
 *   - AC1: Command options (tested via registerAutoCommand integration)
 *   - AC2: Health polling loop (poll → healthy → poll → terminal)
 *   - AC3: Stall detection and kill (STALLED + threshold → SIGTERM + SIGKILL)
 *   - AC4: Automatic restart after kill
 *   - AC5: Terminal state summary and exit codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runAutoSupervisor, registerAutoCommand } from '../auto.js'
import type { PipelineHealthOutput, AutoSupervisorOptions, SupervisorDeps } from '../auto.js'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeHealthy(overrides: Partial<PipelineHealthOutput> = {}): PipelineHealthOutput {
  return {
    verdict: 'HEALTHY',
    run_id: 'run-abc123',
    status: 'running',
    current_phase: 'implementation',
    staleness_seconds: 30,
    last_activity: new Date().toISOString(),
    process: {
      orchestrator_pid: 12345,
      child_pids: [12346, 12347],
      zombies: [],
    },
    stories: {
      active: 1,
      completed: 0,
      escalated: 0,
      details: { '17-1': { phase: 'IN_DEV', review_cycles: 0 } },
    },
    ...overrides,
  }
}

function makeStalled(stalenessSeconds = 700, overrides: Partial<PipelineHealthOutput> = {}): PipelineHealthOutput {
  return makeHealthy({
    verdict: 'STALLED',
    staleness_seconds: stalenessSeconds,
    process: { orchestrator_pid: 12345, child_pids: [12346], zombies: [] },
    ...overrides,
  })
}

function makeTerminal(
  succeeded: string[] = [],
  failed: string[] = [],
): PipelineHealthOutput {
  const details: Record<string, { phase: string; review_cycles: number }> = {}
  for (const k of succeeded) details[k] = { phase: 'COMPLETE', review_cycles: 0 }
  for (const k of failed) details[k] = { phase: 'ESCALATED', review_cycles: 3 }

  return {
    verdict: 'NO_PIPELINE_RUNNING',
    run_id: 'run-abc123',
    status: 'completed',
    current_phase: null,
    staleness_seconds: 0,
    last_activity: new Date().toISOString(),
    process: { orchestrator_pid: null, child_pids: [], zombies: [] },
    stories: {
      active: 0,
      completed: succeeded.length,
      escalated: failed.length,
      details,
    },
  }
}

function makeNoRun(): PipelineHealthOutput {
  return {
    verdict: 'NO_PIPELINE_RUNNING',
    run_id: null,
    status: null,
    current_phase: null,
    staleness_seconds: 0,
    last_activity: '',
    process: { orchestrator_pid: null, child_pids: [], zombies: [] },
    stories: { active: 0, completed: 0, escalated: 0, details: {} },
  }
}

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<AutoSupervisorOptions> = {}): AutoSupervisorOptions {
  return {
    pollInterval: 1,       // 1 second (overridden by mock sleep anyway)
    stallThreshold: 600,
    maxRestarts: 3,
    outputFormat: 'human',
    projectRoot: '/tmp/test',
    pack: 'bmad',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// stdout capture helpers
// ---------------------------------------------------------------------------

function captureStdout(): { getOutput: () => string; restore: () => void } {
  const chunks: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write
  return {
    getOutput: () => chunks.join(''),
    restore: () => {
      process.stdout.write = origWrite
    },
  }
}

// ---------------------------------------------------------------------------
// Tests: AC2 — Health Polling Loop
// ---------------------------------------------------------------------------

describe('runAutoSupervisor — AC2: health polling loop', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('exits 0 immediately when pipeline is already in terminal state (no stories)', async () => {
    const sleepCalls: number[] = []
    const healthResults = [makeNoRun()]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthResults[callIdx++])),
      sleep: vi.fn().mockImplementation((ms: number) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions(), deps)

    expect(exitCode).toBe(0)
    // No sleep calls because we exited immediately
    expect(sleepCalls).toHaveLength(0)
  })

  it('polls multiple times before terminal state', async () => {
    const sleepCalls: number[] = []
    const healthSequence = [makeHealthy(), makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockImplementation((ms: number) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions({ pollInterval: 60 }), deps)

    expect(exitCode).toBe(0)
    // Two healthy polls → two sleep(60000) calls before terminal
    expect(sleepCalls).toHaveLength(2)
    expect(sleepCalls[0]).toBe(60_000)
    expect(sleepCalls[1]).toBe(60_000)
  })

  it('logs verdict and metrics on each poll (human format)', async () => {
    const healthSequence = [makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ outputFormat: 'human' }), deps)

    const output = stdoutCapture.getOutput()
    expect(output).toContain('Health: HEALTHY')
    expect(output).toContain('staleness=')
  })

  it('emits supervisor:summary event on terminal state', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1', '17-2'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const summaryLine = lines.find((l) => l.includes('supervisor:summary'))
    expect(summaryLine).toBeDefined()
    const evt = JSON.parse(summaryLine!)
    expect(evt.type).toBe('supervisor:summary')
    expect(evt.run_id).toBe('run-abc123')
    expect(evt.succeeded).toContain('17-1')
    expect(evt.succeeded).toContain('17-2')
    expect(evt.restarts).toBe(0)
    expect(evt.ts).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: AC5 — Terminal State Summary and Exit Codes
// ---------------------------------------------------------------------------

describe('runAutoSupervisor — AC5: terminal state summary and exit codes', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('exits 0 when all stories succeeded', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1', '17-2', '17-3'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions(), deps)
    expect(exitCode).toBe(0)
  })

  it('exits 1 when any story failed/escalated', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'], ['17-2'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions(), deps)
    expect(exitCode).toBe(1)
  })

  it('exits 0 when no stories at all (no run found)', async () => {
    // No run found: NO_PIPELINE_RUNNING with no story details → 0 failed → exit 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeNoRun()),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions(), deps)
    expect(exitCode).toBe(0)
  })

  it('includes elapsed time and restarts in summary event', async () => {
    let restartCount = 0
    const healthSequence: PipelineHealthOutput[] = [
      makeStalled(700),
      makeTerminal(['17-1']),
    ]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockImplementation(() => {
        restartCount++
        return Promise.resolve(0)
      }),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ maxRestarts: 3, outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const summaryLine = lines.find((l) => l.includes('supervisor:summary'))
    expect(summaryLine).toBeDefined()
    const evt = JSON.parse(summaryLine!)
    expect(evt.restarts).toBe(1)
    expect(typeof evt.elapsed_seconds).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC3 — Stall Detection and Kill
// ---------------------------------------------------------------------------

describe('runAutoSupervisor — AC3: stall detection and kill', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('does NOT kill when STALLED but staleness below threshold', async () => {
    // Staleness is 300s, threshold is 600s
    const healthSequence = [makeStalled(300), makeTerminal(['17-1'])]
    let callIdx = 0
    const killPid = vi.fn()

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid,
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600 }), deps)

    // Should NOT have killed any process
    expect(killPid).not.toHaveBeenCalled()
  })

  it('kills SIGTERM then SIGKILL when stalled and staleness >= threshold', async () => {
    const healthSequence = [makeStalled(700), makeTerminal(['17-1'])]
    let callIdx = 0
    const killCalls: Array<[number, string]> = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600 }), deps)

    // Should have sent SIGTERM to orchestrator + child
    const sigterms = killCalls.filter(([, s]) => s === 'SIGTERM')
    const sigkills = killCalls.filter(([, s]) => s === 'SIGKILL')
    expect(sigterms.length).toBeGreaterThan(0)
    expect(sigkills.length).toBeGreaterThan(0)

    // PIDs match what we set in makeStalled (12345 orchestrator, 12346 child)
    expect(sigterms.map(([p]) => p)).toContain(12345)
    expect(sigterms.map(([p]) => p)).toContain(12346)
  })

  it('sends 5-second grace period sleep between SIGTERM and SIGKILL', async () => {
    const healthSequence = [makeStalled(700), makeTerminal(['17-1'])]
    let callIdx = 0
    const sleepCalls: number[] = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockImplementation((ms: number) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600 }), deps)

    // 5000ms grace period sleep should be present
    expect(sleepCalls).toContain(5000)
  })

  it('emits supervisor:kill event with PIDs and staleness', async () => {
    const healthSequence = [makeStalled(720), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600, outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const killLine = lines.find((l) => l.includes('supervisor:kill'))
    expect(killLine).toBeDefined()
    const evt = JSON.parse(killLine!)
    expect(evt.type).toBe('supervisor:kill')
    expect(evt.reason).toBe('stall')
    expect(evt.staleness_seconds).toBe(720)
    expect(evt.pids).toContain(12345)
    expect(evt.ts).toBeDefined()
  })

  it('handles case where no PIDs are found (orchestrator_pid is null)', async () => {
    const stalledNoPids = makeStalled(700, {
      process: { orchestrator_pid: null, child_pids: [], zombies: [] },
    })
    const healthSequence = [stalledNoPids, makeTerminal(['17-1'])]
    let callIdx = 0
    const killPid = vi.fn()

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid,
    }

    // Should not throw even with no PIDs
    const exitCode = await runAutoSupervisor(makeOptions({ stallThreshold: 600 }), deps)
    expect(exitCode).toBe(0)
    expect(killPid).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: AC4 — Automatic Restart After Kill
// ---------------------------------------------------------------------------

describe('runAutoSupervisor — AC4: automatic restart after kill', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('calls resumePipeline after killing stalled pipeline', async () => {
    const healthSequence = [makeStalled(700), makeTerminal(['17-1'])]
    let callIdx = 0
    const resumePipeline = vi.fn().mockResolvedValue(0)

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline,
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600 }), deps)

    expect(resumePipeline).toHaveBeenCalledOnce()
    const callArgs = resumePipeline.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.runId).toBe('run-abc123')
    expect(callArgs.projectRoot).toBe('/tmp/test')
    expect(callArgs.pack).toBe('bmad')
  })

  it('emits supervisor:restart event with attempt count', async () => {
    const healthSequence = [makeStalled(700), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600, outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const restartLine = lines.find((l) => l.includes('supervisor:restart'))
    expect(restartLine).toBeDefined()
    const evt = JSON.parse(restartLine!)
    expect(evt.type).toBe('supervisor:restart')
    expect(evt.attempt).toBe(1)
    expect(evt.run_id).toBe('run-abc123')
    expect(evt.ts).toBeDefined()
  })

  it('increments restart count on each stall+kill cycle', async () => {
    // Two stall events followed by terminal
    const healthSequence = [makeStalled(700), makeStalled(700), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ stallThreshold: 600, maxRestarts: 5, outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const restartLines = lines.filter((l) => l.includes('supervisor:restart'))
    expect(restartLines).toHaveLength(2)
    expect(JSON.parse(restartLines[0]).attempt).toBe(1)
    expect(JSON.parse(restartLines[1]).attempt).toBe(2)
  })

  it('continues polling after restart', async () => {
    // stall → restart → healthy → terminal
    const healthSequence = [makeStalled(700), makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0
    const sleepCalls: number[] = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockImplementation((ms: number) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions({ stallThreshold: 600, pollInterval: 60 }), deps)

    expect(exitCode).toBe(0)
    // Should have polled at least twice (after stall+restart, then after healthy)
    expect(deps.getHealth).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// Tests: AC6 — Max Restarts Safety Valve (within batch scope)
// ---------------------------------------------------------------------------

describe('runAutoSupervisor — AC6: max restarts safety valve', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('exits 2 when restart count exceeds maxRestarts', async () => {
    // maxRestarts=2, but we stall 3 times → abort on the 3rd stall (restartCount already equals maxRestarts)
    const healthSequence = [
      makeStalled(700),  // kill + restart #1
      makeStalled(700),  // kill + restart #2
      makeStalled(700),  // restartCount === 2 === maxRestarts → abort
    ]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runAutoSupervisor(makeOptions({ maxRestarts: 2, stallThreshold: 600 }), deps)
    expect(exitCode).toBe(2)
  })

  it('emits supervisor:abort event when max restarts exceeded', async () => {
    const healthSequence = [makeStalled(700), makeStalled(700)]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ maxRestarts: 1, stallThreshold: 600, outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const abortLine = lines.find((l) => l.includes('supervisor:abort'))
    expect(abortLine).toBeDefined()
    const evt = JSON.parse(abortLine!)
    expect(evt.type).toBe('supervisor:abort')
    expect(evt.reason).toBe('max_restarts_exceeded')
    expect(typeof evt.attempts).toBe('number')
    expect(evt.ts).toBeDefined()
  })

  it('does NOT attempt another resume after aborting', async () => {
    const healthSequence = [makeStalled(700), makeStalled(700)]
    let callIdx = 0
    const resumePipeline = vi.fn().mockResolvedValue(0)

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline,
      killPid: vi.fn(),
    }

    await runAutoSupervisor(makeOptions({ maxRestarts: 1, stallThreshold: 600 }), deps)

    // First stall: restart called (count becomes 1)
    // Second stall: restartCount (1) >= maxRestarts (1) → abort, no resume
    expect(resumePipeline).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: AC1 — Command Registration
// ---------------------------------------------------------------------------

describe('registerAutoCommand — AC1: supervisor command registration', () => {
  it('registers the supervisor subcommand on the auto command group', () => {
    const program = new Command()
    registerAutoCommand(program, '0.0.0', '/tmp/test')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')
    expect(autoCmd).toBeDefined()

    const supervisorCmd = autoCmd!.commands.find((c) => c.name() === 'supervisor')
    expect(supervisorCmd).toBeDefined()
  })

  it('supervisor command has --poll-interval option with default 60', () => {
    const program = new Command()
    registerAutoCommand(program, '0.0.0', '/tmp/test')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')!
    const supervisorCmd = autoCmd.commands.find((c) => c.name() === 'supervisor')!

    const opts = supervisorCmd.opts()
    // Before parsing, check option definitions exist
    const optDefs = supervisorCmd.options
    const pollOpt = optDefs.find((o) => o.long === '--poll-interval')
    expect(pollOpt).toBeDefined()
    expect(pollOpt!.defaultValue).toBe(60)
  })

  it('supervisor command has --stall-threshold option with default 600', () => {
    const program = new Command()
    registerAutoCommand(program, '0.0.0', '/tmp/test')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')!
    const supervisorCmd = autoCmd.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const stallOpt = optDefs.find((o) => o.long === '--stall-threshold')
    expect(stallOpt).toBeDefined()
    expect(stallOpt!.defaultValue).toBe(600)
  })

  it('supervisor command has --max-restarts option with default 3', () => {
    const program = new Command()
    registerAutoCommand(program, '0.0.0', '/tmp/test')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')!
    const supervisorCmd = autoCmd.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const maxRestartsOpt = optDefs.find((o) => o.long === '--max-restarts')
    expect(maxRestartsOpt).toBeDefined()
    expect(maxRestartsOpt!.defaultValue).toBe(3)
  })

  it('supervisor command has --output-format option', () => {
    const program = new Command()
    registerAutoCommand(program, '0.0.0', '/tmp/test')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')!
    const supervisorCmd = autoCmd.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const fmtOpt = optDefs.find((o) => o.long === '--output-format')
    expect(fmtOpt).toBeDefined()
    expect(fmtOpt!.defaultValue).toBe('human')
  })

  it('supervisor command has --project-root option', () => {
    const program = new Command()
    registerAutoCommand(program, '0.0.0', '/tmp/test')

    const autoCmd = program.commands.find((c) => c.name() === 'auto')!
    const supervisorCmd = autoCmd.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const rootOpt = optDefs.find((o) => o.long === '--project-root')
    expect(rootOpt).toBeDefined()
  })
})
