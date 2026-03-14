/**
 * Integration test for Story 27-12 Task 7 (updated for 27-15 dual-track):
 * POST OTLP payload → BatchBuffer → TelemetryPipeline → persistence.
 *
 * Verifies the full end-to-end wiring: an HTTP POST to the ingestion server
 * triggers normalization, turn analysis, efficiency scoring, and persistence.
 *
 * Uses:
 *   - Real TelemetryNormalizer, TurnAnalyzer, LogTurnAnalyzer, Categorizer,
 *     ConsumerAnalyzer, EfficiencyScorer, Recommender (all working implementations)
 *   - Real TelemetryPersistence backed by a WASM SQLite in-memory database
 *   - batchSize=1 to trigger an immediate flush on each POST
 *   - server.stop() awaits in-flight processBatch() calls (AC5 guarantee)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { IngestionServer } from '../ingestion-server.js'
import { TelemetryPipeline } from '../telemetry-pipeline.js'
import { TelemetryNormalizer } from '../normalizer.js'
import { TurnAnalyzer } from '../turn-analyzer.js'
import { LogTurnAnalyzer } from '../log-turn-analyzer.js'
import { Categorizer } from '../categorizer.js'
import { ConsumerAnalyzer } from '../consumer-analyzer.js'
import { EfficiencyScorer } from '../efficiency-scorer.js'
import { Recommender } from '../recommender.js'
import { TelemetryPersistence } from '../persistence.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createWasmSqliteAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { createLogger } from '../../../utils/logger.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

async function createTestAdapter(): Promise<DatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter()
  const persistence = new TelemetryPersistence(adapter)
  await persistence.initSchema()
  return adapter
}

// ---------------------------------------------------------------------------
// HTTP helper
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
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// OTLP payload fixtures
// ---------------------------------------------------------------------------

const STORY_KEY = '27-12-integration'

/**
 * A minimal but valid OTLP trace payload with one span tagged with a storyKey.
 * The span has a recognisable source (claude-code) and token counts so that
 * TurnAnalyzer can produce a TurnAnalysis entry.
 */
function makeOtlpTracePayload(storyKey: string): object {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'substrate.story_key', value: { stringValue: storyKey } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                spanId: 'a1b2c3d4e5f6a7b8',
                traceId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
                name: 'llm.chat',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'claude-3-5-sonnet' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: 100 } },
                  { key: 'gen_ai.usage.output_tokens', value: { intValue: 50 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * A minimal but valid OTLP log payload with one log record tagged with a storyKey.
 * The log has token counts so that LogTurnAnalyzer can produce a TurnAnalysis entry.
 */
function makeOtlpLogPayload(storyKey: string): object {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'substrate.story_key', value: { stringValue: storyKey } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                traceId: 'b1b2b3b4b5b6b7b8b9b0b1b2b3b4b5b6',
                spanId: 'b1b2c3d4e5f6a7b8',
                timeUnixNano: '1700000002000000000',
                severityText: 'INFO',
                body: { stringValue: 'LLM completion' },
                attributes: [
                  { key: 'gen_ai.request.model', value: { stringValue: 'claude-3-5-sonnet' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: 80 } },
                  { key: 'gen_ai.usage.output_tokens', value: { intValue: 40 } },
                  { key: 'event.name', value: { stringValue: 'llm.completion' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Ingestion pipeline integration: POST → buffer → pipeline → persistence', () => {
  let adapter: DatabaseAdapter
  let persistence: TelemetryPersistence
  let pipeline: TelemetryPipeline
  let server: IngestionServer

  beforeEach(async () => {
    adapter = await createTestAdapter()
    persistence = new TelemetryPersistence(adapter)

    const log = createLogger('test:ingestion-pipeline', { level: 'silent' })
    const normalizer = new TelemetryNormalizer(log)
    const turnAnalyzer = new TurnAnalyzer(log)
    const logTurnAnalyzer = new LogTurnAnalyzer(log)
    const categorizer = new Categorizer(log)
    const consumerAnalyzer = new ConsumerAnalyzer(categorizer, log)
    const efficiencyScorer = new EfficiencyScorer(log)
    const recommender = new Recommender(log)

    pipeline = new TelemetryPipeline({
      normalizer,
      turnAnalyzer,
      logTurnAnalyzer,
      categorizer,
      consumerAnalyzer,
      efficiencyScorer,
      recommender,
      persistence,
    })

    // batchSize=1 ensures each POST triggers an immediate flush
    server = new IngestionServer({
      port: 0,
      pipeline,
      batchSize: 1,
      flushIntervalMs: 60_000, // disable timer-based flush in tests
    })
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // already stopped
    }
    await adapter.close()
  })

  it('HTTP POST flows end-to-end to persistence', async () => {
    await server.start()

    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    const payload = makeOtlpTracePayload(STORY_KEY)
    const response = await sendPost(endpoint + '/v1/traces', JSON.stringify(payload))

    // Server responds immediately with 200
    expect(response.status).toBe(200)
    expect(response.body).toBe('{}')

    // stop() awaits in-flight processBatch() calls (AC5 guarantee)
    await server.stop()

    // Verify data reached persistence: efficiency score is always stored
    const score = await persistence.getEfficiencyScore(STORY_KEY)
    expect(score).not.toBeNull()
    expect(score!.storyKey).toBe(STORY_KEY)
    expect(score!.compositeScore).toBeGreaterThanOrEqual(0)
    expect(score!.totalTurns).toBeGreaterThanOrEqual(1)
  })

  it('turn analysis is persisted for a recognized span', async () => {
    await server.start()

    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    const payload = makeOtlpTracePayload(STORY_KEY)
    await sendPost(endpoint + '/v1/traces', JSON.stringify(payload))

    await server.stop()

    const turns = await persistence.getTurnAnalysis(STORY_KEY)
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect(turns[0]!.name).toBe('llm.chat')
  })

  it('malformed JSON payload is discarded gracefully — server remains healthy', async () => {
    await server.start()

    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT

    // POST invalid JSON
    const badResponse = await sendPost(endpoint + '/v1/traces', 'not-valid-json')
    expect(badResponse.status).toBe(200) // server still responds 200

    // POST valid payload after the bad one
    const goodPayload = makeOtlpTracePayload(STORY_KEY)
    const goodResponse = await sendPost(endpoint + '/v1/traces', JSON.stringify(goodPayload))
    expect(goodResponse.status).toBe(200)

    await server.stop()

    // The valid payload was still processed
    const score = await persistence.getEfficiencyScore(STORY_KEY)
    expect(score).not.toBeNull()
  })

  it('multiple payloads for the same story are processed independently', async () => {
    await server.start()

    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    const payload1 = makeOtlpTracePayload(STORY_KEY)
    const payload2 = makeOtlpTracePayload(STORY_KEY + '-2')

    await sendPost(endpoint + '/v1/traces', JSON.stringify(payload1))
    await sendPost(endpoint + '/v1/traces', JSON.stringify(payload2))

    await server.stop()

    const score1 = await persistence.getEfficiencyScore(STORY_KEY)
    const score2 = await persistence.getEfficiencyScore(STORY_KEY + '-2')

    expect(score1).not.toBeNull()
    expect(score2).not.toBeNull()
    expect(score1!.storyKey).toBe(STORY_KEY)
    expect(score2!.storyKey).toBe(STORY_KEY + '-2')
  })

  // -- Story 27-15: Log-only OTLP payload integration test --

  it('AC3/AC6: log-only OTLP payload flows to turn analysis and efficiency persistence', async () => {
    const logStoryKey = '27-15-log-only'
    await server.start()

    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    const logPayload = makeOtlpLogPayload(logStoryKey)
    const response = await sendPost(endpoint + '/v1/logs', JSON.stringify(logPayload))

    expect(response.status).toBe(200)

    await server.stop()

    // Verify turn analysis was persisted from logs
    const turns = await persistence.getTurnAnalysis(logStoryKey)
    expect(turns.length).toBeGreaterThanOrEqual(1)

    // Verify efficiency score was computed and persisted
    const score = await persistence.getEfficiencyScore(logStoryKey)
    expect(score).not.toBeNull()
    expect(score!.storyKey).toBe(logStoryKey)
    expect(score!.totalTurns).toBeGreaterThanOrEqual(1)
  })
})
