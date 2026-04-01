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
import { freemem, platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { EventMap } from '../events/types.js'
import type { TypedEventBus } from '../events/event-bus.js'
import type { DispatcherMemoryState } from './types.js'
import type {
  Dispatcher,
  DispatchRequest,
  DispatchHandle,
  DispatchResult,
  DispatchConfig,
  IAdapterRegistry,
  ILogger,
} from './types.js'
import { DispatcherShuttingDownError, DEFAULT_TIMEOUTS, DEFAULT_MAX_TURNS } from './types.js'
import { extractYamlBlock, parseYamlResult } from './yaml-parser.js'

// Grace period (ms) between SIGTERM and SIGKILL during shutdown()
const SHUTDOWN_GRACE_MS = 10_000

// Maximum time (ms) to wait for processes to exit after SIGKILL during shutdown()
const SHUTDOWN_MAX_WAIT_MS = 30_000

// Characters per token for estimation heuristic
const CHARS_PER_TOKEN = 4

// YAML output format reminder appended to prompts for non-Claude agents.
// Claude Code follows the methodology pack's embedded YAML instructions reliably;
// other agents (Codex, Gemini) sometimes need an explicit final reminder.
// When an outputSchema is provided, the suffix includes actual field names
// so the agent knows exactly what to emit.

/**
 * Extract top-level field names from a Zod schema for prompt injection.
 * Returns field names with type hints (e.g., "result: <string>", "files_modified: <list>").
 */
function extractSchemaFields(schema: unknown): string[] {
  // Zod object schemas have a .shape property with field definitions.
  // Navigate through .innerType() for transformed/preprocessed schemas.
  let current = schema as Record<string, unknown>

  // Unwrap ZodEffects (transform/preprocess/refine)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let def = (current as any)?._def
  while (def?.typeName === 'ZodEffects' && def?.schema != null) {
    current = def.schema as Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def = (current as any)?._def
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = (current as any)?.shape
  if (shape == null || typeof shape !== 'object') return []

  const fields: string[] = []
  for (const [key, fieldDef] of Object.entries(shape)) {
    const typeName = resolveZodTypeName(fieldDef)
    fields.push(`${key}: ${typeName}`)
  }
  return fields
}

/**
 * Resolve a human-readable type hint from a Zod field definition.
 */
function resolveZodTypeName(fieldDef: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = fieldDef as any
  const typeName = d?._def?.typeName as string | undefined

  // Unwrap wrappers: optional, default, preprocess
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
    return d._def?.innerType != null ? resolveZodTypeName(d._def.innerType) : '<value>'
  }
  if (typeName === 'ZodEffects') {
    return d._def?.schema != null ? resolveZodTypeName(d._def.schema) : '<value>'
  }

  if (typeName === 'ZodString') return '<string>'
  if (typeName === 'ZodNumber') return '<number>'
  if (typeName === 'ZodBoolean') return '<boolean>'
  if (typeName === 'ZodEnum') {
    const values = d._def?.values as string[] | undefined
    return values != null ? values.join(' | ') : '<enum>'
  }
  if (typeName === 'ZodArray') return '<list>'
  if (typeName === 'ZodObject') return '<object>'
  return '<value>'
}

function buildYamlOutputSuffix(outputSchema?: unknown): string {
  const fields = outputSchema != null ? extractSchemaFields(outputSchema) : []
  const fieldLines = fields.length > 0
    ? fields.map((f) => `  ${f}`).join('\n')
    : '  result: success\n  # ... additional fields as specified in the task above'

  return `

---
IMPORTANT: When you have completed the task, output your structured result as a fenced YAML block at the END of your response. Use this exact format:

\`\`\`yaml
${fieldLines}
\`\`\`

The YAML block MUST be the last thing in your output. Do not add any text after the closing fence.`
}

// Minimum free system memory (bytes) required before spawning a new agent.
// When free memory is below this threshold, dispatches are held in the queue
// and retried periodically until memory recovers.
// Override with SUBSTRATE_MEMORY_THRESHOLD_MB env var (e.g. "128" for 128 MB).
//
// History: originally 256MB when concurrent test suite runs caused OOM.
// Lowered to 128MB in v0.8.5 — concurrent dispatch is now controlled by
// concurrency slots, and the test suite has been optimized. Only level 4
// (critical) kernel pressure hard-gates to 0.
const MIN_FREE_MEMORY_BYTES = (() => {
  const envMB = process.env['SUBSTRATE_MEMORY_THRESHOLD_MB']
  if (envMB) {
    const parsed = parseInt(envMB, 10)
    if (!isNaN(parsed) && parsed >= 0) return parsed * 1024 * 1024
  }
  return 128 * 1024 * 1024 // 128 MB default
})()

// How often (ms) to re-check memory when the queue is held due to pressure
const MEMORY_PRESSURE_POLL_MS = 10_000

// Maximum time (ms) to hold the dispatch queue due to memory pressure before
// forcing dispatch with a warning. Prevents indefinite stalls when the system
// is persistently pressured (e.g., macOS with many concurrent processes).
const MEMORY_PRESSURE_MAX_HOLD_MS = 300_000 // 5 minutes

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
 * 2. Use page calculation: free + inactive + purgeable + speculative.
 *    These categories are reclaimable by the OS — matching macOS Activity
 *    Monitor's definition of available memory (Physical - Used).
 *    Inactive pages ("Cached Files") are included because macOS reclaims
 *    them transparently. Excluding them caused substrate to see ~3 GB
 *    available when Activity Monitor showed ~8 GB on a 24 GB machine.
 */
function getAvailableMemory(logger: ILogger): number {
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
      const inactive = parseInt(vmstat.match(/Pages inactive:\s+(\d+)/)?.[1] ?? '0', 10)
      const purgeable = parseInt(vmstat.match(/Pages purgeable:\s+(\d+)/)?.[1] ?? '0', 10)
      const speculative = parseInt(vmstat.match(/Pages speculative:\s+(\d+)/)?.[1] ?? '0', 10)
      const available = (free + inactive + purgeable + speculative) * pageSize
      // At warn level (2), log but trust the vm_stat estimate as-is.
      // Level 2 fires frequently on macOS when the compressor is active,
      // even with gigabytes of reclaimable memory. Halving caused false
      // stalls on 24GB machines during single-story runs.
      // Only level 4 (critical) hard-gates to 0 (handled above).
      if (pressureLevel >= 2) {
        logger.debug({ pressureLevel, available }, 'macOS kernel reports memory pressure level 2 (warn) — using raw estimate')
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
// CreateDispatcherOptions
// ---------------------------------------------------------------------------

/**
 * Options for the createDispatcher factory function.
 */
export interface CreateDispatcherOptions {
  /** Event bus instance to emit dispatch lifecycle events */
  eventBus: TypedEventBus<EventMap>
  /** Adapter registry for looking up agent CLI adapters */
  adapterRegistry: IAdapterRegistry
  /** Dispatcher configuration */
  config: DispatchConfig
  /** Optional logger instance. Defaults to console. */
  logger?: ILogger
}

// ---------------------------------------------------------------------------
// DispatcherImpl
// ---------------------------------------------------------------------------

export class DispatcherImpl implements Dispatcher {
  private readonly _eventBus: TypedEventBus<EventMap>
  private readonly _adapterRegistry: IAdapterRegistry
  private readonly _config: DispatchConfig
  private readonly _logger: ILogger

  private readonly _running: Map<string, ActiveDispatch> = new Map()
  private readonly _queue: QueuedDispatch[] = []

  private _shuttingDown: boolean = false
  private _memoryPressureTimer: ReturnType<typeof setInterval> | null = null
  private _memoryPressureHoldStart: number | null = null

  constructor(
    eventBus: TypedEventBus<EventMap>,
    adapterRegistry: IAdapterRegistry,
    config: DispatchConfig,
    logger: ILogger = console
  ) {
    this._eventBus = eventBus
    this._adapterRegistry = adapterRegistry
    this._config = config
    this._logger = logger
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

        this._logger.debug({ id, queueLength: this._queue.length }, 'Dispatch queued')
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
        queued?.reject(new Error(`Dispatch ${id} was cancelled while queued`))
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

    this._logger.info({ running: this._running.size, queued: this._queue.length }, 'Dispatcher shutting down')

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

    this._logger.info('Dispatcher shutdown complete')
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

    if (effectiveModel === undefined && this._config.routingResolver !== undefined) {
      const resolution = this._config.routingResolver.resolveModel(taskType)
      if (resolution !== null) {
        effectiveModel = resolution.model
        // Emit routing:model-selected before agent:spawned
        this._eventBus.emit('routing:model-selected' as never, {
          dispatchId: id,
          taskType,
          model: resolution.model,
          phase: resolution.phase,
          source: resolution.source,
        } as never)
        this._logger.debug({ id, taskType, model: resolution.model, routingSource: resolution.source }, 'Routing resolved model')
      } else {
        this._logger.debug({ id, taskType, routingSource: 'fallback' }, 'Routing returned null — using adapter default')
      }
    }

    // Look up adapter
    const adapter = this._adapterRegistry.get(agent)
    if (adapter === undefined) {
      this._logger.warn({ id, agent }, 'No adapter found for agent')
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

    // For agents that require it (declared via capabilities), append a YAML output
    // format reminder to the prompt. Claude Code follows methodology pack format
    // instructions reliably; other agents need an explicit final nudge.
    const capabilities = adapter.getCapabilities()
    const effectivePrompt = capabilities.requiresYamlSuffix === true
      ? prompt + buildYamlOutputSuffix(outputSchema)
      : prompt

    const cmd = adapter.buildCommand(effectivePrompt, {
      worktreePath,
      billingMode: 'subscription',
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(resolvedMaxTurns !== undefined ? { maxTurns: resolvedMaxTurns } : {}),
      ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      ...(otlpEndpoint !== undefined ? { otlpEndpoint } : {}),
      ...(storyKey !== undefined ? { storyKey } : {}),
      ...(optimizationDirectives !== undefined ? { optimizationDirectives } : {}),
      taskType,
      dispatchId: id,
    })

    // Resolve timeout, applying per-agent multiplier from adapter capabilities.
    // Agents that are slower (e.g., Codex) declare timeoutMultiplier > 1.0
    // so all timeouts scale automatically without per-project config overrides.
    const baseTimeoutMs =
      timeout ??
      this._config.defaultTimeouts[taskType] ??
      DEFAULT_TIMEOUTS[taskType] ??
      300_000
    const timeoutMultiplier = capabilities.timeoutMultiplier ?? 1.0
    const timeoutMs = Math.round(baseTimeoutMs * timeoutMultiplier)

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
      this._logger.error({ id, binary: cmd.binary, error: err.message }, 'Process spawn failed')
    })

    // Write prompt to stdin and close — guard against EPIPE if process exits early
    if (proc.stdin !== null) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // Suppress EPIPE errors that occur when the process exits before stdin is consumed
        if (err.code !== 'EPIPE') {
          this._logger.warn({ id, error: err.message }, 'stdin write error')
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

    this._logger.debug({ id, agent, taskType, timeoutMs }, 'Agent dispatched')

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

      this._logger.warn({ id, agent, taskType, timeoutMs }, 'Agent timed out')

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

        this._logger.debug({ id, agent, taskType, durationMs }, 'Agent completed')

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

        this._logger.warn(
          { id, agent, taskType, exitCode: code, durationMs, stderr: stderr.slice(0, 500) },
          'Agent failed',
        )

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
    this._logger.debug({ id: next.id, queueLength: this._queue.length }, 'Dequeued dispatch')

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
    const free = getAvailableMemory(this._logger)
    if (free < MIN_FREE_MEMORY_BYTES) {
      const now = Date.now()
      if (this._memoryPressureHoldStart === null) {
        this._memoryPressureHoldStart = now
      }
      const holdDurationMs = now - this._memoryPressureHoldStart
      // If we've been holding for too long, force dispatch with a warning
      if (holdDurationMs >= MEMORY_PRESSURE_MAX_HOLD_MS) {
        this._logger.warn(
          {
            freeMB: Math.round(free / 1024 / 1024),
            thresholdMB: Math.round(MIN_FREE_MEMORY_BYTES / 1024 / 1024),
            pressureLevel: _lastKnownPressureLevel,
            holdDurationMs,
          },
          'Memory pressure hold exceeded max duration — forcing dispatch',
        )
        this._memoryPressureHoldStart = null
        return false
      }
      // AC3 (Story 23-8): log freeMB, thresholdMB, and pressureLevel at warn
      this._logger.warn(
        {
          freeMB: Math.round(free / 1024 / 1024),
          thresholdMB: Math.round(MIN_FREE_MEMORY_BYTES / 1024 / 1024),
          pressureLevel: _lastKnownPressureLevel,
          holdDurationMs,
        },
        'Memory pressure detected — holding dispatch queue',
      )
      return true
    }
    // Memory cleared — reset hold timer
    this._memoryPressureHoldStart = null
    return false
  }

  /**
   * Return current memory pressure state (Story 23-8, AC1).
   *
   * Used by the orchestrator before dispatching a story phase so it can
   * implement backoff-retry without waiting on the dispatcher's internal queue.
   */
  getMemoryState(): DispatcherMemoryState {
    const free = getAvailableMemory(this._logger)
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
// createDispatcher factory
// ---------------------------------------------------------------------------

/**
 * Create a new DispatcherImpl instance.
 *
 * @param options - Configuration options for the dispatcher
 * @returns A new Dispatcher instance
 */
export function createDispatcher(options: CreateDispatcherOptions): Dispatcher {
  return new DispatcherImpl(
    options.eventBus,
    options.adapterRegistry,
    options.config,
    options.logger ?? console,
  )
}
