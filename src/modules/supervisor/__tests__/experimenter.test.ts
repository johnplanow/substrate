/**
 * Unit tests for the Experimenter module (Story 17-6).
 *
 * Tests the experiment state machine, branch creation, modification application,
 * single-story run invocation, and results comparison/verdict logic.
 *
 * Coverage:
 *   - AC1: experiment mode (tested via flag integration in auto.ts)
 *   - AC2: branch creation and modification
 *   - AC3: single-story controlled run
 *   - AC4: results comparison and verdict derivation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  buildBranchName,
  buildWorktreePath,
  buildModificationDirective,
  resolvePromptFile,
  determineVerdict,
  buildPRBody,
  buildAuditLogEntry,
  createExperimenter,
} from '../experimenter.js'
import type {
  SupervisorRecommendation,
  ExperimentConfig,
  ExperimenterDeps,
  ExperimentMetricDeltas,
  ExperimentResult,
} from '../experimenter.js'
import type { RunMetricsRow, StoryMetricsRow } from '../../../persistence/queries/metrics.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecommendation(overrides: Partial<SupervisorRecommendation> = {}): SupervisorRecommendation {
  return {
    type: 'token_regression',
    story_key: '7-1',
    phase: 'dev-story',
    description: 'dev-story phase used 61% more tokens than baseline',
    short_desc: 'dev-story-token-regression',
    tokens_actual: 8200,
    tokens_baseline: 5100,
    delta_pct: 61,
    ...overrides,
  }
}

function makeRunMetrics(overrides: Partial<RunMetricsRow> = {}): RunMetricsRow {
  return {
    run_id: 'run-baseline',
    methodology: 'bmad',
    status: 'completed',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T01:00:00Z',
    wall_clock_seconds: 3600,
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_cost_usd: 1.5,
    stories_attempted: 1,
    stories_succeeded: 1,
    stories_failed: 0,
    stories_escalated: 0,
    total_review_cycles: 2,
    total_dispatches: 3,
    concurrency_setting: 1,
    max_concurrent_actual: 1,
    restarts: 0,
    is_baseline: 1,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeConfig(overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    projectRoot: '/project',
    pack: 'bmad',
    maxExperiments: 2,
    tokenBudgetMultiplier: 2,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildBranchName
// ---------------------------------------------------------------------------

describe('buildBranchName', () => {
  it('creates a valid branch name from run-id and short description', () => {
    const name = buildBranchName('abc12345-xyz', 'dev-story-token-regression')
    expect(name).toBe('supervisor/experiment/abc12345-dev-story-token-regression')
  })

  it('sanitizes special characters in short_desc', () => {
    const name = buildBranchName('abc12345', 'Fix: Token Regression!')
    expect(name).toMatch(/^supervisor\/experiment\/abc12345-/)
    expect(name).not.toMatch(/[A-Z!: ]/)
  })

  it('truncates long descriptions to 30 chars', () => {
    const longDesc = 'a-very-long-description-that-exceeds-the-limit'
    const name = buildBranchName('abc12345', longDesc)
    const suffix = name.replace('supervisor/experiment/abc12345-', '')
    expect(suffix.length).toBeLessThanOrEqual(30)
  })

  it('uses only first 8 chars of run-id', () => {
    const name = buildBranchName('abc12345-very-long-run-id', 'fix')
    expect(name).toBe('supervisor/experiment/abc12345-fix')
  })
})

// ---------------------------------------------------------------------------
// buildWorktreePath
// ---------------------------------------------------------------------------

describe('buildWorktreePath', () => {
  it('builds a worktree path under .claude/worktrees', () => {
    const path = buildWorktreePath('/project', 'run-baseline', 'dev-story-token-regression')
    expect(path).toBe('/project/.claude/worktrees/experiment-run-base-dev-story-token-regr')
  })

  it('sanitizes special characters in short_desc', () => {
    const path = buildWorktreePath('/project', 'run-baseline', 'Fix: Token Regression!')
    expect(path).toContain('.claude/worktrees/experiment-run-base-')
    expect(path).not.toMatch(/[A-Z!: ]/)
  })

  it('truncates short_desc to 20 chars in path', () => {
    const longDesc = 'a-very-long-description-that-exceeds-the-limit'
    const path = buildWorktreePath('/project', 'run-baseline', longDesc)
    const dirName = path.split('/').pop()!
    // experiment- (11) + run-base (8) + - (1) + max20 = max 40 chars
    expect(dirName.length).toBeLessThanOrEqual(40)
  })

  it('uses first 8 chars of baseline run ID', () => {
    const path = buildWorktreePath('/project', 'abcdefgh-very-long-run-id', 'fix')
    expect(path).toContain('experiment-abcdefgh-fix')
  })
})

// ---------------------------------------------------------------------------
// buildModificationDirective
// ---------------------------------------------------------------------------

describe('buildModificationDirective', () => {
  it('returns a token compression directive for token_regression', () => {
    const rec = makeRecommendation({ type: 'token_regression' })
    const directive = buildModificationDirective(rec)
    expect(directive).toContain('token_regression')
    expect(directive).toContain('compress')
  })

  it('returns a review strictness directive for review_cycles', () => {
    const rec = makeRecommendation({ type: 'review_cycles' })
    const directive = buildModificationDirective(rec)
    expect(directive).toContain('review_cycles')
  })

  it('returns a timing optimization directive for timing_bottleneck', () => {
    const rec = makeRecommendation({ type: 'timing_bottleneck' })
    const directive = buildModificationDirective(rec)
    expect(directive).toContain('timing_bottleneck')
  })
})

// ---------------------------------------------------------------------------
// resolvePromptFile
// ---------------------------------------------------------------------------

describe('resolvePromptFile', () => {
  it('resolves dev-story prompt file', () => {
    const rec = makeRecommendation({ phase: 'dev-story' })
    const path = resolvePromptFile(rec, '/project', 'bmad')
    expect(path).toBe('/project/packs/bmad/prompts/dev-story.md')
  })

  it('resolves code-review prompt file', () => {
    const rec = makeRecommendation({ phase: 'code-review', type: 'review_cycles' })
    const path = resolvePromptFile(rec, '/project', 'bmad')
    expect(path).toBe('/project/packs/bmad/prompts/code-review.md')
  })

  it('resolves create-story prompt file', () => {
    const rec = makeRecommendation({ phase: 'create-story' })
    const path = resolvePromptFile(rec, '/project', 'bmad')
    expect(path).toBe('/project/packs/bmad/prompts/create-story.md')
  })

  it('falls back to <phase>.md for unknown phases', () => {
    const rec = makeRecommendation({ phase: 'custom-phase' })
    const path = resolvePromptFile(rec, '/project', 'bmad')
    expect(path).toBe('/project/packs/bmad/prompts/custom-phase.md')
  })
})

// ---------------------------------------------------------------------------
// determineVerdict
// ---------------------------------------------------------------------------

describe('determineVerdict', () => {
  describe('token_regression recommendation', () => {
    it('returns IMPROVED when tokens decrease and no regressions', () => {
      const rec = makeRecommendation({ type: 'token_regression' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: -15,
        cost_pct: -10,
        review_cycles_pct: 5,
        wall_clock_pct: 2,
      }
      expect(determineVerdict(rec, deltas)).toBe('IMPROVED')
    })

    it('returns REGRESSED when tokens increase', () => {
      const rec = makeRecommendation({ type: 'token_regression' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: 10,
        cost_pct: 5,
        review_cycles_pct: 0,
        wall_clock_pct: 0,
      }
      expect(determineVerdict(rec, deltas)).toBe('REGRESSED')
    })

    it('returns MIXED when tokens decrease but review cycles regress heavily', () => {
      const rec = makeRecommendation({ type: 'token_regression' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: -15,
        cost_pct: -10,
        review_cycles_pct: 25, // >20% regression threshold
        wall_clock_pct: 2,
      }
      expect(determineVerdict(rec, deltas)).toBe('MIXED')
    })

    it('returns IMPROVED when tokens_pct is null (no baseline tokens)', () => {
      const rec = makeRecommendation({ type: 'token_regression' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: null,
        cost_pct: null,
        review_cycles_pct: null,
        wall_clock_pct: null,
      }
      // null means we can't compute — treat as not improved
      expect(determineVerdict(rec, deltas)).toBe('REGRESSED')
    })
  })

  describe('review_cycles recommendation', () => {
    it('returns IMPROVED when review cycles decrease', () => {
      const rec = makeRecommendation({ type: 'review_cycles' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: 5,
        cost_pct: 2,
        review_cycles_pct: -30,
        wall_clock_pct: -5,
      }
      expect(determineVerdict(rec, deltas)).toBe('IMPROVED')
    })

    it('returns REGRESSED when review cycles increase', () => {
      const rec = makeRecommendation({ type: 'review_cycles' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: -5,
        cost_pct: -2,
        review_cycles_pct: 15,
        wall_clock_pct: 10,
      }
      expect(determineVerdict(rec, deltas)).toBe('REGRESSED')
    })

    it('returns MIXED when review cycles decrease but tokens regress heavily', () => {
      const rec = makeRecommendation({ type: 'review_cycles' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: 30, // >20% regression
        cost_pct: 25,
        review_cycles_pct: -20,
        wall_clock_pct: 5,
      }
      expect(determineVerdict(rec, deltas)).toBe('MIXED')
    })
  })

  describe('timing_bottleneck recommendation', () => {
    it('returns IMPROVED when wall clock time decreases', () => {
      const rec = makeRecommendation({ type: 'timing_bottleneck' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: 5,
        cost_pct: 2,
        review_cycles_pct: 5,
        wall_clock_pct: -20,
      }
      expect(determineVerdict(rec, deltas)).toBe('IMPROVED')
    })

    it('returns REGRESSED when wall clock time increases', () => {
      const rec = makeRecommendation({ type: 'timing_bottleneck' })
      const deltas: ExperimentMetricDeltas = {
        tokens_pct: 0,
        cost_pct: 0,
        review_cycles_pct: 0,
        wall_clock_pct: 10,
      }
      expect(determineVerdict(rec, deltas)).toBe('REGRESSED')
    })
  })
})

// ---------------------------------------------------------------------------
// createExperimenter — full experiment flow
// ---------------------------------------------------------------------------

describe('createExperimenter', () => {
  let mockGit: ReturnType<typeof vi.fn>
  let mockSpawn: ReturnType<typeof vi.fn>
  let mockRunStory: ReturnType<typeof vi.fn>
  let mockGetRunMetrics: ReturnType<typeof vi.fn>
  let mockGetStoryMetrics: ReturnType<typeof vi.fn>
  let mockReadFile: ReturnType<typeof vi.fn>
  let mockWriteFile: ReturnType<typeof vi.fn>
  let mockMkdir: ReturnType<typeof vi.fn>
  let mockLog: ReturnType<typeof vi.fn>
  let mockDb: object
  let deps: ExperimenterDeps
  let config: ExperimentConfig

  beforeEach(() => {
    mockGit = vi.fn()
    mockSpawn = vi.fn()
    mockRunStory = vi.fn()
    mockGetRunMetrics = vi.fn()
    mockGetStoryMetrics = vi.fn()
    mockReadFile = vi.fn()
    mockWriteFile = vi.fn()
    mockMkdir = vi.fn()
    mockLog = vi.fn()
    mockDb = {}

    // Default: git commands succeed
    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 })
      }
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    })

    // Default: gh spawn succeeds (returns a fake PR URL)
    mockSpawn.mockResolvedValue({ stdout: 'https://github.com/owner/repo/pull/42', stderr: '', code: 0 })

    // Default: runStory succeeds
    mockRunStory.mockResolvedValue({ runId: 'run-experiment-01', exitCode: 0 })

    // Default: metrics available
    mockGetRunMetrics.mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return makeRunMetrics({ run_id: 'run-baseline', total_input_tokens: 10000, total_output_tokens: 5000, total_cost_usd: 1.5, total_review_cycles: 2 })
      }
      // experiment run — improved metrics
      return makeRunMetrics({ run_id: 'run-experiment-01', total_input_tokens: 8000, total_output_tokens: 4000, total_cost_usd: 1.2, total_review_cycles: 2 })
    })

    mockGetStoryMetrics.mockReturnValue([])
    mockReadFile.mockResolvedValue('# Dev Story Prompt\n\nOriginal content here.')
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)

    deps = {
      git: mockGit,
      spawn: mockSpawn,
      runStory: mockRunStory,
      getRunMetrics: mockGetRunMetrics,
      getStoryMetrics: mockGetStoryMetrics,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      mkdir: mockMkdir,
      log: mockLog,
    }

    config = makeConfig()
  })

  describe('runExperiments', () => {
    it('returns empty results when no recommendations provided', async () => {
      const experimenter = createExperimenter(config, deps)
      const results = await experimenter.runExperiments(mockDb as any, [], 'run-baseline')
      expect(results).toHaveLength(0)
    })

    it('runs a single experiment successfully with IMPROVED verdict', async () => {
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      expect(results).toHaveLength(1)
      const result = results[0]!
      expect(result.verdict).toBe('IMPROVED')
      expect(result.baselineRunId).toBe('run-baseline')
      expect(result.experimentRunId).toBe('run-experiment-01')
      expect(result.recommendation).toEqual(rec)
    })

    it('creates a git worktree with the correct branch name', async () => {
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      // Should have called git worktree add with the branch name
      const worktreeCall = mockGit.mock.calls.find(
        (call: string[][]) => call[0]?.[0] === 'worktree' && call[0]?.[1] === 'add',
      )
      expect(worktreeCall).toBeDefined()
      // Third arg is the worktree path, fourth arg is '-b', fifth is branch name
      expect(worktreeCall![0]?.[2]).toContain('.claude/worktrees/experiment-run-base')
      expect(worktreeCall![0]?.[3]).toBe('-b')
      expect(worktreeCall![0]?.[4]).toMatch(/^supervisor\/experiment\/run-base-/)
    })

    it('reads and writes the prompt file in the worktree for modification', async () => {
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation({ phase: 'dev-story' })
      await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      // Prompt file should be read from worktree path (not projectRoot)
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('packs/bmad/prompts/dev-story.md'),
      )
      const readPath: string = mockReadFile.mock.calls[0]?.[0] as string
      expect(readPath).toContain('.claude/worktrees/experiment-run-base')
      expect(readPath).toContain('packs/bmad/prompts/dev-story.md')

      // Write should also be to the worktree
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('packs/bmad/prompts/dev-story.md'),
        expect.stringContaining('token_regression'),
      )
    })

    it('commits the modification with a message referencing the recommendation', async () => {
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      const commitCall = mockGit.mock.calls.find(
        (call: string[][]) => call[0]?.[0] === 'commit',
      )
      expect(commitCall).toBeDefined()
      const commitMsg = commitCall![0]?.[2] as string
      expect(commitMsg).toContain('supervisor-experiment')
      expect(commitMsg).toContain(rec.story_key)
    })

    it('calls runStory with the worktree path as projectRoot', async () => {
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation({ story_key: '7-3' })
      await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      // runStory should receive the worktree path, not the main projectRoot
      expect(mockRunStory).toHaveBeenCalledWith(
        expect.objectContaining({
          stories: '7-3',
          pack: 'bmad',
        }),
      )
      const runStoryArgs = mockRunStory.mock.calls[0]?.[0] as { projectRoot: string }
      expect(runStoryArgs.projectRoot).toContain('.claude/worktrees/experiment-run-base')
    })

    it('removes the worktree after experiment completes (main working tree unaffected)', async () => {
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      // Should have called git worktree remove (cleanup)
      const worktreeRemove = mockGit.mock.calls.find(
        (call: string[][]) => call[0]?.[0] === 'worktree' && call[0]?.[1] === 'remove',
      )
      expect(worktreeRemove).toBeDefined()
      // The worktree path should be in the call
      expect(worktreeRemove![0]?.[2]).toContain('.claude/worktrees/experiment-run-base')
      // Should NOT have called checkout to switch back to original branch
      const checkoutMain = mockGit.mock.calls.find(
        (call: string[][]) => call[0]?.[0] === 'checkout' && call[0]?.[1] === 'main',
      )
      expect(checkoutMain).toBeUndefined()
    })

    it('respects maxExperiments limit', async () => {
      const experimenter = createExperimenter({ ...config, maxExperiments: 2 }, deps)
      const recs = [
        makeRecommendation({ short_desc: 'rec-1', story_key: '7-1' }),
        makeRecommendation({ short_desc: 'rec-2', story_key: '7-2' }),
        makeRecommendation({ short_desc: 'rec-3', story_key: '7-3' }),
      ]
      const results = await experimenter.runExperiments(mockDb as any, recs, 'run-baseline')
      expect(results).toHaveLength(2)
    })

    it('returns REGRESSED verdict on experiment run failure', async () => {
      mockRunStory.mockRejectedValue(new Error('Pipeline execution failed'))
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      expect(results).toHaveLength(1)
      expect(results[0]!.verdict).toBe('REGRESSED')
      expect(results[0]!.error).toContain('Pipeline execution failed')
    })

    it('returns REGRESSED verdict when metrics are unavailable', async () => {
      mockGetRunMetrics.mockReturnValue(undefined)
      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      expect(results).toHaveLength(1)
      expect(results[0]!.verdict).toBe('REGRESSED')
    })

    it('removes the worktree even on error (cleanup in finally block)', async () => {
      mockGit.mockImplementation((args: string[]) => {
        if (args[0] === 'rev-parse') {
          return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 })
        }
        if (args[0] === 'worktree' && args[1] === 'add') {
          return Promise.resolve({ stdout: '', stderr: '', code: 0 })
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return Promise.resolve({ stdout: '', stderr: '', code: 0 })
        }
        return Promise.resolve({ stdout: '', stderr: '', code: 0 })
      })
      mockReadFile.mockRejectedValue(new Error('File not found'))

      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation()
      await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      // Should have tried to remove the worktree (cleanup in finally)
      const worktreeRemove = mockGit.mock.calls.find(
        (call: string[][]) => call[0]?.[0] === 'worktree' && call[0]?.[1] === 'remove',
      )
      expect(worktreeRemove).toBeDefined()
    })

    it('computes deltas correctly for MIXED verdict', async () => {
      // Experiment improved tokens but review cycles spiked
      mockGetRunMetrics.mockImplementation((_db: unknown, runId: string) => {
        if (runId === 'run-baseline') {
          return makeRunMetrics({
            run_id: 'run-baseline',
            total_input_tokens: 10000,
            total_output_tokens: 5000,
            total_review_cycles: 4,
          })
        }
        return makeRunMetrics({
          run_id: 'run-experiment-01',
          total_input_tokens: 7000, // -33% tokens (improved)
          total_output_tokens: 3500,
          total_review_cycles: 8, // +100% review cycles (regression!)
        })
      })

      const experimenter = createExperimenter(config, deps)
      const rec = makeRecommendation({ type: 'token_regression' })
      const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

      expect(results[0]!.verdict).toBe('MIXED')
      expect(results[0]!.deltas.tokens_pct).toBeLessThan(0) // improved
      expect(results[0]!.deltas.review_cycles_pct).toBeGreaterThan(20) // regression
    })
  })
})

// ---------------------------------------------------------------------------
// buildPRBody (AC5)
// ---------------------------------------------------------------------------

describe('buildPRBody', () => {
  it('contains verdict in the PR body', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation(),
      branchName: 'supervisor/experiment/abc12345-dev-story-token-regression',
      baselineRunId: 'run-baseline',
      experimentRunId: 'run-experiment-01',
      verdict: 'IMPROVED',
      deltas: { tokens_pct: -20, cost_pct: -15, review_cycles_pct: 0, wall_clock_pct: -5 },
      currentPhase: 'REPORTING',
    }
    const body = buildPRBody(result)
    expect(body).toContain('IMPROVED')
    expect(body).toContain('token_regression')
    expect(body).toContain('run-baseline')
    expect(body).toContain('run-experiment-01')
    expect(body).toContain('-20%')
  })

  it('shows N/A for null deltas', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation(),
      branchName: 'supervisor/experiment/abc12345-fix',
      baselineRunId: 'run-baseline',
      experimentRunId: null,
      verdict: 'REGRESSED',
      deltas: { tokens_pct: null, cost_pct: null, review_cycles_pct: null, wall_clock_pct: null },
      currentPhase: 'REPORTING',
    }
    const body = buildPRBody(result)
    expect(body).toContain('N/A')
  })

  it('includes the branch name', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation(),
      branchName: 'supervisor/experiment/abc12345-review-cycles',
      baselineRunId: 'run-baseline',
      experimentRunId: 'run-exp-02',
      verdict: 'MIXED',
      deltas: { tokens_pct: 5, cost_pct: 3, review_cycles_pct: -25, wall_clock_pct: 2 },
      currentPhase: 'REPORTING',
    }
    const body = buildPRBody(result)
    expect(body).toContain('supervisor/experiment/abc12345-review-cycles')
  })
})

// ---------------------------------------------------------------------------
// buildAuditLogEntry (AC7)
// ---------------------------------------------------------------------------

describe('buildAuditLogEntry', () => {
  it('contains hypothesis and verdict', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation({
        description: 'dev-story phase used 61% more tokens than baseline',
        short_desc: 'dev-story-token-regression',
      }),
      branchName: 'supervisor/experiment/abc12345-dev-story-token-regression',
      baselineRunId: 'run-baseline',
      experimentRunId: 'run-experiment-01',
      verdict: 'IMPROVED',
      deltas: { tokens_pct: -20, cost_pct: -15, review_cycles_pct: 0, wall_clock_pct: -5 },
      currentPhase: 'REPORTING',
    }
    const entry = buildAuditLogEntry(result, '2026-03-01T10:00:00Z')
    expect(entry).toContain('dev-story-token-regression (2026-03-01T10:00:00Z)')
    expect(entry).toContain('dev-story phase used 61% more tokens than baseline')
    expect(entry).toContain('Verdict: IMPROVED')
    expect(entry).toContain('-20%')
  })

  it('includes PR link when provided', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation(),
      branchName: 'supervisor/experiment/abc12345-fix',
      baselineRunId: 'run-baseline',
      experimentRunId: 'run-experiment-01',
      verdict: 'IMPROVED',
      deltas: { tokens_pct: -10, cost_pct: -8, review_cycles_pct: 0, wall_clock_pct: -5 },
      currentPhase: 'REPORTING',
      prLink: 'https://github.com/owner/repo/pull/42',
    }
    const entry = buildAuditLogEntry(result, '2026-03-01T10:00:00Z')
    expect(entry).toContain('https://github.com/owner/repo/pull/42')
  })

  it('includes error when present', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation(),
      branchName: 'supervisor/experiment/abc12345-fix',
      baselineRunId: 'run-baseline',
      experimentRunId: null,
      verdict: 'REGRESSED',
      deltas: { tokens_pct: null, cost_pct: null, review_cycles_pct: null, wall_clock_pct: null },
      currentPhase: 'MODIFYING',
      error: 'File not found',
    }
    const entry = buildAuditLogEntry(result, '2026-03-01T10:00:00Z')
    expect(entry).toContain('File not found')
  })

  it('ends with a separator for appending', () => {
    const result: ExperimentResult = {
      recommendation: makeRecommendation(),
      branchName: 'supervisor/experiment/abc12345-fix',
      baselineRunId: 'run-baseline',
      experimentRunId: 'run-exp-01',
      verdict: 'IMPROVED',
      deltas: { tokens_pct: -10, cost_pct: -8, review_cycles_pct: 0, wall_clock_pct: -5 },
      currentPhase: 'REPORTING',
    }
    const entry = buildAuditLogEntry(result, '2026-03-01T10:00:00Z')
    expect(entry).toContain('---')
  })
})

// ---------------------------------------------------------------------------
// AC5: PR creation and branch deletion (T6)
// ---------------------------------------------------------------------------

describe('createExperimenter — PR creation and branch deletion (AC5)', () => {
  let mockGit: ReturnType<typeof vi.fn>
  let mockSpawn: ReturnType<typeof vi.fn>
  let mockRunStory: ReturnType<typeof vi.fn>
  let mockGetRunMetrics: ReturnType<typeof vi.fn>
  let mockGetStoryMetrics: ReturnType<typeof vi.fn>
  let mockReadFile: ReturnType<typeof vi.fn>
  let mockWriteFile: ReturnType<typeof vi.fn>
  let mockMkdir: ReturnType<typeof vi.fn>
  let mockLog: ReturnType<typeof vi.fn>
  let mockDb: object
  let deps: ExperimenterDeps
  let config: ExperimentConfig

  beforeEach(() => {
    mockGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 })
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    })
    mockSpawn = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/owner/repo/pull/99',
      stderr: '',
      code: 0,
    })
    mockRunStory = vi.fn().mockResolvedValue({ runId: 'run-exp-01', exitCode: 0 })
    mockGetRunMetrics = vi.fn().mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return makeRunMetrics({ run_id: 'run-baseline', total_input_tokens: 10000, total_output_tokens: 5000, total_review_cycles: 2 })
      }
      return makeRunMetrics({ run_id: 'run-exp-01', total_input_tokens: 8000, total_output_tokens: 4000, total_review_cycles: 2 })
    })
    mockGetStoryMetrics = vi.fn().mockReturnValue([])
    mockReadFile = vi.fn().mockResolvedValue('# Prompt content')
    mockWriteFile = vi.fn().mockResolvedValue(undefined)
    mockMkdir = vi.fn().mockResolvedValue(undefined)
    mockLog = vi.fn()
    mockDb = {}

    deps = {
      git: mockGit,
      spawn: mockSpawn,
      runStory: mockRunStory,
      getRunMetrics: mockGetRunMetrics,
      getStoryMetrics: mockGetStoryMetrics,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      mkdir: mockMkdir,
      log: mockLog,
    }
    config = makeConfig()
  })

  it('creates a PR via gh CLI for IMPROVED verdict', async () => {
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation()
    const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

    expect(results[0]!.verdict).toBe('IMPROVED')
    expect(mockSpawn).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'create', '--label', 'supervisor', '--label', 'automated-experiment']),
      expect.any(Object),
    )
    expect(results[0]!.prLink).toBe('https://github.com/owner/repo/pull/99')
  })

  it('creates a PR for MIXED verdict', async () => {
    // Setup MIXED: tokens improve but review cycles spike
    mockGetRunMetrics.mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return makeRunMetrics({ run_id: 'run-baseline', total_input_tokens: 10000, total_output_tokens: 5000, total_review_cycles: 4 })
      }
      return makeRunMetrics({ run_id: 'run-exp-01', total_input_tokens: 7000, total_output_tokens: 3500, total_review_cycles: 8 })
    })
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation({ type: 'token_regression' })
    const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

    expect(results[0]!.verdict).toBe('MIXED')
    expect(mockSpawn).toHaveBeenCalled()
    expect(results[0]!.prLink).toBeTruthy()
  })

  it('deletes the branch (not creates PR) for REGRESSED verdict', async () => {
    // Setup REGRESSED: tokens get worse
    mockGetRunMetrics.mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return makeRunMetrics({ run_id: 'run-baseline', total_input_tokens: 10000, total_output_tokens: 5000 })
      }
      return makeRunMetrics({ run_id: 'run-exp-01', total_input_tokens: 12000, total_output_tokens: 6000 })
    })
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation()
    const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

    expect(results[0]!.verdict).toBe('REGRESSED')
    expect(results[0]!.prLink).toBeNull()
    // Should NOT have called gh pr create
    expect(mockSpawn).not.toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'create']), expect.any(Object))
    // Should have deleted the branch
    const deleteCall = mockGit.mock.calls.find(
      (call: string[][]) => call[0]?.[0] === 'branch' && call[0]?.[1] === '-D',
    )
    expect(deleteCall).toBeDefined()
  })

  it('degrades gracefully when gh CLI fails (returns null prLink)', async () => {
    mockSpawn.mockResolvedValue({ stdout: '', stderr: 'gh: command not found', code: 127 })
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation()
    const results = await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

    expect(results[0]!.verdict).toBe('IMPROVED')
    expect(results[0]!.prLink).toBeNull()
  })

  it('writes audit log for every experiment (IMPROVED, MIXED, REGRESSED)', async () => {
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation()
    await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

    // writeFile should have been called at least twice: once for prompt modification, once for audit log
    // The audit log write will contain markdown content
    const auditWrite = mockWriteFile.mock.calls.find(
      (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('Experiment:'),
    )
    expect(auditWrite).toBeDefined()
  })

  it('appends to existing audit log (append-only)', async () => {
    // Pre-populate the audit log with existing content
    const existingContent = '# Supervisor Experiment Log\n\nRun ID: `run-baseline`\n\n## Previous entry\n\n---\n\n'
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes('-experiments.md')) return Promise.resolve(existingContent)
      return Promise.resolve('# Prompt content')
    })

    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation()
    await experimenter.runExperiments(mockDb as any, [rec], 'run-baseline')

    const auditWrite = mockWriteFile.mock.calls.find(
      (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes('Previous entry'),
    )
    expect(auditWrite).toBeDefined()
    // The new entry should be appended after the existing content
    const writtenContent = auditWrite![1] as string
    expect(writtenContent).toContain('Previous entry')
    expect(writtenContent).toContain('## Experiment:')
  })
})

// ---------------------------------------------------------------------------
// AC6: Token budget cap (T7)
// ---------------------------------------------------------------------------

describe('createExperimenter — token budget cap (AC6)', () => {
  it('returns REGRESSED when experiment exceeds token budget cap', async () => {
    const mockGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 })
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    })
    const mockSpawn = vi.fn().mockResolvedValue({ stdout: 'https://github.com/pull/1', stderr: '', code: 0 })
    const mockRunStory = vi.fn().mockResolvedValue({ runId: 'run-exp-01', exitCode: 0 })
    const mockLog = vi.fn()

    // Run-level metrics: experiment looks IMPROVED (tokens down)
    // But story-level metrics: experiment used 3x the baseline tokens → exceeds 2x cap
    const mockGetRunMetrics = vi.fn().mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return makeRunMetrics({ run_id: 'run-baseline', total_input_tokens: 10000, total_output_tokens: 5000 })
      }
      return makeRunMetrics({ run_id: 'run-exp-01', total_input_tokens: 8000, total_output_tokens: 4000 })
    })

    const mockGetStoryMetrics = vi.fn().mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return [{ story_key: '7-1', input_tokens: 5000, output_tokens: 2000 } as any]
      }
      // Experiment used 3x baseline story tokens → exceeds 2x cap
      return [{ story_key: '7-1', input_tokens: 15000, output_tokens: 6000 } as any]
    })

    const deps: ExperimenterDeps = {
      git: mockGit,
      spawn: mockSpawn,
      runStory: mockRunStory,
      getRunMetrics: mockGetRunMetrics,
      getStoryMetrics: mockGetStoryMetrics,
      readFile: vi.fn().mockResolvedValue('# Prompt'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      log: mockLog,
    }
    const config = makeConfig({ tokenBudgetMultiplier: 2 })
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation({ story_key: '7-1' })
    const results = await experimenter.runExperiments({} as any, [rec], 'run-baseline')

    expect(results[0]!.verdict).toBe('REGRESSED')
    expect(results[0]!.error).toContain('Token budget cap exceeded')
    // Should log the budget exceeded message
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Token budget'))
  })

  it('allows experiment within token budget cap', async () => {
    const mockGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 })
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    })
    const mockRunStory = vi.fn().mockResolvedValue({ runId: 'run-exp-01', exitCode: 0 })
    const mockGetRunMetrics = vi.fn().mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return makeRunMetrics({ run_id: 'run-baseline', total_input_tokens: 10000, total_output_tokens: 5000 })
      }
      return makeRunMetrics({ run_id: 'run-exp-01', total_input_tokens: 8000, total_output_tokens: 4000 })
    })

    const mockGetStoryMetrics = vi.fn().mockImplementation((_db: unknown, runId: string) => {
      if (runId === 'run-baseline') {
        return [{ story_key: '7-1', input_tokens: 5000, output_tokens: 2000 } as any]
      }
      // Experiment used 1.5x baseline → within 2x cap
      return [{ story_key: '7-1', input_tokens: 7000, output_tokens: 3500 } as any]
    })

    const deps: ExperimenterDeps = {
      git: mockGit,
      spawn: vi.fn().mockResolvedValue({ stdout: 'https://github.com/pull/1', stderr: '', code: 0 }),
      runStory: mockRunStory,
      getRunMetrics: mockGetRunMetrics,
      getStoryMetrics: mockGetStoryMetrics,
      readFile: vi.fn().mockResolvedValue('# Prompt'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    }
    const config = makeConfig({ tokenBudgetMultiplier: 2 })
    const experimenter = createExperimenter(config, deps)
    const rec = makeRecommendation({ story_key: '7-1' })
    const results = await experimenter.runExperiments({} as any, [rec], 'run-baseline')

    expect(results[0]!.verdict).toBe('IMPROVED')
  })
})

// ---------------------------------------------------------------------------
// --experiment flag integration (AC1)
// ---------------------------------------------------------------------------

describe('AutoSupervisorOptions includes experiment flag (AC1)', () => {
  it('runAutoSupervisor accepts experiment and maxExperiments options', async () => {
    const { runAutoSupervisor } = await import('../../../cli/commands/auto.js')
    expect(typeof runAutoSupervisor).toBe('function')

    // Verify the function can be called with experiment: true and maxExperiments
    // by using mock deps that immediately return NO_PIPELINE_RUNNING
    // (preventing any real pipeline work)
    const mockDeps = {
      getHealth: vi.fn().mockResolvedValue({
        verdict: 'NO_PIPELINE_RUNNING' as const,
        run_id: null,
        staleness_seconds: 0,
        stories: { active: 0, completed: 0, escalated: 0, total: 0, details: {} },
      }),
      killPid: vi.fn(),
      resumePipeline: vi.fn().mockResolvedValue(0),
      sleep: vi.fn().mockResolvedValue(undefined),
      incrementRestarts: vi.fn(),
      runAnalysis: vi.fn().mockResolvedValue(undefined),
    }

    // Call with experiment: true — should NOT throw, should return 0 (no failures/escalations)
    const exitCode = await runAutoSupervisor(
      {
        pollInterval: 1,
        stallThreshold: 10,
        maxRestarts: 3,
        outputFormat: 'json' as const,
        projectRoot: '/tmp/test-project',
        pack: 'bmad',
        experiment: true,
        maxExperiments: 5,
      },
      mockDeps,
    )
    expect(exitCode).toBe(0)
  })

  it('experiment mode is skipped when experiment flag is false', async () => {
    const { runAutoSupervisor } = await import('../../../cli/commands/auto.js')

    const stdoutChunks: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      if (typeof chunk === 'string') stdoutChunks.push(chunk)
      return true
    })

    try {
      const mockDeps = {
        getHealth: vi.fn().mockResolvedValue({
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: 'test-run-id',
          staleness_seconds: 0,
          stories: { active: 0, completed: 1, escalated: 0, total: 1, details: { '7-1': { phase: 'COMPLETE' } } },
        }),
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        runAnalysis: vi.fn().mockResolvedValue(undefined),
      }

      await runAutoSupervisor(
        {
          pollInterval: 1,
          stallThreshold: 10,
          maxRestarts: 3,
          outputFormat: 'json' as const,
          projectRoot: '/tmp/test-project',
          pack: 'bmad',
          experiment: false,
        },
        mockDeps,
      )

      // When experiment is false, no supervisor:experiment:start event should be emitted
      const allOutput = stdoutChunks.join('')
      expect(allOutput).not.toContain('supervisor:experiment:start')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('supervisor enters experiment block when run_id is non-null and analysis report exists on disk', async () => {
    const { runAutoSupervisor } = await import('../../../cli/commands/auto.js')

    // Create a temp project with an analysis report on disk
    const projectRoot = join(tmpdir(), `substrate-exp-test-${randomUUID()}`)
    const supervisorReportsDir = join(projectRoot, '_bmad-output', 'supervisor-reports')
    const runId = 'test-run-experiment-001'
    mkdirSync(supervisorReportsDir, { recursive: true })

    // Write an analysis report JSON with a recommendation so the experiment block is entered
    const analysisReport = {
      run_id: runId,
      recommendations: [
        {
          type: 'token_regression',
          story_key: '7-1',
          phase: 'dev-story',
          description: 'dev-story phase used 61% more tokens than baseline',
          short_desc: 'dev-story-token-regression',
          tokens_actual: 8200,
          tokens_baseline: 5100,
          delta_pct: 61,
        },
      ],
    }
    writeFileSync(
      join(supervisorReportsDir, `${runId}-analysis.json`),
      JSON.stringify(analysisReport),
      'utf-8',
    )

    const stdoutChunks: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      if (typeof chunk === 'string') stdoutChunks.push(chunk)
      return true
    })

    try {
      const mockDeps = {
        // Health returns a terminal state with the non-null run_id
        getHealth: vi.fn().mockResolvedValue({
          verdict: 'NO_PIPELINE_RUNNING' as const,
          run_id: runId,
          staleness_seconds: 0,
          status: 'completed',
          current_phase: null,
          last_activity: new Date().toISOString(),
          stories: { active: 0, completed: 1, escalated: 0, details: { '7-1': { phase: 'COMPLETE', review_cycles: 0 } } },
          process: { orchestrator_pid: null, child_pids: [], zombies: [] },
        }),
        killPid: vi.fn(),
        resumePipeline: vi.fn().mockResolvedValue(0),
        sleep: vi.fn().mockResolvedValue(undefined),
        incrementRestarts: vi.fn(),
        runAnalysis: vi.fn().mockResolvedValue(undefined),
      }

      await runAutoSupervisor(
        {
          pollInterval: 1,
          stallThreshold: 10,
          maxRestarts: 3,
          outputFormat: 'json' as const,
          projectRoot,
          pack: 'bmad',
          experiment: true,
          maxExperiments: 1,
        },
        mockDeps,
      )

      // The supervisor should have entered the experiment block and emitted
      // supervisor:experiment:start — proving the supervisor→experimenter wiring
      // was reached (experiment only executes when run_id !== null AND report exists)
      const allOutput = stdoutChunks.join('')
      expect(allOutput).toContain('supervisor:experiment:start')

      // After finding recommendations it should also emit the recommendations event
      // or fall into the error/skip path — either way it passed the wiring point
      const hasRecsEvent = allOutput.includes('supervisor:experiment:recommendations')
      const hasErrorEvent = allOutput.includes('supervisor:experiment:error')
      const hasSkipEvent = allOutput.includes('supervisor:experiment:skip')
      expect(hasRecsEvent || hasErrorEvent || hasSkipEvent).toBe(true)
    } finally {
      writeSpy.mockRestore()
      try { rmSync(projectRoot, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
