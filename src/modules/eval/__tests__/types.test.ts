import { describe, it, expect } from 'vitest'
import type {
  EvalDepth,
  EvalPhase,
  ReportFormat,
  EvalOptions,
  EvalAssertion,
  AssertionResult,
  LayerResult,
  PhaseEvalResult,
  EvalReport,
  EvalMetadata,
} from '../types.js'

describe('eval types', () => {
  it('EvalOptions accepts valid standard config', () => {
    const opts: EvalOptions = {
      depth: 'standard',
      report: 'table',
      projectRoot: '/tmp/test',
    }
    expect(opts.depth).toBe('standard')
    expect(opts.report).toBe('table')
  })

  it('EvalOptions accepts deep config with all optionals', () => {
    const opts: EvalOptions = {
      depth: 'deep',
      phases: ['analysis', 'planning'],
      runId: 'abc-123',
      concept: 'cli-task-tracker',
      report: 'json',
      projectRoot: '/tmp/test',
    }
    expect(opts.phases).toEqual(['analysis', 'planning'])
    expect(opts.concept).toBe('cli-task-tracker')
  })

  it('LayerResult has correct structure', () => {
    const result: LayerResult = {
      layer: 'prompt-compliance',
      score: 0.85,
      pass: true,
      assertions: [
        {
          name: 'follows-instructions',
          score: 0.85,
          pass: true,
          reason: 'Output follows all prompt instructions',
        },
      ],
    }
    expect(result.layer).toBe('prompt-compliance')
    expect(result.assertions).toHaveLength(1)
  })

  it('PhaseEvalResult includes feedback for retry prompts', () => {
    const result: PhaseEvalResult = {
      phase: 'analysis',
      score: 0.72,
      pass: true,
      layers: [],
      issues: ['target_users lacks specificity'],
      feedback: 'The output scored low on user specificity (0.65). Target users should be concrete segments, not generic personas.',
    }
    expect(result.feedback).toContain('user specificity')
  })

  it('EvalReport rolls up phase results', () => {
    const report: EvalReport = {
      runId: 'run-001',
      depth: 'standard',
      timestamp: '2026-04-09T00:00:00Z',
      phases: [],
      overallScore: 0.82,
      pass: true,
    }
    expect(report.depth).toBe('standard')
    expect(report.pass).toBe(true)
  })

  it('EvalReport accepts metadata (V1b-1)', () => {
    const report: EvalReport = {
      runId: 'run-002',
      depth: 'deep',
      timestamp: '2026-04-12T00:00:00Z',
      phases: [],
      overallScore: 0.88,
      pass: true,
      metadata: {
        schemaVersion: '1b',
        gitSha: 'abc1234',
        rubricHashes: { analysis: 'deadbeef' },
      },
    }
    expect(report.metadata?.schemaVersion).toBe('1b')
    expect(report.metadata?.gitSha).toBe('abc1234')
    expect(report.metadata?.rubricHashes?.analysis).toBe('deadbeef')
  })

  it('EvalReport metadata is optional — V1a backward compat (V1b-1)', () => {
    const report: EvalReport = {
      runId: 'run-001',
      depth: 'standard',
      timestamp: '2026-04-09T00:00:00Z',
      phases: [],
      overallScore: 0.82,
      pass: true,
    }
    expect(report.metadata).toBeUndefined()
  })

  it('EvalMetadata schemaVersion is the literal 1b (V1b-1)', () => {
    const meta: EvalMetadata = {
      schemaVersion: '1b',
    }
    expect(meta.schemaVersion).toBe('1b')
    expect(meta.gitSha).toBeUndefined()
    expect(meta.judgeModel).toBeUndefined()
    expect(meta.rubricHashes).toBeUndefined()
  })
})
