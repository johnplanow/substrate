/**
 * Integration tests for the pyramid summarization system (Story 49-8).
 *
 * Covers cross-component flows between LLMSummaryEngine, AutoSummarizer,
 * and ConvergenceController.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { LLMSummaryEngine } from '../summarizer.js'
import {
  AutoSummarizer,
  estimateTokens,
  type IterationContext,
  type CompressedIterationContext,
} from '../auto-summarizer.js'
import {
  SUMMARY_BUDGET,
  type SummaryLevel,
  type Summary,
  type SummarizeOptions,
  type ExpandOptions,
} from '../summary-types.js'
import type { SummaryEngine } from '../summary-engine.js'
import type { LLMClient } from '../../llm/client.js'
import type { LLMRequest } from '../../llm/types.js'
import { createConvergenceController } from '../../convergence/controller.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockLLMClient(defaultResponse = 'mock summary content') {
  let callCount = 0
  let responseContent = defaultResponse

  const client = {
    complete: vi.fn(async (_req: LLMRequest) => {
      callCount++
      return {
        content: responseContent,
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
        model: 'mock-model',
        stopReason: 'stop' as const,
        providerMetadata: {},
      }
    }),
  } as unknown as LLMClient

  return {
    client,
    get callCount() {
      return callCount
    },
    setResponse(content: string) {
      responseContent = content
    },
  }
}

class MockSummaryEngine implements SummaryEngine {
  readonly name = 'mock'
  callCount = 0

  async summarize(
    content: string,
    targetLevel: SummaryLevel,
    _opts?: SummarizeOptions,
  ): Promise<Summary> {
    this.callCount++
    return {
      level: targetLevel,
      content: content.slice(0, 20),
      originalHash: 'mock-hash-' + this.callCount,
      createdAt: new Date().toISOString(),
      originalTokenCount: 100,
      summaryTokenCount: 20,
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

// Type narrowing helper
function isCompressed(
  ctx: IterationContext | CompressedIterationContext,
): ctx is CompressedIterationContext {
  return 'compressed' in ctx
}

// ---------------------------------------------------------------------------
// AC1: Full 12-iteration pipeline simulation
// ---------------------------------------------------------------------------

describe('Full 12-iteration pipeline simulation', () => {
  // AutoSummarizer: limit=1000, threshold=0.8 → trigger at > 800
  const mockEngine = new MockSummaryEngine()
  const summarizer = new AutoSummarizer(mockEngine, 1000, { threshold: 0.8 })

  // Build 12 IterationContext objects, each with tokenEstimate=90
  const iterations: IterationContext[] = Array.from({ length: 12 }, (_, i) => ({
    index: i,
    content: `iteration ${i} content`,
    tokenEstimate: 90,
  }))

  it('shouldTrigger returns false for 8 iterations (total 720 < 800)', () => {
    expect(summarizer.shouldTrigger(iterations.slice(0, 8))).toBe(false)
  })

  it('shouldTrigger returns true for 9 iterations (total 810 > 800)', () => {
    expect(summarizer.shouldTrigger(iterations.slice(0, 9))).toBe(true)
  })

  it('compress(iterations[0..8], 8) returns CompressionResult with iterations.length === 9', async () => {
    const result = await summarizer.compress(iterations.slice(0, 9), 8)
    expect(result.iterations).toHaveLength(9)
  })

  it('all entries at indices 0–7 have compressed: true discriminant', async () => {
    const result = await summarizer.compress(iterations.slice(0, 9), 8)
    for (let i = 0; i < 8; i++) {
      const entry = result.iterations.find((c) => c.index === i)
      expect(entry).toBeDefined()
      expect('compressed' in (entry as object)).toBe(true)
      expect((entry as CompressedIterationContext).compressed).toBe(true)
    }
  })

  it('entry at index 8 does not have compressed property (is plain IterationContext)', async () => {
    const result = await summarizer.compress(iterations.slice(0, 9), 8)
    const entry8 = result.iterations.find((c) => c.index === 8)
    expect(entry8).toBeDefined()
    expect('compressed' in (entry8 as object)).toBe(false)
    expect((entry8 as IterationContext).content).toBe('iteration 8 content')
  })

  it('compressedIndices equals [0, 1, 2, 3, 4, 5, 6, 7]', async () => {
    const result = await summarizer.compress(iterations.slice(0, 9), 8)
    expect(result.compressedIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})

// ---------------------------------------------------------------------------
// AC2: Lossless round-trip across all summary levels
// ---------------------------------------------------------------------------

describe('Lossless round-trip — all summary levels', () => {
  const originalContent =
    'This is the full original content with important details that must be preserved exactly.'

  it('expand at "full" level with originalContent returns exact original content', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(originalContent, 'full')
    const expanded = await engine.expand(summary, 'full', { originalContent })
    expect(expanded).toBe(originalContent)
  })

  it('expand at "high" level with originalContent returns exact original content', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(originalContent, 'high')
    const expanded = await engine.expand(summary, 'full', { originalContent })
    expect(expanded).toBe(originalContent)
  })

  it('expand at "medium" level with originalContent returns exact original content', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(originalContent, 'medium')
    const expanded = await engine.expand(summary, 'full', { originalContent })
    expect(expanded).toBe(originalContent)
  })

  it('expand at "low" level with originalContent returns exact original content', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(originalContent, 'low')
    const expanded = await engine.expand(summary, 'full', { originalContent })
    expect(expanded).toBe(originalContent)
  })

  it('MockLLMClient.complete is not called during any expand with originalContent (callCount stays at 4)', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const levels: SummaryLevel[] = ['full', 'high', 'medium', 'low']
    // Summarize at all 4 levels
    const summaries: Summary[] = []
    for (const level of levels) {
      summaries.push(await engine.summarize(originalContent, level))
    }
    const afterSummarize = mock.callCount
    // Expand all 4 with originalContent — no LLM calls expected
    for (const summary of summaries) {
      await engine.expand(summary, 'full', { originalContent })
    }
    expect(mock.callCount).toBe(afterSummarize)
    expect(mock.callCount).toBe(4)
  })

  it('summary.originalHash for "high" level equals SHA-256 of original content', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(originalContent, 'high')
    const expectedHash = createHash('sha256').update(originalContent).digest('hex')
    expect(summary.originalHash).toBe(expectedHash)
  })

  it('summary.createdAt for "low" level is a valid ISO-8601 string parseable by new Date()', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(originalContent, 'low')
    const parsed = new Date(summary.createdAt)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(parsed.getTime()).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// AC3: LLM expansion path — no originalContent
// ---------------------------------------------------------------------------

describe('LLM expansion path — no originalContent', () => {
  it('MockLLMClient.callCount is 1 after summarize and 2 after expand (no originalContent)', async () => {
    const mock = createMockLLMClient('summary text')
    const engine = new LLMSummaryEngine(mock.client)
    const content = 'Some original content to summarize'
    const summary = await engine.summarize(content, 'medium')
    expect(mock.callCount).toBe(1)
    mock.setResponse('expanded content from LLM')
    await engine.expand(summary, 'full')
    expect(mock.callCount).toBe(2)
  })

  it('expand without originalContent returns the mock LLM response content', async () => {
    const mock = createMockLLMClient('summary text')
    const engine = new LLMSummaryEngine(mock.client)
    const content = 'Some original content to summarize'
    const summary = await engine.summarize(content, 'medium')
    mock.setResponse('expand result content')
    const expanded = await engine.expand(summary, 'full')
    expect(expanded).toBe('expand result content')
  })

  it('summary.summaryTokenCount is a positive integer set from LLM response outputTokens (30)', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize('content', 'medium')
    expect(summary.summaryTokenCount).toBeDefined()
    expect(typeof summary.summaryTokenCount).toBe('number')
    expect(summary.summaryTokenCount!).toBeGreaterThan(0)
    expect(summary.summaryTokenCount).toBe(30)
  })

  it('summary.originalTokenCount is a positive integer set from LLM response inputTokens (100)', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize('content', 'medium')
    expect(summary.originalTokenCount).toBeDefined()
    expect(typeof summary.originalTokenCount).toBe('number')
    expect(summary.originalTokenCount!).toBeGreaterThan(0)
    expect(summary.originalTokenCount).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// AC4: ConvergenceController integration with AutoSummarizer
// ---------------------------------------------------------------------------

describe('ConvergenceController with AutoSummarizer integration', () => {
  it('recordIterationContext appends to getStoredContexts — length 3 after 3 calls', () => {
    const controller = createConvergenceController()
    controller.recordIterationContext({ index: 0, content: 'ctx 0', tokenEstimate: 10 })
    controller.recordIterationContext({ index: 1, content: 'ctx 1', tokenEstimate: 10 })
    controller.recordIterationContext({ index: 2, content: 'ctx 2', tokenEstimate: 10 })
    expect(controller.getStoredContexts()).toHaveLength(3)
  })

  it('prepareForIteration without autoSummarizer returns stored contexts unchanged', async () => {
    const controller = createConvergenceController()
    controller.recordIterationContext({ index: 0, content: 'ctx 0', tokenEstimate: 50 })
    controller.recordIterationContext({ index: 1, content: 'ctx 1', tokenEstimate: 50 })
    const result = await controller.prepareForIteration(2)
    expect(result).toHaveLength(2)
    expect(isCompressed(result[0]!)).toBe(false)
    expect(isCompressed(result[1]!)).toBe(false)
  })

  it('after 6 contexts at 40 tokens each (total 240 > 160), prepareForIteration(5) returns 6 entries', async () => {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 200, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })

    for (let i = 0; i < 6; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 40 })
    }

    const result = await controller.prepareForIteration(5)
    expect(result).toHaveLength(6)
  })

  it('all returned entries with index < 5 have compressed: true after prepareForIteration(5)', async () => {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 200, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })

    for (let i = 0; i < 6; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 40 })
    }

    const result = await controller.prepareForIteration(5)
    const compressedEntries = result.filter((c) => c.index < 5)
    expect(compressedEntries.every(isCompressed)).toBe(true)
  })

  it('entry at index 5 lacks "compressed" key (is plain IterationContext)', async () => {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 200, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })

    for (let i = 0; i < 6; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 40 })
    }

    const result = await controller.prepareForIteration(5)
    const entry5 = result.find((c) => c.index === 5)
    expect(entry5).toBeDefined()
    expect(isCompressed(entry5!)).toBe(false)
  })

  it('each compressed entry has summary.level === "medium" (the configured targetLevel)', async () => {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 200, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })

    for (let i = 0; i < 6; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 40 })
    }

    const result = await controller.prepareForIteration(5)
    const compressedEntries = result.filter(isCompressed)
    for (const entry of compressedEntries) {
      expect(entry.summary.level).toBe('medium')
    }
  })

  it('getStoredContexts().length === 6 after compression', async () => {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 200, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })

    for (let i = 0; i < 6; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 40 })
    }

    await controller.prepareForIteration(5)
    expect(controller.getStoredContexts()).toHaveLength(6)
  })

  it('MockSummaryEngine.callCount === 5 after compressing indices 0–4', async () => {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 200, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })

    for (let i = 0; i < 6; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 40 })
    }

    await controller.prepareForIteration(5)
    expect(mockEngine.callCount).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// AC5: Hash and metadata integrity
// ---------------------------------------------------------------------------

describe('Hash and metadata integrity', () => {
  const content = `\`\`\`js\nconst x = 1\n\`\`\`\n\nFile: src/foo/bar.ts\n\nError: ENOENT: file not found`

  it('summary.originalHash is a 64-character lowercase hex string', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(content, 'medium')
    expect(summary.originalHash).toHaveLength(64)
    expect(summary.originalHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('summary.originalHash matches SHA-256 of the input content', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(content, 'medium')
    const expectedHash = createHash('sha256').update(content).digest('hex')
    expect(summary.originalHash).toBe(expectedHash)
  })

  it('summary.createdAt yields a valid non-NaN date when parsed by new Date()', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(content, 'medium')
    const parsed = new Date(summary.createdAt)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(parsed.getTime()).toBeGreaterThan(0)
  })

  it('summary.summaryTokenCount is a positive integer', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(content, 'medium')
    expect(summary.summaryTokenCount).toBeDefined()
    expect(summary.summaryTokenCount!).toBeGreaterThan(0)
    expect(Number.isInteger(summary.summaryTokenCount)).toBe(true)
  })

  it('summary.originalTokenCount is a positive integer', async () => {
    const mock = createMockLLMClient()
    const engine = new LLMSummaryEngine(mock.client)
    const summary = await engine.summarize(content, 'medium')
    expect(summary.originalTokenCount).toBeDefined()
    expect(summary.originalTokenCount!).toBeGreaterThan(0)
    expect(Number.isInteger(summary.originalTokenCount)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC6: Boundary conditions for shouldTrigger and estimateTokens
// ---------------------------------------------------------------------------

describe('shouldTrigger boundary conditions', () => {
  // Model limit = 100, threshold = 0.8 → trigger at total strictly > 80
  const mockEngine = new MockSummaryEngine()

  it('total === 80 (exactly at threshold) returns false', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.8 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 40 },
      { index: 1, content: '', tokenEstimate: 40 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('total === 81 (one above threshold) returns true', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.8 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 40 },
      { index: 1, content: '', tokenEstimate: 41 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(true)
  })

  it('total === 40 (well below threshold) returns false', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.8 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 40 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('iteration with no tokenEstimate and 40-char content uses estimateTokens → 10 tokens → false', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.8 })
    // 40 chars / 4 = 10 tokens; 10 > 80? → false
    const content40 = 'a'.repeat(40)
    expect(estimateTokens(content40)).toBe(10)
    const iterations: IterationContext[] = [{ index: 0, content: content40 }]
    // Manually computed: 10 tokens, trigger at >80 → false
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('explicit tokenEstimate=90 overrides content-based estimate and triggers (90 > 80)', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.8 })
    // content is 'a' (1 char → estimateTokens=1), but tokenEstimate=90 overrides
    const iterations: IterationContext[] = [
      { index: 0, content: 'a', tokenEstimate: 90 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(true)
  })

  it('threshold=0.5: trigger fires at total > 50 (51 tokens → true)', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.5 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 51 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(true)
  })

  it('threshold=0.5: does not fire at exactly 50 tokens', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.5 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 50 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('threshold=0.95: does not fire at 94 tokens (94 is not > 95)', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.95 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 94 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(false)
  })

  it('threshold=0.95: fires at 96 tokens (96 > 95)', () => {
    const summarizer = new AutoSummarizer(mockEngine, 100, { threshold: 0.95 })
    const iterations: IterationContext[] = [
      { index: 0, content: '', tokenEstimate: 96 },
    ]
    expect(summarizer.shouldTrigger(iterations)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC7: Multi-round compression through ConvergenceController
// ---------------------------------------------------------------------------

describe('Multi-round compression via ConvergenceController', () => {
  // limit=100, threshold=0.8 → trigger at > 80

  function setupController() {
    const mockEngine = new MockSummaryEngine()
    const autoSummarizer = new AutoSummarizer(mockEngine, 100, {
      threshold: 0.8,
      targetLevel: 'medium',
    })
    const controller = createConvergenceController({ autoSummarizer })
    return { mockEngine, autoSummarizer, controller }
  }

  it('after first prepareForIteration(4), getStoredContexts() has 5 entries with indices 0–3 compressed', async () => {
    const { controller } = setupController()
    // Record 5 contexts (0-4), each with 25 tokens → total=125 > 80 → triggers
    for (let i = 0; i < 5; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 25 })
    }
    await controller.prepareForIteration(4)
    const stored = controller.getStoredContexts()
    expect(stored).toHaveLength(5)
    // Indices 0-3 should be compressed, index 4 should be plain
    for (let i = 0; i < 4; i++) {
      const entry = stored.find((c) => c.index === i)
      expect(entry).toBeDefined()
      expect(isCompressed(entry!)).toBe(true)
    }
    const entry4 = stored.find((c) => c.index === 4)
    expect(entry4).toBeDefined()
    expect(isCompressed(entry4!)).toBe(false)
  })

  it('callCount increases by only 1 after second round (already-compressed 0–3 not re-summarized)', async () => {
    const { mockEngine, controller } = setupController()
    // First round: record 5 contexts (0-4) at 25 tokens each
    for (let i = 0; i < 5; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 25 })
    }
    await controller.prepareForIteration(4)
    const callCountAfterFirst = mockEngine.callCount // should be 4

    // Record context index=5 with tokenEstimate=90 → uncompressed=[iter4_25, iter5_90]=115>80 → triggers
    controller.recordIterationContext({ index: 5, content: 'ctx 5', tokenEstimate: 90 })
    await controller.prepareForIteration(5)

    expect(mockEngine.callCount).toBe(callCountAfterFirst + 1)
  })

  it('getStoredContexts() after second round has length 6', async () => {
    const { controller } = setupController()
    for (let i = 0; i < 5; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 25 })
    }
    await controller.prepareForIteration(4)
    controller.recordIterationContext({ index: 5, content: 'ctx 5', tokenEstimate: 90 })
    await controller.prepareForIteration(5)
    expect(controller.getStoredContexts()).toHaveLength(6)
  })

  it('indices 0–4 all compressed: true, index 5 is plain IterationContext after second round', async () => {
    const { controller } = setupController()
    for (let i = 0; i < 5; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 25 })
    }
    await controller.prepareForIteration(4)
    controller.recordIterationContext({ index: 5, content: 'ctx 5', tokenEstimate: 90 })
    await controller.prepareForIteration(5)

    const stored = controller.getStoredContexts()
    for (let i = 0; i < 5; i++) {
      const entry = stored.find((c) => c.index === i)
      expect(entry).toBeDefined()
      expect(isCompressed(entry!)).toBe(true)
    }
    const entry5 = stored.find((c) => c.index === 5)
    expect(entry5).toBeDefined()
    expect(isCompressed(entry5!)).toBe(false)
  })

  it('merged array is sorted by index (index 0 first, index 5 last) after second round', async () => {
    const { controller } = setupController()
    for (let i = 0; i < 5; i++) {
      controller.recordIterationContext({ index: i, content: `ctx ${i}`, tokenEstimate: 25 })
    }
    await controller.prepareForIteration(4)
    controller.recordIterationContext({ index: 5, content: 'ctx 5', tokenEstimate: 90 })
    await controller.prepareForIteration(5)

    const stored = controller.getStoredContexts()
    expect(stored[0]?.index).toBe(0)
    expect(stored[stored.length - 1]?.index).toBe(5)
    // Verify fully sorted
    for (let i = 1; i < stored.length; i++) {
      expect(stored[i]!.index).toBeGreaterThan(stored[i - 1]!.index)
    }
  })
})

// Ensure SUMMARY_BUDGET is referenced to avoid import being flagged as unused
void SUMMARY_BUDGET
