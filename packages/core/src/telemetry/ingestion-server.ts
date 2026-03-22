/**
 * IngestionServer — local OTLP HTTP/JSON endpoint for Claude Code telemetry.
 *
 * Starts an HTTP server that accepts OTLP-formatted telemetry payloads from
 * Claude Code sub-agents. The server binds to a configurable port (default 4318)
 * and exposes `getOtlpEnvVars()` to retrieve the 5 environment variables that
 * configure Claude Code to export telemetry to this endpoint.
 *
 * When a `TelemetryPipeline` is injected, received payloads are parsed and
 * buffered via `BatchBuffer`, which flushes to the pipeline on size or time
 * triggers. Without a pipeline, the server operates in stub mode (acknowledge
 * and discard), preserving backwards-compatibility.
 *
 * Usage:
 *   const server = new IngestionServer({ port: 4318 })
 *   await server.start()
 *   const envVars = server.getOtlpEnvVars()  // inject into sub-agents
 *   await server.stop()
 */

import { createServer } from 'node:http'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGunzip, createInflate } from 'node:zlib'
import type { ILogger } from '../dispatch/types.js'
import { BatchBuffer } from './batch-buffer.js'
import type { TelemetryPipeline } from './telemetry-pipeline.js'
import type { RawOtlpPayload, DispatchContext } from './types.js'
import { detectSource } from './source-detector.js'

// Re-export DispatchContext from types so consumers can import it from this path
export type { DispatchContext } from './types.js'

// ---------------------------------------------------------------------------
// TelemetryError
// ---------------------------------------------------------------------------

/**
 * Error thrown by IngestionServer for server lifecycle violations.
 * Extends Error with a machine-readable `code` property.
 * (In the monolith, callers may import TelemetryError from the shim which
 * re-exports this class from @substrate-ai/core.)
 */
export class TelemetryError extends Error {
  public readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'TelemetryError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// IngestionServerOptions
// ---------------------------------------------------------------------------

export interface IngestionServerOptions {
  /** Port to bind to. Pass 0 to let the OS assign a free port (for tests). */
  port?: number
  /** Optional TelemetryPipeline to process received payloads. */
  pipeline?: TelemetryPipeline
  /** Override BatchBuffer batch size (default: 100). */
  batchSize?: number
  /** Override BatchBuffer flush interval in ms (default: 5000). */
  flushIntervalMs?: number
  /** Optional logger (defaults to console). */
  logger?: ILogger
}

// ---------------------------------------------------------------------------
// IngestionServer
// ---------------------------------------------------------------------------

/**
 * Local HTTP server that accepts OTLP payloads from Claude Code sub-agents.
 *
 * Binds to `port` (default 4318). Use port 0 in tests for an OS-assigned port.
 */
export class IngestionServer {
  private _server: Server | null = null
  private readonly _port: number
  private readonly _batchSize: number
  private readonly _flushIntervalMs: number
  private _buffer: BatchBuffer<RawOtlpPayload> | undefined
  private readonly _pendingBatches = new Set<Promise<void>>()
  private readonly _logger: ILogger

  constructor(options: IngestionServerOptions = {}) {
    this._port = options.port ?? 4318
    this._batchSize = options.batchSize ?? 100
    this._flushIntervalMs = options.flushIntervalMs ?? 5000
    this._logger = options.logger ?? console

    if (options.pipeline !== undefined) {
      this._initPipeline(options.pipeline)
    }
  }

  /**
   * Wire a TelemetryPipeline before the server is started.
   * Must be called before start() — has no effect if called after start().
   */
  setPipeline(pipeline: TelemetryPipeline): void {
    if (this._server !== null) {
      this._logger.warn('IngestionServer.setPipeline() called after start() — ignoring')
      return
    }
    this._initPipeline(pipeline)
  }

  private _initPipeline(pipeline: TelemetryPipeline): void {
    this._buffer = new BatchBuffer<RawOtlpPayload>({
      batchSize: this._batchSize,
      flushIntervalMs: this._flushIntervalMs,
    })

    // Wire: batch flush → pipeline processBatch
    // Track each in-flight processBatch() promise so stop() can await them.
    this._buffer.on('flush', (items: RawOtlpPayload[]) => {
      const pending = pipeline.processBatch(items).catch((err: unknown) => {
        this._logger.warn({ err }, 'TelemetryPipeline.processBatch failed (batch flush)')
      })
      this._pendingBatches.add(pending)
      void pending.then(() => {
        this._pendingBatches.delete(pending)
      })
    })
  }

  /**
   * Force-flush buffered OTLP payloads and await all in-flight processBatch() calls.
   * Call this between story dispatches to ensure story N's telemetry (including
   * recommendations) is fully persisted before story N+1 begins.
   *
   * No-op when no TelemetryPipeline is wired.
   */
  async flushAndAwait(): Promise<void> {
    if (this._buffer === undefined) return
    this._buffer.flush()
    if (this._pendingBatches.size > 0) {
      await Promise.all([...this._pendingBatches])
    }
  }

  /**
   * Start the HTTP ingestion server.
   * Resolves when the server is listening and ready to accept connections.
   * On EADDRINUSE, retries up to 10 consecutive ports before failing.
   */
  async start(): Promise<void> {
    if (this._server !== null) {
      this._logger.warn('IngestionServer.start() called while already started — ignoring')
      return
    }

    const maxRetries = 10
    let lastErr: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const port = this._port + attempt
      try {
        await this._tryListen(port)
        return
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException
        if (nodeErr.code === 'EADDRINUSE' && attempt < maxRetries) {
          this._logger.warn(
            { port, attempt: attempt + 1 },
            `Port ${port} in use — trying ${port + 1}`,
          )
          lastErr = nodeErr
          continue
        }
        throw err
      }
    }

    throw lastErr ?? new Error('IngestionServer: exhausted port retry attempts')
  }

  private _tryListen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer(this._handleRequest.bind(this))

      server.on('error', (err) => {
        server.close()
        reject(err)
      })

      server.listen(port, '127.0.0.1', () => {
        this._server = server
        const addr = server.address() as AddressInfo
        this._logger.info(
          { port: addr.port, requestedPort: this._port },
          'IngestionServer listening',
        )

        // Start the batch buffer timer (if pipeline is wired)
        this._buffer?.start()

        resolve()
      })
    })
  }

  /**
   * Stop the HTTP ingestion server.
   * Drains the batch buffer before closing the HTTP server.
   * Resolves when the server has closed all connections.
   */
  async stop(): Promise<void> {
    const server = this._server
    if (server === null) {
      return
    }
    this._server = null

    // Stop (and drain) the batch buffer first
    this._buffer?.stop()

    // Await any in-flight processBatch() calls
    if (this._pendingBatches.size > 0) {
      await Promise.all([...this._pendingBatches])
    }

    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          this._logger.info('IngestionServer stopped')
          resolve()
        }
      })
    })
  }

  /**
   * Return the 5 OTLP environment variables to inject into sub-agent processes.
   *
   * @throws {TelemetryError} ERR_TELEMETRY_NOT_STARTED if the server is not started.
   */
  getOtlpEnvVars(): Record<string, string> {
    const addr = this._server?.address()
    if (addr === null || addr === undefined || typeof addr === 'string') {
      throw new TelemetryError(
        'ERR_TELEMETRY_NOT_STARTED',
        'IngestionServer is not started — call start() before getOtlpEnvVars()',
      )
    }
    const endpoint = `http://localhost:${(addr as AddressInfo).port}`
    return {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Substrate resource attributes extracted from an OTLP payload.
   * These are set by ClaudeCodeAdapter via OTEL_RESOURCE_ATTRIBUTES env var.
   */
  private _extractSubstrateAttributes(body: unknown): {
    storyKey?: string
    taskType?: string
    dispatchId?: string
  } {
    if (!body || typeof body !== 'object') return {}
    const payload = body as Record<string, unknown>

    const extractFromResources = (resources: unknown): Record<string, string> => {
      const result: Record<string, string> = {}
      if (!Array.isArray(resources)) return result
      for (const entry of resources) {
        if (!entry || typeof entry !== 'object') continue
        const resource = (entry as Record<string, unknown>).resource
        if (!resource || typeof resource !== 'object') continue
        const attrs = (resource as Record<string, unknown>).attributes
        if (!Array.isArray(attrs)) continue
        for (const attr of attrs) {
          if (!attr || typeof attr !== 'object') continue
          const a = attr as Record<string, unknown>
          const key = a.key as string | undefined
          if (key !== undefined && key.startsWith('substrate.')) {
            const val = a.value as Record<string, unknown> | undefined
            if (val && typeof val.stringValue === 'string') {
              result[key] = val.stringValue
            }
          }
        }
      }
      return result
    }

    const attrs = {
      ...extractFromResources(payload.resourceSpans),
      ...extractFromResources(payload.resourceLogs),
    }

    return {
      ...(attrs['substrate.story_key'] !== undefined && {
        storyKey: attrs['substrate.story_key'],
      }),
      ...(attrs['substrate.task_type'] !== undefined && {
        taskType: attrs['substrate.task_type'],
      }),
      ...(attrs['substrate.dispatch_id'] !== undefined && {
        dispatchId: attrs['substrate.dispatch_id'],
      }),
    }
  }

  private _handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Health check support
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    // Collect body, decompressing gzip/deflate if needed
    const encoding = req.headers['content-encoding']
    let stream: NodeJS.ReadableStream = req
    if (encoding === 'gzip' || encoding === 'deflate') {
      stream = encoding === 'gzip' ? req.pipe(createGunzip()) : req.pipe(createInflate())
    }

    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    stream.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf-8')
      this._logger.debug({ url: req.url, bodyLength: bodyStr.length }, 'OTLP payload received')

      // If a pipeline is wired, parse and buffer the payload
      if (this._buffer !== undefined) {
        try {
          const body: unknown = JSON.parse(bodyStr)
          const source = detectSource(body)
          const { storyKey, taskType, dispatchId } = this._extractSubstrateAttributes(body)
          // Dispatch context is extracted directly from OTLP resource attributes
          // (set by ClaudeCodeAdapter via OTEL_RESOURCE_ATTRIBUTES env var).
          const dispatchContext: DispatchContext | undefined =
            taskType !== undefined && dispatchId !== undefined
              ? { taskType, phase: taskType, dispatchId }
              : undefined
          const payload: RawOtlpPayload = {
            body,
            source,
            receivedAt: Date.now(),
            ...(storyKey !== undefined && { storyKey }),
            ...(dispatchContext !== undefined && { dispatchContext }),
          }
          this._buffer.push(payload)
        } catch (err) {
          this._logger.warn({ err, url: req.url }, 'Failed to parse OTLP payload JSON — discarding')
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    stream.on('error', (err) => {
      this._logger.warn({ err }, 'Error reading OTLP request body')
      if (!res.headersSent) {
        res.writeHead(400)
        res.end('Bad Request')
      }
    })
  }
}
