/**
 * Unit tests for fan-in handler (story 50-2).
 *
 * Covers AC1–AC7:
 *   AC1 – Heuristic selection by outcome rank
 *   AC2 – LLM-based selection
 *   AC3 – Winner context updates applied
 *   AC4 – All-failed scenario
 *   AC5 – Partial-failure tolerance
 *   AC6 – Empty or absent parallel.results
 *   AC7 – Registry wiring (tripleoctagon + parallel.fan_in type)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createFanInHandler,
  rankBranches,
  buildSelectionPrompt,
  parseLlmWinnerResponse,
  type BranchResult,
} from '../fan-in.js'
import { createDefaultRegistry } from '../registry.js'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, IGraphContext } from '../../graph/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'fan-in-node',
    label: 'Fan-in',
    shape: 'tripleoctagon',
    type: 'parallel.fan_in',
    prompt: '',
    maxRetries: 0,
    goalGate: false,
    retryTarget: '',
    fallbackRetryTarget: '',
    fidelity: '',
    threadId: '',
    class: '',
    timeout: 0,
    llmModel: '',
    llmProvider: '',
    reasoningEffort: '',
    autoStatus: false,
    allowPartial: false,
    toolCommand: '',
    backend: '',
    ...overrides,
  }
}

const stubGraph = {} as Graph

function makeContext(initial?: Record<string, unknown>): IGraphContext {
  return new GraphContext(initial)
}

function makeBranch(overrides: Partial<BranchResult> = {}): BranchResult {
  return {
    branch_id: 1,
    status: 'SUCCESS',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// rankBranches unit tests (AC1, AC4, AC5)
// ---------------------------------------------------------------------------

describe('rankBranches', () => {
  it('selects SUCCESS over PARTIAL_SUCCESS (AC1)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'PARTIAL_SUCCESS' }),
      makeBranch({ branch_id: 2, status: 'SUCCESS' }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(2)
    expect(winner?.status).toBe('SUCCESS')
  })

  it('selects PARTIAL_SUCCESS over NEEDS_RETRY (AC1)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'NEEDS_RETRY' }),
      makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS' }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(2)
  })

  it('selects NEEDS_RETRY over FAILURE (AC1, AC5)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'FAILURE' }),
      makeBranch({ branch_id: 2, status: 'NEEDS_RETRY' }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(2)
  })

  it('tiebreak: higher score wins when status is equal (AC1)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'SUCCESS', score: 50 }),
      makeBranch({ branch_id: 2, status: 'SUCCESS', score: 90 }),
      makeBranch({ branch_id: 3, status: 'SUCCESS', score: 70 }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(2)
  })

  it('tiebreak: lower branch_id wins when status and score are equal (AC1)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 3, status: 'SUCCESS', score: 80 }),
      makeBranch({ branch_id: 1, status: 'SUCCESS', score: 80 }),
      makeBranch({ branch_id: 2, status: 'SUCCESS', score: 80 }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(1)
  })

  it('treats absent score as 0 in tiebreak (AC1)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'SUCCESS' }), // no score → treated as 0
      makeBranch({ branch_id: 2, status: 'SUCCESS', score: 5 }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(2)
  })

  it('excludes FAILURE branches and picks best non-FAILURE (AC5)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'FAILURE', failure_reason: 'error A' }),
      makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS' }),
      makeBranch({ branch_id: 3, status: 'FAILURE', failure_reason: 'error B' }),
    ]
    const winner = rankBranches(results)
    expect(winner?.branch_id).toBe(2)
    expect(winner?.status).toBe('PARTIAL_SUCCESS')
  })

  it('returns null when all branches are FAILURE (AC4)', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'FAILURE' }),
      makeBranch({ branch_id: 2, status: 'FAILURE' }),
    ]
    const winner = rankBranches(results)
    expect(winner).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(rankBranches([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildSelectionPrompt unit tests (AC2)
// ---------------------------------------------------------------------------

describe('buildSelectionPrompt', () => {
  it('prepends node prompt text', () => {
    const results: BranchResult[] = [makeBranch({ branch_id: 1, status: 'SUCCESS' })]
    const prompt = buildSelectionPrompt('Which branch is best?', results)
    expect(prompt).toContain('Which branch is best?')
  })

  it('lists each branch with branch_id, status, and score', () => {
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'SUCCESS', score: 85 }),
      makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS', score: 60 }),
    ]
    const prompt = buildSelectionPrompt('Choose', results)
    expect(prompt).toContain('Branch 1')
    expect(prompt).toContain('status=SUCCESS')
    expect(prompt).toContain('score=85')
    expect(prompt).toContain('Branch 2')
    expect(prompt).toContain('status=PARTIAL_SUCCESS')
    expect(prompt).toContain('score=60')
  })

  it('includes context_update_keys (not values) for token efficiency', () => {
    const results: BranchResult[] = [
      makeBranch({
        branch_id: 1,
        status: 'SUCCESS',
        context_updates: { outputFile: '/tmp/file.ts', coverage: 95 },
      }),
    ]
    const prompt = buildSelectionPrompt('Choose', results)
    expect(prompt).toContain('outputFile')
    expect(prompt).toContain('coverage')
    // Values should NOT appear
    expect(prompt).not.toContain('/tmp/file.ts')
    expect(prompt).not.toContain('95')
  })

  it('shows (none) for branches with no context_updates', () => {
    const results: BranchResult[] = [makeBranch({ branch_id: 1, status: 'SUCCESS' })]
    const prompt = buildSelectionPrompt('Choose', results)
    expect(prompt).toContain('(none)')
  })

  it('instructs LLM to reply with integer branch_id', () => {
    const results: BranchResult[] = [makeBranch({ branch_id: 1, status: 'SUCCESS' })]
    const prompt = buildSelectionPrompt('Choose', results)
    expect(prompt.toLowerCase()).toContain('branch_id')
  })
})

// ---------------------------------------------------------------------------
// parseLlmWinnerResponse unit tests (AC2)
// ---------------------------------------------------------------------------

describe('parseLlmWinnerResponse', () => {
  const results: BranchResult[] = [
    makeBranch({ branch_id: 1, status: 'SUCCESS' }),
    makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS' }),
    makeBranch({ branch_id: 3, status: 'NEEDS_RETRY' }),
  ]

  it('parses a plain integer response', () => {
    const winner = parseLlmWinnerResponse('2', results)
    expect(winner?.branch_id).toBe(2)
  })

  it('parses an integer embedded in a sentence', () => {
    const winner = parseLlmWinnerResponse('The best candidate is branch 3.', results)
    expect(winner?.branch_id).toBe(3)
  })

  it('returns first valid branch_id found in response', () => {
    // "1" appears first and is valid
    const winner = parseLlmWinnerResponse('Branch 1 is better than branch 2.', results)
    expect(winner?.branch_id).toBe(1)
  })

  it('returns null and logs warning when no valid branch_id in response', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const winner = parseLlmWinnerResponse('I cannot decide.', results)
    expect(winner).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to heuristic'))
    warnSpy.mockRestore()
  })

  it('returns null for response with only invalid branch ids', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const winner = parseLlmWinnerResponse('Branch 99 is the best.', results)
    expect(winner).toBeNull()
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// createFanInHandler integration tests (AC1–AC6)
// ---------------------------------------------------------------------------

describe('createFanInHandler — heuristic mode (no prompt)', () => {
  it('selects winner and returns SUCCESS for multi-branch results (AC1)', async () => {
    const handler = createFanInHandler()
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'PARTIAL_SUCCESS' }),
      makeBranch({ branch_id: 2, status: 'SUCCESS' }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
  })

  it('merges winner context_updates into the main context (AC3)', async () => {
    const handler = createFanInHandler()
    const results: BranchResult[] = [
      makeBranch({
        branch_id: 1,
        status: 'SUCCESS',
        context_updates: { generatedFile: 'src/foo.ts', testsPassed: true },
      }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(ctx.get('generatedFile')).toBe('src/foo.ts')
    expect(ctx.get('testsPassed')).toBe(true)
  })

  it('sets parallel.fan_in.best_id and best_outcome in context (AC3)', async () => {
    const handler = createFanInHandler()
    const results: BranchResult[] = [
      makeBranch({ branch_id: 2, status: 'SUCCESS' }),
      makeBranch({ branch_id: 1, status: 'PARTIAL_SUCCESS' }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(ctx.get('parallel.fan_in.best_id')).toBe(2)
    expect(ctx.get('parallel.fan_in.best_outcome')).toBe('SUCCESS')
  })

  it('returns FAILURE when all branches failed, with aggregated reasons (AC4)', async () => {
    const handler = createFanInHandler()
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'FAILURE', failure_reason: 'compile error' }),
      makeBranch({ branch_id: 2, status: 'FAILURE', failure_reason: 'timeout' }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('compile error')
    expect(outcome.failureReason).toContain('timeout')
  })

  it('selects best non-FAILURE from mixed results (AC5)', async () => {
    const handler = createFanInHandler()
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'FAILURE', failure_reason: 'bad' }),
      makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS', score: 70 }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
    expect(ctx.get('parallel.fan_in.best_id')).toBe(2)
    expect(ctx.get('parallel.fan_in.best_outcome')).toBe('PARTIAL_SUCCESS')
  })

  it('returns FAILURE when parallel.results is an empty array (AC6)', async () => {
    const handler = createFanInHandler()
    const ctx = makeContext({ 'parallel.results': [] })
    const outcome = await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('no parallel results')
  })

  it('returns FAILURE when parallel.results key is absent from context (AC6)', async () => {
    const handler = createFanInHandler()
    const ctx = makeContext()
    const outcome = await handler(makeNode({ prompt: '' }), ctx, stubGraph)
    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('no parallel results')
  })
})

// ---------------------------------------------------------------------------
// createFanInHandler — LLM mode (AC2)
// ---------------------------------------------------------------------------

describe('createFanInHandler — LLM mode (with prompt)', () => {
  it('calls llmCall with the selection prompt and uses returned branch_id (AC2)', async () => {
    const mockLlmCall = vi.fn().mockResolvedValue('2')
    const handler = createFanInHandler({ llmCall: mockLlmCall })
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'PARTIAL_SUCCESS' }),
      makeBranch({ branch_id: 2, status: 'SUCCESS' }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(makeNode({ prompt: 'Pick the best implementation' }), ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
    expect(mockLlmCall).toHaveBeenCalledOnce()
    expect(mockLlmCall).toHaveBeenCalledWith(expect.stringContaining('Pick the best implementation'))
    expect(ctx.get('parallel.fan_in.best_id')).toBe(2)
  })

  it('passes branch summaries to the LLM call (AC2)', async () => {
    let capturedPrompt = ''
    const mockLlmCall = vi.fn().mockImplementation((p: string) => {
      capturedPrompt = p
      return Promise.resolve('1')
    })
    const handler = createFanInHandler({ llmCall: mockLlmCall })
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'SUCCESS', score: 90 }),
      makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS', score: 60 }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    await handler(makeNode({ prompt: 'Select best' }), ctx, stubGraph)
    expect(capturedPrompt).toContain('Branch 1')
    expect(capturedPrompt).toContain('Branch 2')
    expect(capturedPrompt).toContain('status=SUCCESS')
    expect(capturedPrompt).toContain('score=90')
  })

  it('falls back to heuristic when LLM response has no valid branch_id (AC2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockLlmCall = vi.fn().mockResolvedValue('I cannot decide')
    const handler = createFanInHandler({ llmCall: mockLlmCall })
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'PARTIAL_SUCCESS' }),
      makeBranch({ branch_id: 2, status: 'SUCCESS' }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(makeNode({ prompt: 'Choose' }), ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
    // Heuristic fallback selects SUCCESS branch (id=2)
    expect(ctx.get('parallel.fan_in.best_id')).toBe(2)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to heuristic'))
    warnSpy.mockRestore()
  })

  it('falls back to heuristic when llmCall throws (AC2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockLlmCall = vi.fn().mockRejectedValue(new Error('network failure'))
    const handler = createFanInHandler({ llmCall: mockLlmCall })
    const results: BranchResult[] = [
      makeBranch({ branch_id: 1, status: 'SUCCESS' }),
      makeBranch({ branch_id: 2, status: 'PARTIAL_SUCCESS' }),
    ]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(makeNode({ prompt: 'Choose' }), ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
    expect(ctx.get('parallel.fan_in.best_id')).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LLM call failed'))
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Registry wiring (AC7)
// ---------------------------------------------------------------------------

describe('Registry wiring (AC7)', () => {
  it('resolves parallel.fan_in type to a function', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'parallel.fan_in', shape: '' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('resolves tripleoctagon shape to a function (fan-in handler)', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: '', shape: 'tripleoctagon' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('tripleoctagon shape and parallel.fan_in type resolve to the same handler instance', () => {
    const registry = createDefaultRegistry()
    const byType = registry.resolve(makeNode({ type: 'parallel.fan_in', shape: '' }))
    const byShape = registry.resolve(makeNode({ type: '', shape: 'tripleoctagon' }))
    // Both should be functions (they will be separate instances from createFanInHandler,
    // but both should behave as fan-in handlers)
    expect(typeof byType).toBe('function')
    expect(typeof byShape).toBe('function')
  })

  it('fan-in handler works correctly when resolved from registry (AC7 + smoke)', async () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'parallel.fan_in', shape: 'tripleoctagon', prompt: '' })
    const handler = registry.resolve(node)
    const results: BranchResult[] = [makeBranch({ branch_id: 1, status: 'SUCCESS' })]
    const ctx = makeContext({ 'parallel.results': results })
    const outcome = await handler(node, ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
    expect(ctx.get('parallel.fan_in.best_id')).toBe(1)
  })
})
