/**
 * Unit tests for `substrate supervisor` command (Story 17-1).
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
import { runSupervisorAction, runMultiProjectSupervisor, registerSupervisorCommand, buildPollEvent, buildTerminalSummary, handleStallRecovery } from '../supervisor.js'
import type { SupervisorOptions, SupervisorDeps, MultiProjectSupervisorOptions, ProjectCycleState } from '../supervisor.js'
import type { PipelineHealthOutput } from '../health.js'
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
  escalated: string[] = [],
): PipelineHealthOutput {
  const details: Record<string, { phase: string; review_cycles: number }> = {}
  for (const k of succeeded) details[k] = { phase: 'COMPLETE', review_cycles: 0 }
  for (const k of failed) details[k] = { phase: 'FAILED', review_cycles: 3 }
  for (const k of escalated) details[k] = { phase: 'ESCALATED', review_cycles: 3 }

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
      escalated: escalated.length,
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

function makeOptions(overrides: Partial<SupervisorOptions> = {}): SupervisorOptions {
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

describe('runSupervisorAction — AC2: health polling loop', () => {
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

    const exitCode = await runSupervisorAction(makeOptions(), deps)

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

    const exitCode = await runSupervisorAction(makeOptions({ pollInterval: 60 }), deps)

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

    await runSupervisorAction(makeOptions({ outputFormat: 'human' }), deps)

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

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

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

describe('runSupervisorAction — AC5: terminal state summary and exit codes', () => {
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

    const exitCode = await runSupervisorAction(makeOptions(), deps)
    expect(exitCode).toBe(0)
  })

  it('exits 1 when any story failed', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'], ['17-2'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runSupervisorAction(makeOptions(), deps)
    expect(exitCode).toBe(1)
  })

  it('exits 1 when any story escalated (even if none failed)', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'], [], ['17-2'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runSupervisorAction(makeOptions(), deps)
    expect(exitCode).toBe(1)
  })

  it('partitions stories into succeeded/failed/escalated without overlap', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'], ['17-2'], ['17-3'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const summaryLine = output.trim().split('\n').find((l) => l.includes('supervisor:summary'))
    expect(summaryLine).toBeDefined()
    const evt = JSON.parse(summaryLine!)
    expect(evt.succeeded).toEqual(['17-1'])
    expect(evt.failed).toEqual(['17-2'])
    expect(evt.escalated).toEqual(['17-3'])
  })

  it('exits 0 when no stories at all (no run found)', async () => {
    // No run found: NO_PIPELINE_RUNNING with no story details → 0 failed → exit 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeNoRun()),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runSupervisorAction(makeOptions(), deps)
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

    await runSupervisorAction(makeOptions({ maxRestarts: 3, outputFormat: 'json' }), deps)

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

describe('runSupervisorAction — AC3: stall detection and kill', () => {
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

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

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

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

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

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

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

    await runSupervisorAction(makeOptions({ stallThreshold: 600, outputFormat: 'json' }), deps)

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
    const exitCode = await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)
    expect(exitCode).toBe(0)
    expect(killPid).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: AC4 — Automatic Restart After Kill
// ---------------------------------------------------------------------------

describe('runSupervisorAction — AC4: automatic restart after kill', () => {
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

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

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

    await runSupervisorAction(makeOptions({ stallThreshold: 600, outputFormat: 'json' }), deps)

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

    await runSupervisorAction(makeOptions({ stallThreshold: 600, maxRestarts: 5, outputFormat: 'json' }), deps)

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

    const exitCode = await runSupervisorAction(makeOptions({ stallThreshold: 600, pollInterval: 60 }), deps)

    expect(exitCode).toBe(0)
    // Should have polled at least twice (after stall+restart, then after healthy)
    expect(deps.getHealth).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// Tests: AC6 — Max Restarts Safety Valve (within batch scope)
// ---------------------------------------------------------------------------

describe('runSupervisorAction — AC6: max restarts safety valve', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('exits 2 when restart count exceeds maxRestarts', async () => {
    // maxRestarts=2, but we stall 3 times → abort on the 3rd stall (restartCount already equals maxRestarts)
    // Poll 4 is the grace poll — pipeline still not terminal, so exit code 2
    const healthSequence = [
      makeStalled(700),  // kill + restart #1
      makeStalled(700),  // kill + restart #2
      makeStalled(700),  // restartCount === 2 === maxRestarts → abort, sets maxRestartsExhausted
      makeStalled(700),  // grace poll: still not terminal → exit 2
    ]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    const exitCode = await runSupervisorAction(makeOptions({ maxRestarts: 2, stallThreshold: 600 }), deps)
    expect(exitCode).toBe(2)
  })

  it('emits supervisor:abort event when max restarts exceeded', async () => {
    const healthSequence = [makeStalled(700), makeStalled(700), makeStalled(700)]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
    }

    await runSupervisorAction(makeOptions({ maxRestarts: 1, stallThreshold: 600, outputFormat: 'json' }), deps)

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
    const healthSequence = [makeStalled(700), makeStalled(700), makeStalled(700)]
    let callIdx = 0
    const resumePipeline = vi.fn().mockResolvedValue(0)

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline,
      killPid: vi.fn(),
    }

    await runSupervisorAction(makeOptions({ maxRestarts: 1, stallThreshold: 600 }), deps)

    // First stall: restart called (count becomes 1)
    // Second stall: restartCount (1) >= maxRestarts (1) → abort, no resume
    expect(resumePipeline).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: AC1 — Command Registration
// ---------------------------------------------------------------------------

describe('registerSupervisorCommand — AC1: supervisor command registration', () => {
  it('registers the supervisor command on the program', () => {
    const program = new Command()
    registerSupervisorCommand(program, '0.0.0', '/tmp/test')

    const supervisorCmd = program.commands.find((c) => c.name() === 'supervisor')
    expect(supervisorCmd).toBeDefined()
  })

  it('supervisor command has --poll-interval option with default 60', () => {
    const program = new Command()
    registerSupervisorCommand(program, '0.0.0', '/tmp/test')

    const supervisorCmd = program.commands.find((c) => c.name() === 'supervisor')!

    const opts = supervisorCmd.opts()
    // Before parsing, check option definitions exist
    const optDefs = supervisorCmd.options
    const pollOpt = optDefs.find((o) => o.long === '--poll-interval')
    expect(pollOpt).toBeDefined()
    expect(pollOpt!.defaultValue).toBe(60)
  })

  it('supervisor command has --stall-threshold option with default 600', () => {
    const program = new Command()
    registerSupervisorCommand(program, '0.0.0', '/tmp/test')

    const supervisorCmd = program.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const stallOpt = optDefs.find((o) => o.long === '--stall-threshold')
    expect(stallOpt).toBeDefined()
    expect(stallOpt!.defaultValue).toBe(600)
  })

  it('supervisor command has --max-restarts option with default 3', () => {
    const program = new Command()
    registerSupervisorCommand(program, '0.0.0', '/tmp/test')

    const supervisorCmd = program.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const maxRestartsOpt = optDefs.find((o) => o.long === '--max-restarts')
    expect(maxRestartsOpt).toBeDefined()
    expect(maxRestartsOpt!.defaultValue).toBe(3)
  })

  it('supervisor command has --output-format option', () => {
    const program = new Command()
    registerSupervisorCommand(program, '0.0.0', '/tmp/test')

    const supervisorCmd = program.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const fmtOpt = optDefs.find((o) => o.long === '--output-format')
    expect(fmtOpt).toBeDefined()
    expect(fmtOpt!.defaultValue).toBe('human')
  })

  it('supervisor command has --project-root option', () => {
    const program = new Command()
    registerSupervisorCommand(program, '0.0.0', '/tmp/test')

    const supervisorCmd = program.commands.find((c) => c.name() === 'supervisor')!

    const optDefs = supervisorCmd.options
    const rootOpt = optDefs.find((o) => o.long === '--project-root')
    expect(rootOpt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: AC1 (Story 17-3) — Post-Run Analysis Hook
// ---------------------------------------------------------------------------

describe('runSupervisorAction — AC1 (Story 17-3): post-run analysis hook', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('calls runAnalysis when pipeline reaches terminal state with a run_id', async () => {
    const runAnalysis = vi.fn().mockResolvedValue(undefined)

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      runAnalysis,
    }

    await runSupervisorAction(makeOptions(), deps)

    expect(runAnalysis).toHaveBeenCalledOnce()
    expect(runAnalysis).toHaveBeenCalledWith('run-abc123', '/tmp/test')
  })

  it('does NOT call runAnalysis when no run_id is present', async () => {
    const runAnalysis = vi.fn().mockResolvedValue(undefined)

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeNoRun()), // run_id is null
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      runAnalysis,
    }

    await runSupervisorAction(makeOptions(), deps)

    expect(runAnalysis).not.toHaveBeenCalled()
  })

  it('does NOT call runAnalysis when dep is not provided (undefined)', async () => {
    // Should not throw when runAnalysis is omitted
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      // runAnalysis is intentionally omitted
    }

    const exitCode = await runSupervisorAction(makeOptions(), deps)
    // Should still exit 0 without analysis dep
    expect(exitCode).toBe(0)
  })

  it('emits supervisor:analysis:complete event after runAnalysis (json format)', async () => {
    const runAnalysis = vi.fn().mockResolvedValue(undefined)

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      runAnalysis,
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const analysisLine = lines.find((l) => l.includes('supervisor:analysis:complete'))
    expect(analysisLine).toBeDefined()
    const evt = JSON.parse(analysisLine!)
    expect(evt.type).toBe('supervisor:analysis:complete')
    expect(evt.run_id).toBe('run-abc123')
  })

  it('runAnalysis error does not crash supervisor', async () => {
    const runAnalysis = vi.fn().mockRejectedValue(new Error('analysis failed'))

    const deps: Partial<SupervisorDeps> = {
      // Override getHealth to succeed, then terminal
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      runAnalysis,
    }

    // Should not throw even if runAnalysis fails
    const exitCode = await runSupervisorAction(makeOptions(), deps)
    expect(exitCode).toBe(0)
  })

  it('emits supervisor:analysis:error event when runAnalysis throws (Story 17.5 T9)', async () => {
    const runAnalysis = vi.fn().mockRejectedValue(new Error('disk full'))

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      runAnalysis,
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const errLine = lines.find((l) => l.includes('supervisor:analysis:error'))
    expect(errLine).toBeDefined()
    const evt = JSON.parse(errLine!)
    expect(evt.type).toBe('supervisor:analysis:error')
    expect(evt.run_id).toBe('run-abc123')
    expect(evt.error).toContain('disk full')
    expect(evt.ts).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: Story 19-2 — supervisor:poll heartbeat events
// ---------------------------------------------------------------------------

describe('runSupervisorAction — Story 19-2 AC1-AC4: supervisor:poll emitted in JSON mode', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('emits supervisor:poll event on every poll cycle in JSON mode', async () => {
    const healthSequence = [makeHealthy(), makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0
    const tokenSnapshot = { input: 1000, output: 500, cost_usd: 0.01 }

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue(tokenSnapshot),
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n').filter((l) => l.includes('supervisor:poll'))
    // Three poll cycles (two healthy + one terminal), each should emit supervisor:poll
    expect(lines).toHaveLength(3)
  })

  it('supervisor:poll event has all required AC1 fields', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 100, output: 50, cost_usd: 0.005 }),
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const pollLine = output.trim().split('\n').find((l) => l.includes('supervisor:poll'))
    expect(pollLine).toBeDefined()
    const evt = JSON.parse(pollLine!)
    // AC1: required fields
    expect(evt.type).toBe('supervisor:poll')
    expect(typeof evt.ts).toBe('string')
    expect(evt.run_id).toBe('run-abc123')
    expect(evt.verdict).toBe('NO_PIPELINE_RUNNING')
    expect(typeof evt.staleness_seconds).toBe('number')
    // stories object with active/completed/escalated
    expect(typeof evt.stories.active).toBe('number')
    expect(typeof evt.stories.completed).toBe('number')
    expect(typeof evt.stories.escalated).toBe('number')
  })

  it('supervisor:poll event has AC2 story_details', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeHealthy()),
      sleep: vi.fn().mockImplementation(() => {
        // Replace getHealth after first call to return terminal so loop exits
        ;(deps.getHealth as ReturnType<typeof vi.fn>).mockResolvedValue(makeTerminal(['17-1']))
        return Promise.resolve()
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const pollLines = output.trim().split('\n').filter((l) => l.includes('supervisor:poll'))
    expect(pollLines.length).toBeGreaterThan(0)
    const evt = JSON.parse(pollLines[0])
    // AC2: story_details
    expect(evt.story_details).toBeDefined()
    expect(typeof evt.story_details).toBe('object')
    // First poll is from makeHealthy, which has '17-1' in details
    expect(evt.story_details['17-1']).toBeDefined()
    expect(typeof evt.story_details['17-1'].phase).toBe('string')
    expect(typeof evt.story_details['17-1'].review_cycles).toBe('number')
  })

  it('supervisor:poll event has AC3 tokens snapshot', async () => {
    const getTokenSnapshot = vi.fn().mockReturnValue({ input: 2500, output: 1200, cost_usd: 0.042 })

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['17-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot,
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const pollLine = output.trim().split('\n').find((l) => l.includes('supervisor:poll'))
    expect(pollLine).toBeDefined()
    const evt = JSON.parse(pollLine!)
    // AC3: tokens
    expect(evt.tokens.input).toBe(2500)
    expect(evt.tokens.output).toBe(1200)
    expect(evt.tokens.cost_usd).toBe(0.042)
  })

  it('supervisor:poll event has AC4 process health fields', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeHealthy()),
      sleep: vi.fn().mockImplementation(() => {
        ;(deps.getHealth as ReturnType<typeof vi.fn>).mockResolvedValue(makeTerminal(['17-1']))
        return Promise.resolve()
      }),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const pollLines = output.trim().split('\n').filter((l) => l.includes('supervisor:poll'))
    const evt = JSON.parse(pollLines[0])
    // AC4: process health
    expect('orchestrator_pid' in evt.process).toBe(true)
    expect(typeof evt.process.child_count).toBe('number')
    expect(typeof evt.process.zombie_count).toBe('number')
    // makeHealthy has orchestrator_pid: 12345, child_pids: [12346, 12347], zombies: []
    expect(evt.process.orchestrator_pid).toBe(12345)
    expect(evt.process.child_count).toBe(2)
    expect(evt.process.zombie_count).toBe(0)
  })

  it('calls getTokenSnapshot with run_id and projectRoot on each poll cycle', async () => {
    const getTokenSnapshot = vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 })
    const healthSequence = [makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot,
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json', projectRoot: '/tmp/test' }), deps)

    // Two poll cycles, each with a non-null run_id
    expect(getTokenSnapshot).toHaveBeenCalledTimes(2)
    expect(getTokenSnapshot).toHaveBeenCalledWith('run-abc123', '/tmp/test')
  })

  it('tokens default to zeros when run_id is null', async () => {
    const getTokenSnapshot = vi.fn().mockReturnValue({ input: 999, output: 999, cost_usd: 99 })

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeNoRun()), // run_id is null
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot,
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const pollLine = output.trim().split('\n').find((l) => l.includes('supervisor:poll'))
    expect(pollLine).toBeDefined()
    const evt = JSON.parse(pollLine!)
    // run_id is null so getTokenSnapshot should NOT be called; tokens default to 0
    expect(getTokenSnapshot).not.toHaveBeenCalled()
    expect(evt.tokens.input).toBe(0)
    expect(evt.tokens.output).toBe(0)
    expect(evt.tokens.cost_usd).toBe(0)
  })
})

describe('runSupervisorAction — Story 19-2 AC5: supervisor:poll NOT emitted in human mode', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('does NOT emit supervisor:poll in human output mode', async () => {
    const getTokenSnapshot = vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 })
    const healthSequence = [makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot,
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'human' }), deps)

    const output = stdoutCapture.getOutput()
    expect(output).not.toContain('supervisor:poll')
    // Also verify getTokenSnapshot was not called (no poll events = no token queries needed)
    expect(getTokenSnapshot).not.toHaveBeenCalled()
  })

  it('still emits human-readable log lines in human mode (AC5 unaffected)', async () => {
    const healthSequence = [makeHealthy(), makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    await runSupervisorAction(makeOptions({ outputFormat: 'human' }), deps)

    const output = stdoutCapture.getOutput()
    expect(output).toContain('Health: HEALTHY')
    expect(output).not.toContain('supervisor:poll')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC8 — Orphan Child Process Cleanup (recursive process tree kill)
// ---------------------------------------------------------------------------

describe('runSupervisorAction — AC8: recursive process tree kill / orphan cleanup', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('kills all descendants in a 3-level process tree (orchestrator → children → grandchildren)', async () => {
    // Process tree:
    //   orchestrator (PID 1000)
    //     ├── child-1 (PID 1001)  — direct child (in child_pids)
    //     │     └── grandchild-1 (PID 1003)  — descendant via getAllDescendants
    //     └── child-2 (PID 1002)  — direct child (in child_pids)
    //           └── grandchild-2 (PID 1004)  — descendant via getAllDescendants
    const stalledWithChildren = makeHealthy({
      verdict: 'STALLED',
      staleness_seconds: 700,
      process: {
        orchestrator_pid: 1000,
        child_pids: [1001, 1002],
        zombies: [],
      },
    })

    const healthSequence = [stalledWithChildren, makeTerminal(['17-1'])]
    let callIdx = 0
    const killCalls: Array<[number, string]> = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
      // getAllDescendants is called with directPids=[1000,1001,1002] and returns grandchildren
      getAllDescendants: vi.fn().mockImplementation((_rootPids: number[]) => [1003, 1004]),
    }

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

    // All 5 PIDs (orchestrator + 2 children + 2 grandchildren) should receive SIGTERM
    const sigterms = killCalls.filter(([, s]) => s === 'SIGTERM').map(([p]) => p)
    expect(sigterms).toContain(1000)  // orchestrator
    expect(sigterms).toContain(1001)  // direct child
    expect(sigterms).toContain(1002)  // direct child
    expect(sigterms).toContain(1003)  // grandchild
    expect(sigterms).toContain(1004)  // grandchild

    // All 5 PIDs should also receive SIGKILL
    const sigkills = killCalls.filter(([, s]) => s === 'SIGKILL').map(([p]) => p)
    expect(sigkills).toContain(1000)
    expect(sigkills).toContain(1001)
    expect(sigkills).toContain(1002)
    expect(sigkills).toContain(1003)
    expect(sigkills).toContain(1004)
  })

  it('calls getAllDescendants with all direct PIDs (orchestrator + child_pids)', async () => {
    const stalledWithChildren = makeHealthy({
      verdict: 'STALLED',
      staleness_seconds: 700,
      process: {
        orchestrator_pid: 5000,
        child_pids: [5001, 5002, 5003],
        zombies: [],
      },
    })

    const healthSequence = [stalledWithChildren, makeTerminal(['17-1'])]
    let callIdx = 0
    const getAllDescendants = vi.fn().mockReturnValue([])

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getAllDescendants,
    }

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

    // getAllDescendants should be called with all direct PIDs
    expect(getAllDescendants).toHaveBeenCalledOnce()
    const callArg = getAllDescendants.mock.calls[0][0] as number[]
    expect(callArg).toContain(5000)  // orchestrator
    expect(callArg).toContain(5001)  // child
    expect(callArg).toContain(5002)  // child
    expect(callArg).toContain(5003)  // child
  })

  it('handles case where getAllDescendants returns empty (no grandchildren)', async () => {
    const stalledSimple = makeStalled(700)  // orchestrator + 1 child
    const healthSequence = [stalledSimple, makeTerminal(['17-1'])]
    let callIdx = 0
    const killCalls: Array<[number, string]> = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
      getAllDescendants: vi.fn().mockReturnValue([]),  // no grandchildren
    }

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

    // Should still kill the direct PIDs (orchestrator + child)
    const sigterms = killCalls.filter(([, s]) => s === 'SIGTERM').map(([p]) => p)
    expect(sigterms).toContain(12345)  // orchestrator
    expect(sigterms).toContain(12346)  // direct child
    // No grandchildren to kill
    expect(sigterms).toHaveLength(2)
  })

  it('does not duplicate PIDs in kill list when descendants overlap with direct PIDs', async () => {
    const stalledWithChildren = makeHealthy({
      verdict: 'STALLED',
      staleness_seconds: 700,
      process: {
        orchestrator_pid: 7000,
        child_pids: [7001],
        zombies: [],
      },
    })

    const healthSequence = [stalledWithChildren, makeTerminal(['17-1'])]
    let callIdx = 0
    const killCalls: Array<[number, string]> = []

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn().mockImplementation((pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }),
      // Return a descendant that is already in the direct PIDs (edge case)
      getAllDescendants: vi.fn().mockReturnValue([7001, 7002]),  // 7001 already in direct, 7002 is new
    }

    await runSupervisorAction(makeOptions({ stallThreshold: 600 }), deps)

    // PID 7001 should appear exactly once (not duplicated)
    const sigterms = killCalls.filter(([, s]) => s === 'SIGTERM').map(([p]) => p)
    const pid7001Count = sigterms.filter((p) => p === 7001).length
    expect(pid7001Count).toBe(1)
    // PID 7002 should also be killed
    expect(sigterms).toContain(7002)
  })

  it('supervisor:kill event still fires correctly when descendants are included', async () => {
    const stalledWithChildren = makeHealthy({
      verdict: 'STALLED',
      staleness_seconds: 720,
      process: {
        orchestrator_pid: 9000,
        child_pids: [9001],
        zombies: [],
      },
    })

    const healthSequence = [stalledWithChildren, makeTerminal(['17-1'])]
    let callIdx = 0

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => Promise.resolve(healthSequence[callIdx++])),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getAllDescendants: vi.fn().mockReturnValue([9002, 9003]),  // grandchildren
    }

    await runSupervisorAction(makeOptions({ stallThreshold: 600, outputFormat: 'json' }), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n')
    const killLine = lines.find((l) => l.includes('supervisor:kill'))
    expect(killLine).toBeDefined()
    const evt = JSON.parse(killLine!)
    expect(evt.type).toBe('supervisor:kill')
    expect(evt.staleness_seconds).toBe(720)
    // The supervisor:kill event includes all PIDs (direct + descendants)
    expect(evt.pids).toContain(9000)
    expect(evt.pids).toContain(9001)
    expect(evt.pids).toContain(9002)
    expect(evt.pids).toContain(9003)
  })
})

// ---------------------------------------------------------------------------
// Extracted helpers: buildPollEvent, buildTerminalSummary, handleStallRecovery
// ---------------------------------------------------------------------------

describe('buildPollEvent — helper unit tests', () => {
  it('builds correct event payload from health data', () => {
    const health = makeHealthy()
    const tokens = { input: 1000, output: 200, cost_usd: 0.05 }
    const event = buildPollEvent(health, '/tmp/test', tokens)

    expect(event.type).toBe('supervisor:poll')
    expect(event.run_id).toBe('run-abc123')
    expect(event.verdict).toBe('HEALTHY')
    expect(event.tokens).toEqual(tokens)
    expect((event.process as any).child_count).toBe(2)
  })

  it('includes extra fields when provided', () => {
    const health = makeHealthy()
    const tokens = { input: 0, output: 0, cost_usd: 0 }
    const event = buildPollEvent(health, '/tmp/test', tokens, { project: '/tmp/test' })

    expect(event.project).toBe('/tmp/test')
    expect(event.type).toBe('supervisor:poll')
  })
})

describe('buildTerminalSummary — helper unit tests', () => {
  it('categorizes story phases correctly', () => {
    const details = {
      '1-1': { phase: 'COMPLETE', review_cycles: 0 },
      '1-2': { phase: 'FAILED', review_cycles: 3 },
      '1-3': { phase: 'ESCALATED', review_cycles: 2 },
      '1-4': { phase: 'PENDING', review_cycles: 0 },
      '1-5': { phase: 'IN_DEV', review_cycles: 1 },
    }
    const summary = buildTerminalSummary(details)

    expect(summary.succeeded).toEqual(['1-1'])
    expect(summary.failed).toEqual(['1-2', '1-5'])
    expect(summary.escalated).toEqual(['1-3'])
  })

  it('returns empty arrays for empty details', () => {
    const summary = buildTerminalSummary({})
    expect(summary.succeeded).toEqual([])
    expect(summary.failed).toEqual([])
    expect(summary.escalated).toEqual([])
  })
})

describe('handleStallRecovery — helper unit tests', () => {
  it('returns null when staleness is below threshold', async () => {
    const health = makeHealthy({ staleness_seconds: 100 })
    const state: ProjectCycleState = { projectRoot: '/tmp/test', restartCount: 0 }
    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
      },
      { emitEvent: vi.fn(), log: vi.fn() },
    )
    expect(result).toBeNull()
  })

  it('kills and restarts when stalled, returns updated state', async () => {
    const health = makeStalled(700)
    const state: ProjectCycleState = { projectRoot: '/tmp/test', restartCount: 0 }
    const killPid = vi.fn()
    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid,
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
      },
      { emitEvent: vi.fn(), log: vi.fn() },
    )

    expect(result).not.toBeNull()
    expect(result!.maxRestartsExceeded).toBe(false)
    expect(result!.state.restartCount).toBe(1)
    expect(killPid).toHaveBeenCalled()
  })

  it('returns null (no kill) when health run_id differs from supervisor runId', async () => {
    const health = makeStalled(700, { run_id: 'run-xyz' })
    const state: ProjectCycleState = { projectRoot: '/tmp/test', runId: 'run-abc', restartCount: 0 }
    const killPid = vi.fn()
    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid,
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
      },
      { emitEvent: vi.fn(), log: vi.fn() },
    )
    expect(result).toBeNull()
    expect(killPid).not.toHaveBeenCalled()
  })

  it('proceeds with kill when supervisor has no runId set (undefined)', async () => {
    const health = makeStalled(700)
    const state: ProjectCycleState = { projectRoot: '/tmp/test', restartCount: 0 }
    const killPid = vi.fn()
    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid,
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
      },
      { emitEvent: vi.fn(), log: vi.fn() },
    )
    expect(result).not.toBeNull()
    expect(killPid).toHaveBeenCalled()
  })

  it('returns maxRestartsExceeded when limit hit', async () => {
    const health = makeStalled(700)
    const state: ProjectCycleState = { projectRoot: '/tmp/test', restartCount: 3 }
    const result = await handleStallRecovery(
      health,
      state,
      { stallThreshold: 600, maxRestarts: 3, pack: 'bmad', outputFormat: 'json' },
      {
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        getAllDescendants: vi.fn().mockReturnValue([]),
      },
      { emitEvent: vi.fn(), log: vi.fn() },
    )

    expect(result).not.toBeNull()
    expect(result!.maxRestartsExceeded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Multi-project supervisor
// ---------------------------------------------------------------------------

describe('runMultiProjectSupervisor — multi-project mode', () => {
  let stdoutCapture: { getOutput: () => string; restore: () => void }

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  function makeMultiOptions(overrides: Partial<MultiProjectSupervisorOptions> = {}): MultiProjectSupervisorOptions {
    return {
      projects: ['/tmp/project-a', '/tmp/project-b'],
      pollInterval: 1,
      stallThreshold: 600,
      maxRestarts: 3,
      outputFormat: 'json',
      pack: 'bmad',
      ...overrides,
    }
  }

  it('exits 0 when both projects reach terminal state successfully', async () => {
    const healthMap: Record<string, PipelineHealthOutput[]> = {
      '/tmp/project-a': [makeHealthy(), makeTerminal(['1-1'])],
      '/tmp/project-b': [makeHealthy(), makeTerminal(['2-1'])],
    }
    const callCounts: Record<string, number> = { '/tmp/project-a': 0, '/tmp/project-b': 0 }

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        const seq = healthMap[projectRoot] ?? [makeNoRun()]
        const idx = Math.min(callCounts[projectRoot] ?? 0, seq.length - 1)
        callCounts[projectRoot] = (callCounts[projectRoot] ?? 0) + 1
        return Promise.resolve(seq[idx])
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    const exitCode = await runMultiProjectSupervisor(makeMultiOptions(), deps)
    expect(exitCode).toBe(0)

    // Verify events have project field
    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n').filter(Boolean)
    const pollEvents = lines.filter((l) => l.includes('"supervisor:poll"')).map((l) => JSON.parse(l))
    expect(pollEvents.length).toBeGreaterThanOrEqual(2)
    expect(pollEvents.some((e: any) => e.project === '/tmp/project-a')).toBe(true)
    expect(pollEvents.some((e: any) => e.project === '/tmp/project-b')).toBe(true)
  })

  it('exits 1 when one project has failures', async () => {
    const healthMap: Record<string, PipelineHealthOutput[]> = {
      '/tmp/project-a': [makeTerminal(['1-1'])],          // success
      '/tmp/project-b': [makeTerminal([], ['2-1'])],      // failure
    }

    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        return Promise.resolve((healthMap[projectRoot] ?? [makeNoRun()])[0])
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    const exitCode = await runMultiProjectSupervisor(makeMultiOptions(), deps)
    expect(exitCode).toBe(1)
  })

  it('exits 2 when one project hits max restarts', async () => {
    // Project A: always stalled, hits max restarts
    // Project B: terminal success
    let aCallCount = 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        if (projectRoot === '/tmp/project-a') {
          aCallCount++
          return Promise.resolve(makeStalled(700))
        }
        return Promise.resolve(makeTerminal(['2-1']))
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      killPid: vi.fn(),
      resumePipeline: vi.fn().mockResolvedValue(0),
      incrementRestarts: vi.fn(),
      getAllDescendants: vi.fn().mockReturnValue([]),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    const exitCode = await runMultiProjectSupervisor(
      makeMultiOptions({ maxRestarts: 1 }),
      deps,
    )
    expect(exitCode).toBe(2)
  })

  it('one stalled project gets restarted while healthy project continues', async () => {
    let aCallCount = 0
    let bCallCount = 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        if (projectRoot === '/tmp/project-a') {
          aCallCount++
          // First call: stalled. After restart: terminal success.
          return Promise.resolve(aCallCount === 1 ? makeStalled(700) : makeTerminal(['1-1']))
        }
        bCallCount++
        return Promise.resolve(bCallCount === 1 ? makeHealthy() : makeTerminal(['2-1']))
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      killPid: vi.fn(),
      resumePipeline: vi.fn().mockResolvedValue(0),
      incrementRestarts: vi.fn(),
      getAllDescendants: vi.fn().mockReturnValue([]),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    const exitCode = await runMultiProjectSupervisor(makeMultiOptions(), deps)
    expect(exitCode).toBe(0)
    expect(deps.resumePipeline).toHaveBeenCalledOnce()
  })

  it('events interleave correctly (A-poll, B-poll per cycle)', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        return Promise.resolve(makeTerminal(projectRoot === '/tmp/project-a' ? ['1-1'] : ['2-1']))
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    await runMultiProjectSupervisor(makeMultiOptions(), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    // First two events should be polls for A then B (interleaved)
    const polls = lines.filter((e: any) => e.type === 'supervisor:poll')
    expect(polls[0].project).toBe('/tmp/project-a')
    expect(polls[1].project).toBe('/tmp/project-b')
  })

  it('errors on empty projects list', async () => {
    const exitCode = await runMultiProjectSupervisor(makeMultiOptions({ projects: [] }))
    expect(exitCode).toBe(1)
  })

  it('single project via --projects behaves like single-project mode', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal(['1-1'])),
      sleep: vi.fn().mockResolvedValue(undefined),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    const exitCode = await runMultiProjectSupervisor(
      makeMultiOptions({ projects: ['/tmp/project-a'] }),
      deps,
    )
    expect(exitCode).toBe(0)
  })

  it('handles project disappearing mid-run gracefully', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        if (projectRoot === '/tmp/project-a') {
          return Promise.reject(new Error('ENOENT: DB not found'))
        }
        return Promise.resolve(makeTerminal(['2-1']))
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    const exitCode = await runMultiProjectSupervisor(makeMultiOptions(), deps)
    // Project A errored (exit 1), project B succeeded (exit 0) → worst = 1
    expect(exitCode).toBe(1)
  })

  it('emits supervisor:done with project_results when all projects finish', async () => {
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(({ projectRoot }: { projectRoot: string }) => {
        return Promise.resolve(
          projectRoot === '/tmp/project-a'
            ? makeTerminal(['1-1'])
            : makeTerminal([], ['2-1']),
        )
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      getTokenSnapshot: vi.fn().mockReturnValue({ input: 0, output: 0, cost_usd: 0 }),
    }

    await runMultiProjectSupervisor(makeMultiOptions(), deps)

    const output = stdoutCapture.getOutput()
    const lines = output.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const doneEvent = lines.find((e: any) => e.type === 'supervisor:done')
    expect(doneEvent).toBeDefined()
    expect(doneEvent.project_results['/tmp/project-a']).toBe(0)
    expect(doneEvent.project_results['/tmp/project-b']).toBe(1)
  })
})
