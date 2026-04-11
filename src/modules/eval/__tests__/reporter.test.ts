// src/modules/eval/__tests__/reporter.test.ts
import { describe, it, expect } from 'vitest'
import { EvalReporter } from '../reporter.js'
import type { EvalReport } from '../types.js'

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
})
