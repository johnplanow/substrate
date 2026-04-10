/**
 * Unit tests for IngestionServer (Story 27-9, Task 2; Story 30-5, Task 2).
 *
 * Tests server lifecycle, getOtlpEnvVars() guard/content, and flushAndAwait().
 * Uses port 0 for OS-assigned ports to avoid conflicts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IngestionServer, TelemetryError } from '../ingestion-server.js'
import type { TelemetryPipeline } from '../telemetry-pipeline.js'

describe('IngestionServer', () => {
  let server: IngestionServer

  beforeEach(() => {
    server = new IngestionServer({ port: 0 })
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // ignore — server may already be stopped
    }
  })

  // -- getOtlpEnvVars guard --

  it('throws TelemetryError with ERR_TELEMETRY_NOT_STARTED before start()', () => {
    expect(() => server.getOtlpEnvVars()).toThrow(TelemetryError)
    try {
      server.getOtlpEnvVars()
    } catch (err) {
      expect(err).toBeInstanceOf(TelemetryError)
      expect((err as TelemetryError).code).toBe('ERR_TELEMETRY_NOT_STARTED')
    }
  })

  it('throws after stop() is called', async () => {
    await server.start()
    await server.stop()
    expect(() => server.getOtlpEnvVars()).toThrow(TelemetryError)
  })

  // -- start / getOtlpEnvVars --

  it('returns all 5 OTLP env vars after start()', async () => {
    await server.start()
    const vars = server.getOtlpEnvVars()
    expect(vars).toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY', '1')
    expect(vars).toHaveProperty('OTEL_LOGS_EXPORTER', 'otlp')
    expect(vars).toHaveProperty('OTEL_METRICS_EXPORTER', 'otlp')
    expect(vars).toHaveProperty('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json')
    expect(vars).toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT')
  })

  it('OTEL_EXPORTER_OTLP_ENDPOINT contains localhost and a valid port', async () => {
    await server.start()
    const vars = server.getOtlpEnvVars()
    const endpoint = vars['OTEL_EXPORTER_OTLP_ENDPOINT']
    expect(typeof endpoint).toBe('string')
    expect(endpoint).toMatch(/^http:\/\/localhost:\d+$/)
    const port = parseInt(endpoint!.split(':')[2] ?? '0', 10)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('start() is idempotent — calling twice does not throw', async () => {
    await server.start()
    await expect(server.start()).resolves.toBeUndefined()
  })

  it('stop() is idempotent — calling twice does not throw', async () => {
    await server.start()
    await server.stop()
    await expect(server.stop()).resolves.toBeUndefined()
  })
})

// -- flushAndAwait() --

describe('IngestionServer.flushAndAwait()', () => {
  it('resolves immediately when no pipeline is wired (AC3)', async () => {
    const server = new IngestionServer({ port: 0 })
    await expect(server.flushAndAwait()).resolves.toBeUndefined()
  })

  it('resolves after in-flight processBatch() completes (AC2)', async () => {
    let resolveBatch!: () => void
    const batchPromise = new Promise<void>((resolve) => {
      resolveBatch = resolve
    })

    const mockPipeline: TelemetryPipeline = {
      processBatch: vi.fn().mockReturnValue(batchPromise),
    } as unknown as TelemetryPipeline

    const server = new IngestionServer({ port: 0, pipeline: mockPipeline, batchSize: 1 })
    await server.start()

    // Push an item to trigger a size-based flush, which starts processBatch in-flight
    const fetch = await import('node:http')
    const envVars = server.getOtlpEnvVars()
    const endpoint = envVars['OTEL_EXPORTER_OTLP_ENDPOINT']!

    // Post a minimal OTLP payload to the server to trigger processing
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ resourceLogs: [] })
      const url = new URL('/v1/logs', endpoint)
      const req = fetch.request(
        {
          hostname: '127.0.0.1',
          port: url.port,
          method: 'POST',
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    // The batch should now be in-flight (processBatch called but not resolved)
    let awaited = false
    const flushPromise = server.flushAndAwait().then(() => {
      awaited = true
    })

    // Before resolving the batch, flushAndAwait should not have resolved
    await new Promise<void>((r) => setImmediate(r))
    expect(awaited).toBe(false)

    // Resolve the in-flight batch
    resolveBatch()
    await flushPromise
    expect(awaited).toBe(true)

    await server.stop()
  })

  it('resolves immediately when buffer has items but no pending batches (no-op on pending)', async () => {
    // A server with pipeline but batchSize=100 so timer flush won't fire synchronously
    const mockPipeline: TelemetryPipeline = {
      processBatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelemetryPipeline

    const server = new IngestionServer({
      port: 0,
      pipeline: mockPipeline,
      batchSize: 100,
      flushIntervalMs: 60000,
    })
    await server.start()

    // flushAndAwait with no buffered items and no pending batches should resolve
    await expect(server.flushAndAwait()).resolves.toBeUndefined()

    await server.stop()
  })
})

// -- TelemetryError --

describe('TelemetryError', () => {
  it('has correct code and message', () => {
    const err = new TelemetryError('ERR_TELEMETRY_NOT_STARTED', 'test message')
    expect(err.code).toBe('ERR_TELEMETRY_NOT_STARTED')
    expect(err.message).toBe('test message')
    expect(err.name).toBe('TelemetryError')
    expect(err).toBeInstanceOf(Error)
  })
})
