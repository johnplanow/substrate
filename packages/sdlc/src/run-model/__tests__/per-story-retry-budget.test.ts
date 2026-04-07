/**
 * Unit tests for retry_count field in PerStoryStateSchema — Story 53-4.
 *
 * Covers AC1 (retry_count field presence and default), AC6 (backward compat).
 */

import { describe, it, expect } from 'vitest'
import { PerStoryStateSchema } from '../per-story-state.js'

// ---------------------------------------------------------------------------
// Test suite: retry_count field in PerStoryStateSchema (AC1, AC6)
// ---------------------------------------------------------------------------

describe('PerStoryStateSchema: retry_count field (Story 53-4)', () => {
  // -------------------------------------------------------------------------
  // Backward compatibility: manifests without retry_count parse without error
  // -------------------------------------------------------------------------

  it('AC1, AC6: parses a manifest entry without retry_count (backward compat — retry_count is undefined)', () => {
    const entry = {
      status: 'pending',
      phase: 'IN_DEV',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      // retry_count is optional — absence is treated as 0 by consumers
      expect(result.data.retry_count).toBeUndefined()
    }
  })

  it('AC1: parses retry_count: 0 correctly', () => {
    const entry = {
      status: 'dispatched',
      phase: 'IN_DEV',
      started_at: '2026-04-06T00:00:00.000Z',
      retry_count: 0,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_count).toBe(0)
    }
  })

  it('AC1: parses retry_count: 3 correctly', () => {
    const entry = {
      status: 'in-review',
      phase: 'IN_REVIEW',
      started_at: '2026-04-06T00:00:00.000Z',
      retry_count: 3,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_count).toBe(3)
    }
  })

  it('AC1: rejects negative retry_count (nonnegative constraint)', () => {
    const entry = {
      status: 'in-review',
      phase: 'IN_REVIEW',
      started_at: '2026-04-06T00:00:00.000Z',
      retry_count: -1,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it('AC1: rejects non-integer retry_count', () => {
    const entry = {
      status: 'in-review',
      phase: 'IN_REVIEW',
      started_at: '2026-04-06T00:00:00.000Z',
      retry_count: 1.5,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it('AC1: parses fully-populated entry including retry_count', () => {
    const entry = {
      status: 'escalated',
      phase: 'ESCALATED',
      started_at: '2026-04-06T00:00:00.000Z',
      completed_at: '2026-04-06T01:00:00.000Z',
      cost_usd: 0.5,
      review_cycles: 2,
      dispatches: 3,
      retry_count: 2,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.retry_count).toBe(2)
      expect(result.data.review_cycles).toBe(2)
      expect(result.data.dispatches).toBe(3)
    }
  })
})
