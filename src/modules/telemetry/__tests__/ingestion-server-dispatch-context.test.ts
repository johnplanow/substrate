/**
 * Tests for dispatch context injection (Story 30-1).
 *
 * Covers:
 *   - IngestionServer.setActiveDispatch() / clearActiveDispatch() state management
 *   - Payload stamping with dispatchContext when storyKey matches active dispatch
 *   - No stamping when storyKey has no active dispatch or no storyKey in payload
 *   - TelemetryNormalizer.normalizeLog() propagates dispatchContext to NormalizedLog
 *   - LogTurnAnalyzer.analyze() copies taskType/phase/dispatchId to TurnAnalysis
 *   - TelemetryPipeline.processBatch() passes dispatchContext through to normalizeLog
 *   - Integration: full end-to-end path from payload receipt → TurnAnalysis
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type pino from 'pino'
import { IngestionServer } from '../ingestion-server.js'
import type { DispatchContext } from '../ingestion-server.js'
import { TelemetryNormalizer } from '../normalizer.js'
import { LogTurnAnalyzer } from '../log-turn-analyzer.js'
import { TelemetryPipeline } from '../telemetry-pipeline.js'
import type { RawOtlpPayload } from '../telemetry-pipeline.js'
import { TurnAnalyzer } from '../turn-analyzer.js'
import { Categorizer } from '../categorizer.js'
import { ConsumerAnalyzer } from '../consumer-analyzer.js'
import { EfficiencyScorer } from '../efficiency-scorer.js'
import { Recommender } from '../recommender.js'
import type { NormalizedLog, TurnAnalysis } from '../types.js'
import type { ITelemetryPersistence } from '../persistence.js'

// ---------------------------------------------------------------------------
// Mock logger factory
// ---------------------------------------------------------------------------

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger
}

// ---------------------------------------------------------------------------
// Mock ITelemetryPersistence
// ---------------------------------------------------------------------------

function makeMockPersistence(): ITelemetryPersistence & {
  storedTurns: Map<string, TurnAnalysis[]>
} {
  const storedTurns = new Map<string, TurnAnalysis[]>()
  return {
    storedTurns,
    storeTurnAnalysis: vi.fn(async (storyKey: string, turns: TurnAnalysis[]) => {
      storedTurns.set(storyKey, turns)
    }),
    getTurnAnalysis: vi.fn(async (storyKey: string) => storedTurns.get(storyKey) ?? []),
    storeEfficiencyScore: vi.fn(async () => {}),
    getEfficiencyScore: vi.fn(async () => null),
    getEfficiencyScores: vi.fn(async () => []),
    getDispatchEfficiencyScores: vi.fn(async () => []),
    saveRecommendations: vi.fn(async () => {}),
    getRecommendations: vi.fn(async () => []),
    getAllRecommendations: vi.fn(async () => []),
    storeCategoryStats: vi.fn(async () => {}),
    getCategoryStats: vi.fn(async () => []),
    storeConsumerStats: vi.fn(async () => {}),
    getConsumerStats: vi.fn(async () => []),
    recordSpan: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// OTLP log payload factory — with substrate.story_key in resource attributes
// ---------------------------------------------------------------------------

function makeOtlpLogPayload(storyKey: string, inputTokens = 1000, outputTokens = 200): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'substrate.story_key', value: { stringValue: storyKey } },
            { key: 'service.name', value: { stringValue: 'claude-code' } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                logRecordId: `log-${storyKey}-1`,
                traceId: 'trace-abc',
                spanId: `span-${storyKey}-1`,
                timeUnixNano: String(Date.now() * 1_000_000),
                severityText: 'INFO',
                body: { stringValue: 'api_request' },
                attributes: [
                  { key: 'event.name', value: { stringValue: 'api_request' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: inputTokens } },
                  { key: 'gen_ai.usage.output_tokens', value: { intValue: outputTokens } },
                  { key: 'gen_ai.request.model', value: { stringValue: 'claude-3-5-sonnet-20241022' } },
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
// IngestionServer dispatch context state management tests
// ---------------------------------------------------------------------------

describe('IngestionServer — dispatch context state management', () => {
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

  it('setActiveDispatch registers a context for a story key', () => {
    const ctx: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'dispatch-001' }
    // should not throw
    expect(() => server.setActiveDispatch('30-1', ctx)).not.toThrow()
  })

  it('clearActiveDispatch removes a registered context', () => {
    const ctx: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'dispatch-001' }
    server.setActiveDispatch('30-1', ctx)
    // should not throw
    expect(() => server.clearActiveDispatch('30-1')).not.toThrow()
  })

  it('clearActiveDispatch is a no-op when no context is registered', () => {
    // No prior setActiveDispatch call — should not throw
    expect(() => server.clearActiveDispatch('no-story')).not.toThrow()
  })

  it('setActiveDispatch overwrites a prior context for the same story key', () => {
    const ctx1: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'dispatch-001' }
    const ctx2: DispatchContext = { taskType: 'code-review', phase: 'IN_REVIEW', dispatchId: 'dispatch-002' }
    server.setActiveDispatch('30-1', ctx1)
    server.setActiveDispatch('30-1', ctx2)
    // No assertion on internals — the overwrite should silently succeed
    expect(() => server.clearActiveDispatch('30-1')).not.toThrow()
  })

  it('multiple story keys can have independent dispatch contexts', () => {
    const ctx1: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'd1' }
    const ctx2: DispatchContext = { taskType: 'code-review', phase: 'IN_REVIEW', dispatchId: 'd2' }
    server.setActiveDispatch('30-1', ctx1)
    server.setActiveDispatch('30-2', ctx2)
    // Clear only one — the other should remain (no cross-story interference)
    server.clearActiveDispatch('30-1')
    // Still no-op clearing the second
    expect(() => server.clearActiveDispatch('30-2')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// TelemetryNormalizer — normalizeLog dispatch context propagation
// ---------------------------------------------------------------------------

describe('TelemetryNormalizer.normalizeLog — dispatch context propagation', () => {
  let normalizer: TelemetryNormalizer
  let logger: pino.Logger

  beforeEach(() => {
    logger = makeMockLogger()
    normalizer = new TelemetryNormalizer(logger)
  })

  it('propagates taskType, phase, dispatchId to all NormalizedLog records when dispatchContext is provided', () => {
    const payload = makeOtlpLogPayload('30-1')
    const ctx: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'dispatch-abc' }
    const logs = normalizer.normalizeLog(payload, ctx)
    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(log.taskType).toBe('dev-story')
      expect(log.phase).toBe('IN_DEV')
      expect(log.dispatchId).toBe('dispatch-abc')
    }
  })

  it('does not set taskType/phase/dispatchId when no dispatchContext is provided', () => {
    const payload = makeOtlpLogPayload('30-1')
    const logs = normalizer.normalizeLog(payload)
    expect(logs.length).toBeGreaterThan(0)
    for (const log of logs) {
      expect(log.taskType).toBeUndefined()
      expect(log.phase).toBeUndefined()
      expect(log.dispatchId).toBeUndefined()
    }
  })

  it('propagates different dispatch contexts for different story keys', () => {
    const payload1 = makeOtlpLogPayload('30-1')
    const payload2 = makeOtlpLogPayload('30-2')
    const ctx1: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'd1' }
    const ctx2: DispatchContext = { taskType: 'code-review', phase: 'IN_REVIEW', dispatchId: 'd2' }

    const logs1 = normalizer.normalizeLog(payload1, ctx1)
    const logs2 = normalizer.normalizeLog(payload2, ctx2)

    expect(logs1[0]?.taskType).toBe('dev-story')
    expect(logs1[0]?.phase).toBe('IN_DEV')
    expect(logs2[0]?.taskType).toBe('code-review')
    expect(logs2[0]?.phase).toBe('IN_REVIEW')
  })

  it('handles undefined dispatchContext gracefully', () => {
    const payload = makeOtlpLogPayload('30-1')
    expect(() => normalizer.normalizeLog(payload, undefined)).not.toThrow()
    const logs = normalizer.normalizeLog(payload, undefined)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]?.taskType).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LogTurnAnalyzer — dispatch context copied to TurnAnalysis
// ---------------------------------------------------------------------------

describe('LogTurnAnalyzer — dispatch context fields propagated to TurnAnalysis', () => {
  let analyzer: LogTurnAnalyzer
  let logger: pino.Logger

  beforeEach(() => {
    logger = makeMockLogger()
    analyzer = new LogTurnAnalyzer(logger)
  })

  function makeLog(overrides: Partial<NormalizedLog> = {}): NormalizedLog {
    return {
      logId: `log-${Math.random()}`,
      traceId: 'trace-1',
      spanId: `span-${Math.random()}`,
      timestamp: Date.now(),
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 400,
      costUsd: 0.001,
      model: 'claude-3-5-sonnet-20241022',
      ...overrides,
    }
  }

  it('copies taskType, phase, dispatchId from NormalizedLog to TurnAnalysis', () => {
    const log = makeLog({ taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'dispatch-xyz' })
    const turns = analyzer.analyze([log])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.taskType).toBe('dev-story')
    expect(turns[0]?.phase).toBe('IN_DEV')
    expect(turns[0]?.dispatchId).toBe('dispatch-xyz')
  })

  it('leaves taskType/phase/dispatchId undefined when not present in log', () => {
    const log = makeLog()
    const turns = analyzer.analyze([log])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.taskType).toBeUndefined()
    expect(turns[0]?.phase).toBeUndefined()
    expect(turns[0]?.dispatchId).toBeUndefined()
  })

  it('handles mixed logs — some with context, some without', () => {
    const logWithCtx = makeLog({
      traceId: 'trace-1',
      spanId: 'span-1',
      timestamp: 1000,
      taskType: 'dev-story',
      phase: 'IN_DEV',
      dispatchId: 'dispatch-abc',
    })
    const logWithoutCtx = makeLog({
      traceId: 'trace-2',
      spanId: 'span-2',
      timestamp: 2000,
    })
    const turns = analyzer.analyze([logWithCtx, logWithoutCtx])
    expect(turns).toHaveLength(2)
    // First turn should have context
    expect(turns[0]?.taskType).toBe('dev-story')
    expect(turns[0]?.phase).toBe('IN_DEV')
    // Second turn should not have context
    expect(turns[1]?.taskType).toBeUndefined()
    expect(turns[1]?.phase).toBeUndefined()
  })

  it('copies all three fields: taskType, phase, dispatchId simultaneously', () => {
    const log = makeLog({
      taskType: 'code-review',
      phase: 'IN_REVIEW',
      dispatchId: 'review-dispatch-001',
    })
    const turns = analyzer.analyze([log])
    expect(turns[0]?.taskType).toBe('code-review')
    expect(turns[0]?.phase).toBe('IN_REVIEW')
    expect(turns[0]?.dispatchId).toBe('review-dispatch-001')
  })
})

// ---------------------------------------------------------------------------
// TelemetryPipeline — processBatch passes dispatchContext through normalizeLog
// ---------------------------------------------------------------------------

describe('TelemetryPipeline.processBatch — dispatch context flows through normalizeLog to persistence', () => {
  let logger: pino.Logger
  let persistence: ReturnType<typeof makeMockPersistence>

  beforeEach(() => {
    logger = makeMockLogger()
    persistence = makeMockPersistence()
  })

  it('stamps turns with taskType and phase when dispatchContext is provided on payload', async () => {
    const pipeline = new TelemetryPipeline({
      normalizer: new TelemetryNormalizer(logger),
      turnAnalyzer: new TurnAnalyzer(logger),
      logTurnAnalyzer: new LogTurnAnalyzer(logger),
      categorizer: new Categorizer(logger),
      consumerAnalyzer: new ConsumerAnalyzer(new Categorizer(logger), logger),
      efficiencyScorer: new EfficiencyScorer(logger),
      recommender: new Recommender(logger),
      persistence,
    })

    const storyKey = '30-1-pipeline-test'
    const payload: RawOtlpPayload = {
      body: makeOtlpLogPayload(storyKey),
      source: 'claude-code',
      receivedAt: Date.now(),
      dispatchContext: { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'dispatch-pipeline-01' },
    }

    await pipeline.processBatch([payload])

    const storedTurns = persistence.storedTurns.get(storyKey)
    expect(storedTurns).toBeDefined()
    expect(storedTurns!.length).toBeGreaterThan(0)
    expect(storedTurns![0]?.taskType).toBe('dev-story')
    expect(storedTurns![0]?.phase).toBe('IN_DEV')
    expect(storedTurns![0]?.dispatchId).toBe('dispatch-pipeline-01')
  })

  it('does not stamp turns when no dispatchContext is present on payload', async () => {
    const pipeline = new TelemetryPipeline({
      normalizer: new TelemetryNormalizer(logger),
      turnAnalyzer: new TurnAnalyzer(logger),
      logTurnAnalyzer: new LogTurnAnalyzer(logger),
      categorizer: new Categorizer(logger),
      consumerAnalyzer: new ConsumerAnalyzer(new Categorizer(logger), logger),
      efficiencyScorer: new EfficiencyScorer(logger),
      recommender: new Recommender(logger),
      persistence,
    })

    const storyKey = '30-1-no-context-test'
    const payload: RawOtlpPayload = {
      body: makeOtlpLogPayload(storyKey),
      source: 'claude-code',
      receivedAt: Date.now(),
    }

    await pipeline.processBatch([payload])

    const storedTurns = persistence.storedTurns.get(storyKey)
    expect(storedTurns).toBeDefined()
    expect(storedTurns!.length).toBeGreaterThan(0)
    expect(storedTurns![0]?.taskType).toBeUndefined()
    expect(storedTurns![0]?.phase).toBeUndefined()
    expect(storedTurns![0]?.dispatchId).toBeUndefined()
  })

  it('processes multiple payloads with different dispatch contexts independently', async () => {
    const pipeline = new TelemetryPipeline({
      normalizer: new TelemetryNormalizer(logger),
      turnAnalyzer: new TurnAnalyzer(logger),
      logTurnAnalyzer: new LogTurnAnalyzer(logger),
      categorizer: new Categorizer(logger),
      consumerAnalyzer: new ConsumerAnalyzer(new Categorizer(logger), logger),
      efficiencyScorer: new EfficiencyScorer(logger),
      recommender: new Recommender(logger),
      persistence,
    })

    const storyKey1 = '30-1-multi-a'
    const storyKey2 = '30-1-multi-b'

    const payload1: RawOtlpPayload = {
      body: makeOtlpLogPayload(storyKey1),
      source: 'claude-code',
      receivedAt: Date.now(),
      dispatchContext: { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'd-a' },
    }
    const payload2: RawOtlpPayload = {
      body: makeOtlpLogPayload(storyKey2),
      source: 'claude-code',
      receivedAt: Date.now(),
      dispatchContext: { taskType: 'code-review', phase: 'IN_REVIEW', dispatchId: 'd-b' },
    }

    await pipeline.processBatch([payload1, payload2])

    const turns1 = persistence.storedTurns.get(storyKey1)
    const turns2 = persistence.storedTurns.get(storyKey2)

    expect(turns1![0]?.taskType).toBe('dev-story')
    expect(turns1![0]?.phase).toBe('IN_DEV')
    expect(turns2![0]?.taskType).toBe('code-review')
    expect(turns2![0]?.phase).toBe('IN_REVIEW')
  })
})

// ---------------------------------------------------------------------------
// IngestionServer HTTP integration — dispatch context stamping on received payloads
// ---------------------------------------------------------------------------

describe('IngestionServer — HTTP payload stamping with dispatch context', () => {
  let server: IngestionServer

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // ignore
    }
  })

  async function sendPost(url: string, body: string): Promise<{ status: number }> {
    const { default: http } = await import('node:http')
    return new Promise<{ status: number }>((resolve, reject) => {
      const parsed = new URL(url)
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: '/v1/logs',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        },
      )
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  it('stamps dispatchContext on received payloads when storyKey has an active dispatch', async () => {
    const storedPayloads: import('../telemetry-pipeline.js').RawOtlpPayload[] = []
    const mockPipeline = {
      processBatch: vi.fn(async (items: import('../telemetry-pipeline.js').RawOtlpPayload[]) => {
        storedPayloads.push(...items)
      }),
    } as unknown as import('../telemetry-pipeline.js').TelemetryPipeline

    server = new IngestionServer({ port: 0, batchSize: 1, flushIntervalMs: 10000 })
    server.setPipeline(mockPipeline)
    await server.start()

    const storyKey = '30-1-http-test'
    const dispatchCtx: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'http-dispatch-01' }
    server.setActiveDispatch(storyKey, dispatchCtx)

    const body = JSON.stringify(makeOtlpLogPayload(storyKey))
    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    await sendPost(endpoint!, body)

    // Wait for batch buffer flush (batchSize=1 triggers immediate flush)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(storedPayloads.length).toBeGreaterThan(0)
    expect(storedPayloads[0]?.dispatchContext).toEqual(dispatchCtx)
  })

  it('does not stamp dispatchContext on payloads when no active dispatch is registered', async () => {
    const storedPayloads: import('../telemetry-pipeline.js').RawOtlpPayload[] = []
    const mockPipeline = {
      processBatch: vi.fn(async (items: import('../telemetry-pipeline.js').RawOtlpPayload[]) => {
        storedPayloads.push(...items)
      }),
    } as unknown as import('../telemetry-pipeline.js').TelemetryPipeline

    server = new IngestionServer({ port: 0, batchSize: 1, flushIntervalMs: 10000 })
    server.setPipeline(mockPipeline)
    await server.start()

    const storyKey = '30-1-http-no-ctx'
    const body = JSON.stringify(makeOtlpLogPayload(storyKey))
    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    await sendPost(endpoint!, body)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(storedPayloads.length).toBeGreaterThan(0)
    expect(storedPayloads[0]?.dispatchContext).toBeUndefined()
  })

  it('does not stamp dispatchContext after clearActiveDispatch is called', async () => {
    const storedPayloads: import('../telemetry-pipeline.js').RawOtlpPayload[] = []
    const mockPipeline = {
      processBatch: vi.fn(async (items: import('../telemetry-pipeline.js').RawOtlpPayload[]) => {
        storedPayloads.push(...items)
      }),
    } as unknown as import('../telemetry-pipeline.js').TelemetryPipeline

    server = new IngestionServer({ port: 0, batchSize: 1, flushIntervalMs: 10000 })
    server.setPipeline(mockPipeline)
    await server.start()

    const storyKey = '30-1-http-clear'
    const dispatchCtx: DispatchContext = { taskType: 'dev-story', phase: 'IN_DEV', dispatchId: 'http-dispatch-02' }
    server.setActiveDispatch(storyKey, dispatchCtx)
    server.clearActiveDispatch(storyKey)

    const body = JSON.stringify(makeOtlpLogPayload(storyKey))
    const endpoint = server.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
    await sendPost(endpoint!, body)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(storedPayloads.length).toBeGreaterThan(0)
    expect(storedPayloads[0]?.dispatchContext).toBeUndefined()
  })
})
