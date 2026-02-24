/**
 * DispatcherImpl — concrete implementation of the Dispatcher interface.
 *
 * Spawns autonomous coding agents (Claude, Codex, Gemini) as subprocesses,
 * tracks their lifecycle, enforces concurrency limits, parses their YAML
 * output, and emits events through the event bus.
 *
 * Architecture:
 * - Uses child_process.spawn (ADR-005) — NOT exec
 * - Communicates via event bus (ADR-001: modular monolith)
 * - Prompt delivered via stdin
 * - YAML output parsed from stdout
 * - Concurrency limited with FIFO queue
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type {
  Dispatcher,
  DispatchRequest,
  DispatchHandle,
  DispatchResult,
  DispatchConfig,
} from './types.js'
import { DispatcherShuttingDownError, DEFAULT_TIMEOUTS, DEFAULT_MAX_TURNS } from './types.js'
import { extractYamlBlock, parseYamlResult } from './yaml-parser.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('agent-dispatch')

// Grace period (ms) between SIGTERM and SIGKILL during shutdown()
const SHUTDOWN_GRACE_MS = 10_000

// Maximum time (ms) to wait for processes to exit after SIGKILL during shutdown()
const SHUTDOWN_MAX_WAIT_MS = 30_000

// Characters per token for estimation heuristic
const CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// Internal active dispatch entry
// ---------------------------------------------------------------------------

interface ActiveDispatch {
  id: string
  agent: string
  taskType: string
  proc: ChildProcess
  startedAt: number
  timeoutHandle: ReturnType<typeof setTimeout> | null
  stdoutChunks: Buffer[]
  stderrChunks: Buffer[]
  resolve: (result: DispatchResult<unknown>) => void
  timedOut: boolean
  terminated: boolean
}

// ---------------------------------------------------------------------------
// Internal queued dispatch entry
// ---------------------------------------------------------------------------

interface QueuedDispatch {
  id: string
  request: DispatchRequest<unknown>
  handle: MutableDispatchHandle
  resolve: (result: DispatchResult<unknown>) => void
  reject: (err: Error) => void
}

// ---------------------------------------------------------------------------
// Mutable handle implementation
// ---------------------------------------------------------------------------

class MutableDispatchHandle implements DispatchHandle {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout'

  private _cancelFn: () => Promise<void>

  constructor(
    id: string,
    initialStatus: 'queued' | 'running',
    cancelFn: () => Promise<void>
  ) {
    this.id = id
    this.status = initialStatus
    this._cancelFn = cancelFn
  }

  cancel(): Promise<void> {
    return this._cancelFn()
  }
}

// ---------------------------------------------------------------------------
// DispatcherImpl
// ---------------------------------------------------------------------------

export class DispatcherImpl implements Dispatcher {
  private readonly _eventBus: TypedEventBus
  private readonly _adapterRegistry: AdapterRegistry
  private readonly _config: DispatchConfig

  private readonly _running: Map<string, ActiveDispatch> = new Map()
  private readonly _queue: QueuedDispatch[] = []

  private _shuttingDown: boolean = false

  constructor(
    eventBus: TypedEventBus,
    adapterRegistry: AdapterRegistry,
    config: DispatchConfig
  ) {
    this._eventBus = eventBus
    this._adapterRegistry = adapterRegistry
    this._config = config
  }

  // ---------------------------------------------------------------------------
  // Dispatcher interface
  // ---------------------------------------------------------------------------

  dispatch<T>(request: DispatchRequest<T>): DispatchHandle & { result: Promise<DispatchResult<T>> } {
    if (this._shuttingDown) {
      const handle = new MutableDispatchHandle(randomUUID(), 'failed', async () => {})
      handle.status = 'failed'
      return Object.assign(handle, {
        result: Promise.reject(new DispatcherShuttingDownError()) as Promise<DispatchResult<T>>,
      })
    }

    const id = randomUUID()

    const resultPromise = new Promise<DispatchResult<T>>((resolve, reject) => {
      const typedResolve = resolve as (result: DispatchResult<unknown>) => void

      if (this._running.size < this._config.maxConcurrency) {
        // Reserve the running slot synchronously before async work begins
        // This ensures getRunning() returns the correct count immediately
        this._reserveSlot(id)
        // Start the actual dispatch asynchronously
        this._startDispatch(id, request as DispatchRequest<unknown>, typedResolve).catch((err: unknown) => {
          // If _startDispatch throws unexpectedly, clean up the slot and drain the queue
          this._running.delete(id)
          this._drainQueue()
          reject(err as Error)
        })
      } else {
        // Queue it
        const queueHandle = new MutableDispatchHandle(id, 'queued', async () => {
          this._removeFromQueue(id)
          resolve({
            id,
            status: 'failed',
            exitCode: -1,
            output: '',
            parsed: null,
            parseError: 'Cancelled while queued',
            durationMs: 0,
            tokenEstimate: { input: 0, output: 0 },
          })
        })

        this._queue.push({
          id,
          request: request as DispatchRequest<unknown>,
          handle: queueHandle,
          resolve: typedResolve,
          reject,
        })

        logger.debug({ id, queueLength: this._queue.length }, 'Dispatch queued')
      }
    })

    // Determine initial status by checking whether the id was placed in the
    // running map (via _reserveSlot) or in the queue.  Reading both maps
    // directly avoids any reliance on side-effect ordering from the async
    // _startDispatch call above.
    const initialStatus = this._running.has(id) ? 'running' as const : 'queued' as const
    const cancelFn = async (): Promise<void> => {
      // If queued, remove from queue and reject the pending promise so the caller is not left hanging
      const queueIdx = this._queue.findIndex((q) => q.id === id)
      if (queueIdx !== -1) {
        const [queued] = this._queue.splice(queueIdx, 1)
        queued.reject(new Error(`Dispatch ${id} was cancelled while queued`))
        return
      }
      // If running, kill the process
      const entry = this._running.get(id)
      if (entry !== undefined && entry.proc != null) {
        try {
          entry.proc.kill('SIGTERM')
        } catch {
          // Process may already be dead
        }
      }
    }

    const handle = new MutableDispatchHandle(id, initialStatus, cancelFn)
    return Object.assign(handle, { result: resultPromise })
  }

  getPending(): number {
    return this._queue.length
  }

  getRunning(): number {
    return this._running.size
  }

  async shutdown(): Promise<void> {
    this._shuttingDown = true

    logger.info({ running: this._running.size, queued: this._queue.length }, 'Dispatcher shutting down')

    // Reject all queued dispatches
    const queued = this._queue.splice(0, this._queue.length)
    for (const entry of queued) {
      entry.reject(new DispatcherShuttingDownError())
    }

    if (this._running.size === 0) {
      return
    }

    // Snapshot running dispatches
    const runningEntries = Array.from(this._running.values())

    // Send SIGTERM to all running processes, mark as terminated
    for (const entry of runningEntries) {
      entry.terminated = true
      if (entry.timeoutHandle !== null) {
        clearTimeout(entry.timeoutHandle)
        entry.timeoutHandle = null
      }
      // Guard: proc may be null for placeholder slots reserved before spawn completes
      if (entry.proc !== null && entry.proc !== undefined) {
        try {
          entry.proc.kill('SIGTERM')
        } catch {
          // Process may already be dead
        }
      }
    }

    // Wait grace period
    await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))

    // SIGKILL any still remaining
    for (const entry of runningEntries) {
      if (this._running.has(entry.id)) {
        // Guard: proc may be null for placeholder slots
        if (entry.proc !== null && entry.proc !== undefined) {
          try {
            entry.proc.kill('SIGKILL')
          } catch {
            // Process may already be dead
          }
        }
      }
    }

    // Wait for all to exit (they should have after SIGKILL)
    // A maximum wait of 30 seconds is enforced to avoid hanging forever if
    // SIGKILL fails (e.g., on Windows or in edge cases).
    if (this._running.size > 0) {
      await new Promise<void>((resolve) => {
        const startWait = Date.now()
        const checkInterval = setInterval(() => {
          if (this._running.size === 0 || Date.now() - startWait >= SHUTDOWN_MAX_WAIT_MS) {
            clearInterval(checkInterval)
            resolve()
          }
        }, 50)
      })
    }

    logger.info('Dispatcher shutdown complete')
  }

  // ---------------------------------------------------------------------------
  // Internal dispatch lifecycle
  // ---------------------------------------------------------------------------

  private async _startDispatch(
    id: string,
    request: DispatchRequest<unknown>,
    resolve: (result: DispatchResult<unknown>) => void
  ): Promise<void> {
    const { prompt, agent, taskType, timeout, outputSchema, workingDirectory, maxTurns } = request

    // Look up adapter
    const adapter = this._adapterRegistry.get(agent as Parameters<typeof this._adapterRegistry.get>[0])
    if (adapter === undefined) {
      logger.warn({ id, agent }, 'No adapter found for agent')
      this._running.delete(id)
      this._drainQueue()
      resolve({
        id,
        status: 'failed',
        exitCode: -1,
        output: '',
        parsed: null,
        parseError: `No adapter registered for agent "${agent}"`,
        durationMs: 0,
        tokenEstimate: {
          input: Math.ceil(prompt.length / CHARS_PER_TOKEN),
          output: 0,
        },
      })
      return
    }

    // Build spawn command from adapter, using workingDirectory from request or process.cwd() as fallback
    const worktreePath = workingDirectory ?? process.cwd()
    const resolvedMaxTurns = maxTurns ?? DEFAULT_MAX_TURNS[taskType]
    const cmd = adapter.buildCommand(prompt, {
      worktreePath,
      billingMode: 'subscription',
      ...(resolvedMaxTurns !== undefined ? { maxTurns: resolvedMaxTurns } : {}),
    })

    // Resolve timeout
    const timeoutMs =
      timeout ??
      this._config.defaultTimeouts[taskType] ??
      DEFAULT_TIMEOUTS[taskType] ??
      300_000

    // Spawn the process
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    if (cmd.env !== undefined) {
      Object.assign(env, cmd.env)
    }
    if (cmd.unsetEnvKeys !== undefined) {
      for (const key of cmd.unsetEnvKeys) {
        delete env[key]
      }
    }

    const proc = spawn(cmd.binary, cmd.args, {
      cwd: cmd.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const startedAt = Date.now()

    // Write prompt to stdin and close — guard against EPIPE if process exits early
    if (proc.stdin !== null) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // Suppress EPIPE errors that occur when the process exits before stdin is consumed
        if (err.code !== 'EPIPE') {
          logger.warn({ id, error: err.message }, 'stdin write error')
        }
      })
      try {
        proc.stdin.write(prompt)
        proc.stdin.end()
      } catch {
        // Process may have already exited — stdin write failures are non-fatal
      }
    }

    // Set up output collection
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    if (proc.stdout !== null) {
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk)
        const dataStr = chunk.toString('utf-8')
        this._eventBus.emit('agent:output' as never, {
          dispatchId: id,
          data: dataStr,
        } as never)
      })
    }

    if (proc.stderr !== null) {
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })
    }

    // Create the active dispatch entry
    const activeDispatch: ActiveDispatch = {
      id,
      agent,
      taskType,
      proc,
      startedAt,
      timeoutHandle: null,
      stdoutChunks,
      stderrChunks,
      resolve,
      timedOut: false,
      terminated: false,
    }

    this._running.set(id, activeDispatch)

    // Emit spawned event
    this._eventBus.emit('agent:spawned' as never, {
      dispatchId: id,
      agent,
      taskType,
    } as never)

    logger.debug({ id, agent, taskType, timeoutMs }, 'Agent dispatched')

    // Set up timeout
    activeDispatch.timeoutHandle = setTimeout(() => {
      activeDispatch.timedOut = true
      proc.kill('SIGTERM')

      const durationMs = Date.now() - startedAt
      const output = Buffer.concat(stdoutChunks).toString('utf-8')
      const inputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN)
      const outputTokens = Math.ceil(output.length / CHARS_PER_TOKEN)

      this._eventBus.emit('agent:timeout' as never, {
        dispatchId: id,
        timeoutMs,
      } as never)

      logger.warn({ id, agent, taskType, timeoutMs }, 'Agent timed out')

      this._running.delete(id)
      this._drainQueue()

      resolve({
        id,
        status: 'timeout',
        exitCode: -1,
        output,
        parsed: null,
        parseError: `Agent timed out after ${String(timeoutMs)}ms`,
        durationMs,
        tokenEstimate: { input: inputTokens, output: outputTokens },
      })
    }, timeoutMs)

    // Set up close handler
    proc.on('close', (exitCode) => {
      const entry = this._running.get(id)
      if (entry === undefined || entry.timedOut) {
        return
      }

      // If terminated (shutdown in progress), clean up the running slot so
      // shutdown() can detect that all processes have exited.
      if (entry.terminated) {
        this._running.delete(id)
        this._drainQueue()
        return
      }

      if (entry.timeoutHandle !== null) {
        clearTimeout(entry.timeoutHandle)
        entry.timeoutHandle = null
      }

      const durationMs = Date.now() - startedAt
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const code = exitCode ?? 1

      const inputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN)

      this._running.delete(id)
      this._drainQueue()

      if (code === 0) {
        // Parse YAML output
        const yamlBlock = extractYamlBlock(stdout)
        let parsed: unknown = null
        let parseError: string | null = null

        if (yamlBlock !== null) {
          const parseResult = parseYamlResult(yamlBlock, outputSchema)
          parsed = parseResult.parsed
          parseError = parseResult.error
        } else {
          parseError = 'no_yaml_block'
        }

        this._eventBus.emit('agent:completed' as never, {
          dispatchId: id,
          exitCode: code,
          output: stdout,
        } as never)

        logger.debug({ id, agent, taskType, durationMs }, 'Agent completed')

        resolve({
          id,
          status: 'completed',
          exitCode: code,
          output: stdout,
          parsed,
          parseError,
          durationMs,
          tokenEstimate: { input: inputTokens, output: Math.ceil(stdout.length / CHARS_PER_TOKEN) },
        })
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8')

        this._eventBus.emit('agent:failed' as never, {
          dispatchId: id,
          error: stderr || `Process exited with code ${String(code)}`,
          exitCode: code,
        } as never)

        logger.debug({ id, agent, taskType, exitCode: code, durationMs }, 'Agent failed')

        // Combine stdout and stderr so callers have full context for failures
        const combinedOutput = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout

        resolve({
          id,
          status: 'failed',
          exitCode: code,
          output: combinedOutput,
          parsed: null,
          parseError: `Agent exited with code ${String(code)}`,
          durationMs,
          tokenEstimate: { input: inputTokens, output: Math.ceil(combinedOutput.length / CHARS_PER_TOKEN) },
        })
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Slot reservation
  // ---------------------------------------------------------------------------

  /**
   * Synchronously reserve a slot in the running map with a placeholder entry.
   * This ensures getRunning() reflects the correct count immediately, before
   * the async _startDispatch has a chance to set up the real ActiveDispatch entry.
   */
  private _reserveSlot(id: string): void {
    const placeholder: ActiveDispatch = {
      id,
      agent: '',
      taskType: '',
      proc: null as unknown as import('node:child_process').ChildProcess,
      startedAt: Date.now(),
      timeoutHandle: null,
      stdoutChunks: [],
      stderrChunks: [],
      resolve: () => undefined,
      timedOut: false,
      terminated: false,
    }
    this._running.set(id, placeholder)
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  private _drainQueue(): void {
    if (this._queue.length === 0) {
      return
    }
    if (this._running.size >= this._config.maxConcurrency) {
      return
    }
    if (this._shuttingDown) {
      return
    }

    const next = this._queue.shift()
    if (next === undefined) {
      return
    }

    next.handle.status = 'running'
    logger.debug({ id: next.id, queueLength: this._queue.length }, 'Dequeued dispatch')

    this._startDispatch(next.id, next.request, next.resolve).catch(next.reject)
  }

  private _removeFromQueue(id: string): void {
    const idx = this._queue.findIndex((q) => q.id === id)
    if (idx !== -1) {
      this._queue.splice(idx, 1)
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export interface CreateDispatcherOptions {
  eventBus: TypedEventBus
  adapterRegistry: AdapterRegistry
  config?: Partial<DispatchConfig>
}

/**
 * Create a new Dispatcher instance.
 *
 * @param options - Required eventBus and adapterRegistry; optional config overrides
 */
export function createDispatcher(options: CreateDispatcherOptions): Dispatcher {
  const config: DispatchConfig = {
    maxConcurrency: options.config?.maxConcurrency ?? 3,
    defaultTimeouts: {
      ...DEFAULT_TIMEOUTS,
      ...(options.config?.defaultTimeouts ?? {}),
    },
  }

  return new DispatcherImpl(options.eventBus, options.adapterRegistry, config)
}
