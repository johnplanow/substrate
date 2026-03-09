/**
 * Unit tests for IngestionServer (Story 27-9, Task 2).
 *
 * Tests server lifecycle and getOtlpEnvVars() guard/content.
 * Uses port 0 for OS-assigned ports to avoid conflicts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IngestionServer, TelemetryError } from '../ingestion-server.js'

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
