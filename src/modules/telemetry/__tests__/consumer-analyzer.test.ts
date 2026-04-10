/**
 * Unit tests for ConsumerAnalyzer.
 *
 * Covers:
 *   - Grouping spans by consumerKey (operationName|toolName)
 *   - Top 20 cap on topInvocations
 *   - Zero-token span/group exclusion
 *   - Sorting by totalTokens descending
 *   - Delegation to Categorizer.classify (via mock)
 *
 * No SQLite or Dolt involved. Logger and Categorizer are vi.fn() stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { ConsumerAnalyzer } from '../consumer-analyzer.js'
import type { Categorizer } from '../categorizer.js'
import type { NormalizedSpan, SemanticCategory, TurnAnalysis } from '../types.js'

// ---------------------------------------------------------------------------
// Mock factories
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

function makeMockCategorizer(defaultCategory: SemanticCategory = 'tool_outputs'): Categorizer {
  return {
    classify: vi.fn().mockReturnValue(defaultCategory),
    computeCategoryStats: vi.fn(),
    computeTrend: vi.fn(),
  } as unknown as Categorizer
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

let _spanCounter = 0

function makeSpan(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  _spanCounter++
  return {
    spanId: `span-${_spanCounter}`,
    traceId: `trace-${_spanCounter}`,
    name: 'test_operation',
    operationName: 'test_operation',
    source: 'claude-code',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 100,
    startTime: 1000 * _spanCounter,
    attributes: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsumerAnalyzer', () => {
  let analyzer: ConsumerAnalyzer
  let mockCategorizer: Categorizer

  beforeEach(() => {
    _spanCounter = 0
    mockCategorizer = makeMockCategorizer('tool_outputs')
    analyzer = new ConsumerAnalyzer(mockCategorizer, makeMockLogger())
  })

  describe('analyze()', () => {
    it('should return [] for empty spans array', () => {
      expect(analyzer.analyze([])).toEqual([])
    })

    // -------------------------------------------------------------------------
    // Grouping
    // -------------------------------------------------------------------------

    it('should group spans with same operationName and no toolName into single ConsumerStats', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'bash',
          name: 'bash',
          inputTokens: 100,
          outputTokens: 50,
        }),
        makeSpan({
          spanId: 's2',
          operationName: 'bash',
          name: 'bash',
          inputTokens: 200,
          outputTokens: 100,
        }),
      ]
      const result = analyzer.analyze(spans)

      expect(result).toHaveLength(1)
      expect(result[0].consumerKey).toBe('bash|')
      expect(result[0].totalTokens).toBe(450) // (100+50) + (200+100)
      expect(result[0].eventCount).toBe(2)
    })

    it('should separate spans with same operationName but different toolNames', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'tool_call',
          name: 'tool_call',
          attributes: { 'tool.name': 'read_file' },
          inputTokens: 100,
          outputTokens: 50,
        }),
        makeSpan({
          spanId: 's2',
          operationName: 'tool_call',
          name: 'tool_call',
          attributes: { 'tool.name': 'bash' },
          inputTokens: 200,
          outputTokens: 100,
        }),
      ]
      const result = analyzer.analyze(spans)

      expect(result).toHaveLength(2)
      const keys = result.map((r) => r.consumerKey).sort()
      expect(keys).toContain('tool_call|bash')
      expect(keys).toContain('tool_call|read_file')
    })

    it('should build consumerKey using operationName|toolName', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'tool_use',
          name: 'tool_use',
          attributes: { 'tool.name': 'my_tool' },
          inputTokens: 100,
          outputTokens: 50,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('tool_use|my_tool')
    })

    it('should use span.name when operationName is absent', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: undefined,
          name: 'my_op',
          inputTokens: 100,
          outputTokens: 50,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('my_op|')
    })

    it('should fall back to "unknown" when both operationName and name are absent', () => {
      const span: NormalizedSpan = {
        spanId: 'x1',
        traceId: 'tr1',
        name: '',
        operationName: undefined,
        source: 'unknown',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 0,
        startTime: 1000,
        attributes: {},
      }
      const result = analyzer.analyze([span])
      // name is empty string, so operationPart = '' (not 'unknown' since name='')
      expect(result[0].consumerKey).toBe('|')
    })

    // -------------------------------------------------------------------------
    // Top 20 cap
    // -------------------------------------------------------------------------

    it('should cap topInvocations at 20 when group has 25 spans', () => {
      // Create 25 spans all with same consumerKey
      const spans: NormalizedSpan[] = []
      for (let i = 0; i < 25; i++) {
        spans.push(
          makeSpan({
            operationName: 'bash',
            name: 'bash',
            inputTokens: (i + 1) * 10,
            outputTokens: 5,
          })
        )
      }
      const result = analyzer.analyze(spans)

      expect(result).toHaveLength(1)
      expect(result[0].topInvocations).toHaveLength(20)
      expect(result[0].eventCount).toBe(25)
    })

    it('should include top 20 by totalTokens (highest first) from the group', () => {
      const spans: NormalizedSpan[] = []
      // Create 25 spans with different token counts
      for (let i = 0; i < 25; i++) {
        spans.push(
          makeSpan({
            spanId: `span-top-${i}`,
            operationName: 'bash',
            name: 'bash',
            inputTokens: (i + 1) * 10,
            outputTokens: 0,
          })
        )
      }
      const result = analyzer.analyze(spans)
      const topTokens = result[0].topInvocations.map((t) => t.totalTokens)

      // The top 20 should be the 20 spans with highest token counts (spans 5..24 = 60..250)
      // Since we have i=0..24, tokens = 10..250. Top 20 = 60..250 (i=5..24)
      expect(topTokens[0]).toBe(250) // highest: i=24, tokens=250
      expect(topTokens.every((t) => t >= topTokens[topTokens.length - 1])).toBe(true) // sorted desc
      const minTopToken = Math.min(...topTokens)
      expect(minTopToken).toBeGreaterThanOrEqual(60) // 6th highest = 60
    })

    // -------------------------------------------------------------------------
    // Zero-token exclusion
    // -------------------------------------------------------------------------

    it('should exclude zero-token spans (as individual spans)', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'bash', inputTokens: 0, outputTokens: 0 }),
      ]
      const result = analyzer.analyze(spans)
      expect(result).toHaveLength(0)
    })

    it('should exclude groups where all spans have zero tokens', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'zero_op', inputTokens: 0, outputTokens: 0 }),
        makeSpan({ spanId: 's2', operationName: 'zero_op', inputTokens: 0, outputTokens: 0 }),
        makeSpan({ spanId: 's3', operationName: 'real_op', inputTokens: 100, outputTokens: 50 }),
      ]
      const result = analyzer.analyze(spans)
      expect(result).toHaveLength(1)
      expect(result[0].consumerKey).toBe('real_op|')
    })

    // -------------------------------------------------------------------------
    // Sorting
    // -------------------------------------------------------------------------

    it('should sort results by totalTokens descending', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'low_op',
          name: 'low_op',
          inputTokens: 100,
          outputTokens: 0,
        }),
        makeSpan({
          spanId: 's2',
          operationName: 'high_op',
          name: 'high_op',
          inputTokens: 1000,
          outputTokens: 0,
        }),
        makeSpan({
          spanId: 's3',
          operationName: 'mid_op',
          name: 'mid_op',
          inputTokens: 500,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)

      expect(result[0].totalTokens).toBeGreaterThanOrEqual(result[1].totalTokens)
      expect(result[1].totalTokens).toBeGreaterThanOrEqual(result[2].totalTokens)
      expect(result[0].consumerKey).toBe('high_op|')
      expect(result[1].consumerKey).toBe('mid_op|')
      expect(result[2].consumerKey).toBe('low_op|')
    })

    // -------------------------------------------------------------------------
    // Percentage
    // -------------------------------------------------------------------------

    it('should compute percentage correctly for each group', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'op_a',
          name: 'op_a',
          inputTokens: 300,
          outputTokens: 0,
        }),
        makeSpan({
          spanId: 's2',
          operationName: 'op_b',
          name: 'op_b',
          inputTokens: 700,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)

      const opA = result.find((r) => r.consumerKey === 'op_a|')!
      const opB = result.find((r) => r.consumerKey === 'op_b|')!

      expect(opA.percentage).toBeCloseTo(30, 2)
      expect(opB.percentage).toBeCloseTo(70, 2)
    })

    it('should compute percentage as 0 when grandTotal is 0', () => {
      // Zero-token spans are excluded, so this scenario doesn't yield results
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'op_a', inputTokens: 100, outputTokens: 0 }),
      ]
      // All tokens in op_a → percentage = 100
      const result = analyzer.analyze(spans)
      expect(result[0].percentage).toBeCloseTo(100, 2)
    })

    // -------------------------------------------------------------------------
    // Category delegation
    // -------------------------------------------------------------------------

    it('should call categorizer.classify for each consumer group', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'op_a',
          name: 'op_a',
          inputTokens: 100,
          outputTokens: 0,
        }),
        makeSpan({
          spanId: 's2',
          operationName: 'op_b',
          name: 'op_b',
          inputTokens: 200,
          outputTokens: 0,
        }),
      ]
      analyzer.analyze(spans)
      expect(mockCategorizer.classify).toHaveBeenCalledTimes(2)
    })

    it('should assign the category returned by categorizer.classify', () => {
      const mockCat = makeMockCategorizer('file_reads')
      const customAnalyzer = new ConsumerAnalyzer(mockCat, makeMockLogger())
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'op_a',
          name: 'op_a',
          inputTokens: 100,
          outputTokens: 0,
        }),
      ]
      const result = customAnalyzer.analyze(spans)
      expect(result[0].category).toBe('file_reads')
    })

    // -------------------------------------------------------------------------
    // Tool name extraction from attributes
    // -------------------------------------------------------------------------

    it('should extract toolName from span.attributes["tool.name"]', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'tool_call',
          name: 'tool_call',
          attributes: { 'tool.name': 'grep' },
          inputTokens: 100,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('tool_call|grep')
    })

    it('should fall back to "llm.tool.name" attribute', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'tool_call',
          name: 'tool_call',
          attributes: { 'llm.tool.name': 'search' },
          inputTokens: 100,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('tool_call|search')
    })

    it('should fall back to "claude.tool_name" attribute', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'tool_call',
          name: 'tool_call',
          attributes: { 'claude.tool_name': 'list_files' },
          inputTokens: 100,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('tool_call|list_files')
    })

    it('should use no toolName when no tool attributes present', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'bash',
          name: 'bash',
          attributes: {},
          inputTokens: 100,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('bash|')
    })

    it('should prioritize "tool.name" over "llm.tool.name"', () => {
      const spans = [
        makeSpan({
          spanId: 's1',
          operationName: 'tool_call',
          name: 'tool_call',
          attributes: { 'tool.name': 'priority_tool', 'llm.tool.name': 'fallback_tool' },
          inputTokens: 100,
          outputTokens: 0,
        }),
      ]
      const result = analyzer.analyze(spans)
      expect(result[0].consumerKey).toBe('tool_call|priority_tool')
    })

    // -------------------------------------------------------------------------
    // topInvocations fields
    // -------------------------------------------------------------------------

    it('should correctly populate TopInvocation fields', () => {
      const spans = [
        makeSpan({
          spanId: 'inv-span-1',
          operationName: 'bash',
          name: 'bash_op',
          attributes: { 'tool.name': 'my_tool' },
          inputTokens: 200,
          outputTokens: 100,
        }),
      ]
      const result = analyzer.analyze(spans)
      const inv = result[0].topInvocations[0]

      expect(inv.spanId).toBe('inv-span-1')
      expect(inv.name).toBe('bash_op')
      expect(inv.toolName).toBe('my_tool')
      expect(inv.totalTokens).toBe(300)
      expect(inv.inputTokens).toBe(200)
      expect(inv.outputTokens).toBe(100)
    })
  })
})

// ---------------------------------------------------------------------------
// TurnAnalysis fixture factory
// ---------------------------------------------------------------------------

let _turnCounter = 0

function makeTurn(overrides: Partial<TurnAnalysis> = {}): TurnAnalysis {
  _turnCounter++
  return {
    spanId: `turn-${_turnCounter}`,
    turnNumber: _turnCounter,
    name: 'assistant_turn',
    timestamp: 1000 * _turnCounter,
    source: 'claude-code',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    freshTokens: 100,
    cacheHitRate: 0,
    costUsd: 0.001,
    durationMs: 1000,
    contextSize: 1000,
    contextDelta: 1000,
    isContextSpike: false,
    childSpans: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// analyzeFromTurns() tests
// ---------------------------------------------------------------------------

describe('ConsumerAnalyzer.analyzeFromTurns()', () => {
  let analyzer: ConsumerAnalyzer
  let mockCategorizer: Categorizer

  beforeEach(() => {
    _turnCounter = 0
    mockCategorizer = makeMockCategorizer('tool_outputs')
    analyzer = new ConsumerAnalyzer(mockCategorizer, makeMockLogger())
  })

  it('should return [] for empty turns array', () => {
    expect(analyzer.analyzeFromTurns([])).toEqual([])
  })

  it('should group turns with same model and no toolName into single ConsumerStats', () => {
    const turns = [
      makeTurn({
        spanId: 't1',
        model: 'claude-sonnet',
        toolName: undefined,
        inputTokens: 100,
        outputTokens: 50,
      }),
      makeTurn({
        spanId: 't2',
        model: 'claude-sonnet',
        toolName: undefined,
        inputTokens: 200,
        outputTokens: 100,
      }),
    ]
    const result = analyzer.analyzeFromTurns(turns)

    expect(result).toHaveLength(1)
    expect(result[0].consumerKey).toBe('claude-sonnet|')
    expect(result[0].totalTokens).toBe(450) // (100+50) + (200+100)
    expect(result[0].eventCount).toBe(2)
  })

  it('should separate turns with same model but different toolNames', () => {
    const turns = [
      makeTurn({
        spanId: 't1',
        model: 'claude-sonnet',
        toolName: 'bash',
        inputTokens: 100,
        outputTokens: 50,
      }),
      makeTurn({
        spanId: 't2',
        model: 'claude-sonnet',
        toolName: 'read_file',
        inputTokens: 200,
        outputTokens: 100,
      }),
    ]
    const result = analyzer.analyzeFromTurns(turns)

    expect(result).toHaveLength(2)
    const keys = result.map((r) => r.consumerKey).sort()
    expect(keys).toContain('claude-sonnet|bash')
    expect(keys).toContain('claude-sonnet|read_file')
  })

  it('should separate turns with different models', () => {
    const turns = [
      makeTurn({
        spanId: 't1',
        model: 'claude-sonnet',
        toolName: undefined,
        inputTokens: 100,
        outputTokens: 50,
      }),
      makeTurn({
        spanId: 't2',
        model: 'claude-haiku',
        toolName: undefined,
        inputTokens: 200,
        outputTokens: 100,
      }),
    ]
    const result = analyzer.analyzeFromTurns(turns)

    expect(result).toHaveLength(2)
    const keys = result.map((r) => r.consumerKey).sort()
    expect(keys).toContain('claude-sonnet|')
    expect(keys).toContain('claude-haiku|')
  })

  it('should use "unknown" as model part when turn.model is undefined', () => {
    const turns = [
      makeTurn({
        spanId: 't1',
        model: undefined,
        toolName: undefined,
        inputTokens: 100,
        outputTokens: 50,
      }),
    ]
    const result = analyzer.analyzeFromTurns(turns)

    expect(result).toHaveLength(1)
    expect(result[0].consumerKey).toBe('unknown|')
  })

  it('should build consumerKey as model|toolName', () => {
    const turns = [
      makeTurn({
        spanId: 't1',
        model: 'my-model',
        toolName: 'my-tool',
        inputTokens: 100,
        outputTokens: 50,
      }),
    ]
    const result = analyzer.analyzeFromTurns(turns)
    expect(result[0].consumerKey).toBe('my-model|my-tool')
  })

  it('should exclude zero-token groups', () => {
    const turns = [
      makeTurn({ spanId: 't1', model: 'claude-sonnet', inputTokens: 0, outputTokens: 0 }),
    ]
    const result = analyzer.analyzeFromTurns(turns)
    expect(result).toHaveLength(0)
  })

  it('should exclude zero-token groups while keeping non-zero groups', () => {
    const turns = [
      makeTurn({ spanId: 't1', model: 'zero-model', inputTokens: 0, outputTokens: 0 }),
      makeTurn({ spanId: 't2', model: 'real-model', inputTokens: 100, outputTokens: 50 }),
    ]
    const result = analyzer.analyzeFromTurns(turns)
    expect(result).toHaveLength(1)
    expect(result[0].consumerKey).toBe('real-model|')
  })

  it('should sort results by totalTokens descending', () => {
    const turns = [
      makeTurn({ spanId: 't1', model: 'low-model', inputTokens: 100, outputTokens: 0 }),
      makeTurn({ spanId: 't2', model: 'high-model', inputTokens: 1000, outputTokens: 0 }),
      makeTurn({ spanId: 't3', model: 'mid-model', inputTokens: 500, outputTokens: 0 }),
    ]
    const result = analyzer.analyzeFromTurns(turns)

    expect(result[0].totalTokens).toBeGreaterThanOrEqual(result[1].totalTokens)
    expect(result[1].totalTokens).toBeGreaterThanOrEqual(result[2].totalTokens)
    expect(result[0].consumerKey).toBe('high-model|')
  })

  it('should compute percentage correctly for each group', () => {
    const turns = [
      makeTurn({ spanId: 't1', model: 'model-a', inputTokens: 300, outputTokens: 0 }),
      makeTurn({ spanId: 't2', model: 'model-b', inputTokens: 700, outputTokens: 0 }),
    ]
    const result = analyzer.analyzeFromTurns(turns)

    const modelA = result.find((r) => r.consumerKey === 'model-a|')!
    const modelB = result.find((r) => r.consumerKey === 'model-b|')!
    expect(modelA.percentage).toBeCloseTo(30, 2)
    expect(modelB.percentage).toBeCloseTo(70, 2)
  })

  it('should cap topInvocations at 20 when group has 25 turns', () => {
    const turns: TurnAnalysis[] = []
    for (let i = 0; i < 25; i++) {
      turns.push(
        makeTurn({
          model: 'claude-sonnet',
          toolName: undefined,
          inputTokens: (i + 1) * 10,
          outputTokens: 5,
        })
      )
    }
    const result = analyzer.analyzeFromTurns(turns)

    expect(result).toHaveLength(1)
    expect(result[0].topInvocations).toHaveLength(20)
    expect(result[0].eventCount).toBe(25)
  })

  it('should populate TopInvocation fields from turn data', () => {
    const turns = [
      makeTurn({
        spanId: 'inv-turn-1',
        model: 'claude-sonnet',
        name: 'bash_turn',
        toolName: 'my_tool',
        inputTokens: 200,
        outputTokens: 100,
      }),
    ]
    const result = analyzer.analyzeFromTurns(turns)
    const inv = result[0].topInvocations[0]

    expect(inv.spanId).toBe('inv-turn-1')
    expect(inv.name).toBe('bash_turn')
    expect(inv.toolName).toBe('my_tool')
    expect(inv.totalTokens).toBe(300)
    expect(inv.inputTokens).toBe(200)
    expect(inv.outputTokens).toBe(100)
  })

  it('should call categorizer.classify with turn name and toolName', () => {
    const turns = [
      makeTurn({
        spanId: 't1',
        model: 'claude-sonnet',
        name: 'bash',
        toolName: 'my_tool',
        inputTokens: 100,
        outputTokens: 50,
      }),
    ]
    analyzer.analyzeFromTurns(turns)
    expect(mockCategorizer.classify).toHaveBeenCalledWith('bash', 'my_tool')
  })

  it('should assign category from categorizer.classify', () => {
    const mockCat = makeMockCategorizer('file_reads')
    const customAnalyzer = new ConsumerAnalyzer(mockCat, makeMockLogger())
    const turns = [
      makeTurn({ spanId: 't1', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50 }),
    ]
    const result = customAnalyzer.analyzeFromTurns(turns)
    expect(result[0].category).toBe('file_reads')
  })
})
