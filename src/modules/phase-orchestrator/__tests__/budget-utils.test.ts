/**
 * Unit tests for budget-utils module.
 *
 * Covers:
 *  - calculateDynamicBudget: AC2 dynamic budget formula
 *  - summarizeDecisions: Decision summarization/compression
 */

import { describe, it, expect } from 'vitest'
import {
  calculateDynamicBudget,
  summarizeDecisions,
  ABSOLUTE_MAX_PROMPT_TOKENS,
  TOKENS_PER_DECISION,
} from '../budget-utils.js'

// ---------------------------------------------------------------------------
// calculateDynamicBudget
// ---------------------------------------------------------------------------

describe('calculateDynamicBudget()', () => {
  it('returns base budget when decision count is 0', () => {
    expect(calculateDynamicBudget(3_000, 0)).toBe(3_000)
  })

  it('applies the formula: base_budget + (decision_count * tokens_per_decision)', () => {
    // 4000 + 5 * 100 = 4500
    expect(calculateDynamicBudget(4_000, 5)).toBe(4_500)
  })

  it('scales linearly with decision count', () => {
    const base = 2_000
    const budget1 = calculateDynamicBudget(base, 1)
    const budget10 = calculateDynamicBudget(base, 10)
    const budget20 = calculateDynamicBudget(base, 20)

    expect(budget1).toBe(base + 1 * TOKENS_PER_DECISION)
    expect(budget10).toBe(base + 10 * TOKENS_PER_DECISION)
    expect(budget20).toBe(base + 20 * TOKENS_PER_DECISION)
  })

  it('caps budget at ABSOLUTE_MAX_PROMPT_TOKENS', () => {
    // With a large decision count that would exceed the absolute max
    const budget = calculateDynamicBudget(10_000, 100)
    expect(budget).toBe(ABSOLUTE_MAX_PROMPT_TOKENS)
  })

  it('returns exactly ABSOLUTE_MAX_PROMPT_TOKENS when result equals it', () => {
    // Craft inputs so that base + count * TOKENS_PER_DECISION === ABSOLUTE_MAX_PROMPT_TOKENS
    const base = 2_000
    const countToMax = (ABSOLUTE_MAX_PROMPT_TOKENS - base) / TOKENS_PER_DECISION
    expect(calculateDynamicBudget(base, countToMax)).toBe(ABSOLUTE_MAX_PROMPT_TOKENS)
  })

  it('handles very large base budget by capping at max', () => {
    expect(calculateDynamicBudget(20_000, 0)).toBe(ABSOLUTE_MAX_PROMPT_TOKENS)
  })

  it('handles zero base budget', () => {
    expect(calculateDynamicBudget(0, 10)).toBe(10 * TOKENS_PER_DECISION)
  })
})

// ---------------------------------------------------------------------------
// summarizeDecisions
// ---------------------------------------------------------------------------

describe('summarizeDecisions()', () => {
  it('returns header with decisions in compact format', () => {
    const decisions = [
      { key: 'database', value: 'SQLite with WAL mode', category: 'data' },
      { key: 'api-style', value: 'REST with OpenAPI', category: 'api' },
    ]
    const result = summarizeDecisions(decisions, 1000)

    expect(result).toContain('## Architecture Decisions (Summarized)')
    expect(result).toContain('- database: SQLite with WAL mode')
    expect(result).toContain('- api-style: REST with OpenAPI')
  })

  it('truncates long decision values to 120 chars', () => {
    const longValue = 'x'.repeat(200)
    const decisions = [{ key: 'long-key', value: longValue, category: 'data' }]
    const result = summarizeDecisions(decisions, 2000)

    expect(result).toContain('- long-key: ' + 'x'.repeat(117) + '...')
    expect(result).not.toContain('x'.repeat(200))
  })

  it('respects maxChars budget and drops lower-priority decisions', () => {
    const decisions = [
      { key: 'db', value: 'PostgreSQL', category: 'data' },
      { key: 'auth', value: 'JWT tokens', category: 'auth' },
      { key: 'api', value: 'GraphQL', category: 'api' },
      { key: 'ci', value: 'GitHub Actions', category: 'ci' },
      { key: 'monitoring', value: 'Prometheus', category: 'observability' },
    ]

    // Very tight budget — should only include header + some decisions
    const result = summarizeDecisions(decisions, 120)

    // Should have the header at minimum
    expect(result).toContain('## Architecture Decisions (Summarized)')
    // Should NOT include all decisions
    const lineCount = result.split('\n').length
    expect(lineCount).toBeLessThan(6) // header + fewer than 5 decisions
  })

  it('sorts decisions by category priority (data first, ci last)', () => {
    const decisions = [
      { key: 'ci', value: 'GitHub Actions', category: 'ci' },
      { key: 'db', value: 'SQLite', category: 'data' },
      { key: 'login', value: 'OAuth2', category: 'auth' },
    ]
    const result = summarizeDecisions(decisions, 2000)
    const lines = result.split('\n').filter((l) => l.startsWith('- '))

    // data (index 0 in priority) should come before auth (index 1) before ci (index 6)
    expect(lines[0]).toContain('db: SQLite')
    expect(lines[1]).toContain('login: OAuth2')
    expect(lines[2]).toContain('ci: GitHub Actions')
  })

  it('returns only header when budget is too small for any decision', () => {
    const decisions = [
      { key: 'database', value: 'SQLite', category: 'data' },
    ]
    // Budget just big enough for the header but not the decision line
    const headerLen = '## Architecture Decisions (Summarized)'.length
    const result = summarizeDecisions(decisions, headerLen + 5)

    expect(result).toBe('## Architecture Decisions (Summarized)')
  })

  it('handles empty decisions array', () => {
    const result = summarizeDecisions([], 1000)
    expect(result).toBe('## Architecture Decisions (Summarized)')
  })

  it('handles decisions without category (sorted last)', () => {
    const decisions = [
      { key: 'uncategorized', value: 'some value' },
      { key: 'db', value: 'SQLite', category: 'data' },
    ]
    const result = summarizeDecisions(decisions, 2000)
    const lines = result.split('\n').filter((l) => l.startsWith('- '))

    // data category should come first
    expect(lines[0]).toContain('db: SQLite')
    expect(lines[1]).toContain('uncategorized: some value')
  })
})
