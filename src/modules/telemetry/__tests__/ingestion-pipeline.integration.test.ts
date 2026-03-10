/**
 * Integration test for Story 27-12 Task 7:
 * POST OTLP payload → BatchBuffer → TelemetryPipeline → SQLite persistence.
 *
 * Verifies the full end-to-end wiring: an HTTP POST to the ingestion server
 * triggers normalization, turn analysis, efficiency scoring, and persistence.
 *
 * Uses:
 *   - Real TelemetryNormalizer, TurnAnalyzer, Categorizer, ConsumerAnalyzer,
 *     EfficiencyScorer, Recommender (all working implementations)
 *   - Real TelemetryPersistence backed by an in-memory SQLite database
 *   - batchSize=1 to trigger an immediate flush on each POST
 *   - server.stop() awaits in-flight processBatch() calls (AC5 guarantee)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

import { IngestionServer } from '../ingestion-server.js'
import { TelemetryPipeline } from '../telemetry-pipeline.js'
import { TelemetryNormalizer } from '../normalizer.js'
import { TurnAnalyzer } from '../turn-analyzer.js'
import { Categorizer } from '../categorizer.js'
import { ConsumerAnalyzer } from '../consumer-analyzer.js'
import { EfficiencyScorer } from '../efficiency-scorer.js'
import { Recommender } from '../recommender.js'
import { TelemetryPersistence } from '../persistence.js'
import { createLogger } from '../../../utils/logger.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_analysis (
      story_key         VARCHAR(64)    NOT NULL,
      span_id           VARCHAR(128)   NOT NULL,
      turn_number       INTEGER        NOT NULL,
      name              VARCHAR(255)   NOT NULL DEFAULT '',
      timestamp         BIGINT         NOT NULL DEFAULT 0,
      source            VARCHAR(32)    NOT NULL DEFAULT '',
      model             VARCHAR(64),
      input_tokens      INTEGER        NOT NULL DEFAULT 0,
      output_tokens     INTEGER        NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER        NOT NULL DEFAULT 0,
      fresh_tokens      INTEGER        NOT NULL DEFAULT 0,
      cache_hit_rate    DOUBLE         NOT NULL DEFAULT 0,
      cost_usd          DOUBLE         NOT NULL DEFAULT 0,
      duration_ms       INTEGER        NOT NULL DEFAULT 0,
      context_size      INTEGER        NOT NULL DEFAULT 0,
      context_delta     INTEGER        NOT NULL DEFAULT 0,
      tool_name         VARCHAR(128),
      is_context_spike  BOOLEAN        NOT NULL DEFAULT 0,
      child_spans_json  TEXT           NOT NULL DEFAULT '[]',
      PRIMARY KEY (story_key, span_id)
    );

    CREATE TABLE IF NOT EXISTS efficiency_scores (
      story_key                     VARCHAR(64)  NOT NULL,
      timestamp                     BIGINT       NOT NULL,
      composite_score               INTEGER      NOT NULL DEFAULT 0,
      cache_hit_sub_score           DOUBLE       NOT NULL DEFAULT 0,
      io_ratio_sub_score            DOUBLE       NOT NULL DEFAULT 0,
      context_management_sub_score  DOUBLE       NOT NULL DEFAULT 0,
      avg_cache_hit_rate            DOUBLE       NOT NULL DEFAULT 0,
      avg_io_ratio                  DOUBLE       NOT NULL DEFAULT 0,
      context_spike_count           INTEGER      NOT NULL DEFAULT 0,
      total_turns                   INTEGER      NOT NULL DEFAULT 0,
      per_model_json                TEXT         NOT NULL DEFAULT '[]',
      per_source_json               TEXT         NOT NULL DEFAULT '[]',
      PRIMARY KEY (story_key, timestamp)
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id                       VARCHAR(16)   NOT NULL,
      story_key                VARCHAR(64)   NOT NULL,
      sprint_id                VARCHAR(64),
      rule_id                  VARCHAR(64)   NOT NULL,
      severity                 VARCHAR(16)   NOT NULL,
      title                    TEXT          NOT NULL,
      description              TEXT          NOT NULL,
      potential_savings_tokens INTEGER,
      potential_savings_usd    DOUBLE,
      action_target            TEXT,
      generated_at             VARCHAR(32)   NOT NULL,
      PRIMARY KEY (id)
    );

    CREATE TABLE IF NOT EXISTS category_stats (
      story_key            VARCHAR(100)   NOT NULL,
      category             VARCHAR(30)    NOT NULL,
      total_tokens         BIGINT         NOT NULL DEFAULT 0,
      percentage           DECIMAL(6,3)   NOT NULL DEFAULT 0,
      event_count          INTEGER        NOT NULL DEFAULT 0,
      avg_tokens_per_event DECIMAL(12,2)  NOT NULL DEFAULT 0,
      trend                VARCHAR(10)    NOT NULL DEFAULT 'stable',
      PRIMARY KEY (story_key, category)
    );

    CREATE TABLE IF NOT EXISTS consumer_stats (
      story_key            VARCHAR(100)   NOT NULL,
      consumer_key         VARCHAR(300)   NOT NULL,
      category             VARCHAR(30)    NOT NULL,
      total_tokens         BIGINT         NOT NULL DEFAULT 0,
      percentage           DECIMAL(6,3)   NOT NULL DEFAULT 0,
      event_count          INTEGER        NOT NULL DEFAULT 0,
      top_invocations_json TEXT,
      PRIMARY KEY (story_key, consumer_key)
    );
  `)
  return db
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Ingestion pipeline integration: POST → buffer → pipeline → SQLite', () => {
  let db: BetterSqlite3Database
  let persistence: TelemetryPersistence
  let pipeline: TelemetryPipeline
  let server: IngestionServer

  beforeEach(() => {
    db = createTestDb()
    persistence = new TelemetryPersistence(db)

    const log = createLogger('test:ingestion-pipeline', { level: 'silent' })
    const normalizer = new TelemetryNormalizer(log)
    const turnAnalyzer = new TurnAnalyzer(log)
    const categorizer = new Categorizer(log)
    const consumerAnalyzer = new ConsumerAnalyzer(categorizer, log)
    const efficiencyScorer = new EfficiencyScorer(log)
    const recommender = new Recommender(log)

    pipeline = new TelemetryPipeline({
      normalizer,
      turnAnalyzer,
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
    db.close()
  })

  it('HTTP POST flows end-to-end to SQLite persistence', async () => {
    await server.start()

    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    const payload = makeOtlpTracePayload(STORY_KEY)
    const response = await sendPost(endpoint + '/v1/traces', JSON.stringify(payload))

    // Server responds immediately with 200
    expect(response.status).toBe(200)
    expect(response.body).toBe('{}')

    // stop() awaits in-flight processBatch() calls (AC5 guarantee)
    await server.stop()

    // Verify data reached SQLite: efficiency score is always stored
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
})
