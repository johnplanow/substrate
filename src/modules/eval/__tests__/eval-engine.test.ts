// src/modules/eval/__tests__/eval-engine.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EvalEngine, resolveThreshold } from '../eval-engine.js'
import type { EvalAdapter } from '../adapter.js'
import type { LayerResult, EvalPhase, ThresholdConfig } from '../types.js'
import type { Rubric } from '../layers/rubric-scorer.js'
import type { PhaseData } from '../eval-engine.js'

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

describe('EvalEngine deep tier', () => {
  function mockAdapterDeep(results: Record<string, LayerResult>): EvalAdapter {
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

  it('applies rubric weights to compute weighted score', async () => {
    const adapter = mockAdapterDeep({
      'rubric': {
        layer: 'rubric',
        score: 0.75, // simple mean of 0.9 and 0.6 — should be overwritten
        pass: true,
        assertions: [
          { name: 'rubric:a', score: 0.9, pass: true, reason: 'good' },
          { name: 'rubric:b', score: 0.6, pass: true, reason: 'ok' },
        ],
      },
    })

    const engine = new EvalEngine(adapter)

    const phases: PhaseData[] = [
      {
        phase: 'analysis',
        output: 'output',
        promptTemplate: '', // skip prompt compliance by having empty template
        context: {},
        rubric: {
          dimensions: [
            { name: 'a', weight: 0.8, prompt: 'check a' },
            { name: 'b', weight: 0.2, prompt: 'check b' },
          ],
        },
      },
    ]

    const report = await engine.evaluate(phases, 'deep', 'run-003')

    // Weighted score: 0.8 * 0.9 + 0.2 * 0.6 = 0.72 + 0.12 = 0.84
    // NOT the simple mean of 0.75 that came from the adapter
    const rubricLayer = report.phases[0].layers.find((l) => l.layer === 'rubric')
    expect(rubricLayer).toBeDefined()
    expect(rubricLayer!.score).toBeCloseTo(0.84, 2)
  })

  it('applies layer weights when aggregating phase score (G5)', async () => {
    // Layers present on analysis in this setup:
    //   prompt-compliance → 1.0 (weight 0.3)
    //   golden-comparison → 0.0 (weight 0.2)
    //   rubric            → 1.0 (weight 0.4)
    //
    // Unweighted mean:     (1.0 + 0.0 + 1.0) / 3          = 0.6667 → fails 0.7
    // Weighted aggregate:  (0.3·1.0 + 0.2·0.0 + 0.4·1.0) / (0.3+0.2+0.4)
    //                    = 0.70 / 0.9 ≈ 0.7778 → passes 0.7
    //
    // The high-weight rubric and prompt-compliance layers should pull the
    // phase above threshold despite the zero golden score. Under the old
    // unweighted mean, the phase would fail.
    const adapter = mockAdapterDeep({
      'prompt-compliance': {
        layer: 'prompt-compliance',
        score: 1.0,
        pass: true,
        assertions: [{ name: 'compliance', score: 1.0, pass: true, reason: 'good' }],
      },
      'golden-comparison': {
        layer: 'golden-comparison',
        score: 0.0,
        pass: false,
        assertions: [{ name: 'golden:coverage', score: 0.0, pass: false, reason: 'divergent' }],
      },
      'rubric': {
        layer: 'rubric',
        score: 1.0,
        pass: true,
        assertions: [{ name: 'rubric:problem_clarity', score: 1.0, pass: true, reason: 'clear' }],
      },
    })

    const engine = new EvalEngine(adapter)

    const phases: PhaseData[] = [
      {
        phase: 'analysis',
        output: 'analysis output',
        promptTemplate: '## Mission\nAnalyze.',
        context: {},
        goldenExample: 'golden analysis output',
        rubric: {
          dimensions: [
            { name: 'problem_clarity', weight: 1.0, prompt: 'Is the problem clear?' },
          ],
        },
      },
    ]

    const report = await engine.evaluate(phases, 'deep', 'run-g5')

    expect(report.phases[0].layers).toHaveLength(3)
    expect(report.phases[0].score).toBeCloseTo(0.7778, 3)
    expect(report.phases[0].pass).toBe(true)
  })

  it('runs golden comparison and cross-phase analysis in deep mode', async () => {
    const adapter = mockAdapterDeep({
      'prompt-compliance': {
        layer: 'prompt-compliance',
        score: 0.85,
        pass: true,
        assertions: [{ name: 'test', score: 0.85, pass: true, reason: 'good' }],
      },
      'golden-comparison': {
        layer: 'golden-comparison',
        score: 0.78,
        pass: true,
        assertions: [{ name: 'golden-comparison', score: 0.78, pass: true, reason: 'close to reference' }],
      },
      'cross-phase-coherence': {
        layer: 'cross-phase-coherence',
        score: 0.92,
        pass: true,
        assertions: [{ name: 'cross-phase-coherence', score: 0.92, pass: true, reason: 'good coherence' }],
      },
      'rubric': {
        layer: 'rubric',
        score: 0.80,
        pass: true,
        assertions: [{ name: 'rubric:problem_clarity', score: 0.80, pass: true, reason: 'clear' }],
      },
    })

    const engine = new EvalEngine(adapter)

    const phases: PhaseData[] = [
      {
        phase: 'analysis',
        output: 'analysis output',
        promptTemplate: '## Mission\nAnalyze.',
        context: {},
        goldenExample: 'golden analysis output',
        rubric: {
          dimensions: [{ name: 'problem_clarity', weight: 1.0, prompt: 'Is the problem clear?' }],
        },
      },
      {
        phase: 'planning',
        output: 'planning output',
        promptTemplate: '## Mission\nPlan.',
        context: {},
        upstreamOutput: 'analysis output',
        upstreamPhase: 'analysis',
      },
    ]

    const report = await engine.evaluate(phases, 'deep', 'run-002')

    expect(report.depth).toBe('deep')
    // Analysis should have: prompt-compliance + golden-comparison + rubric = 3 layers
    expect(report.phases[0].layers.length).toBeGreaterThanOrEqual(2)
    // Planning should have: prompt-compliance + cross-phase = 2 layers
    expect(report.phases[1].layers.length).toBeGreaterThanOrEqual(2)
  })
})

describe('resolveThreshold (V1b-3)', () => {
  it('returns per-phase threshold when configured', () => {
    const config: ThresholdConfig = {
      default: 0.7,
      phases: { implementation: 0.60 },
    }
    expect(resolveThreshold('implementation', config)).toBe(0.60)
  })

  it('returns config default for phases not listed', () => {
    const config: ThresholdConfig = {
      default: 0.75,
      phases: { implementation: 0.60 },
    }
    expect(resolveThreshold('analysis', config)).toBe(0.75)
  })

  it('returns DEFAULT_PASS_THRESHOLD when no config', () => {
    expect(resolveThreshold('analysis')).toBe(0.7)
    expect(resolveThreshold('analysis', undefined)).toBe(0.7)
  })

  it('returns config default when phases map is undefined', () => {
    const config: ThresholdConfig = { default: 0.65 }
    expect(resolveThreshold('planning', config)).toBe(0.65)
  })
})

describe('EvalEngine with thresholds (V1b-3)', () => {
  it('uses per-phase threshold for pass determination', async () => {
    // Score 0.65 — fails default 0.70 but passes impl threshold 0.60
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName,
        score: 0.65,
        pass: true,
        assertions: [{ name: 'test', score: 0.65, pass: true, reason: 'ok' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const result = await engine.evaluatePhase(
      {
        phase: 'implementation',
        output: 'impl output',
        promptTemplate: '## Mission\nImplement.',
        context: {},
      },
      'standard',
      { default: 0.7, phases: { implementation: 0.60 } },
    )

    expect(result.score).toBeCloseTo(0.65, 2)
    expect(result.pass).toBe(true)
  })

  it('fails phase when score is below per-phase threshold', async () => {
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName,
        score: 0.55,
        pass: true,
        assertions: [{ name: 'test', score: 0.55, pass: true, reason: 'weak' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const result = await engine.evaluatePhase(
      {
        phase: 'implementation',
        output: 'impl output',
        promptTemplate: '## Mission\nImplement.',
        context: {},
      },
      'standard',
      { default: 0.7, phases: { implementation: 0.60 } },
    )

    expect(result.score).toBeCloseTo(0.55, 2)
    expect(result.pass).toBe(false)
  })

  it('standard tier runs cross-phase-coherence-standard with upstream (V1b-4)', async () => {
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName,
        score: 0.80,
        pass: true,
        assertions: [{ name: 'test', score: 0.80, pass: true, reason: 'ok' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const result = await engine.evaluatePhase(
      {
        phase: 'planning',
        output: 'planning output',
        promptTemplate: '## Mission\nPlan.',
        context: {},
        upstreamOutput: 'analysis output',
        upstreamPhase: 'analysis',
      },
      'standard',
    )

    // Should have prompt-compliance + cross-phase-coherence-standard
    const layerNames = result.layers.map((l) => l.layer)
    expect(layerNames).toContain('prompt-compliance')
    expect(layerNames).toContain('cross-phase-coherence-standard')
    // Should NOT have the deep-tier layer name
    expect(layerNames).not.toContain('cross-phase-coherence')
  })

  it('deep tier runs cross-phase-coherence (not standard) with upstream (V1b-4)', async () => {
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName,
        score: 0.80,
        pass: true,
        assertions: [{ name: 'test', score: 0.80, pass: true, reason: 'ok' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const result = await engine.evaluatePhase(
      {
        phase: 'planning',
        output: 'planning output',
        promptTemplate: '## Mission\nPlan.',
        context: {},
        upstreamOutput: 'analysis output',
        upstreamPhase: 'analysis',
      },
      'deep',
    )

    const layerNames = result.layers.map((l) => l.layer)
    expect(layerNames).toContain('cross-phase-coherence')
    expect(layerNames).not.toContain('cross-phase-coherence-standard')
  })

  it('passes thresholds through evaluate() to all phases', async () => {
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName,
        score: 0.65,
        pass: true,
        assertions: [{ name: 'test', score: 0.65, pass: true, reason: 'ok' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const report = await engine.evaluate(
      [
        { phase: 'analysis', output: 'out', promptTemplate: '## M', context: {} },
        { phase: 'implementation', output: 'out', promptTemplate: '## M', context: {} },
      ],
      'standard',
      'run-v1b3',
      { default: 0.7, phases: { implementation: 0.60 } },
    )

    // Analysis at 0.65 fails default 0.70
    expect(report.phases[0].pass).toBe(false)
    // Implementation at 0.65 passes custom 0.60
    expect(report.phases[1].pass).toBe(true)
    // Overall: one phase failed
    expect(report.pass).toBe(false)
  })
})
