/**
 * Recovery Engine unit tests — Story 73-1.
 *
 * Tests for classifyRecoveryAction (pure) and runRecoveryEngine (action handler).
 * All I/O dependencies are mocked; no real RunManifest files are written.
 *
 * ≥ 7 test cases (AC11):
 *   (a) Tier A — build-failure → retry with diagnosis injected into prompt
 *   (b) Tier A — retry budget exhausted → escalates to Tier B proposal
 *   (c) Tier B — scope-violation → proposal appended to manifest
 *   (d) Tier C — halt-policy root cause → returns halt action
 *   (e) back-pressure with work graph ≥2 proposals → independent stories continue,
 *       dependent paused
 *   (f) back-pressure — linear mode, ≥2 proposals → all dispatching paused
 *   (g) safety valve — ≥5 proposals → run halted regardless of dependency data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyRecoveryAction, runRecoveryEngine } from '../index.js'
import type { RecoveryEngineInput, RecoveryFailure, RecoveryBudget } from '../index.js'
import type { RunManifest } from '@substrate-ai/sdlc'
import type { DatabaseAdapter } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Mock RunManifest
// ---------------------------------------------------------------------------

const mockAppendProposal = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
const mockRead = vi.fn()

function makeManifest(proposals: Array<{ storyKey?: string; story_key?: string }> = []) {
  mockRead.mockResolvedValue({ pending_proposals: proposals })
  return {
    appendProposal: mockAppendProposal,
    read: mockRead,
  } as unknown as RunManifest
}

// ---------------------------------------------------------------------------
// Mock Event Bus
// ---------------------------------------------------------------------------

function makeBus() {
  return { emit: vi.fn() } as unknown as RecoveryEngineInput['bus']
}

// ---------------------------------------------------------------------------
// Mock DatabaseAdapter
// ---------------------------------------------------------------------------

function makeAdapter(deps: Array<{ story_key: string; depends_on: string }> = []) {
  return {
    query: vi.fn().mockResolvedValue(deps),
  } as unknown as DatabaseAdapter
}

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeFailure(rootCause: string, extras: Partial<RecoveryFailure> = {}): RecoveryFailure {
  return { rootCause, ...extras }
}

function makeBudget(remaining: number, max = 3): RecoveryBudget {
  return { remaining, max }
}

// ---------------------------------------------------------------------------
// Tests: classifyRecoveryAction (pure function)
// ---------------------------------------------------------------------------

describe('classifyRecoveryAction', () => {
  it('returns retry for build-failure when budget available', () => {
    expect(classifyRecoveryAction({ rootCause: 'build-failure' }, makeBudget(2))).toBe('retry')
  })

  it('returns retry for test-coverage-gap when budget available', () => {
    expect(classifyRecoveryAction({ rootCause: 'test-coverage-gap' }, makeBudget(1))).toBe('retry')
  })

  it('returns retry for missing-import when budget available', () => {
    expect(classifyRecoveryAction({ rootCause: 'missing-import' }, makeBudget(2))).toBe('retry')
  })

  it('returns propose for build-failure when budget exhausted', () => {
    expect(classifyRecoveryAction({ rootCause: 'build-failure' }, makeBudget(0))).toBe('propose')
  })

  it('returns propose for scope-violation regardless of budget', () => {
    expect(classifyRecoveryAction({ rootCause: 'scope-violation' }, makeBudget(3))).toBe('propose')
  })

  it('returns propose for fundamental-design-error regardless of budget', () => {
    expect(
      classifyRecoveryAction({ rootCause: 'fundamental-design-error' }, makeBudget(5)),
    ).toBe('propose')
  })

  it('returns halt for halt-policy root cause', () => {
    expect(classifyRecoveryAction({ rootCause: 'halt-policy' }, makeBudget(2))).toBe('halt')
  })

  it('returns propose for unknown root cause (safe default)', () => {
    expect(classifyRecoveryAction({ rootCause: 'unknown-new-cause' }, makeBudget(2))).toBe('propose')
  })
})

// ---------------------------------------------------------------------------
// Tests: runRecoveryEngine (action handler) — AC11 cases (a)–(g)
// ---------------------------------------------------------------------------

describe('runRecoveryEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // (a) Tier A — build-failure → retry with diagnosis injected into prompt

  it('(a) Tier A: build-failure with budget → returns retry, emits tier-a-retry, enrichedPrompt contains diagnosis', async () => {
    const bus = makeBus()
    const manifest = makeManifest([])
    const adapter = makeAdapter()

    const input: RecoveryEngineInput = {
      runId: 'run-001',
      storyKey: '73-1',
      failure: makeFailure('build-failure', {
        diagnosis: 'TypeScript compile error on line 42',
        findings: ['Error TS2345: Argument of type X is not assignable to type Y'],
      }),
      budget: makeBudget(2),
      bus,
      manifest,
      adapter,
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('retry')
    if (result.action !== 'retry') return

    // Verify event emitted
    expect(bus.emit).toHaveBeenCalledWith('recovery:tier-a-retry', {
      runId: 'run-001',
      storyKey: '73-1',
      rootCause: 'build-failure',
      attempt: 2, // attempt = max - remaining + 1 = 3 - 2 + 1 = 2
      retryBudgetRemaining: 1, // remaining - 1
    })

    // Verify enriched prompt contains diagnosis
    expect(result.enrichedPrompt).toBeDefined()
    expect(result.enrichedPrompt).toContain('TypeScript compile error on line 42')
    expect(result.enrichedPrompt).toContain('Error TS2345')

    // Verify budget updated correctly
    expect(result.retryBudgetRemaining).toBe(1)
    expect(result.attempt).toBe(2)

    // No proposal appended for Tier A
    expect(mockAppendProposal).not.toHaveBeenCalled()
  })

  // (b) Tier A — retry budget 0 → escalates to Tier B proposal

  it('(b) Tier A budget exhausted → escalates to Tier B: returns propose, emits tier-b-proposal', async () => {
    const bus = makeBus()
    const manifest = makeManifest([]) // starts empty, after append has 1
    // After appendProposal, read returns 1 proposal
    mockAppendProposal.mockResolvedValue(undefined)
    mockRead.mockResolvedValue({ pending_proposals: [{ storyKey: '73-1' }] })

    const adapter = makeAdapter()

    const input: RecoveryEngineInput = {
      runId: 'run-001',
      storyKey: '73-1',
      failure: makeFailure('build-failure'),
      budget: makeBudget(0), // exhausted
      bus,
      manifest,
      adapter,
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('propose')

    // Proposal appended
    expect(mockAppendProposal).toHaveBeenCalledOnce()
    const proposalArg = mockAppendProposal.mock.calls[0]?.[0]
    expect(proposalArg).toMatchObject({
      storyKey: '73-1',
      rootCause: 'build-failure',
      type: 'escalate',
    })

    // Tier B event emitted (not Tier A)
    expect(bus.emit).not.toHaveBeenCalledWith('recovery:tier-a-retry', expect.anything())
    expect(bus.emit).toHaveBeenCalledWith('recovery:tier-b-proposal', expect.objectContaining({
      runId: 'run-001',
      storyKey: '73-1',
      rootCause: 'build-failure',
    }))
  })

  // (c) Tier B — scope-violation → proposal appended to manifest

  it('(c) Tier B: scope-violation → proposal appended, tier-b-proposal emitted', async () => {
    const bus = makeBus()
    const manifest = makeManifest([])
    mockRead.mockResolvedValue({ pending_proposals: [{ storyKey: '73-1' }] })
    const adapter = makeAdapter()

    const input: RecoveryEngineInput = {
      runId: 'run-002',
      storyKey: '73-1',
      failure: makeFailure('scope-violation'),
      budget: makeBudget(2), // budget available but scope-violation always proposes
      bus,
      manifest,
      adapter,
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('propose')

    // Proposal appended
    expect(mockAppendProposal).toHaveBeenCalledOnce()
    const proposalArg = mockAppendProposal.mock.calls[0]?.[0]
    expect(proposalArg).toMatchObject({
      storyKey: '73-1',
      rootCause: 'scope-violation',
      type: 'escalate',
      suggestedAction: expect.stringContaining('Split story'),
    })

    // Tier B event emitted
    expect(bus.emit).toHaveBeenCalledWith('recovery:tier-b-proposal', expect.objectContaining({
      runId: 'run-002',
      storyKey: '73-1',
      rootCause: 'scope-violation',
    }))
  })

  // (d) Tier C — halt-policy root cause → returns halt action

  it('(d) Tier C: halt-policy root cause → returns halt, emits tier-c-halt', async () => {
    const bus = makeBus()
    const manifest = makeManifest([])
    const adapter = makeAdapter()

    const input: RecoveryEngineInput = {
      runId: 'run-003',
      storyKey: '73-1',
      failure: makeFailure('halt-policy'),
      budget: makeBudget(2),
      bus,
      manifest,
      adapter,
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('halt')

    // Halt event emitted
    expect(bus.emit).toHaveBeenCalledWith('recovery:tier-c-halt', {
      runId: 'run-003',
      storyKey: '73-1',
      rootCause: 'halt-policy',
    })

    // No proposal appended for Tier C
    expect(mockAppendProposal).not.toHaveBeenCalled()
  })

  // (e) back-pressure with work graph ≥2 proposals → independent stories continue,
  //     dependent paused

  it('(e) back-pressure work graph: ≥2 proposals → dependent paused, independent continue', async () => {
    const bus = makeBus()

    // After appending 73-1 proposal, there are 2 proposals
    mockAppendProposal.mockResolvedValue(undefined)
    mockRead.mockResolvedValue({
      pending_proposals: [
        { storyKey: '72-1' },
        { storyKey: '73-1' }, // this one was just appended
      ],
    })

    const manifest = {
      appendProposal: mockAppendProposal,
      read: mockRead,
    } as unknown as import('@substrate-ai/sdlc/run-model/run-manifest.js').RunManifest

    // 73-2 depends on 73-1 (proposed), 73-3 is independent
    const adapter = makeAdapter([
      { story_key: '73-2', depends_on: '73-1' }, // 73-2 is blocked by proposed 73-1
    ])

    const input: RecoveryEngineInput = {
      runId: 'run-004',
      storyKey: '73-1',
      failure: makeFailure('scope-violation'),
      budget: makeBudget(2),
      bus,
      manifest,
      adapter,
      engine: 'graph', // work graph mode
      pendingStoryKeys: ['73-2', '73-3'],
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('propose')
    if (result.action !== 'propose') return

    // 73-2 depends on proposed 73-1 → should be paused
    expect(result.pause).toContain('73-2')
    // 73-3 is independent → should continue
    expect(result.continue).toContain('73-3')
    // Not a full pause-all
    expect(result.pauseAll).toBeUndefined()
  })

  // (f) back-pressure — linear mode, ≥2 proposals → all dispatching paused

  it('(f) back-pressure linear mode: ≥2 proposals → pauseAll=true', async () => {
    const bus = makeBus()

    mockAppendProposal.mockResolvedValue(undefined)
    mockRead.mockResolvedValue({
      pending_proposals: [
        { storyKey: '72-1' },
        { storyKey: '73-1' },
      ],
    })

    const manifest = {
      appendProposal: mockAppendProposal,
      read: mockRead,
    } as unknown as import('@substrate-ai/sdlc/run-model/run-manifest.js').RunManifest

    const adapter = makeAdapter()

    const input: RecoveryEngineInput = {
      runId: 'run-005',
      storyKey: '73-1',
      failure: makeFailure('scope-violation'),
      budget: makeBudget(2),
      bus,
      manifest,
      adapter,
      engine: 'linear', // linear mode
      pendingStoryKeys: ['73-2', '73-3'],
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('propose')
    if (result.action !== 'propose') return

    // Linear mode → pause all
    expect(result.pauseAll).toBe(true)
    // No dependency computation in linear mode
    expect(result.pause).toBeUndefined()
  })

  // (g) safety valve — ≥5 proposals → run-halt returned regardless of dependency data

  it('(g) safety valve: ≥5 proposals → halt-entire-run, pipeline:halted-pending-proposals emitted', async () => {
    const bus = makeBus()

    // After appending, there are 5 proposals (safety valve)
    mockAppendProposal.mockResolvedValue(undefined)
    mockRead.mockResolvedValue({
      pending_proposals: [
        { storyKey: '70-1' },
        { storyKey: '71-1' },
        { storyKey: '72-1' },
        { storyKey: '72-2' },
        { storyKey: '73-1' }, // the 5th one triggers safety valve
      ],
    })

    const manifest = {
      appendProposal: mockAppendProposal,
      read: mockRead,
    } as unknown as import('@substrate-ai/sdlc/run-model/run-manifest.js').RunManifest

    // Even if work graph has deps, safety valve should fire regardless
    const adapter = makeAdapter([
      { story_key: '73-2', depends_on: '73-1' },
    ])

    const input: RecoveryEngineInput = {
      runId: 'run-006',
      storyKey: '73-1',
      failure: makeFailure('scope-violation'),
      budget: makeBudget(2),
      bus,
      manifest,
      adapter,
      engine: 'graph',
      pendingStoryKeys: ['73-2', '73-3'],
    }

    const result = await runRecoveryEngine(input)

    expect(result.action).toBe('halt-entire-run')
    if (result.action !== 'halt-entire-run') return

    // Safety valve event emitted
    expect(bus.emit).toHaveBeenCalledWith('pipeline:halted-pending-proposals', {
      runId: 'run-006',
      pendingProposalsCount: 5,
    })

    // Correct count returned
    expect(result.pendingProposalsCount).toBe(5)
  })
})
