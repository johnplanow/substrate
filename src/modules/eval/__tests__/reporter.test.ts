// src/modules/eval/__tests__/reporter.test.ts
import { describe, it, expect } from 'vitest'
import { EvalReporter } from '../reporter.js'
import type { EvalReport } from '../types.js'
import type { CompareReport } from '../comparer.js'

const sampleReport: EvalReport = {
  runId: 'run-001',
  depth: 'standard',
  timestamp: '2026-04-09T12:00:00Z',
  phases: [
    {
      phase: 'analysis',
      score: 0.82,
      pass: true,
      layers: [
        {
          layer: 'prompt-compliance',
          score: 0.82,
          pass: true,
          assertions: [
            { name: 'instruction-compliance', score: 0.85, pass: true, reason: 'Good compliance' },
            { name: 'context-awareness', score: 0.79, pass: true, reason: 'Uses context' },
          ],
        },
      ],
      issues: [],
      feedback: '',
    },
    {
      phase: 'implementation',
      score: 0.68,
      pass: false,
      layers: [
        {
          layer: 'prompt-compliance',
          score: 0.75,
          pass: true,
          assertions: [{ name: 'instruction-compliance', score: 0.75, pass: true, reason: 'OK' }],
        },
        {
          layer: 'impl-verifier',
          score: 0.6,
          pass: false,
          assertions: [
            { name: 'compile-check', score: 0.0, pass: false, reason: 'Compilation failed' },
            { name: 'acceptance-criteria', score: 0.8, pass: true, reason: 'Criteria met' },
          ],
        },
      ],
      issues: ['Compilation failed'],
      feedback: 'compile-check scored 0',
    },
  ],
  overallScore: 0.75,
  pass: false,
}

describe('EvalReporter', () => {
  const reporter = new EvalReporter()

  it('formats as table with phase scores and issues', () => {
    const output = reporter.format(sampleReport, 'table')
    expect(output).toContain('analysis')
    expect(output).toContain('0.82')
    expect(output).toContain('implementation')
    expect(output).toContain('FAIL')
    expect(output).toContain('Compilation failed')
  })

  it('formats as json with full detail', () => {
    const output = reporter.format(sampleReport, 'json')
    const parsed = JSON.parse(output)
    expect(parsed.runId).toBe('run-001')
    expect(parsed.phases).toHaveLength(2)
    expect(parsed.pass).toBe(false)
  })

  it('formats as markdown', () => {
    const output = reporter.format(sampleReport, 'markdown')
    expect(output).toContain('# Eval Report')
    expect(output).toContain('run-001')
    expect(output).toContain('| analysis')
  })

  it('table shows per-phase threshold when thresholds provided (V1b-3)', () => {
    const output = reporter.format(sampleReport, 'table', {
      thresholds: {
        default: 0.7,
        phases: { implementation: 0.60 },
      },
    })
    // Header should contain Thresh column
    expect(output).toContain('Thresh')
    // Implementation row should show 0.60
    expect(output).toContain('0.60')
    // Analysis row should show the default 0.70
    const lines = output.split('\n')
    const analysisLine = lines.find((l) => l.startsWith('analysis'))
    expect(analysisLine).toContain('0.70')
  })

  it('table shows default threshold (0.70) when no thresholds provided (V1b-3)', () => {
    const output = reporter.format(sampleReport, 'table')
    expect(output).toContain('0.70')
    expect(output).toContain('default threshold: 0.70')
  })

  it('markdown shows threshold column when thresholds provided (V1b-3)', () => {
    const output = reporter.format(sampleReport, 'markdown', {
      thresholds: {
        default: 0.7,
        phases: { implementation: 0.60 },
      },
    })
    expect(output).toContain('| Threshold |')
    expect(output).toContain('| 0.60 |')
  })
})

describe('EvalReporter — comparison (V1b-5)', () => {
  const reporter = new EvalReporter()

  const sampleCompare: CompareReport = {
    runIdA: 'run-a',
    runIdB: 'run-b',
    phases: [
      { phase: 'analysis', scoreA: 0.80, scoreB: 0.82, delta: 0.02, verdict: 'Unchanged' },
      { phase: 'planning', scoreA: 0.90, scoreB: 0.75, delta: -0.15, verdict: 'REGRESSION' },
    ],
    metadataDiff: { gitShaChanged: true, rubricHashesChanged: false, judgeModelChanged: false },
    hasRegression: true,
  }

  it('table comparison shows run IDs and phase deltas', () => {
    const output = reporter.formatComparison(sampleCompare, 'table')
    expect(output).toContain('run-a')
    expect(output).toContain('run-b')
    expect(output).toContain('REGRESSION')
    expect(output).toContain('Unchanged')
    expect(output).toContain('-0.15')
    expect(output).toContain('REGRESSION DETECTED')
  })

  it('json comparison is valid JSON with all fields', () => {
    const output = reporter.formatComparison(sampleCompare, 'json')
    const parsed = JSON.parse(output)
    expect(parsed.runIdA).toBe('run-a')
    expect(parsed.phases).toHaveLength(2)
    expect(parsed.hasRegression).toBe(true)
  })

  it('markdown comparison includes verdict column', () => {
    const output = reporter.formatComparison(sampleCompare, 'markdown')
    expect(output).toContain('# Eval Comparison')
    expect(output).toContain('| Verdict |')
    expect(output).toContain('REGRESSION')
  })

  it('table shows config warning when rubric hashes differ', () => {
    const report: CompareReport = {
      ...sampleCompare,
      metadataDiff: { gitShaChanged: false, rubricHashesChanged: true, judgeModelChanged: false },
    }
    const output = reporter.formatComparison(report, 'table')
    expect(output).toContain('WARNING')
    expect(output).toContain('configuration differs')
  })

  it('table shows no warning when only git SHA changed', () => {
    const report: CompareReport = {
      ...sampleCompare,
      metadataDiff: { gitShaChanged: true, rubricHashesChanged: false, judgeModelChanged: false },
    }
    const output = reporter.formatComparison(report, 'table')
    expect(output).not.toContain('WARNING')
  })
})
