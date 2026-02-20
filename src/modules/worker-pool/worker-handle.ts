/**
 * WorkerHandle — wraps a ChildProcess spawned for a CLI agent task.
 *
 * Responsibilities:
 *  - Spawning the child process via child_process.spawn (ADR-005)
 *  - Collecting stdout / stderr into buffers
 *  - Invoking onComplete or onError callbacks based on exit code
 *  - Enforcing optional timeout via SIGKILL
 *  - Exposing terminate(signal) for external lifecycle control
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { SpawnCommand } from '../../adapters/types.js'

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

/** Called when the worker process exits with code 0 */
export type WorkerCompleteCallback = (stdout: string, stderr: string, exitCode: number) => void

/** Called when the worker process exits with a non-zero code (or times out) */
export type WorkerErrorCallback = (stderr: string, exitCode: number) => void

// ---------------------------------------------------------------------------
// WorkerHandle
// ---------------------------------------------------------------------------

/**
 * Wraps a single ChildProcess representing an executing CLI agent task.
 */
export class WorkerHandle {
  readonly workerId: string
  readonly taskId: string
  readonly adapterName: string

  private readonly _cmd: SpawnCommand
  private readonly _onComplete: WorkerCompleteCallback
  private readonly _onError: WorkerErrorCallback

  private _proc: ChildProcess | null = null
  private _timeoutHandle: ReturnType<typeof setTimeout> | null = null
  private _timedOut: boolean = false
  private _terminated: boolean = false
  readonly startedAt: Date

  constructor(
    workerId: string,
    taskId: string,
    adapterName: string,
    cmd: SpawnCommand,
    onComplete: WorkerCompleteCallback,
    onError: WorkerErrorCallback,
  ) {
    this.workerId = workerId
    this.taskId = taskId
    this.adapterName = adapterName
    this._cmd = cmd
    this._onComplete = onComplete
    this._onError = onError
    this.startedAt = new Date()
  }

  /**
   * Spawn the child process and wire up stdout/stderr collection and close handler.
   * Must be called exactly once.
   */
  start(): void {
    const cmd = this._cmd

    const proc = spawn(cmd.binary, cmd.args, {
      cwd: cmd.cwd,
      env: { ...process.env, ...cmd.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this._proc = proc

    // Pipe stdin if provided
    if (cmd.stdin !== undefined && cmd.stdin !== '') {
      proc.stdin.write(cmd.stdin)
    }
    proc.stdin.end()

    // Collect output into buffers
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    // Set up timeout if specified
    if (cmd.timeoutMs !== undefined && cmd.timeoutMs > 0) {
      this._timeoutHandle = setTimeout(() => {
        this._timedOut = true
        proc.kill('SIGKILL')
        const stderr = Buffer.concat(stderrChunks).toString('utf-8')
        this._onError(
          `Worker timed out after ${String(cmd.timeoutMs)}ms: ${stderr}`,
          1,
        )
      }, cmd.timeoutMs)
    }

    proc.on('close', (exitCode) => {
      // Clear timeout if it hasn't fired
      if (this._timeoutHandle !== null) {
        clearTimeout(this._timeoutHandle)
        this._timeoutHandle = null
      }

      // If the timeout callback already fired, or the worker was intentionally
      // terminated via terminate(), skip the normal callbacks
      if (this._timedOut || this._terminated) {
        return
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')
      const code = exitCode ?? 1

      if (code === 0) {
        this._onComplete(stdout, stderr, code)
      } else {
        this._onError(stderr, code)
      }
    })
  }

  /**
   * Send a signal to the child process.
   *
   * @param signal - 'SIGTERM' for graceful shutdown, 'SIGKILL' for immediate termination
   */
  terminate(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this._proc !== null) {
      this._terminated = true
      if (this._timeoutHandle !== null) {
        clearTimeout(this._timeoutHandle)
        this._timeoutHandle = null
      }
      this._proc.kill(signal)
    }
  }

  /**
   * Return elapsed time in milliseconds since the worker was started.
   */
  get elapsedMs(): number {
    return Date.now() - this.startedAt.getTime()
  }
}
