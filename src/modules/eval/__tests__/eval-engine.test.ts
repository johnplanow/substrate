// src/modules/eval/__tests__/eval-engine.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EvalEngine } from '../eval-engine.js'
import type { EvalAdapter } from '../adapter.js'
import type { LayerResult, EvalPhase } from '../types.js'

function mockAdapter(results: Record<string, LayerResult>): EvalAdapter {
  return {
    runAssertions: vi.fn(async (_output, _assertions, layerName) => {
      return results[layerName] ?? {
        layer: layerName,
        score: 0,
        pass: false,
        assertions: [],
      }
    }),
  }
}

describe('EvalEngine', () => {
  it('runs standard tier for a single phase', async () => {
    const adapter = mockAdapter({
      'prompt-compliance': {
        layer: 'prompt-compliance',
        score: 0.85,
        pass: true,
        assertions: [{ name: 'test', score: 0.85, pass: true, reason: 'good' }],
      },
    })

    const engine = new EvalEngine(adapter)

    const phaseData = {
      phase: 'analysis' as EvalPhase,
      output: 'problem_statement: A task tracker for CLI users...',
      promptTemplate: '## Mission\nAnalyze the concept.',
      context: { concept: 'CLI task tracker' },
    }

    const result = await engine.evaluatePhase(phaseData, 'standard')

    expect(result.phase).toBe('analysis')
    expect(result.score).toBeCloseTo(0.85, 1)
    expect(result.pass).toBe(true)
    expect(result.layers).toHaveLength(1)
    expect(result.layers[0].layer).toBe('prompt-compliance')
  })

  it('aggregates multiple phase results into a report', async () => {
    const adapter = mockAdapter({
      'prompt-compliance': {
        layer: 'prompt-compliance',
        score: 0.9,
        pass: true,
        assertions: [{ name: 'test', score: 0.9, pass: true, reason: 'good' }],
      },
    })

    const engine = new EvalEngine(adapter)

    const phases = [
      {
        phase: 'analysis' as EvalPhase,
        output: 'analysis output',
        promptTemplate: '## Mission\nAnalyze.',
        context: {},
      },
      {
        phase: 'planning' as EvalPhase,
        output: 'planning output',
        promptTemplate: '## Mission\nPlan.',
        context: {},
      },
    ]

    const report = await engine.evaluate(phases, 'standard', 'run-001')

    expect(report.runId).toBe('run-001')
    expect(report.depth).toBe('standard')
    expect(report.phases).toHaveLength(2)
    expect(report.overallScore).toBeCloseTo(0.9, 1)
    expect(report.pass).toBe(true)
  })

  it('marks report as failed when any phase is below threshold', async () => {
    const adapter = mockAdapter({
      'prompt-compliance': {
        layer: 'prompt-compliance',
        score: 0.5,
        pass: false,
        assertions: [{ name: 'test', score: 0.5, pass: false, reason: 'poor' }],
      },
    })

    const engine = new EvalEngine(adapter)

    const phases = [
      {
        phase: 'analysis' as EvalPhase,
        output: 'weak output',
        promptTemplate: '## Mission\nAnalyze.',
        context: {},
      },
    ]

    const report = await engine.evaluate(phases, 'standard', 'run-001')

    expect(report.pass).toBe(false)
    expect(report.phases[0].pass).toBe(false)
  })
})
