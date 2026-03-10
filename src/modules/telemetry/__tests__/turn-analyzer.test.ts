/**
 * Unit tests for TurnAnalyzer.
 *
 * Tests cover all AC requirements: chronological ordering, metrics computation,
 * context accumulation, spike detection, child span grouping, and edge cases.
 * Logger is injected as a vi.fn() stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { TurnAnalyzer } from '../turn-analyzer.js'
import type { NormalizedSpan } from '../types.js'

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

let spanIdCounter = 0

function makeSpan(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  spanIdCounter++
  return {
    spanId: `span-${spanIdCounter}`,
    traceId: 'trace-1',
    name: 'assistant_turn',
    source: 'claude-code',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 400,
    cacheCreationTokens: 0,
    costUsd: 0.001,
    durationMs: 500,
    startTime: spanIdCounter * 1000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnAnalyzer', () => {
  let analyzer: TurnAnalyzer
  let logger: pino.Logger

  beforeEach(() => {
    spanIdCounter = 0
    logger = makeMockLogger()
    analyzer = new TurnAnalyzer(logger)
  })

  // -- Edge cases -----------------------------------------------------------

  it('returns empty array for empty input', () => {
    expect(analyzer.analyze([])).toEqual([])
  })

  it('single span → turnNumber 1, contextDelta equals inputTokens', () => {
    const span = makeSpan({ inputTokens: 500, cacheReadTokens: 0, startTime: 1000 })
    const result = analyzer.analyze([span])

    expect(result).toHaveLength(1)
    expect(result[0].turnNumber).toBe(1)
    expect(result[0].contextSize).toBe(500)
    expect(result[0].contextDelta).toBe(500)
    expect(result[0].isContextSpike).toBe(false) // single turn cannot be spike
  })

  // -- AC1: Chronological ordering and metrics ------------------------------

  it('orders three spans chronologically regardless of input order', () => {
    const span1 = makeSpan({ spanId: 'a', startTime: 3000, inputTokens: 100 })
    const span2 = makeSpan({ spanId: 'b', startTime: 1000, inputTokens: 200 })
    const span3 = makeSpan({ spanId: 'c', startTime: 2000, inputTokens: 300 })

    const result = analyzer.analyze([span1, span2, span3])

    expect(result).toHaveLength(3)
    expect(result[0].spanId).toBe('b') // startTime 1000
    expect(result[1].spanId).toBe('c') // startTime 2000
    expect(result[2].spanId).toBe('a') // startTime 3000
    expect(result[0].turnNumber).toBe(1)
    expect(result[1].turnNumber).toBe(2)
    expect(result[2].turnNumber).toBe(3)
  })

  it('computes freshTokens correctly', () => {
    const span = makeSpan({ inputTokens: 1000, cacheReadTokens: 300 })
    const result = analyzer.analyze([span])
    expect(result[0].freshTokens).toBe(700)
  })

  it('computes cacheHitRate correctly', () => {
    const span = makeSpan({ inputTokens: 1000, cacheReadTokens: 400 })
    const result = analyzer.analyze([span])
    expect(result[0].cacheHitRate).toBeCloseTo(0.4)
  })

  it('cacheHitRate is 0 when inputTokens is 0', () => {
    const span = makeSpan({ inputTokens: 0, cacheReadTokens: 0 })
    const result = analyzer.analyze([span])
    expect(result[0].cacheHitRate).toBe(0)
    expect(result[0].freshTokens).toBe(0)
  })

  it('accumulates contextSize correctly across multiple turns', () => {
    const span1 = makeSpan({ spanId: 'x', startTime: 1000, inputTokens: 100 })
    const span2 = makeSpan({ spanId: 'y', startTime: 2000, inputTokens: 200 })
    const span3 = makeSpan({ spanId: 'z', startTime: 3000, inputTokens: 300 })

    const result = analyzer.analyze([span1, span2, span3])

    expect(result[0].contextSize).toBe(100)
    expect(result[0].contextDelta).toBe(100)
    expect(result[1].contextSize).toBe(300)
    expect(result[1].contextDelta).toBe(200)
    expect(result[2].contextSize).toBe(600)
    expect(result[2].contextDelta).toBe(300)
  })

  it('copies correct fields to TurnAnalysis', () => {
    const span = makeSpan({
      spanId: 'test-span',
      name: 'test_turn',
      source: 'codex',
      model: 'gpt-4',
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 200,
      costUsd: 0.005,
      durationMs: 1234,
      startTime: 9999,
    })
    const result = analyzer.analyze([span])

    expect(result[0].spanId).toBe('test-span')
    expect(result[0].name).toBe('test_turn')
    expect(result[0].source).toBe('codex')
    expect(result[0].model).toBe('gpt-4')
    expect(result[0].outputTokens).toBe(100)
    expect(result[0].costUsd).toBe(0.005)
    expect(result[0].durationMs).toBe(1234)
    expect(result[0].timestamp).toBe(9999)
  })

  // -- AC3: Context spike detection -----------------------------------------

  it('marks turn as context spike when inputTokens > 2x average', () => {
    // avg = (100 + 100 + 500) / 3 ≈ 233.3 → spike threshold > 466.6
    const span1 = makeSpan({ spanId: 'a', startTime: 1000, inputTokens: 100 })
    const span2 = makeSpan({ spanId: 'b', startTime: 2000, inputTokens: 100 })
    const span3 = makeSpan({ spanId: 'c', startTime: 3000, inputTokens: 500 })

    const result = analyzer.analyze([span1, span2, span3])

    expect(result[0].isContextSpike).toBe(false)
    expect(result[1].isContextSpike).toBe(false)
    expect(result[2].isContextSpike).toBe(true)
  })

  it('no spikes when all turns are equal', () => {
    const span1 = makeSpan({ spanId: 'a', startTime: 1000, inputTokens: 300 })
    const span2 = makeSpan({ spanId: 'b', startTime: 2000, inputTokens: 300 })
    const span3 = makeSpan({ spanId: 'c', startTime: 3000, inputTokens: 300 })

    const result = analyzer.analyze([span1, span2, span3])

    expect(result.every((t) => !t.isContextSpike)).toBe(true)
  })

  it('no spikes when average is 0 (zero-token turns)', () => {
    const span1 = makeSpan({ spanId: 'a', startTime: 1000, inputTokens: 0 })
    const span2 = makeSpan({ spanId: 'b', startTime: 2000, inputTokens: 0 })

    const result = analyzer.analyze([span1, span2])

    expect(result.every((t) => !t.isContextSpike)).toBe(true)
  })

  // -- AC2: Child span drill-down -------------------------------------------

  it('groups child spans into the correct parent turn', () => {
    const root = makeSpan({ spanId: 'root-1', startTime: 1000, inputTokens: 1000 })
    const child1 = makeSpan({
      spanId: 'child-1',
      parentSpanId: 'root-1',
      startTime: 1100,
      inputTokens: 50,
      outputTokens: 10,
      durationMs: 100,
      name: 'bash',
    })
    const child2 = makeSpan({
      spanId: 'child-2',
      parentSpanId: 'root-1',
      startTime: 1200,
      inputTokens: 30,
      outputTokens: 5,
      durationMs: 50,
      name: 'read_file',
    })

    const result = analyzer.analyze([root, child1, child2])

    // Only root span becomes a turn
    expect(result).toHaveLength(1)
    expect(result[0].childSpans).toHaveLength(2)
    expect(result[0].childSpans[0].spanId).toBe('child-1')
    expect(result[0].childSpans[0].name).toBe('bash')
    expect(result[0].childSpans[0].inputTokens).toBe(50)
    expect(result[0].childSpans[0].outputTokens).toBe(10)
    expect(result[0].childSpans[0].durationMs).toBe(100)
    expect(result[0].childSpans[1].spanId).toBe('child-2')
  })

  it('child spans are not included as root turns', () => {
    const root = makeSpan({ spanId: 'root-1', startTime: 1000 })
    const child = makeSpan({ spanId: 'child-1', parentSpanId: 'root-1', startTime: 1100 })

    const result = analyzer.analyze([root, child])

    expect(result).toHaveLength(1)
    expect(result[0].spanId).toBe('root-1')
  })

  it('span with parentSpanId not in input set is treated as root', () => {
    // parentSpanId 'external-parent' is not in the input set
    const span = makeSpan({ spanId: 'orphan', parentSpanId: 'external-parent', startTime: 1000 })

    const result = analyzer.analyze([span])

    expect(result).toHaveLength(1)
    expect(result[0].spanId).toBe('orphan')
  })

  it('returns empty childSpans array when turn has no children', () => {
    const span = makeSpan()
    const result = analyzer.analyze([span])
    expect(result[0].childSpans).toEqual([])
  })
})
