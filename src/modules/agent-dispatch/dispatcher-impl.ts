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

import { spawn, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { freemem, platform } from 'node:os'
import type { DispatcherMemoryState } from './types.js'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type { RoutingResolver } from '../../modules/routing/index.js'
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

// Minimum free system memory (bytes) required before spawning a new agent.
// When free memory is below this threshold, dispatches are held in the queue
// and retried periodically until memory recovers.
// Override with SUBSTRATE_MEMORY_THRESHOLD_MB env var (e.g. "256" for 256 MB).
const MIN_FREE_MEMORY_BYTES = (() => {
  const envMB = process.env.SUBSTRATE_MEMORY_THRESHOLD_MB
  if (envMB) {
    const parsed = parseInt(envMB, 10)
    if (!isNaN(parsed) && parsed >= 0) return parsed * 1024 * 1024
  }
  return 256 * 1024 * 1024 // 256 MB default
})()

// How often (ms) to re-check memory when the queue is held due to pressure
const MEMORY_PRESSURE_POLL_MS = 10_000

// Tracks the most recently observed macOS kernel pressure level (1=normal,
// 2=warn, 4=critical). Updated inside getAvailableMemory() on darwin.
// Read by _isMemoryPressured() to include in the warn log (Story 23-8, AC3).
let _lastKnownPressureLevel = 0

/**
 * Get available system memory in bytes, accounting for platform differences.
 *
 * On macOS, the previous approach (free + inactive pages) dramatically
 * overestimates availability because inactive pages may be compressed,
 * swapped, or require I/O to reclaim. With heavy agent concurrency, this
 * leads to spawning too many processes and triggering real memory pressure.
 *
 * New approach:
 * 1. Check kern.memorystatus_vm_pressure_level — the kernel's own assessment.
 *    Level 4 (critical) = hard gate, return 0.
 *    Level 2 (warn) = halve the vm_stat estimate as a conservative signal.
 *    Level 1 (normal) = trust vm_stat as-is.
 *    Note: level 2 fires frequently on macOS when the compressor is active,
 *    even with gigabytes of reclaimable memory. Hard-gating at 2 caused
 *    false stalls on 24GB+ machines with >50% free RAM.
 * 2. Use a conservative page calculation: free + purgeable + speculative.
 *    These categories are truly reclaimable without I/O or decompression.
 *    Inactive pages are excluded because they may require disk I/O,
 *    decompression, or may already be backing the compressor.
 */
function getAvailableMemory(): number {
  if (platform() === 'darwin') {
    let pressureLevel = 0
    try {
      // Kernel memory pressure level (1=normal, 2=warn, 4=critical)
      pressureLevel = parseInt(
        execSync('sysctl -n kern.memorystatus_vm_pressure_level', {
          timeout: 1000,
          encoding: 'utf-8',
        }).trim(),
        10,
      )
      _lastKnownPressureLevel = pressureLevel
      if (pressureLevel >= 4) {
        logger.warn({ pressureLevel }, 'macOS kernel reports critical memory pressure')
        return 0
      }
    } catch {
      // sysctl not available — fall through to vm_stat
    }

    try {
      const vmstat = execSync('vm_stat', { timeout: 2000, encoding: 'utf-8' })
      const pageSize = parseInt(vmstat.match(/page size of (\d+)/)?.[1] ?? '4096', 10)
      const free = parseInt(vmstat.match(/Pages free:\s+(\d+)/)?.[1] ?? '0', 10)
      const purgeable = parseInt(vmstat.match(/Pages purgeable:\s+(\d+)/)?.[1] ?? '0', 10)
      const speculative = parseInt(vmstat.match(/Pages speculative:\s+(\d+)/)?.[1] ?? '0', 10)
      const available = (free + purgeable + speculative) * pageSize
      // At warn level, halve the estimate to be conservative without hard-blocking
      if (pressureLevel >= 2) {
        logger.warn({ pressureLevel, availableBeforeDiscount: available }, 'macOS kernel reports memory pressure — discounting estimate')
        return Math.floor(available / 2)
      }
      return available
    } catch {
      return freemem()
    }
  }
  // Non-darwin: pressure level is always 0
  _lastKnownPressureLevel = 0
  return freemem()
}

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
  private readonly _routingResolver: RoutingResolver | null

  private readonly _running: Map<string, ActiveDispatch> = new Map()
  private readonly _queue: QueuedDispatch[] = []

  private _shuttingDown: boolean = false
  private _memoryPressureTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    eventBus: TypedEventBus,
    adapterRegistry: AdapterRegistry,
    config: DispatchConfig
  ) {
    this._eventBus = eventBus
    this._adapterRegistry = adapterRegistry
    this._config = config
    this._routingResolver = config.routingResolver ?? null
  }

  // ---------------------------------------------------------------------------
  // Dispatcher interface
  // ---------------------------------------------------------------------------

  dispatch<T>(request: DispatchRequest<T>): DispatchHandle & { result: Promise<DispatchResult<T>> } {
    if (this._shuttingDown) {
      const handle = new MutableDispatchHandle(randomUUID(), 'queued', async () => {})
      handle.status = 'failed'
      return Object.assign(handle, {
        result: Promise.reject(new DispatcherShuttingDownError()) as Promise<DispatchResult<T>>,
      })
    }

    const id = randomUUID()

    const resultPromise = new Promise<DispatchResult<T>>((resolve, reject) => {
      const typedResolve = resolve as (result: DispatchResult<unknown>) => void

      if (this._running.size < this._config.maxConcurrency && !this._isMemoryPressured()) {
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
    this._stopMemoryPressureTimer()

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
    const { prompt, agent, taskType, timeout, outputSchema, workingDirectory, model, maxTurns, maxContextTokens, otlpEndpoint, storyKey, optimizationDirectives } = request

    // Resolve effective model: explicit request.model wins; then routing resolver; then undefined (adapter default)
    let effectiveModel: string | undefined = model

    if (effectiveModel === undefined && this._routingResolver !== null) {
      const resolution = this._routingResolver.resolveModel(taskType)
      if (resolution !== null) {
        effectiveModel = resolution.model
        // Emit routing:model-selected before agent:spawned
        this._eventBus.emit('routing:model-selected', {
          dispatchId: id,
          taskType,
          model: resolution.model,
          phase: resolution.phase,
          source: resolution.source,
        })
        logger.debug({ id, taskType, model: resolution.model, routingSource: resolution.source }, 'Routing resolved model')
      } else {
        logger.debug({ id, taskType, routingSource: 'fallback' }, 'Routing returned null — using adapter default')
      }
    }

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
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(resolvedMaxTurns !== undefined ? { maxTurns: resolvedMaxTurns } : {}),
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      ...(otlpEndpoint !== undefined ? { otlpEndpoint } : {}),
      ...(storyKey !== undefined ? { storyKey } : {}),
      ...(optimizationDirectives !== undefined ? { optimizationDirectives } : {}),
    })

    // Resolve timeout
    const timeoutMs =
      timeout ??
      this._config.defaultTimeouts[taskType] ??
      DEFAULT_TIMEOUTS[taskType] ??
      300_000

    // Spawn the process
    const env: Record<string, string> = { ...process.env as Record<string, string> }

    // Cap Node.js heap per spawned agent to prevent memory exhaustion when
    // multiple agents run vitest concurrently (each vitest fork inherits this).
    const parentNodeOpts = env['NODE_OPTIONS'] ?? ''
    if (!parentNodeOpts.includes('--max-old-space-size')) {
      env['NODE_OPTIONS'] = `${parentNodeOpts} --max-old-space-size=512`.trim()
    }

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

    // Handle spawn errors — if the binary doesn't exist or can't be executed,
    // the 'error' event fires. Without this handler, spawn failures are silent.
    proc.on('error', (err: Error) => {
      logger.error({ id, binary: cmd.binary, error: err.message }, 'Process spawn failed')
    })

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
          inputTokens,
          outputTokens: Math.ceil(stdout.length / CHARS_PER_TOKEN),
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
      this._stopMemoryPressureTimer()
      return
    }
    if (this._running.size >= this._config.maxConcurrency) {
      return
    }
    if (this._shuttingDown) {
      return
    }
    if (this._isMemoryPressured()) {
      this._startMemoryPressureTimer()
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

  // ---------------------------------------------------------------------------
  // Memory pressure management
  // ---------------------------------------------------------------------------

  private _isMemoryPressured(): boolean {
    const free = getAvailableMemory()
    if (free < MIN_FREE_MEMORY_BYTES) {
      // AC3 (Story 23-8): log freeMB, thresholdMB, and pressureLevel at warn
      logger.warn(
        {
          freeMB: Math.round(free / 1024 / 1024),
          thresholdMB: Math.round(MIN_FREE_MEMORY_BYTES / 1024 / 1024),
          pressureLevel: _lastKnownPressureLevel,
        },
        'Memory pressure detected — holding dispatch queue',
      )
      return true
    }
    return false
  }

  /**
   * Return current memory pressure state (Story 23-8, AC1).
   *
   * Used by the orchestrator before dispatching a story phase so it can
   * implement backoff-retry without waiting on the dispatcher's internal queue.
   */
  getMemoryState(): DispatcherMemoryState {
    const free = getAvailableMemory()
    return {
      freeMB: Math.round(free / 1024 / 1024),
      thresholdMB: Math.round(MIN_FREE_MEMORY_BYTES / 1024 / 1024),
      pressureLevel: _lastKnownPressureLevel,
      isPressured: free < MIN_FREE_MEMORY_BYTES,
    }
  }

  private _startMemoryPressureTimer(): void {
    if (this._memoryPressureTimer !== null) return
    this._memoryPressureTimer = setInterval(() => {
      this._drainQueue()
    }, MEMORY_PRESSURE_POLL_MS)
    this._memoryPressureTimer.unref()
  }

  private _stopMemoryPressureTimer(): void {
    if (this._memoryPressureTimer !== null) {
      clearInterval(this._memoryPressureTimer)
      this._memoryPressureTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// Build Verification Gate (Story 24-2)
// ---------------------------------------------------------------------------

/** Default command for the build verification gate */
export const DEFAULT_VERIFY_COMMAND = 'npm run build'

// ---------------------------------------------------------------------------
// Package Manager Detection (Story 24-8)
// ---------------------------------------------------------------------------

/** Result returned by detectPackageManager */
export interface PackageManagerDetectionResult {
  /** The detected package manager (or 'none' when no build system is recognized) */
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm' | 'none'
  /** The lockfile/marker that was found, or null when falling back */
  lockfile: string | null
  /** The resolved build command, or empty string to skip verification */
  command: string
}

/**
 * Detect the package manager / build system used in a project.
 *
 * Checks for language-specific markers in priority order:
 *   1. Node.js lockfiles → corresponding `<pm> run build`
 *   2. Python markers (pyproject.toml, poetry.lock, setup.py) → skip (no universal build step)
 *   3. Rust (Cargo.toml) → cargo build
 *   4. Go (go.mod) → go build ./...
 *   5. No markers found → skip (empty command)
 *
 * When a non-Node.js project is detected (or nothing is recognized), the
 * returned command is '' which causes runBuildVerification() to skip.
 */
export function detectPackageManager(projectRoot: string): PackageManagerDetectionResult {
  // Node.js lockfiles — checked first, return a build command
  const nodeCandidates: Array<{
    file: string
    packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm'
    command: string
  }> = [
    { file: 'pnpm-lock.yaml', packageManager: 'pnpm', command: 'pnpm run build' },
    { file: 'yarn.lock', packageManager: 'yarn', command: 'yarn run build' },
    { file: 'bun.lockb', packageManager: 'bun', command: 'bun run build' },
    { file: 'package-lock.json', packageManager: 'npm', command: 'npm run build' },
  ]

  // Non-Node markers — skip build verification (no universal "build" step)
  const nonNodeMarkers = [
    'pyproject.toml',
    'poetry.lock',
    'setup.py',
    'Cargo.toml',
    'go.mod',
  ]

  // Check if a non-Node marker exists. If so, skip even if a package-lock.json
  // also exists (common in projects that use npm for ancillary tooling like bmad).
  for (const marker of nonNodeMarkers) {
    if (existsSync(join(projectRoot, marker))) {
      return { packageManager: 'none', lockfile: marker, command: '' }
    }
  }

  for (const candidate of nodeCandidates) {
    if (existsSync(join(projectRoot, candidate.file))) {
      return {
        packageManager: candidate.packageManager,
        lockfile: candidate.file,
        command: candidate.command,
      }
    }
  }

  // Fallback: no recognized build system — skip verification
  return { packageManager: 'none', lockfile: null, command: '' }
}

/** Default timeout in milliseconds for the build verification gate */
export const DEFAULT_VERIFY_TIMEOUT_MS = 60_000

/** Result returned by runBuildVerification */
export interface BuildVerificationResult {
  /** 'passed' = exit 0; 'failed' = non-zero exit; 'timeout' = exceeded timeout; 'skipped' = gate disabled */
  status: 'passed' | 'failed' | 'skipped' | 'timeout'
  /** Exit code from the process. -1 for timeout, undefined for skipped. */
  exitCode?: number
  /** Combined stdout+stderr output. Empty/undefined for skipped or no output. */
  output?: string
  /** Machine-readable reason for failure/timeout escalation. */
  reason?: 'build-verification-failed' | 'build-verification-timeout'
}

/**
 * Run the build verification gate synchronously.
 *
 * Executes the configured verifyCommand (default: "npm run build") in the
 * project root directory, capturing stdout and stderr. On success (exit 0)
 * returns { status: 'passed' }. On failure or timeout, returns a structured
 * result with status, exitCode, output, and reason.
 *
 * AC4/5: reads verifyCommand from options (or defaults to 'npm run build').
 * AC6: if verifyCommand is empty string or false, returns { status: 'skipped' }.
 * AC8: timeout is configurable via verifyTimeoutMs (default 60 s).
 */
export function runBuildVerification(options: {
  verifyCommand?: string | false
  verifyTimeoutMs?: number
  projectRoot: string
}): BuildVerificationResult {
  const { verifyCommand, verifyTimeoutMs, projectRoot } = options

  // Resolve the build command:
  // - undefined → auto-detect from lockfile (AC1, AC4, AC5)
  // - string    → use as-is, even if empty (AC2)
  // - false     → skip (AC3)
  let cmd: string | false
  if (verifyCommand === undefined) {
    const detection = detectPackageManager(projectRoot)
    logger.info(
      {
        packageManager: detection.packageManager,
        lockfile: detection.lockfile,
        resolvedCommand: detection.command,
      },
      'Build verification: resolved command via package manager detection',
    )
    cmd = detection.command
  } else {
    cmd = verifyCommand
  }

  // AC6: skip if explicitly disabled (false or empty string)
  if (!cmd) {
    return { status: 'skipped' }
  }

  const timeoutMs = verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS

  try {
    const stdout = execSync(cmd, {
      cwd: projectRoot,
      timeout: timeoutMs,
      encoding: 'utf-8',
    })

    return {
      status: 'passed',
      exitCode: 0,
      output: typeof stdout === 'string' ? stdout : '',
    }
  } catch (err: unknown) {
    if (err != null && typeof err === 'object') {
      const e = err as {
        killed?: boolean
        signal?: string | null
        status?: number | null
        stdout?: unknown
        stderr?: unknown
      }

      const isTimeout = e.killed === true
      const exitCode = typeof e.status === 'number' ? e.status : 1

      const rawStdout = e.stdout
      const rawStderr = e.stderr
      const stdoutStr =
        typeof rawStdout === 'string'
          ? rawStdout
          : Buffer.isBuffer(rawStdout)
            ? rawStdout.toString('utf-8')
            : ''
      const stderrStr =
        typeof rawStderr === 'string'
          ? rawStderr
          : Buffer.isBuffer(rawStderr)
            ? rawStderr.toString('utf-8')
            : ''
      const combinedOutput = [stdoutStr, stderrStr]
        .filter((s) => s.length > 0)
        .join('\n')

      if (isTimeout) {
        return {
          status: 'timeout',
          exitCode: -1,
          output: combinedOutput,
          reason: 'build-verification-timeout',
        }
      }

      return {
        status: 'failed',
        exitCode,
        output: combinedOutput,
        reason: 'build-verification-failed',
      }
    }

    return {
      status: 'failed',
      exitCode: 1,
      output: String(err),
      reason: 'build-verification-failed',
    }
  }
}

// ---------------------------------------------------------------------------
// Zero-Diff Detection Helper (Story 24-1)
// ---------------------------------------------------------------------------

/**
 * Check git working tree for modified files using `git diff --name-only HEAD`
 * (unstaged + staged changes to tracked files) and `git diff --cached --name-only`
 * (staged new files not yet in HEAD). Returns a deduplicated array of file paths.
 *
 * Returns an empty array when:
 * - No files have been modified or staged
 * - Git commands fail (e.g., not in a git repo, git not installed)
 *
 * Used by the zero-diff detection gate (Story 24-1) to catch phantom completions
 * where a dev-story agent reported COMPLETE but made no actual file changes.
 *
 * @param workingDir - Directory to run git commands in (defaults to process.cwd())
 * @returns Array of changed file paths; empty when nothing changed
 */
export function checkGitDiffFiles(workingDir: string = process.cwd()): string[] {
  const results = new Set<string>()

  try {
    const unstaged = execSync('git diff --name-only HEAD', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    unstaged
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((f) => results.add(f))
  } catch {
    // git not available, not a repo, or diff failed — treat as no changes detected.
    // When both git commands fail, results stays empty → changedFiles.length === 0
    // → the orchestrator will escalate the story via the zero-diff gate (not proceed
    // to code-review).
  }

  try {
    const staged = execSync('git diff --cached --name-only', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    staged
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((f) => results.add(f))
  } catch {
    // staged diff failed — continue with whatever we have
  }

  return Array.from(results)
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export interface CreateDispatcherOptions {
  eventBus: TypedEventBus
  adapterRegistry: AdapterRegistry
  config?: Partial<DispatchConfig> & { routingResolver?: RoutingResolver }
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
    routingResolver: options.config?.routingResolver ?? undefined,
  }

  return new DispatcherImpl(options.eventBus, options.adapterRegistry, config)
}
