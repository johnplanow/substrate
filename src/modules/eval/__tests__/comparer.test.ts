/**
 * Unit tests for EvalComparer (V1b-5).
 */

import { describe, it, expect } from 'vitest'
import { EvalComparer } from '../comparer.js'
import type { EvalReport, PhaseEvalResult } from '../types.js'

function makeReport(
  runId: string,
  phases: Array<{ phase: string; score: number }>,
  metadata?: EvalReport['metadata'],
): EvalReport {
  return {
    runId,
    depth: 'standard',
    timestamp: new Date().toISOString(),
    phases: phases.map(
      (p): PhaseEvalResult => ({
        phase: p.phase as PhaseEvalResult['phase'],
        score: p.score,
        pass: p.score >= 0.7,
        layers: [],
        issues: [],
        feedback: '',
      }),
    ),
    overallScore: phases.reduce((s, p) => s + p.score, 0) / phases.length,
    pass: phases.every((p) => p.score >= 0.7),
    metadata,
  }
}

describe('EvalComparer', () => {
  const comparer = new EvalComparer()

  it('detects regression when score drops by more than threshold', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.80 }])
    const b = makeReport('run-b', [{ phase: 'analysis', score: 0.70 }])

    const result = comparer.compare(a, b)

    expect(result.hasRegression).toBe(true)
    expect(result.phases[0].verdict).toBe('REGRESSION')
    expect(result.phases[0].delta).toBeCloseTo(-0.10, 2)
  })

  it('flags Improved when score increases by more than threshold', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.70 }])
    const b = makeReport('run-b', [{ phase: 'analysis', score: 0.85 }])

    const result = comparer.compare(a, b)

    expect(result.hasRegression).toBe(false)
    expect(result.phases[0].verdict).toBe('Improved')
    expect(result.phases[0].delta).toBeCloseTo(0.15, 2)
  })

  it('flags Unchanged when delta is within threshold', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.80 }])
    const b = makeReport('run-b', [{ phase: 'analysis', score: 0.78 }])

    const result = comparer.compare(a, b)

    expect(result.hasRegression).toBe(false)
    expect(result.phases[0].verdict).toBe('Unchanged')
  })

  it('handles phases present in only one report', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.80 }])
    const b = makeReport('run-b', [{ phase: 'planning', score: 0.85 }])

    const result = comparer.compare(a, b)

    expect(result.phases).toHaveLength(2)
    const removed = result.phases.find((p) => p.phase === 'analysis')
    const added = result.phases.find((p) => p.phase === 'planning')
    expect(removed?.verdict).toBe('Removed')
    expect(removed?.scoreB).toBeUndefined()
    expect(added?.verdict).toBe('New')
    expect(added?.scoreA).toBeUndefined()
  })

  it('uses custom regression threshold from config', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.80 }])
    const b = makeReport('run-b', [{ phase: 'analysis', score: 0.77 }])

    // Default threshold 0.05 → Unchanged (delta = -0.03)
    const resultDefault = comparer.compare(a, b)
    expect(resultDefault.phases[0].verdict).toBe('Unchanged')

    // Custom threshold 0.02 → REGRESSION (delta = -0.03 exceeds 0.02)
    const resultStrict = comparer.compare(a, b, { default: 0.7, regression: 0.02 })
    expect(resultStrict.phases[0].verdict).toBe('REGRESSION')
    expect(resultStrict.hasRegression).toBe(true)
  })

  it('detects metadata differences', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.80 }], {
      schemaVersion: '1b',
      gitSha: 'aaa1111',
      rubricHashes: { analysis: 'hash-a' },
    })
    const b = makeReport('run-b', [{ phase: 'analysis', score: 0.80 }], {
      schemaVersion: '1b',
      gitSha: 'bbb2222',
      rubricHashes: { analysis: 'hash-b' },
    })

    const result = comparer.compare(a, b)

    expect(result.metadataDiff).toBeDefined()
    expect(result.metadataDiff!.gitShaChanged).toBe(true)
    expect(result.metadataDiff!.rubricHashesChanged).toBe(true)
  })

  it('handles missing metadata on both sides', () => {
    const a = makeReport('run-a', [{ phase: 'analysis', score: 0.80 }])
    const b = makeReport('run-b', [{ phase: 'analysis', score: 0.80 }])

    const result = comparer.compare(a, b)
    expect(result.metadataDiff).toBeUndefined()
  })

  it('compares multiple phases correctly', () => {
    const a = makeReport('run-a', [
      { phase: 'analysis', score: 0.80 },
      { phase: 'planning', score: 0.90 },
      { phase: 'implementation', score: 0.70 },
    ])
    const b = makeReport('run-b', [
      { phase: 'analysis', score: 0.82 },
      { phase: 'planning', score: 0.75 },
      { phase: 'implementation', score: 0.72 },
    ])

    const result = comparer.compare(a, b)

    expect(result.phases).toHaveLength(3)
    expect(result.phases.find((p) => p.phase === 'analysis')!.verdict).toBe('Unchanged')
    expect(result.phases.find((p) => p.phase === 'planning')!.verdict).toBe('REGRESSION')
    expect(result.phases.find((p) => p.phase === 'implementation')!.verdict).toBe('Unchanged')
    expect(result.hasRegression).toBe(true)
  })
})
