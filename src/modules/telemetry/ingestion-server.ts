/**
 * IngestionServer — local OTLP HTTP/JSON endpoint for Claude Code telemetry.
 *
 * Starts an HTTP server that accepts OTLP-formatted telemetry payloads from
 * Claude Code sub-agents. The server binds to a configurable port (default 4318)
 * and exposes `getOtlpEnvVars()` to retrieve the 5 environment variables that
 * configure Claude Code to export telemetry to this endpoint.
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

  constructor(options: IngestionServerOptions = {}) {
    this._port = options.port ?? 4318
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
        resolve()
      })
    })
  }

  /**
   * Stop the HTTP ingestion server.
   * Resolves when the server has closed all connections.
   */
  async stop(): Promise<void> {
    const server = this._server
    if (server === null) {
      return
    }
    this._server = null
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

  private _handleRequest(_req: IncomingMessage, res: ServerResponse): void {
    // Collect body
    const chunks: Buffer[] = []
    _req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    _req.on('end', () => {
      // Accept all OTLP payloads — future stories will parse and persist them.
      // For now, acknowledge receipt and log at trace level.
      const body = Buffer.concat(chunks).toString('utf-8')
      logger.trace({ url: _req.url, bodyLength: body.length }, 'OTLP payload received')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    _req.on('error', (err) => {
      logger.warn({ err }, 'Error reading OTLP request body')
      res.writeHead(400)
      res.end('Bad Request')
    })
  }
}
