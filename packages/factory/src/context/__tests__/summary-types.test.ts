import { describe, it, expect } from 'vitest'
import type { SummaryLevel, SummarizeOptions, ExpandOptions, Summary } from '../summary-types.js'
import {
  SUMMARY_BUDGET,
  DEFAULT_SUMMARY_LEVEL,
  computeBudget,
} from '../summary-types.js'
import type { SummaryEngine } from '../summary-engine.js'

// MockSummaryEngine implements SummaryEngine — compile-time verification
class MockSummaryEngine implements SummaryEngine {
  readonly name = 'mock'

  async summarize(
    content: string,
    targetLevel: SummaryLevel,
    _opts?: SummarizeOptions,
  ): Promise<Summary> {
    return {
      level: targetLevel,
      content: content.slice(0, Math.floor(content.length * SUMMARY_BUDGET[targetLevel])),
      originalHash: 'abc123deadbeef0000000000000000000000000000000000000000000000000000',
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

describe('SUMMARY_BUDGET', () => {
  it('full level has budget 1.0', () => {
    expect(SUMMARY_BUDGET['full']).toBe(1.0)
  })

  it('high level has budget 0.75', () => {
    expect(SUMMARY_BUDGET['high']).toBe(0.75)
  })

  it('medium level has budget 0.50', () => {
    expect(SUMMARY_BUDGET['medium']).toBe(0.50)
  })

  it('low level has budget 0.25', () => {
    expect(SUMMARY_BUDGET['low']).toBe(0.25)
  })
})

describe('DEFAULT_SUMMARY_LEVEL', () => {
  it('default level is medium', () => {
    expect(DEFAULT_SUMMARY_LEVEL).toBe('medium')
  })
})

describe('Summary interface shape', () => {
  it('minimal Summary with all required fields is valid', () => {
    const summary: Summary = {
      level: 'medium',
      content: 'Summarized content here.',
      originalHash: 'deadbeef00000000000000000000000000000000000000000000000000000000',
      createdAt: '2026-03-26T00:00:00.000Z',
    }
    expect(summary).toMatchObject({
      level: 'medium',
      content: 'Summarized content here.',
      originalHash: 'deadbeef00000000000000000000000000000000000000000000000000000000',
      createdAt: '2026-03-26T00:00:00.000Z',
    })
  })

  it('full Summary with all optional fields is valid', () => {
    const summary: Summary = {
      level: 'high',
      content: 'High-fidelity summary.',
      originalHash: 'cafebabe00000000000000000000000000000000000000000000000000000000',
      createdAt: '2026-03-26T12:00:00.000Z',
      originalTokenCount: 8000,
      summaryTokenCount: 6000,
      metadata: { engine: 'llm', model: 'claude-3-5-sonnet' },
    }
    expect(summary.originalTokenCount).toBe(8000)
    expect(summary.summaryTokenCount).toBe(6000)
    expect(summary.metadata).toEqual({ engine: 'llm', model: 'claude-3-5-sonnet' })
  })
})

describe('SummaryEngine interface', () => {
  it('engine.name is a string', () => {
    const engine: SummaryEngine = new MockSummaryEngine()
    expect(typeof engine.name).toBe('string')
    expect(engine.name).toBe('mock')
  })

  it('summarize() returns a Summary with the requested level', async () => {
    const engine: SummaryEngine = new MockSummaryEngine()
    const content = 'This is a long piece of context that should be summarized.'
    const summary = await engine.summarize(content, 'medium')
    expect(summary.level).toBe('medium')
    expect(typeof summary.content).toBe('string')
    expect(typeof summary.originalHash).toBe('string')
    expect(typeof summary.createdAt).toBe('string')
  })

  it('expand() returns a string', async () => {
    const engine: SummaryEngine = new MockSummaryEngine()
    const summary: Summary = {
      level: 'medium',
      content: 'Compressed context.',
      originalHash: 'abc123',
      createdAt: new Date().toISOString(),
    }
    const expanded = await engine.expand(summary, 'full')
    expect(typeof expanded).toBe('string')
  })

  it('expand() uses originalContent when provided', async () => {
    const engine: SummaryEngine = new MockSummaryEngine()
    const summary: Summary = {
      level: 'medium',
      content: 'Compressed context.',
      originalHash: 'abc123',
      createdAt: new Date().toISOString(),
    }
    const original = 'Full original context that was compressed.'
    const expanded = await engine.expand(summary, 'full', { originalContent: original })
    expect(expanded).toBe(original)
  })
})

describe('computeBudget', () => {
  it('returns 100% of tokens for full level', () => {
    const budget = computeBudget(100_000, 'full')
    expect(budget.targetTokenCount).toBe(100_000)
    expect(budget.compressionRatio).toBe(1.0)
    expect(budget.modelTokenLimit).toBe(100_000)
    expect(budget.level).toBe('full')
  })

  it('returns 50% of tokens for medium level', () => {
    const budget = computeBudget(100_000, 'medium')
    expect(budget.targetTokenCount).toBe(50_000)
    expect(budget.compressionRatio).toBe(0.50)
  })

  it('returns 25% of tokens for low level', () => {
    const budget = computeBudget(100_000, 'low')
    expect(budget.targetTokenCount).toBe(25_000)
    expect(budget.compressionRatio).toBe(0.25)
  })

  it('returns 75% of tokens for high level with larger limit', () => {
    const budget = computeBudget(200_000, 'high')
    expect(budget.targetTokenCount).toBe(150_000)
    expect(budget.compressionRatio).toBe(0.75)
  })
})
