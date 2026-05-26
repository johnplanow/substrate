// @vitest-environment node
/**
 * Unit tests for `enrichEscalation` in report.ts — Story 78-1.
 *
 * AC5: recovery_attempts computation correctly reflects both review_cycles and
 * recovery_history entry count (using Math.max so neither signal masks the other).
 */

import { describe, it, expect } from 'vitest'
import { enrichEscalation } from '../report.js'

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal RawStoryState with optional review_cycles. */
function stateWith(review_cycles?: number) {
  return {
    status: 'escalated' as const,
    escalation_reason: 'checkpoint-retry-timeout',
    review_cycles,
  }
}

/** Build a minimal RawManifest with N recovery_history entries for 'test-story-1'. */
function manifestWith(historyEntries: number) {
  return {
    run_id: 'run-test-001',
    per_story_state: {} as Record<string, ReturnType<typeof stateWith>>,
    recovery_history: Array.from({ length: historyEntries }, (_, i) => ({
      story_key: 'test-story-1',
      attempt_number: i + 1,
    })),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const STORY_KEY = 'test-story-1'
const RUN_ID = 'run-test-001'

describe('enrichEscalation — recovery_attempts computation (AC5)', () => {
  it('(a) review_cycles=0 + 2 recovery_history entries → recovery_attempts === 2', () => {
    const state = stateWith(0)
    const manifest = manifestWith(2)
    const detail = enrichEscalation(STORY_KEY, state, RUN_ID, manifest)

    expect(detail.recovery_attempts).toBe(2)
    expect(detail.blast_radius).toContain('2 recovery attempt(s)')
  })

  it('(b) review_cycles=3 + 0 recovery_history entries → recovery_attempts === 3', () => {
    const state = stateWith(3)
    const manifest = manifestWith(0)
    const detail = enrichEscalation(STORY_KEY, state, RUN_ID, manifest)

    expect(detail.recovery_attempts).toBe(3)
    expect(detail.blast_radius).toContain('3 recovery attempt(s)')
  })

  it('(c) review_cycles=1 + 2 recovery_history entries → recovery_attempts === 2', () => {
    const state = stateWith(1)
    const manifest = manifestWith(2)
    const detail = enrichEscalation(STORY_KEY, state, RUN_ID, manifest)

    expect(detail.recovery_attempts).toBe(2)
    expect(detail.blast_radius).toContain('2 recovery attempt(s)')
  })

  it('(d) both absent (undefined review_cycles, empty recovery_history) → recovery_attempts === 0', () => {
    const state = stateWith(undefined)
    const manifest = manifestWith(0)
    const detail = enrichEscalation(STORY_KEY, state, RUN_ID, manifest)

    expect(detail.recovery_attempts).toBe(0)
    expect(detail.blast_radius).toContain('0 recovery attempt(s)')
  })
})
