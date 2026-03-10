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
import { AppError } from '../../errors/app-error.js'
import { createLogger } from '../../utils/logger.js'
import { BatchBuffer } from './batch-buffer.js'
import type { TelemetryPipeline, RawOtlpPayload } from './telemetry-pipeline.js'
import { detectSource } from './source-detector.js'

const logger = createLogger('telemetry:ingestion-server')

// ---------------------------------------------------------------------------
// TelemetryError
// ---------------------------------------------------------------------------

/**
 * Error thrown by IngestionServer for server lifecycle violations.
 * Extends AppError to align with the project-standard error-handling pattern
 * (AppError base class with numeric exit codes).
 */
export class TelemetryError extends AppError {
  constructor(code: string, message: string) {
    super(code, 2, message)
    this.name = 'TelemetryError'
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

  constructor(options: IngestionServerOptions = {}) {
    this._port = options.port ?? 4318
    this._batchSize = options.batchSize ?? 100
    this._flushIntervalMs = options.flushIntervalMs ?? 5000

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
      logger.warn('IngestionServer.setPipeline() called after start() — ignoring')
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
        logger.warn({ err }, 'TelemetryPipeline.processBatch failed (batch flush)')
      })
      this._pendingBatches.add(pending)
      void pending.then(() => {
        this._pendingBatches.delete(pending)
      })
    })
  }

  /**
   * Start the HTTP ingestion server.
   * Resolves when the server is listening and ready to accept connections.
   */
  async start(): Promise<void> {
    if (this._server !== null) {
      logger.warn('IngestionServer.start() called while already started — ignoring')
      return
    }

    return new Promise<void>((resolve, reject) => {
      const server = createServer(this._handleRequest.bind(this))

      server.on('error', (err) => {
        logger.error({ err }, 'IngestionServer failed to start')
        reject(err)
      })

      server.listen(this._port, '127.0.0.1', () => {
        this._server = server
        const addr = server.address() as AddressInfo
        logger.info({ port: addr.port }, 'IngestionServer listening')

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

    // Await any in-flight processBatch() calls to satisfy AC5:
    // "remaining buffered items are flushed and processed before the server closes"
    if (this._pendingBatches.size > 0) {
      await Promise.all([...this._pendingBatches])
    }

    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          logger.info('IngestionServer stopped')
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

  private _handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Health check support
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    // Collect body
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf-8')
      logger.trace({ url: req.url, bodyLength: bodyStr.length }, 'OTLP payload received')

      // If a pipeline is wired, parse and buffer the payload
      if (this._buffer !== undefined) {
        try {
          const body: unknown = JSON.parse(bodyStr)
          const source = detectSource(body)
          const payload: RawOtlpPayload = { body, source, receivedAt: Date.now() }
          this._buffer.push(payload)
        } catch (err) {
          logger.warn({ err, url: req.url }, 'Failed to parse OTLP payload JSON — discarding')
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    req.on('error', (err) => {
      logger.warn({ err }, 'Error reading OTLP request body')
      res.writeHead(400)
      res.end('Bad Request')
    })
  }
}
