/**
 * Stop-after integration tests for `src/cli/commands/auto.ts`
 *
 * Covers --stop-after option parsing and validation (AC7 for stop-after):
 *   - Valid phase names are accepted
 *   - Invalid phase names are rejected with a clear error
 *   - Conflict between --stop-after and --from is rejected
 *
 * These tests exercise the pure stop-after module directly; integration
 * with the full auto pipeline is covered in auto-pipeline.integration.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  VALID_PHASES,
  createStopAfterGate,
  validateStopAfterFromConflict,
  formatPhaseCompletionSummary,
} from '../../../modules/stop-after/index.js'
import type { PhaseName } from '../../../modules/stop-after/index.js'

// ---------------------------------------------------------------------------
// VALID_PHASES
// ---------------------------------------------------------------------------

describe('VALID_PHASES', () => {
  it('contains expected pipeline phases', () => {
    expect(VALID_PHASES).toContain('analysis')
    expect(VALID_PHASES).toContain('planning')
    expect(VALID_PHASES).toContain('solutioning')
    expect(VALID_PHASES).toContain('implementation')
  })

  it('has exactly four phases', () => {
    expect(VALID_PHASES).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// --stop-after option: phase name validation
// ---------------------------------------------------------------------------

describe('--stop-after option parsing', () => {
  it('accepts all valid phase names', () => {
    for (const phase of VALID_PHASES) {
      expect(() => createStopAfterGate(phase as PhaseName)).not.toThrow()
    }
  })

  it('rejects an invalid phase name', () => {
    expect(() => createStopAfterGate('nonexistent' as PhaseName)).toThrow(
      /invalid phase name/i,
    )
  })
})

// ---------------------------------------------------------------------------
// --stop-after / --from conflict validation
// ---------------------------------------------------------------------------

describe('validateStopAfterFromConflict', () => {
  it('returns valid when from is undefined', () => {
    const result = validateStopAfterFromConflict('analysis', undefined)
    expect(result.valid).toBe(true)
  })

  it('returns valid when stopAfter comes after from', () => {
    const result = validateStopAfterFromConflict('solutioning', 'analysis')
    expect(result.valid).toBe(true)
  })

  it('returns valid when stopAfter equals from', () => {
    const result = validateStopAfterFromConflict('planning', 'planning')
    expect(result.valid).toBe(true)
  })

  it('returns invalid when stopAfter comes before from', () => {
    const result = validateStopAfterFromConflict('analysis', 'planning')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/stop-after.*before.*start|stop phase before start phase/i)
  })
})

// ---------------------------------------------------------------------------
// formatPhaseCompletionSummary
// ---------------------------------------------------------------------------

describe('formatPhaseCompletionSummary', () => {
  const baseParams = {
    phaseName: 'analysis' as PhaseName,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    decisionsCount: 5,
    artifactPaths: [],
    runId: 'run-abc-123',
  }

  it('includes the phase name in output', () => {
    const summary = formatPhaseCompletionSummary(baseParams)
    expect(summary).toMatch(/analysis/i)
  })

  it('includes the run ID for resume', () => {
    const summary = formatPhaseCompletionSummary(baseParams)
    expect(summary).toContain('run-abc-123')
  })

  it('includes decisions count', () => {
    const summary = formatPhaseCompletionSummary(baseParams)
    expect(summary).toContain('5')
  })

  it('handles empty artifactPaths gracefully', () => {
    const summary = formatPhaseCompletionSummary({ ...baseParams, artifactPaths: [] })
    expect(summary).toMatch(/none|no artifact/i)
  })

  it('stays within 500 words for large artifact lists', () => {
    const manyPaths = Array.from({ length: 100 }, (_, i) => `path/to/artifact-${i}.md`)
    const summary = formatPhaseCompletionSummary({ ...baseParams, artifactPaths: manyPaths })
    const wordCount = summary.split(/\s+/).filter((w) => w.length > 0).length
    expect(wordCount).toBeLessThanOrEqual(500)
  })
})

// ---------------------------------------------------------------------------
// createStopAfterGate
// ---------------------------------------------------------------------------

describe('createStopAfterGate', () => {
  it('shouldHalt returns true (gate always halts when constructed for a phase)', () => {
    const gate = createStopAfterGate('planning')
    expect(gate.shouldHalt()).toBe(true)
  })

  it('isStopPhase returns true', () => {
    const gate = createStopAfterGate('solutioning')
    expect(gate.isStopPhase()).toBe(true)
  })
})
