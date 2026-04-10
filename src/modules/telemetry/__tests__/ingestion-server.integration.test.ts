/**
 * Integration tests for IngestionServer (Story 27-9, Task 7).
 *
 * Uses port 0 (OS-assigned) to avoid port conflicts.
 * Tests real HTTP requests to the server to verify it accepts OTLP payloads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IngestionServer, TelemetryError } from '../ingestion-server.js'

// ---------------------------------------------------------------------------
// Helper: send a simple HTTP POST request
// ---------------------------------------------------------------------------

async function sendPost(url: string, body: string): Promise<{ status: number; body: string }> {
  const { default: http } = await import('node:http')
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionServer integration (port 0)', () => {
  let server: IngestionServer

  beforeEach(() => {
    server = new IngestionServer({ port: 0 })
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // ignore
    }
  })

  it('getOtlpEnvVars() returns a valid endpoint after start()', async () => {
    await server.start()
    const vars = server.getOtlpEnvVars()
    expect(vars.OTEL_EXPORTER_OTLP_ENDPOINT).toMatch(/^http:\/\/localhost:\d+$/)
    const port = parseInt(vars.OTEL_EXPORTER_OTLP_ENDPOINT.split(':')[2] ?? '0', 10)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('accepts a POST request and returns 200 JSON', async () => {
    await server.start()
    const vars = server.getOtlpEnvVars()
    const endpoint = vars.OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/traces'

    const payload = JSON.stringify({ resourceSpans: [] })
    const response = await sendPost(endpoint, payload)

    expect(response.status).toBe(200)
    expect(response.body).toBe('{}')
  })

  it('throws TelemetryError if getOtlpEnvVars() called before start()', () => {
    expect(() => server.getOtlpEnvVars()).toThrow(TelemetryError)
    try {
      server.getOtlpEnvVars()
    } catch (err) {
      if (err instanceof TelemetryError) {
        expect(err.code).toBe('ERR_TELEMETRY_NOT_STARTED')
      }
    }
  })

  it('binds to different ports for concurrent servers', async () => {
    const server2 = new IngestionServer({ port: 0 })
    try {
      await server.start()
      await server2.start()

      const endpoint1 = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
      const endpoint2 = server2.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT

      expect(endpoint1).not.toBe(endpoint2)
    } finally {
      await server2.stop()
    }
  })
})
