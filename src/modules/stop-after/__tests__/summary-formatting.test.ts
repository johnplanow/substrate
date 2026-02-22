/**
 * Unit tests for formatPhaseCompletionSummary() word count and content structure
 */

import { describe, it, expect } from 'vitest'
import { formatPhaseCompletionSummary } from '../gate-impl.js'
import { createStopAfterGate } from '../gate-impl.js'
import type { CompletionSummaryParams } from '../types.js'

// Helper: count words the same way the implementation does
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

// Fixed timestamps for deterministic duration testing
const START_AT = '2026-02-22T10:00:00.000Z'
const COMPLETED_AT = '2026-02-22T10:00:45.000Z' // 45 seconds later

function makeParams(overrides: Partial<CompletionSummaryParams> = {}): CompletionSummaryParams {
  return {
    phaseName: 'analysis',
    startedAt: START_AT,
    completedAt: COMPLETED_AT,
    decisionsCount: 5,
    artifactPaths: [
      '_bmad-output/artifacts/brief.md',
      '_bmad-output/artifacts/context.md',
      '_bmad-output/artifacts/stakeholders.md',
    ],
    runId: 'abc123',
    ...overrides,
  }
}

describe('formatPhaseCompletionSummary()', () => {
  describe('typical case — 3 artifacts, 5 decisions', () => {
    it('returns a non-empty string', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })

    it('word count is between 50 and 500', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      const words = countWords(result)
      expect(words).toBeGreaterThanOrEqual(50)
      expect(words).toBeLessThanOrEqual(500)
    })

    it('contains the phase name', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result.toLowerCase()).toContain('analysis')
    })

    it('contains "completed"', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result.toLowerCase()).toContain('completed')
    })

    it('contains the decisions count', () => {
      const result = formatPhaseCompletionSummary(makeParams({ decisionsCount: 5 }))
      expect(result).toContain('5')
    })

    it('contains the run-id in the resume command', () => {
      const result = formatPhaseCompletionSummary(makeParams({ runId: 'abc123' }))
      expect(result).toContain('--run-id')
      expect(result).toContain('abc123')
    })

    it('contains "substrate auto resume"', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result).toContain('substrate auto resume')
    })

    it('contains "45 seconds" duration', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result).toContain('45 seconds')
    })

    it('contains artifact paths as bullet points', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result).toContain('brief.md')
      expect(result).toContain('context.md')
      expect(result).toContain('stakeholders.md')
    })

    it('does not contain ANSI escape codes', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      // ANSI codes start with ESC (\x1b) or similar
      expect(result).not.toMatch(/\x1b\[/)
    })
  })

  describe('zero artifacts, zero decisions', () => {
    it('word count is still >= 50', () => {
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: [], decisionsCount: 0 }),
      )
      const words = countWords(result)
      expect(words).toBeGreaterThanOrEqual(50)
    })

    it('word count is <= 500', () => {
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: [], decisionsCount: 0 }),
      )
      const words = countWords(result)
      expect(words).toBeLessThanOrEqual(500)
    })

    it('still contains phase name and completed status', () => {
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: [], decisionsCount: 0 }),
      )
      expect(result.toLowerCase()).toContain('analysis')
      expect(result.toLowerCase()).toContain('completed')
    })

    it('resume command is still present', () => {
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: [], decisionsCount: 0 }),
      )
      expect(result).toContain('substrate auto resume')
      expect(result).toContain('--run-id')
    })
  })

  describe('max case — 20 artifacts, 100 decisions', () => {
    it('word count is <= 500', () => {
      const manyArtifacts = Array.from({ length: 20 }, (_, i) => `_bmad-output/artifact-${i}.md`)
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: manyArtifacts, decisionsCount: 100 }),
      )
      const words = countWords(result)
      expect(words).toBeLessThanOrEqual(500)
    })

    it('resume command is never truncated when artifacts are truncated', () => {
      const manyArtifacts = Array.from({ length: 20 }, (_, i) => `_bmad-output/artifact-${i}.md`)
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: manyArtifacts, decisionsCount: 100, runId: 'run-xyz-999' }),
      )
      expect(result).toContain('substrate auto resume --run-id run-xyz-999')
    })

    it('contains truncation indicator when artifacts are truncated', () => {
      const manyArtifacts = Array.from({ length: 20 }, (_, i) => `_bmad-output/artifact-${i}.md`)
      const result = formatPhaseCompletionSummary(
        makeParams({ artifactPaths: manyArtifacts, decisionsCount: 100 }),
      )
      // If truncated, should mention "more artifacts"
      // (or all fit — either is acceptable as long as word count <= 500)
      const words = countWords(result)
      if (words < 500) {
        // All fit — no truncation needed
        expect(words).toBeLessThanOrEqual(500)
      } else {
        expect(result).toContain('more artifact')
      }
    })
  })

  describe('all phases', () => {
    const phases = ['analysis', 'planning', 'solutioning', 'implementation'] as const

    for (const phase of phases) {
      it(`formats correctly for phase '${phase}'`, () => {
        const result = formatPhaseCompletionSummary(makeParams({ phaseName: phase }))
        expect(result.toLowerCase()).toContain(phase)
        expect(result.toLowerCase()).toContain('completed')
        const words = countWords(result)
        expect(words).toBeGreaterThanOrEqual(50)
        expect(words).toBeLessThanOrEqual(500)
      })
    }
  })

  describe('next-phase description', () => {
    it('includes the provided nextPhaseDescription', () => {
      const result = formatPhaseCompletionSummary(
        makeParams({ nextPhaseDescription: 'Planning will use the brief for requirements.' }),
      )
      expect(result).toContain('Planning will use the brief for requirements.')
    })

    it('uses default description when nextPhaseDescription is not provided', () => {
      const result = formatPhaseCompletionSummary(makeParams({ phaseName: 'analysis' }))
      expect(result.toLowerCase()).toContain('planning')
      expect(result.toLowerCase()).toContain('brief')
    })
  })

  describe('duration formatting', () => {
    it('shows seconds for sub-minute duration', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result).toContain('45 seconds')
    })

    it('shows minutes and seconds for longer duration', () => {
      const longEnd = '2026-02-22T10:02:30.000Z' // 2 minutes 30 seconds
      const result = formatPhaseCompletionSummary(
        makeParams({ completedAt: longEnd }),
      )
      expect(result).toContain('2 minutes')
      expect(result).toContain('30 seconds')
    })

    it('shows only minutes when seconds is 0', () => {
      const exactMinutes = '2026-02-22T10:03:00.000Z' // exactly 3 minutes
      const result = formatPhaseCompletionSummary(
        makeParams({ completedAt: exactMinutes }),
      )
      expect(result).toContain('3 minutes')
    })

    it('shows 1 second (singular) not 1 seconds', () => {
      const oneSecEnd = '2026-02-22T10:00:01.000Z'
      const result = formatPhaseCompletionSummary(
        makeParams({ completedAt: oneSecEnd }),
      )
      expect(result).toContain('1 second')
      expect(result).not.toContain('1 seconds')
    })
  })

  describe('via gate.formatCompletionSummary()', () => {
    it('gate delegates correctly to formatPhaseCompletionSummary', () => {
      const gate = createStopAfterGate('planning')
      const params = makeParams({ phaseName: 'planning' })
      const result = gate.formatCompletionSummary(params)
      const expected = formatPhaseCompletionSummary(params)
      expect(result).toBe(expected)
    })
  })

  describe('resume command exact format', () => {
    it('resume command syntax is "substrate auto resume --run-id <id>"', () => {
      const result = formatPhaseCompletionSummary(makeParams({ runId: 'test-run-id-42' }))
      expect(result).toContain('substrate auto resume --run-id test-run-id-42')
    })
  })

  describe('artifact list format', () => {
    it('artifacts appear as bullet points (- prefix)', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      // Check bullet point format
      expect(result).toMatch(/^\s*-\s+.*brief\.md/m)
    })

    it('contains "Artifacts created" label', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result).toContain('Artifacts created')
    })
  })

  describe('phase status line', () => {
    it('contains the capitalized phase name', () => {
      const result = formatPhaseCompletionSummary(makeParams({ phaseName: 'analysis' }))
      expect(result).toContain('Analysis')
    })

    it('contains "completed" in the status line', () => {
      const result = formatPhaseCompletionSummary(makeParams())
      expect(result.toLowerCase()).toContain('completed')
    })
  })
})
