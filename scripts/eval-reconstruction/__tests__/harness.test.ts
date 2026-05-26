/**
 * Unit tests for scripts/eval-reconstruction/harness.mjs (Story 77-8).
 *
 * The real reconstruction corpus is forward-thin (0 clean pairs today — Story
 * 77-6 / F-commitsha only persists the auto-commit SHA going forward), so these
 * tests drive the harness wiring against SYNTHETIC corpus fixtures and fully
 * injected I/O (no git worktree, no LLM dispatch). They pin the AC behaviors:
 * isolated-checkout orchestration, bare single dispatch, per-case budget cap,
 * artifact capture, always-cleanup, and failure-tolerance.
 */

import { describe, it, expect, vi } from 'vitest'

// @ts-expect-error — importing JS module from TS test (vitest handles the cross-load)
import {
  parseReconstructionCorpus,
  validateTriple,
  selectReconstructableCases,
  buildPhaseDispatch,
  estimateCostUsd,
  enforceBudget,
  reconstructCase,
  runHarness,
  CASE_RECONSTRUCTED,
  CASE_SKIPPED,
  CASE_BUDGET_EXCEEDED,
  CASE_DISPATCH_ERROR,
} from '../harness.mjs'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTriple(overrides: Record<string, unknown> = {}) {
  return {
    repo: '/repo/ynab',
    story_key: '3-2',
    phase: 'dev-story',
    commit_sha: 'aaaa1111',
    parent_sha: 'bbbb2222',
    run_id: 'run-xyz',
    story_file: '_bmad-output/implementation-artifacts/3-2-feature.md',
    ...overrides,
  }
}

function makeDispatchResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 1000, output: 500 },
    ...overrides,
  }
}

/** Fully-injected deps with spies; override any piece per test. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    checkoutParent: vi.fn(async () => '/tmp/checkout-3-2'),
    readStoryFile: vi.fn(async () => '# Story 3-2\nAC1: do the thing'),
    dispatch: vi.fn(async () => makeDispatchResult()),
    captureArtifacts: vi.fn(async () => ['src/feature.ts', 'src/__tests__/feature.test.ts']),
    cleanup: vi.fn(async () => undefined),
    costFn: () => 0.01,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseReconstructionCorpus', () => {
  it('parses a valid corpus document', () => {
    const yaml = 'corpus_version: 1\ncorpus_ceiling: 0\ncases: []\n'
    const c = parseReconstructionCorpus(yaml)
    expect(c.corpus_version).toBe(1)
    expect(c.corpus_ceiling).toBe(0)
    expect(c.cases).toEqual([])
  })

  it('defaults corpus_ceiling to the case count when absent', () => {
    const yaml = 'cases:\n  - story_key: 1-1\n  - story_key: 1-2\n'
    expect(parseReconstructionCorpus(yaml).corpus_ceiling).toBe(2)
  })

  it('throws when the document is not a mapping', () => {
    expect(() => parseReconstructionCorpus('- just\n- a\n- list\n')).toThrow(/mapping/)
  })

  it('throws when cases is not a list', () => {
    expect(() => parseReconstructionCorpus('cases: not-a-list\n')).toThrow(/cases/)
  })
})

describe('validateTriple', () => {
  it('accepts a complete dev-story triple', () => {
    expect(validateTriple(makeTriple())).toEqual({ ok: true })
  })

  it('rejects a triple missing a required field', () => {
    const v = validateTriple(makeTriple({ commit_sha: '' }))
    expect(v).toEqual({ ok: false, reason: expect.stringContaining('commit_sha') })
  })

  it('rejects an unsupported phase', () => {
    const v = validateTriple(makeTriple({ phase: 'test-plan' }))
    expect(v).toEqual({ ok: false, reason: expect.stringContaining('unsupported phase') })
  })

  it('requires story_file for dev-story / code-review phases', () => {
    const v = validateTriple(makeTriple({ story_file: undefined }))
    expect(v).toEqual({ ok: false, reason: expect.stringContaining('story_file') })
  })

  it('does not require story_file for create-story (it produces the file)', () => {
    expect(validateTriple(makeTriple({ phase: 'create-story', story_file: undefined }))).toEqual({ ok: true })
  })

  it('rejects a non-object triple', () => {
    expect(validateTriple(null).ok).toBe(false)
  })
})

describe('selectReconstructableCases', () => {
  it('partitions reconstructable vs skipped with reasons', () => {
    const corpus = {
      cases: [
        makeTriple({ story_key: 'ok-1' }),
        makeTriple({ story_key: 'bad-1', phase: 'nope' }),
        makeTriple({ story_key: 'ok-2', phase: 'create-story', story_file: undefined }),
      ],
    }
    const { reconstructable, skipped } = selectReconstructableCases(corpus)
    expect(reconstructable.map((t: { story_key: string }) => t.story_key)).toEqual(['ok-1', 'ok-2'])
    expect(skipped).toEqual([{ story_key: 'bad-1', reason: expect.stringContaining('unsupported phase') }])
  })
})

describe('buildPhaseDispatch', () => {
  it('builds a bare dispatch request for the producing phase', () => {
    const req = buildPhaseDispatch(makeTriple(), '# story content', '/tmp/co')
    expect(req).toMatchObject({
      taskType: 'dev-story',
      storyKey: '3-2',
      prompt: '# story content',
      workingDirectory: '/tmp/co',
    })
    expect(req.timeout).toBeGreaterThan(0)
  })

  it('honors a timeout override', () => {
    expect(buildPhaseDispatch(makeTriple(), 'x', '/tmp/co', { timeout: 1234 }).timeout).toBe(1234)
  })
})

describe('estimateCostUsd', () => {
  it('estimates cost from the token total at the blended rate', () => {
    // (1000 + 500) / 1e6 * 9 = 0.0135
    expect(estimateCostUsd(makeDispatchResult())).toBeCloseTo(0.0135, 6)
  })

  it('respects a rate override and tolerates a missing token estimate', () => {
    expect(estimateCostUsd({ tokenEstimate: { input: 1_000_000, output: 0 } }, { ratePerMTokUsd: 10 })).toBeCloseTo(10, 6)
    expect(estimateCostUsd({})).toBe(0)
  })
})

describe('enforceBudget', () => {
  it('is within budget at or below the cap', () => {
    expect(enforceBudget(0.5, 0.5)).toEqual({ within: true })
    expect(enforceBudget(0.1, 0.5)).toEqual({ within: true })
  })
  it('is over budget above the cap', () => {
    expect(enforceBudget(0.6, 0.5)).toEqual({ within: false })
  })
})

// ---------------------------------------------------------------------------
// reconstructCase
// ---------------------------------------------------------------------------

describe('reconstructCase', () => {
  it('reconstructs a clean case and captures the artifact set (AC1, AC2, AC4)', async () => {
    const deps = makeDeps()
    const result = await reconstructCase(makeTriple(), deps, { budgetPerCaseUsd: 0.5 })

    expect(result.status).toBe(CASE_RECONSTRUCTED)
    expect(result.reconstructed_files).toEqual(['src/feature.ts', 'src/__tests__/feature.test.ts'])
    expect(result.cost_usd).toBe(0.01)
    // AC2: exactly ONE dispatch, with the producing-phase request.
    expect(deps.dispatch).toHaveBeenCalledTimes(1)
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'dev-story', storyKey: '3-2' }))
    // AC1: checked out the PARENT sha in isolation.
    expect(deps.checkoutParent).toHaveBeenCalledWith('/repo/ynab', 'bbbb2222', '3-2')
    // AC4: cleanup ran.
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('records budget-exceeded without grading when cost exceeds the cap (AC3)', async () => {
    const deps = makeDeps({ costFn: () => 5.0 })
    const result = await reconstructCase(makeTriple(), deps, { budgetPerCaseUsd: 0.5 })

    expect(result.status).toBe(CASE_BUDGET_EXCEEDED)
    expect(result.cost_usd).toBe(5.0)
    expect(result.budget_usd).toBe(0.5)
    // Did not proceed to capture, but DID clean up.
    expect(deps.captureArtifacts).not.toHaveBeenCalled()
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('records dispatch-error when the dispatch fails or times out (AC5)', async () => {
    const deps = makeDeps({ dispatch: vi.fn(async () => makeDispatchResult({ status: 'timeout' })) })
    const result = await reconstructCase(makeTriple(), deps, {})

    expect(result.status).toBe(CASE_DISPATCH_ERROR)
    expect(result.reason).toContain('timeout')
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('is failure-tolerant: a thrown dispatch becomes dispatch-error and still cleans up (AC5, AC4)', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async () => {
        throw new Error('agent process crashed')
      }),
    })
    const result = await reconstructCase(makeTriple(), deps, {})

    expect(result.status).toBe(CASE_DISPATCH_ERROR)
    expect(result.reason).toContain('agent process crashed')
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })

  it('skips an invalid triple without checking out or dispatching', async () => {
    const deps = makeDeps()
    const result = await reconstructCase(makeTriple({ phase: 'bogus' }), deps, {})

    expect(result.status).toBe(CASE_SKIPPED)
    expect(deps.checkoutParent).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()
    expect(deps.cleanup).not.toHaveBeenCalled()
  })

  it('cleans up even when capture throws (finally guarantee)', async () => {
    const deps = makeDeps({
      captureArtifacts: vi.fn(async () => {
        throw new Error('git status failed')
      }),
    })
    const result = await reconstructCase(makeTriple(), deps, {})
    expect(result.status).toBe(CASE_DISPATCH_ERROR)
    expect(deps.cleanup).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// runHarness
// ---------------------------------------------------------------------------

describe('runHarness', () => {
  it('summarizes outcomes across a mixed corpus', async () => {
    const corpus = {
      cases: [
        makeTriple({ story_key: 'good-1' }),
        makeTriple({ story_key: 'over-1' }),
        makeTriple({ story_key: 'bad-1', phase: 'nope' }),
      ],
    }
    // good-1 reconstructs cheaply; over-1 blows the budget.
    const deps = makeDeps({
      costFn: (r: unknown, _o: unknown) => 0.01, // overridden per-call below via dispatch? simpler: budget logic
    })
    // Make over-1 expensive by keying cost off story via dispatch token size.
    deps.dispatch = vi.fn(async (req: { storyKey: string }) =>
      makeDispatchResult({ tokenEstimate: req.storyKey === 'over-1' ? { input: 10_000_000, output: 0 } : { input: 1000, output: 0 } }),
    )
    deps.costFn = estimateCostUsd

    const { reconstructions, summary } = await runHarness(corpus, deps, { budgetPerCaseUsd: 0.5 })

    expect(summary.total).toBe(3)
    expect(summary.reconstructed).toBe(1)
    expect(summary.budget_exceeded).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.dispatch_error).toBe(0)
    expect(reconstructions).toHaveLength(3)
  })

  it('returns an all-zero report for a forward-thin (empty) corpus', async () => {
    const { reconstructions, summary } = await runHarness({ cases: [] }, makeDeps(), {})
    expect(reconstructions).toEqual([])
    expect(summary).toEqual({ total: 0, reconstructed: 0, skipped: 0, budget_exceeded: 0, dispatch_error: 0 })
  })
})
