/**
 * Multi-Signal Stall Detection — Story 53-2
 *
 * Three pure classes that require two independent signals before declaring a stall:
 *   1. OutputGrowthTracker — tracks per-story output size snapshots
 *   2. CpuSampler          — platform-aware CPU usage sampling
 *   3. MultiSignalStallDetector — combines timer + output + CPU signals
 *
 * All I/O is injected; these classes have no side effects of their own.
 */

import { promises as fsPromises } from 'fs'

// ---------------------------------------------------------------------------
// OutputGrowthTracker
// ---------------------------------------------------------------------------

export interface OutputSnapshot {
  sizeBytes: number
  recordedAt: number
}

export class OutputGrowthTracker {
  private readonly history: Map<string, OutputSnapshot[]> = new Map()
  private readonly maxHistoryPerStory: number

  constructor(maxHistoryPerStory = 5) {
    this.maxHistoryPerStory = maxHistoryPerStory
  }

  /**
   * Append a new snapshot for the given story, trimming to `maxHistoryPerStory`.
   */
  recordSnapshot(storyKey: string, sizeBytes: number): void {
    const existing = this.history.get(storyKey) ?? []
    const updated = [...existing, { sizeBytes, recordedAt: Date.now() }]
    if (updated.length > this.maxHistoryPerStory) {
      updated.splice(0, updated.length - this.maxHistoryPerStory)
    }
    this.history.set(storyKey, updated)
  }

  /**
   * Returns true if the last `minConsecutivePolls` snapshots all have equal sizeBytes.
   * Returns false if fewer than `minConsecutivePolls` snapshots exist — not enough data.
   */
  isStagnant(storyKey: string, minConsecutivePolls: number): boolean {
    const snapshots = this.history.get(storyKey) ?? []
    if (snapshots.length < minConsecutivePolls) return false
    const recent = snapshots.slice(-minConsecutivePolls)
    const baseline = recent[0]!.sizeBytes
    return recent.every((s) => s.sizeBytes === baseline)
  }

  /**
   * Remove history for one story (call on story completion or restart).
   */
  clear(storyKey: string): void {
    this.history.delete(storyKey)
  }

  /**
   * Wipe all history (call on supervisor restart).
   */
  clearAll(): void {
    this.history.clear()
  }
}

// ---------------------------------------------------------------------------
// CpuSampler
// ---------------------------------------------------------------------------

export interface CpuSamplerResult {
  cpuPercent: number | null
  available: boolean
}

export interface CpuSamplerDeps {
  readFile?: (path: string) => Promise<string>
  execLine?: (cmd: string) => Promise<string>
}

export class CpuSampler {
  private readonly prevTicks: Map<number, number> = new Map()
  private readonly readFile: (path: string) => Promise<string>
  private readonly execLine: (cmd: string) => Promise<string>
  private readonly platform: string

  constructor(deps: CpuSamplerDeps = {}, platform?: string) {
    this.readFile = deps.readFile ?? ((path) => fsPromises.readFile(path, 'utf-8'))
    this.execLine =
      deps.execLine ??
      (async (cmd) => {
        // Lazy import to avoid static child_process dependency (per dev notes)
        const { execFile: execFileRaw } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFileRaw)
        // Parse the command into binary + args for execFile
        const parts = cmd.trim().split(/\s+/)
        const bin = parts[0]!
        const args = parts.slice(1)
        const { stdout } = await execFileAsync(bin, args, { timeout: 5000 })
        return stdout
      })
    this.platform = platform ?? process.platform
  }

  /**
   * Sample CPU usage for the given PID.
   *
   * Linux: reads /proc/{pid}/stat and computes delta ticks between calls.
   *   - First call: stores ticks, returns { cpuPercent: null, available: true } (no baseline yet)
   *   - Subsequent calls: returns { cpuPercent: 0 | 1, available: true }
   *
   * macOS: runs `ps -p {pid} -o %cpu=` and parses the float result.
   *
   * On error: returns { cpuPercent: null, available: false }
   */
  async sample(pid: number): Promise<CpuSamplerResult> {
    try {
      if (this.platform === 'linux') {
        return await this._sampleLinux(pid)
      } else {
        return await this._sampleMacOs(pid)
      }
    } catch {
      this.prevTicks.delete(pid)
      return { cpuPercent: null, available: false }
    }
  }

  private async _sampleLinux(pid: number): Promise<CpuSamplerResult> {
    let content: string
    try {
      content = await this.readFile(`/proc/${pid}/stat`)
    } catch {
      this.prevTicks.delete(pid)
      return { cpuPercent: null, available: false }
    }

    const fields = content.trim().split(' ')
    // Fields 13 and 14 (0-indexed) are utime and stime
    const utime = parseInt(fields[13]!, 10)
    const stime = parseInt(fields[14]!, 10)

    if (isNaN(utime) || isNaN(stime)) {
      this.prevTicks.delete(pid)
      return { cpuPercent: null, available: false }
    }

    const ticks = utime + stime

    if (!this.prevTicks.has(pid)) {
      // First sample — store baseline, no verdict yet
      this.prevTicks.set(pid, ticks)
      return { cpuPercent: null, available: true }
    }

    const prev = this.prevTicks.get(pid)!
    const delta = ticks - prev
    this.prevTicks.set(pid, ticks)

    return { cpuPercent: delta > 0 ? 1 : 0, available: true }
  }

  private async _sampleMacOs(pid: number): Promise<CpuSamplerResult> {
    let raw: string
    try {
      raw = await this.execLine(`ps -p ${pid} -o %cpu=`)
    } catch {
      return { cpuPercent: null, available: false }
    }

    const trimmed = raw.trim()
    const parsed = parseFloat(trimmed)

    if (isNaN(parsed)) {
      return { cpuPercent: null, available: false }
    }

    return { cpuPercent: parsed, available: true }
  }
}

// ---------------------------------------------------------------------------
// MultiSignalStallDetector
// ---------------------------------------------------------------------------

export interface MultiSignalInput {
  stallTimerExceeded: boolean // from StallDetector.evaluate().isStalled
  outputStagnant2: boolean // OutputGrowthTracker.isStagnant(key, 2)
  outputStagnant3: boolean // OutputGrowthTracker.isStagnant(key, 3)
  cpuResult: CpuSamplerResult
  processAlive: boolean // true when orchestrator PID responds to kill(pid, 0)
}

export interface MultiSignalResult {
  isStall: boolean
  isZombie: boolean
  suppressedBySingleSignal: boolean // true when timer exceeded but second signal absent
  reason: string // human-readable explanation
}

export class MultiSignalStallDetector {
  /**
   * Evaluate whether a stall or zombie condition is present given two independent signals.
   *
   * Zombie check (independent of timer): process alive + CPU=0 + output stagnant 3 polls
   * Stall check: timer exceeded + (output stagnant 2 polls OR CPU idle OR process dead)
   *   If CPU unavailable: timer exceeded + output stagnant 2 polls only
   */
  evaluate(input: MultiSignalInput, logWarning: (msg: string) => void): MultiSignalResult {
    const { stallTimerExceeded, outputStagnant2, outputStagnant3, cpuResult, processAlive } = input

    // Zombie: independent of timer — a process alive but consuming no CPU and producing
    // no output for 3 consecutive polls is hung beyond recovery.
    const isZombie =
      processAlive && cpuResult.available && cpuResult.cpuPercent === 0 && outputStagnant3

    let isStall = false
    if (stallTimerExceeded) {
      if (cpuResult.available) {
        // Second signal: output stagnation OR CPU idle OR process dead
        isStall = outputStagnant2 || cpuResult.cpuPercent === 0 || !processAlive
      } else {
        // CPU signal unavailable — output stagnation is the sole required second signal.
        logWarning('CPU sampling unavailable — using output growth as second stall signal')
        isStall = outputStagnant2
      }
    }

    const suppressedBySingleSignal = stallTimerExceeded && !isStall && !isZombie

    return {
      isStall,
      isZombie,
      suppressedBySingleSignal,
      reason: isZombie
        ? 'zombie: process alive, CPU=0, output stagnant 3 polls'
        : isStall
          ? `stall: timer exceeded, second signal confirmed (cpu=${cpuResult.cpuPercent}, outputStagnant=${outputStagnant2}, processAlive=${processAlive})`
          : suppressedBySingleSignal
            ? 'timer exceeded but output still growing — kill suppressed'
            : 'no stall',
    }
  }
}
