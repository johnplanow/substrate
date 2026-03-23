/**
 * Tests for normalizeGraphSummaryToStatus — pure function that maps
 * GraphRunSummary → linear-compatible status shape.
 */

import { describe, it, expect } from 'vitest'
import { normalizeGraphSummaryToStatus } from '../run.js'
import type { GraphRunSummary } from '@substrate-ai/sdlc'

describe('normalizeGraphSummaryToStatus', () => {
  it('maps SUCCESS outcome to phase COMPLETE', () => {
    const summary: GraphRunSummary = {
      successCount: 1,
      failureCount: 0,
      totalStories: 1,
      stories: { '1-1': { outcome: 'SUCCESS' } },
    }
    const result = normalizeGraphSummaryToStatus(summary)
    expect(result.stories['1-1']).toEqual({ phase: 'COMPLETE' })
  })

  it('maps FAILED outcome to phase FAILED with error', () => {
    const summary: GraphRunSummary = {
      successCount: 0,
      failureCount: 1,
      totalStories: 1,
      stories: { '1-1': { outcome: 'FAILED', error: 'build failed' } },
    }
    const result = normalizeGraphSummaryToStatus(summary)
    expect(result.stories['1-1']).toEqual({ phase: 'FAILED', error: 'build failed' })
  })

  it('maps FAILED outcome without error — no error field in output', () => {
    const summary: GraphRunSummary = {
      successCount: 0,
      failureCount: 1,
      totalStories: 1,
      stories: { '1-1': { outcome: 'FAILED' } },
    }
    const result = normalizeGraphSummaryToStatus(summary)
    expect(result.stories['1-1']).toEqual({ phase: 'FAILED' })
    expect('error' in result.stories['1-1']!).toBe(false)
  })

  it('maps ESCALATED outcome to phase ESCALATED', () => {
    const summary: GraphRunSummary = {
      successCount: 0,
      failureCount: 1,
      totalStories: 1,
      stories: { '1-1': { outcome: 'ESCALATED' } },
    }
    const result = normalizeGraphSummaryToStatus(summary)
    expect(result.stories['1-1']).toEqual({ phase: 'ESCALATED' })
  })

  it('handles mixed outcomes across multiple stories', () => {
    const summary: GraphRunSummary = {
      successCount: 2,
      failureCount: 2,
      totalStories: 4,
      stories: {
        '1-1': { outcome: 'SUCCESS' },
        '1-2': { outcome: 'FAILED', error: 'timeout' },
        '1-3': { outcome: 'ESCALATED' },
        '1-4': { outcome: 'SUCCESS' },
      },
    }
    const result = normalizeGraphSummaryToStatus(summary)
    expect(result.stories['1-1']).toEqual({ phase: 'COMPLETE' })
    expect(result.stories['1-2']).toEqual({ phase: 'FAILED', error: 'timeout' })
    expect(result.stories['1-3']).toEqual({ phase: 'ESCALATED' })
    expect(result.stories['1-4']).toEqual({ phase: 'COMPLETE' })
  })
})
