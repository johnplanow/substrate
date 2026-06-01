/**
 * Unit tests for aggregateStoryDispatchTelemetry — Story 81-1, AC6.
 *
 * Covers:
 *   (a) empty dispatch list returns {} (not zero)
 *   (b) single-dispatch single-phase sums correctly
 *   (c) multi-phase multi-dispatch sums correctly across create-story + dev-story + code-review
 *   (d) missing token data on one dispatch doesn't break aggregation (other dispatches still count)
 *   (e) missing turn data on one dispatch doesn't break aggregation
 */

import { describe, it, expect } from 'vitest'
import {
  aggregateStoryDispatchTelemetry,
  type DispatchRecord,
} from '../dispatch-telemetry-aggregation.js'

describe('aggregateStoryDispatchTelemetry (Story 81-1, AC6)', () => {
  // -------------------------------------------------------------------------
  // AC6(a): empty dispatch list returns {} (both fields absent, NOT zero)
  // -------------------------------------------------------------------------

  it('AC6(a): empty dispatch list returns {} with both fields absent', () => {
    const result = aggregateStoryDispatchTelemetry([])
    expect(result).toEqual({})
    expect(result.total_turns).toBeUndefined()
    expect(result.total_tokens).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC6(b): single-dispatch single-phase sums correctly
  // -------------------------------------------------------------------------

  it('AC6(b): single dispatch with turns and tokens sums correctly', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'dev-story', turns: 12, tokens: { input: 500, output: 200 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBe(12)
    expect(result.total_tokens).toEqual({ input: 500, output: 200 })
  })

  it('AC6(b): single dispatch with turns only returns total_turns, no total_tokens', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'dev-story', turns: 7 },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBe(7)
    expect(result.total_tokens).toBeUndefined()
  })

  it('AC6(b): single dispatch with tokens only returns total_tokens, no total_turns', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'dev-story', tokens: { input: 800, output: 300 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBeUndefined()
    expect(result.total_tokens).toEqual({ input: 800, output: 300 })
  })

  // -------------------------------------------------------------------------
  // AC6(c): multi-phase multi-dispatch sums correctly across all phases
  // -------------------------------------------------------------------------

  it('AC6(c): multi-phase dispatches (create-story + dev-story + code-review) sum correctly', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', turns: 3, tokens: { input: 200, output: 80 } },
      { agent: 'claude-code', phase: 'dev-story', turns: 15, tokens: { input: 1200, output: 400 } },
      { agent: 'claude-code', phase: 'code-review', turns: 5, tokens: { input: 600, output: 150 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBe(23) // 3 + 15 + 5
    expect(result.total_tokens).toEqual({ input: 2000, output: 630 }) // (200+1200+600), (80+400+150)
  })

  it('AC6(c): includes fix/rework dispatches in multi-cycle scenario', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', turns: 2, tokens: { input: 150, output: 60 } },
      { agent: 'claude-code', phase: 'dev-story', turns: 10, tokens: { input: 900, output: 300 } },
      { agent: 'claude-code', phase: 'code-review', turns: 4, tokens: { input: 400, output: 100 } },
      { agent: 'claude-code', phase: 'fix-story', turns: 8, tokens: { input: 700, output: 250 } },
      { agent: 'claude-code', phase: 'code-review', turns: 3, tokens: { input: 350, output: 90 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBe(27) // 2+10+4+8+3
    expect(result.total_tokens).toEqual({ input: 2500, output: 800 }) // sums of all
  })

  // -------------------------------------------------------------------------
  // AC6(d): missing token data on one dispatch doesn't break aggregation
  // -------------------------------------------------------------------------

  it('AC6(d): missing tokens on one dispatch — other dispatch tokens still aggregate', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', turns: 3, tokens: { input: 200, output: 80 } },
      { agent: 'claude-code', phase: 'dev-story', turns: 15 }, // no tokens
      { agent: 'claude-code', phase: 'code-review', turns: 5, tokens: { input: 600, output: 150 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    // turns still sums all three
    expect(result.total_turns).toBe(23)
    // tokens only sums the two dispatches that HAD token data (dev-story absent MUST NOT be treated as zero)
    expect(result.total_tokens).toEqual({ input: 800, output: 230 }) // 200+600, 80+150
  })

  it('AC6(d): all dispatches missing tokens — total_tokens is absent (not zero)', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', turns: 3 },
      { agent: 'claude-code', phase: 'dev-story', turns: 15 },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBe(18)
    expect(result.total_tokens).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC6(e): missing turn data on one dispatch doesn't break aggregation
  // -------------------------------------------------------------------------

  it('AC6(e): missing turns on one dispatch — other dispatch turns still aggregate', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', tokens: { input: 200, output: 80 } }, // no turns
      { agent: 'claude-code', phase: 'dev-story', turns: 15, tokens: { input: 1200, output: 400 } },
      { agent: 'claude-code', phase: 'code-review', turns: 5, tokens: { input: 600, output: 150 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    // turns sums only the two that had turn data (create-story absent MUST NOT be treated as zero)
    expect(result.total_turns).toBe(20) // 15 + 5
    // tokens sums all three
    expect(result.total_tokens).toEqual({ input: 2000, output: 630 })
  })

  it('AC6(e): all dispatches missing turns — total_turns is absent (not zero)', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', tokens: { input: 200, output: 80 } },
      { agent: 'claude-code', phase: 'dev-story', tokens: { input: 1200, output: 400 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBeUndefined()
    expect(result.total_tokens).toEqual({ input: 1400, output: 480 })
  })

  // -------------------------------------------------------------------------
  // Additional: bare agent-info records (no turns/tokens) return {} like empty
  // This models the current _storyAgents map behaviour
  // -------------------------------------------------------------------------

  it('bare agent-info records (no turns/tokens) return {} like empty list', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story' },
      { agent: 'claude-code', phase: 'dev-story', model: 'claude-sonnet-4-5' },
      { agent: 'claude-code', phase: 'code-review' },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result).toEqual({})
    expect(result.total_turns).toBeUndefined()
    expect(result.total_tokens).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Zero-value edge cases: turns=0 is valid (not "absent")
  // -------------------------------------------------------------------------

  it('turns=0 is a valid telemetry value (not treated as absent)', () => {
    const records: DispatchRecord[] = [
      { agent: 'claude-code', phase: 'create-story', turns: 0, tokens: { input: 100, output: 40 } },
    ]
    const result = aggregateStoryDispatchTelemetry(records)
    expect(result.total_turns).toBe(0)
    expect(result.total_tokens).toEqual({ input: 100, output: 40 })
  })
})
