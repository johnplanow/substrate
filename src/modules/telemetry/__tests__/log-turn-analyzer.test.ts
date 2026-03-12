/**
 * Unit tests for LogTurnAnalyzer.
 *
 * Tests cover all AC requirements: chronological ordering, token field mapping,
 * context growth tracking, spike detection, deduplication, and edge cases.
 * Logger is injected as a vi.fn() stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { LogTurnAnalyzer } from '../log-turn-analyzer.js'
import type { NormalizedLog } from '../types.js'

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
// Fixture factory
// ---------------------------------------------------------------------------

let logIdCounter = 0

function makeLog(overrides: Partial<NormalizedLog> = {}): NormalizedLog {
  logIdCounter++
  return {
    logId: `log-${logIdCounter}`,
    traceId: 'trace-1',
    spanId: `span-${logIdCounter}`,
    timestamp: logIdCounter * 1000,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 400,
    costUsd: 0.001,
    model: 'claude-3-5-sonnet-20241022',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogTurnAnalyzer', () => {
  let analyzer: LogTurnAnalyzer
  let logger: pino.Logger

  beforeEach(() => {
    logIdCounter = 0
    logger = makeMockLogger()
    analyzer = new LogTurnAnalyzer(logger)
  })

  // -- AC6: Never throws / edge cases -----------------------------------------

  it('returns empty array for empty input', () => {
    expect(analyzer.analyze([])).toEqual([])
  })

  it('returns empty array for null input without throwing', () => {
    // @ts-expect-error testing malformed input
    expect(analyzer.analyze(null)).toEqual([])
  })

  it('returns empty array for non-array input without throwing', () => {
    // @ts-expect-error testing malformed input
    expect(analyzer.analyze('not an array')).toEqual([])
  })

  it('skips null entries in array without throwing', () => {
    const log = makeLog({ inputTokens: 500 })
    // @ts-expect-error testing malformed entries
    const result = analyzer.analyze([null, log, undefined])
    expect(result).toHaveLength(1)
    expect(result[0].inputTokens).toBe(500)
  })

  it('returns empty array when all entries are null (filtered as non-LLM)', () => {
    // @ts-expect-error testing malformed entries
    const result = analyzer.analyze([null, null])
    expect(result).toEqual([])
  })

  // -- AC1: Single log → single turn analysis ----------------------------------

  it('single log → single TurnAnalysis with turnNumber 1', () => {
    const log = makeLog({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 })
    const result = analyzer.analyze([log])

    expect(result).toHaveLength(1)
    expect(result[0].turnNumber).toBe(1)
    expect(result[0].contextSize).toBe(500)
    expect(result[0].contextDelta).toBe(500)
    expect(result[0].isContextSpike).toBe(false) // single turn cannot be a spike
  })

  // -- AC1: Chronological ordering ---------------------------------------------

  it('orders multiple logs chronologically regardless of input order', () => {
    const log1 = makeLog({ logId: 'log-a', spanId: 'span-a', timestamp: 3000, inputTokens: 100 })
    const log2 = makeLog({ logId: 'log-b', spanId: 'span-b', timestamp: 1000, inputTokens: 200 })
    const log3 = makeLog({ logId: 'log-c', spanId: 'span-c', timestamp: 2000, inputTokens: 300 })

    const result = analyzer.analyze([log1, log2, log3])

    expect(result).toHaveLength(3)
    expect(result[0].spanId).toBe('span-b') // timestamp 1000
    expect(result[1].spanId).toBe('span-c') // timestamp 2000
    expect(result[2].spanId).toBe('span-a') // timestamp 3000
    expect(result[0].turnNumber).toBe(1)
    expect(result[1].turnNumber).toBe(2)
    expect(result[2].turnNumber).toBe(3)
  })

  // -- AC2: Token field mapping ------------------------------------------------

  it('maps inputTokens, outputTokens, cacheReadTokens, costUsd, model correctly', () => {
    const log = makeLog({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
      costUsd: 0.005,
      model: 'claude-3-5-sonnet-20241022',
    })
    const result = analyzer.analyze([log])

    expect(result[0].inputTokens).toBe(1000)
    expect(result[0].outputTokens).toBe(200)
    expect(result[0].cacheReadTokens).toBe(300)
    expect(result[0].costUsd).toBe(0.005)
    expect(result[0].model).toBe('claude-3-5-sonnet-20241022')
  })

  it('computes freshTokens as inputTokens - cacheReadTokens', () => {
    const log = makeLog({ inputTokens: 1000, cacheReadTokens: 300 })
    const result = analyzer.analyze([log])
    expect(result[0].freshTokens).toBe(700)
  })

  it('computes cacheHitRate as cacheReadTokens / inputTokens', () => {
    const log = makeLog({ inputTokens: 1000, cacheReadTokens: 400 })
    const result = analyzer.analyze([log])
    expect(result[0].cacheHitRate).toBeCloseTo(0.4)
  })

  it('cacheHitRate is 1 when cacheReadTokens equals inputTokens', () => {
    const log = makeLog({ inputTokens: 500, cacheReadTokens: 500 })
    const result = analyzer.analyze([log])
    expect(result[0].freshTokens).toBe(0)
    expect(result[0].cacheHitRate).toBe(1)
  })

  it('cacheHitRate is 0 when inputTokens is 0', () => {
    const log = makeLog({ inputTokens: 0, cacheReadTokens: 0 })
    const result = analyzer.analyze([log])
    expect(result[0].cacheHitRate).toBe(0)
    expect(result[0].freshTokens).toBe(0)
  })

  it('zero-token logs are filtered out as non-LLM noise', () => {
    const log: NormalizedLog = {
      logId: 'log-minimal',
      timestamp: 1000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    }
    const result = analyzer.analyze([log])
    expect(result).toHaveLength(0)
  })

  // -- AC3: Context growth tracking --------------------------------------------

  it('accumulates contextSize correctly across multiple turns', () => {
    const log1 = makeLog({ spanId: 'x', timestamp: 1000, inputTokens: 100 })
    const log2 = makeLog({ spanId: 'y', timestamp: 2000, inputTokens: 200 })
    const log3 = makeLog({ spanId: 'z', timestamp: 3000, inputTokens: 300 })

    const result = analyzer.analyze([log1, log2, log3])

    expect(result[0].contextSize).toBe(100)
    expect(result[0].contextDelta).toBe(100)
    expect(result[1].contextSize).toBe(300)
    expect(result[1].contextDelta).toBe(200)
    expect(result[2].contextSize).toBe(600)
    expect(result[2].contextDelta).toBe(300)
  })

  it('marks turn as context spike when inputTokens > 2x average', () => {
    // avg = (100 + 100 + 500) / 3 ≈ 233.3 → spike threshold > 466.6
    const log1 = makeLog({ spanId: 'a', timestamp: 1000, inputTokens: 100 })
    const log2 = makeLog({ spanId: 'b', timestamp: 2000, inputTokens: 100 })
    const log3 = makeLog({ spanId: 'c', timestamp: 3000, inputTokens: 500 })

    const result = analyzer.analyze([log1, log2, log3])

    expect(result[0].isContextSpike).toBe(false)
    expect(result[1].isContextSpike).toBe(false)
    expect(result[2].isContextSpike).toBe(true)
  })

  it('no spikes when all turns have equal inputTokens', () => {
    const log1 = makeLog({ spanId: 'a', timestamp: 1000, inputTokens: 300 })
    const log2 = makeLog({ spanId: 'b', timestamp: 2000, inputTokens: 300 })
    const log3 = makeLog({ spanId: 'c', timestamp: 3000, inputTokens: 300 })

    const result = analyzer.analyze([log1, log2, log3])
    expect(result.every((t) => !t.isContextSpike)).toBe(true)
  })

  it('filters out zero-token logs (non-LLM noise)', () => {
    const log1 = makeLog({ spanId: 'a', timestamp: 1000, inputTokens: 0, outputTokens: 0 })
    const log2 = makeLog({ spanId: 'b', timestamp: 2000, inputTokens: 0, outputTokens: 0 })

    const result = analyzer.analyze([log1, log2])
    expect(result).toHaveLength(0)
  })

  it('keeps logs with outputTokens > 0 even if inputTokens is 0', () => {
    const log = makeLog({ spanId: 'a', timestamp: 1000, inputTokens: 0, outputTokens: 500 })

    const result = analyzer.analyze([log])
    expect(result).toHaveLength(1)
    expect(result[0].outputTokens).toBe(500)
  })

  // -- AC4: Story key extraction -----------------------------------------------

  it('storyKey on log does not cause errors', () => {
    const log = makeLog({ storyKey: '27-14' })
    const result = analyzer.analyze([log])
    expect(result).toHaveLength(1)
  })

  it('falls back to logId as spanId when spanId is absent', () => {
    const log: NormalizedLog = {
      logId: 'my-log-id',
      timestamp: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      costUsd: 0,
    }
    const result = analyzer.analyze([log])
    expect(result[0].spanId).toBe('my-log-id')
  })

  it('uses log.spanId as TurnAnalysis spanId when present', () => {
    const log = makeLog({ spanId: 'my-span-123' })
    const result = analyzer.analyze([log])
    expect(result[0].spanId).toBe('my-span-123')
  })

  // -- AC5: Deduplication ------------------------------------------------------

  it('merges logs with same traceId+spanId into a single turn with summed tokens', () => {
    const log1 = makeLog({
      logId: 'log-1a',
      traceId: 'trace-A',
      spanId: 'span-A',
      timestamp: 1000,
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 100,
      costUsd: 0.001,
    })
    const log2: NormalizedLog = {
      logId: 'log-1b',
      traceId: 'trace-A',
      spanId: 'span-A',
      timestamp: 1100,
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 50,
      costUsd: 0.0005,
    }

    const result = analyzer.analyze([log1, log2])

    expect(result).toHaveLength(1)
    expect(result[0].inputTokens).toBe(500) // 300 + 200
    expect(result[0].outputTokens).toBe(80) // 50 + 30
    expect(result[0].cacheReadTokens).toBe(150) // 100 + 50
    expect(result[0].costUsd).toBeCloseTo(0.0015) // 0.001 + 0.0005
  })

  it('treats logs with different spanIds as separate turns even same traceId', () => {
    const log1 = makeLog({ traceId: 'trace-A', spanId: 'span-A', timestamp: 1000 })
    const log2 = makeLog({ traceId: 'trace-A', spanId: 'span-B', timestamp: 2000 })

    const result = analyzer.analyze([log1, log2])
    expect(result).toHaveLength(2)
  })

  it('treats logs with different traceIds as separate turns even same spanId', () => {
    const log1 = makeLog({ traceId: 'trace-A', spanId: 'span-1', timestamp: 1000 })
    const log2 = makeLog({ traceId: 'trace-B', spanId: 'span-1', timestamp: 2000 })

    const result = analyzer.analyze([log1, log2])
    expect(result).toHaveLength(2)
  })

  it('uses logId as dedup key when traceId and spanId are absent', () => {
    const log1: NormalizedLog = {
      logId: 'log-unique-1',
      timestamp: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      costUsd: 0,
    }
    const log2: NormalizedLog = {
      logId: 'log-unique-2',
      timestamp: 2000,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      costUsd: 0,
    }
    const result = analyzer.analyze([log1, log2])
    expect(result).toHaveLength(2)
  })

  // -- Additional field checks -------------------------------------------------

  it('uses eventName as turn name when available', () => {
    const log = makeLog({ eventName: 'llm_call' })
    const result = analyzer.analyze([log])
    expect(result[0].name).toBe('llm_call')
  })

  it('defaults name to "log_turn" when eventName is absent', () => {
    const log = makeLog({ eventName: undefined })
    const result = analyzer.analyze([log])
    expect(result[0].name).toBe('log_turn')
  })

  it('includes toolName when present on log', () => {
    const log = makeLog({ toolName: 'bash' })
    const result = analyzer.analyze([log])
    expect(result[0].toolName).toBe('bash')
  })

  it('has empty childSpans array (logs have no child spans)', () => {
    const log = makeLog()
    const result = analyzer.analyze([log])
    expect(result[0].childSpans).toEqual([])
  })

  it('durationMs is 0 (logs have no duration information)', () => {
    const log = makeLog()
    const result = analyzer.analyze([log])
    expect(result[0].durationMs).toBe(0)
  })

  it('source is always "claude-code"', () => {
    const log = makeLog()
    const result = analyzer.analyze([log])
    expect(result[0].source).toBe('claude-code')
  })

  it('copies timestamp from log', () => {
    const log = makeLog({ timestamp: 99999 })
    const result = analyzer.analyze([log])
    expect(result[0].timestamp).toBe(99999)
  })
})
