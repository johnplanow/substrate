/**
 * Tests for GraphOrchestrator — Story 43-7: Multi-Story Orchestration via Graph Instances.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createGraphOrchestrator,
  GraphOrchestratorInitError,
  applyConfigToGraph,
} from '../graph-orchestrator.js'
import type {
  GraphShape,
  IGraphExecutorLocal,
  GraphRunResult,
  GraphOrchestratorConfig,
  ConflictGrouperFn,
} from '../graph-orchestrator.js'

// ---------------------------------------------------------------------------
// Story 43-7 helpers
// ---------------------------------------------------------------------------

function makeMinimalGraphShape(nodeIds: string[] = ['start', 'end']): GraphShape {
  return {
    nodes: nodeIds.map((id) => ({ id, type: 'sdlc.phase', label: id, prompt: '' })),
    edges: [],
  }
}

function makeBaseConfig(overrides: Partial<GraphOrchestratorConfig> = {}): GraphOrchestratorConfig {
  const mockExecutor: IGraphExecutorLocal = {
    run: vi.fn().mockResolvedValue({ status: 'SUCCESS' } as GraphRunResult),
  }
  return {
    graph: makeMinimalGraphShape(),
    executor: mockExecutor,
    handlerRegistry: {},
    projectRoot: '/project',
    methodologyPack: 'default',
    maxConcurrency: 2,
    logsRoot: '/logs',
    runId: 'test-run',
    gcPauseMs: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Story 43-7: createGraphOrchestrator tests
// ---------------------------------------------------------------------------

describe('createGraphOrchestrator', () => {
  // ── AC6: Graph structural validation at construction ──────────────────────

  it('AC6: throws GraphOrchestratorInitError when graph.nodes is null', () => {
    expect(() =>
      createGraphOrchestrator(
        makeBaseConfig({ graph: { nodes: null as unknown as GraphShape['nodes'], edges: [] } }),
      ),
    ).toThrow(GraphOrchestratorInitError)
  })

  it('AC6: throws GraphOrchestratorInitError when graph.edges is undefined', () => {
    expect(() =>
      createGraphOrchestrator(
        makeBaseConfig({
          graph: {
            nodes: [{ id: 'a', type: 'sdlc.phase', label: 'a', prompt: '' }],
            edges: undefined as unknown as GraphShape['edges'],
          },
        }),
      ),
    ).toThrow(GraphOrchestratorInitError)
  })

  it('AC6: error message describes the problem', () => {
    expect(() =>
      createGraphOrchestrator(
        makeBaseConfig({ graph: { nodes: null as unknown as GraphShape['nodes'], edges: [] } }),
      ),
    ).toThrow('Invalid graph: missing nodes or edges arrays')
  })

  it('AC6: does not throw when graph has valid nodes and edges', () => {
    expect(() => createGraphOrchestrator(makeBaseConfig())).not.toThrow()
  })

  // ── AC3: Run Summary Reflects Final Story Outcomes ────────────────────────

  it('AC3: successCount=2, failureCount=1, totalStories=3', async () => {
    let callIndex = 0
    const outcomes: GraphRunResult[] = [
      { status: 'SUCCESS' },
      { status: 'SUCCESS' },
      { status: 'FAIL' },
    ]
    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async () => outcomes[callIndex++]),
    }
    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, maxConcurrency: 3, gcPauseMs: 0 }),
    )
    const summary = await orch.run(['s1', 's2', 's3'])
    expect(summary.successCount).toBe(2)
    expect(summary.failureCount).toBe(1)
    expect(summary.totalStories).toBe(3)
  })

  it('AC3: non-SUCCESS statuses (FAIL, PARTIAL_SUCCESS, RETRY, SKIPPED) all count as failures', async () => {
    const outcomes: GraphRunResult[] = [
      { status: 'FAIL' },
      { status: 'PARTIAL_SUCCESS' },
      { status: 'RETRY' },
      { status: 'SKIPPED' },
    ]
    let i = 0
    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async () => outcomes[i++]),
    }
    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, maxConcurrency: 4, gcPauseMs: 0 }),
    )
    const summary = await orch.run(['s1', 's2', 's3', 's4'])
    expect(summary.successCount).toBe(0)
    expect(summary.failureCount).toBe(4)
    expect(summary.totalStories).toBe(4)
  })

  // ── AC1: Bounded Concurrency ──────────────────────────────────────────────

  it('AC1: at most maxConcurrency=2 executor instances run concurrently across 3 stories', async () => {
    let running = 0
    let peakRunning = 0

    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async () => {
        running++
        if (running > peakRunning) peakRunning = running
        await Promise.resolve()
        running--
        return { status: 'SUCCESS' } as GraphRunResult
      }),
    }

    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, maxConcurrency: 2, gcPauseMs: 0 }),
    )
    await orch.run(['s1', 's2', 's3'])

    expect(peakRunning).toBeLessThanOrEqual(2)
  })

  it('AC1: resolves only after all 3 stories complete', async () => {
    const completed: string[] = []

    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async (_graph, cfg) => {
        await Promise.resolve()
        const key = (cfg.initialContext?.storyKey as string) ?? 'unknown'
        completed.push(key)
        return { status: 'SUCCESS' } as GraphRunResult
      }),
    }

    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, maxConcurrency: 2, gcPauseMs: 0 }),
    )
    const summary = await orch.run(['s1', 's2', 's3'])

    expect(summary.totalStories).toBe(3)
    expect(completed).toHaveLength(3)
    expect(completed.sort()).toEqual(['s1', 's2', 's3'])
  })

  // ── AC2: Per-Story Context Initialization ─────────────────────────────────

  it('AC2: initialContext contains storyKey, projectRoot, and methodologyPack', async () => {
    const capturedContexts: Record<string, unknown>[] = []
    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async (_graph, cfg) => {
        capturedContexts.push({ ...(cfg.initialContext ?? {}) })
        return { status: 'SUCCESS' } as GraphRunResult
      }),
    }

    const orch = createGraphOrchestrator(
      makeBaseConfig({
        executor,
        projectRoot: '/my/project',
        methodologyPack: 'agile-v2',
        gcPauseMs: 0,
      }),
    )
    await orch.run(['story-1', 'story-2'])

    expect(capturedContexts).toHaveLength(2)
    expect(capturedContexts[0]).toMatchObject({
      storyKey: 'story-1',
      projectRoot: '/my/project',
      methodologyPack: 'agile-v2',
    })
    expect(capturedContexts[1]).toMatchObject({
      storyKey: 'story-2',
      projectRoot: '/my/project',
      methodologyPack: 'agile-v2',
    })
  })

  it('AC2: runId passed to executor is prefixed with config.runId and storyKey', async () => {
    const capturedRunIds: string[] = []
    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async (_graph, cfg) => {
        capturedRunIds.push(cfg.runId)
        return { status: 'SUCCESS' } as GraphRunResult
      }),
    }

    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, runId: 'run-42', gcPauseMs: 0 }),
    )
    await orch.run(['story-1'])

    expect(capturedRunIds[0]).toBe('run-42:story-1')
  })

  // ── AC4: Conflict Group Serialization ─────────────────────────────────────

  it('AC4: stories in the same conflict group execute sequentially', async () => {
    const callLog: string[] = []
    let resolveA!: () => void

    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async (_graph, cfg) => {
        const key = cfg.initialContext?.storyKey as string
        callLog.push(`start:${key}`)
        if (key === 'storyA') {
          await new Promise<void>((resolve) => {
            resolveA = resolve
          })
        }
        callLog.push(`end:${key}`)
        return { status: 'SUCCESS' } as GraphRunResult
      }),
    }

    // Both stories in the same group → must execute sequentially
    const conflictGrouper: ConflictGrouperFn = () => [[['storyA', 'storyB']]]

    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, conflictGrouper, maxConcurrency: 2, gcPauseMs: 0 }),
    )

    const runPromise = orch.run(['storyA', 'storyB'])
    // Let the orchestrator start storyA
    await Promise.resolve()
    await Promise.resolve()
    // storyB should not have started — storyA is still pending
    expect(callLog.includes('start:storyB')).toBe(false)
    // Now finish storyA
    resolveA()
    await runPromise

    // Verify sequential order: storyA fully completes before storyB starts
    const startAIndex = callLog.indexOf('start:storyA')
    const endAIndex = callLog.indexOf('end:storyA')
    const startBIndex = callLog.indexOf('start:storyB')
    expect(startAIndex).toBeLessThan(endAIndex)
    expect(endAIndex).toBeLessThan(startBIndex)
  })

  // ── AC5: Batch Ordering Respects Topological Contract Dependencies ─────────

  it('AC5: batch 1 starts only after batch 0 fully completes', async () => {
    const callLog: string[] = []

    const executor: IGraphExecutorLocal = {
      run: vi.fn().mockImplementation(async (_graph, cfg) => {
        const key = cfg.initialContext?.storyKey as string
        callLog.push(`start:${key}`)
        await Promise.resolve()
        callLog.push(`end:${key}`)
        return { status: 'SUCCESS' } as GraphRunResult
      }),
    }

    // Two batches: batch 0 has storyA, batch 1 has storyB
    const conflictGrouper: ConflictGrouperFn = () => [[['storyA']], [['storyB']]]

    const orch = createGraphOrchestrator(
      makeBaseConfig({ executor, conflictGrouper, maxConcurrency: 2, gcPauseMs: 0 }),
    )
    await orch.run(['storyA', 'storyB'])

    const endAIndex = callLog.indexOf('end:storyA')
    const startBIndex = callLog.indexOf('start:storyB')
    expect(endAIndex).toBeLessThan(startBIndex)
  })
})

// ---------------------------------------------------------------------------
// Story 43-8: applyConfigToGraph
// ---------------------------------------------------------------------------

describe('applyConfigToGraph — Story 43-8', () => {
  function makePatchableGraph(maxRetries = 2) {
    const devStoryNode = { maxRetries }
    return {
      nodes: new Map<string, { maxRetries?: number }>([
        ['start', {}],
        ['dev_story', devStoryNode],
        ['code_review', {}],
        ['exit', {}],
      ]),
    }
  }

  it('sets dev_story.maxRetries to maxReviewCycles value (AC1)', () => {
    const graph = makePatchableGraph(2)
    applyConfigToGraph(graph, { maxReviewCycles: 5 })
    expect(graph.nodes.get('dev_story')?.maxRetries).toBe(5)
  })

  it('sets maxRetries to 0 when maxReviewCycles is 0 (AC2)', () => {
    const graph = makePatchableGraph(2)
    applyConfigToGraph(graph, { maxReviewCycles: 0 })
    expect(graph.nodes.get('dev_story')?.maxRetries).toBe(0)
  })

  it('throws when graph has no dev_story node', () => {
    const graph = { nodes: new Map<string, { maxRetries?: number }>([['start', {}]]) }
    expect(() => applyConfigToGraph(graph, { maxReviewCycles: 3 })).toThrow(
      "applyConfigToGraph: graph does not contain a 'dev_story' node",
    )
  })
})
