/**
 * Unit tests for AutoSummarizer (story 49-3).
 *
 * Covers:
 *   - estimateTokens: empty, short, long strings
 *   - shouldTrigger: below threshold, exactly at threshold, one above threshold
 *   - compress: current-index preservation, previous-iteration compression,
 *               compressedIndices population, CompressionResult shape
 *   - Constructor validation: threshold out of range throws RangeError; boundaries accepted
 *
 * ≥ 14 it() cases required.
 */

import { describe, it, expect } from 'vitest'
import {
  AutoSummarizer,
  estimateTokens,
  type AutoSummarizerConfig,
  type IterationContext,
  type CompressedIterationContext,
  type CompressionResult,
} from '../auto-summarizer.js'
import type { SummaryEngine } from '../summary-engine.js'
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from '../summary-types.js'

// ---------------------------------------------------------------------------
// MockSummaryEngine — local implementation, no vi.mock() needed
// ---------------------------------------------------------------------------

class MockSummaryEngine implements SummaryEngine {
  readonly name = 'mock-summary-engine'

  async summarize(
    content: string,
    targetLevel: SummaryLevel,
    _opts?: SummarizeOptions,
  ): Promise<Summary> {
    return {
      level: targetLevel,
      content: content.slice(0, 10),
      originalHash: 'mock-hash',
      createdAt: new Date().toISOString(),
    }
  }

  async expand(
    summary: Summary,
    _targetLevel: SummaryLevel,
    opts?: ExpandOptions,
  ): Promise<string> {
    return opts?.originalContent ?? summary.content
  }
}

const mockEngine = new MockSummaryEngine()

// ---------------------------------------------------------------------------
// estimateTokens — 3 cases
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it("returns 1 for 'abcd' (4 chars → Math.ceil(4/4) = 1)", () => {
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('returns 100 for a 400-char string (Math.ceil(400/4) = 100)', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// shouldTrigger — 3 cases
// ---------------------------------------------------------------------------

describe('shouldTrigger', () => {
  // Model limit = 1000 tokens, threshold = 0.8 → trigger point = 800 tokens
  const MODEL_LIMIT = 1000
  const THRESHOLD = 0.8

  function makeAutoSummarizer(threshold = THRESHOLD): AutoSummarizer {
    return new AutoSummarizer(mockEngine, MODEL_LIMIT, { threshold })
  }

  it('returns false when total token estimate is below the threshold', () => {
    const summarizer = makeAutoSummarizer()
    // 790 tokens total — below 800
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 400 },
      { index: 1, content: '', tokenEstimate: 390 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('returns false when total token estimate is exactly at the threshold (strict >)', () => {
    const summarizer = makeAutoSummarizer()
    // exactly 800 tokens — NOT strictly greater than 800, so false
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 400 },
      { index: 1, content: '', tokenEstimate: 400 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('returns true when total token estimate is one above the threshold', () => {
    const summarizer = makeAutoSummarizer()
    // 801 tokens — strictly greater than 800
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 400 },
      { index: 1, content: '', tokenEstimate: 401 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// compress — 4 cases
// ---------------------------------------------------------------------------

describe('compress', () => {
  const MODEL_LIMIT = 10000
  let summarizer: AutoSummarizer

  // Set up summarizer before each test
  function getSummarizer(): AutoSummarizer {
    return new AutoSummarizer(mockEngine, MODEL_LIMIT, { threshold: 0.8, targetLevel: 'medium' })
  }

  it('preserves the current-index iteration with original content (no compressed field)', async () => {
    summarizer = getSummarizer()
    const iterations: IterationContext[] = [
      { index: 0, content: 'earlier output' },
      { index: 1, content: 'current output' },
    ]
    const result = await summarizer.compress(iterations, /* currentIndex */ 1)

    const currentIter = result.iterations.find((c) => c.index === 1)
    expect(currentIter).toBeDefined()
    // Should NOT be compressed
    expect('compressed' in (currentIter as object)).toBe(false)
    // Should have original content
    expect((currentIter as IterationContext).content).toBe('current output')
  })

  it('compresses previous iterations with compressed: true and a Summary', async () => {
    summarizer = getSummarizer()
    const iterations: IterationContext[] = [
      { index: 0, content: 'output zero' },
      { index: 1, content: 'output one' },
      { index: 2, content: 'output two — current' },
    ]
    const result = await summarizer.compress(iterations, /* currentIndex */ 2)

    const compressed0 = result.iterations.find((c) => c.index === 0) as CompressedIterationContext
    const compressed1 = result.iterations.find((c) => c.index === 1) as CompressedIterationContext

    expect(compressed0.compressed).toBe(true)
    expect(compressed0.summary).toBeDefined()
    expect(compressed0.summary.level).toBe('medium')

    expect(compressed1.compressed).toBe(true)
    expect(compressed1.summary).toBeDefined()
  })

  it('populates compressedIndices with all indices that were compressed', async () => {
    summarizer = getSummarizer()
    const iterations: IterationContext[] = [
      { index: 0, content: 'output zero' },
      { index: 1, content: 'output one' },
      { index: 2, content: 'current' },
    ]
    const result = await summarizer.compress(iterations, /* currentIndex */ 2)

    expect(result.compressedIndices).toContain(0)
    expect(result.compressedIndices).toContain(1)
    expect(result.compressedIndices).not.toContain(2)
    expect(result.compressedIndices).toHaveLength(2)
  })

  it('CompressionResult has iterations array with expected length (all iterations preserved)', async () => {
    summarizer = getSummarizer()
    const iterations: IterationContext[] = [
      { index: 0, content: 'a' },
      { index: 1, content: 'b' },
      { index: 2, content: 'c' },
    ]
    const result: CompressionResult = await summarizer.compress(iterations, /* currentIndex */ 2)

    // All 3 iterations are present (0 and 1 compressed, 2 unchanged)
    expect(result.iterations).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Constructor validation — 4 cases
// ---------------------------------------------------------------------------

describe('AutoSummarizer constructor — threshold validation', () => {
  it('throws RangeError when threshold is 0.4 (below 0.5)', () => {
    expect(() => new AutoSummarizer(mockEngine, 1000, { threshold: 0.4 })).toThrowError(
      RangeError,
    )
    expect(() => new AutoSummarizer(mockEngine, 1000, { threshold: 0.4 })).toThrowError(
      'context_summarize_threshold must be between 0.5 and 0.95',
    )
  })

  it('throws RangeError when threshold is 0.96 (above 0.95)', () => {
    expect(() => new AutoSummarizer(mockEngine, 1000, { threshold: 0.96 })).toThrowError(
      RangeError,
    )
    expect(() => new AutoSummarizer(mockEngine, 1000, { threshold: 0.96 })).toThrowError(
      'context_summarize_threshold must be between 0.5 and 0.95',
    )
  })

  it('constructs without error when threshold is exactly 0.5 (lower boundary)', () => {
    expect(() => new AutoSummarizer(mockEngine, 1000, { threshold: 0.5 })).not.toThrow()
  })

  it('constructs without error when threshold is exactly 0.95 (upper boundary)', () => {
    expect(() => new AutoSummarizer(mockEngine, 1000, { threshold: 0.95 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Additional coverage — estimateTokens used when tokenEstimate absent + default threshold
// ---------------------------------------------------------------------------

describe('shouldTrigger — uses estimateTokens when tokenEstimate absent', () => {
  it('computes token estimate from content.length/4 when tokenEstimate is not set', () => {
    // model limit 100, threshold 0.8 → trigger at > 80 tokens
    // content = 400 chars → estimateTokens = 100 tokens → should trigger
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.8 })
    const iterations: IterationContext[] = [
      { index: 0, content: 'x'.repeat(400) }, // no tokenEstimate — computed as 100
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(true)
  })
})

describe('AutoSummarizer — default threshold accepted (undefined config)', () => {
  it('constructs without error when no config is passed (default threshold 0.8)', () => {
    expect(() => new AutoSummarizer(mockEngine, 1000)).not.toThrow()
  })
})
