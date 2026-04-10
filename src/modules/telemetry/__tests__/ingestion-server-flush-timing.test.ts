/**
 * Integration tests for IngestionServer flush timing guarantee (Story 30-5, Task 5).
 *
 * Verifies that flushAndAwait() resolves only after all in-flight processBatch()
 * calls complete, providing the timing guarantee needed for inter-story telemetry
 * flushing (AC2, AC6).
 */

import { describe, it, expect, vi } from 'vitest'
import { BatchBuffer } from '../batch-buffer.js'
import { IngestionServer } from '../ingestion-server.js'
import type { TelemetryPipeline, RawOtlpPayload } from '../telemetry-pipeline.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(): RawOtlpPayload {
  return { body: {}, source: 'claude-code', receivedAt: Date.now() }
}

// ---------------------------------------------------------------------------
// BatchBuffer.flush() + flushAndAwait() timing tests
// ---------------------------------------------------------------------------

describe('BatchBuffer flush timing', () => {
  it('flush() triggers immediate emit and subsequent timer still fires', async () => {
    vi.useFakeTimers()
    try {
      const buffer = new BatchBuffer<number>({ batchSize: 100, flushIntervalMs: 100 })
      const flushed: number[][] = []
      buffer.on('flush', (items: number[]) => flushed.push([...items]))
      buffer.start()

      buffer.push(1)
      buffer.push(2)
      buffer.flush()
      expect(flushed).toHaveLength(1)
      expect(flushed[0]).toEqual([1, 2])

      // Timer still active — advance past interval and push more
      buffer.push(3)
      vi.advanceTimersByTime(100)
      expect(flushed).toHaveLength(2)
      expect(flushed[1]).toEqual([3])

      buffer.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('flushAndAwait() awaits processBatch() before resolving', () => {
  it('resolves only after processBatch promise resolves', async () => {
    let resolveBatch!: () => void
    let batchCallCount = 0
    const batchPromise = new Promise<void>((resolve) => {
      resolveBatch = resolve
    })

    const mockPipeline: TelemetryPipeline = {
      processBatch: vi.fn().mockImplementation(() => {
        batchCallCount++
        return batchPromise
      }),
    } as unknown as TelemetryPipeline

    const server = new IngestionServer({ port: 0, pipeline: mockPipeline, batchSize: 1 })
    await server.start()

    // Send a payload to trigger processBatch in-flight
    const envVars = server.getOtlpEnvVars()
    const endpoint = envVars['OTEL_EXPORTER_OTLP_ENDPOINT']!
    const { request } = await import('node:http')

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ resourceLogs: [] })
      const url = new URL('/v1/logs', endpoint)
      const req = request(
        {
          hostname: '127.0.0.1',
          port: parseInt(url.port, 10),
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

    // processBatch should now be in-flight
    expect(batchCallCount).toBeGreaterThan(0)

    // Track whether flushAndAwait resolved before/after batch
    let awaited = false
    const flushPromise = server.flushAndAwait().then(() => {
      awaited = true
    })

    // Give microtasks a chance to run — should not be resolved yet
    await new Promise<void>((r) => setImmediate(r))
    expect(awaited).toBe(false)

    // Resolve the batch
    resolveBatch()
    await flushPromise
    expect(awaited).toBe(true)

    await server.stop()
  })

  it('flushAndAwait() with no wired pipeline resolves immediately (no-op, AC3)', async () => {
    const server = new IngestionServer({ port: 0 })
    // No pipeline wired
    await expect(server.flushAndAwait()).resolves.toBeUndefined()
  })

  it('flushAndAwait() resolves immediately when no batches are in-flight', async () => {
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

    // No items pushed — no pending batches
    await expect(server.flushAndAwait()).resolves.toBeUndefined()

    await server.stop()
  })
})
