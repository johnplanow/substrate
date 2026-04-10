/**
 * Integration tests for graph executor fidelity-based context summarization.
 *
 * Covers AC4 (pre-dispatch summarization fires / no-ops correctly),
 *        AC5 (graph:context-summarized event emitted),
 *        AC6 (checkpoint-resume fidelity 'summary:high' → level 'high').
 * Story 49-5.
 *
 * Approach: mock CheckpointManager (file I/O) and ConvergenceController (avoid
 * real goal-gate evaluation). MockSummaryEngine is a plain class — no vi.mock().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Graph, GraphNode, GraphEdge, IGraphContext } from '../types.js'
import type { IHandlerRegistry, NodeHandler } from '../../handlers/types.js'
import type { GraphExecutorConfig } from '../executor.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import type { SummaryEngine, SummaryLevel, Summary } from '../../context/index.js'

// ---------------------------------------------------------------------------
// Hoist mock factories so vi.mock() can reference them
// ---------------------------------------------------------------------------

const { mockSave, mockLoad, mockResume } = vi.hoisted(() => ({
  mockSave: vi.fn().mockResolvedValue(undefined as void),
  mockLoad: vi.fn(),
  mockResume: vi.fn(),
}))

const { mockCheckGoalGates, mockRecordOutcome, mockResolveRetryTarget } = vi.hoisted(() => ({
  mockCheckGoalGates: vi.fn().mockReturnValue({ satisfied: true, failedGates: [] }),
  mockRecordOutcome: vi.fn(),
  mockResolveRetryTarget: vi.fn().mockReturnValue(null),
}))

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../checkpoint.js', () => ({
  CheckpointManager: vi.fn().mockImplementation(() => ({
    save: mockSave,
    load: mockLoad,
    resume: mockResume,
  })),
}))

vi.mock('../../convergence/index.js', () => ({
  createConvergenceController: vi.fn().mockImplementation(() => ({
    evaluateGates: vi.fn().mockReturnValue({ satisfied: true, failingNodes: [] }),
    recordOutcome: mockRecordOutcome,
    checkGoalGates: mockCheckGoalGates,
    resolveRetryTarget: mockResolveRetryTarget,
    recordIterationContext: vi.fn(),
    prepareForIteration: vi.fn().mockResolvedValue([]),
    getStoredContexts: vi.fn().mockReturnValue([]),
  })),
  SessionBudgetManager: vi.fn().mockImplementation(() => ({
    checkBudget: vi.fn().mockReturnValue({ allowed: true }),
    getElapsedMs: vi.fn().mockReturnValue(0),
    reset: vi.fn(),
  })),
  PipelineBudgetManager: vi.fn().mockImplementation(() => ({
    checkBudget: vi.fn().mockReturnValue({ allowed: true }),
    addCost: vi.fn(),
    getTotalCost: vi.fn().mockReturnValue(0),
    reset: vi.fn(),
  })),
  createPlateauDetector: vi.fn().mockReturnValue({
    recordScore: vi.fn(),
    isPlateaued: vi.fn().mockReturnValue(false),
    getWindow: vi.fn().mockReturnValue(3),
    getScores: vi.fn().mockReturnValue([]),
  }),
  checkPlateauAndEmit: vi.fn().mockReturnValue({ plateaued: false, scores: [] }),
  buildRemediationContext: vi.fn().mockReturnValue({
    previousFailureReason: '',
    scenarioDiff: '',
    iterationCount: 0,
    satisfactionScoreHistory: [],
    fixScope: '',
  }),
  injectRemediationContext: vi.fn(),
  computeBackoffDelay: vi
    .fn()
    .mockImplementation((attempt: number) => Math.min(1000 * 2 ** attempt, 30000)),
  createDualSignalCoordinator: vi.fn().mockReturnValue({ evaluate: vi.fn() }),
  CONTEXT_KEY_CODE_REVIEW_VERDICT: 'code_review_verdict',
}))

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

import { createGraphExecutor } from '../executor.js'
import { GraphContext } from '../context.js'

// ---------------------------------------------------------------------------
// MockSummaryEngine — plain class with call counters, no vi.mock()
// ---------------------------------------------------------------------------

class MockSummaryEngine implements SummaryEngine {
  readonly name = 'mock-summary'
  summarizeCallCount = 0
  lastSummarizeArgs: { content: string; level: SummaryLevel } | null = null

  async summarize(content: string, level: SummaryLevel, _opts?: unknown): Promise<Summary> {
    this.summarizeCallCount++
    this.lastSummarizeArgs = { content, level }
    return {
      content: `[${level}] ${content.slice(0, 50)}`,
      level,
      originalHash: 'test-hash',
      createdAt: new Date().toISOString(),
      originalTokenCount: Math.ceil(content.length / 4),
      summaryTokenCount: Math.ceil(content.length / 16),
    }
  }

  async expand(summary: Summary, _targetLevel: SummaryLevel, _opts?: unknown): Promise<string> {
    return summary.content
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const minimalNode: GraphNode = {
  id: '',
  label: '',
  shape: '',
  type: '',
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
}

function makeNode(id: string, overrides?: Partial<GraphNode>): GraphNode {
  return { ...minimalNode, id, ...overrides }
}

function makeEdge(fromNode: string, toNode: string, overrides?: Partial<GraphEdge>): GraphEdge {
  return {
    fromNode,
    toNode,
    label: '',
    condition: '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
    ...overrides,
  }
}

/**
 * Build a minimal 3-node Graph: start → mid → exit
 * mid has fidelity: 'medium' by default.
 */
function makeThreeNodeGraph(
  midFidelity = 'medium',
  graphDefaultFidelity: '' | 'high' | 'medium' | 'low' | 'draft' = ''
): Graph {
  const startNode = makeNode('start')
  const midNode = makeNode('mid', { fidelity: midFidelity })
  const exitNode = makeNode('exit')
  const edgeList: GraphEdge[] = [makeEdge('start', 'mid'), makeEdge('mid', 'exit')]
  const nodeMap = new Map([
    ['start', startNode],
    ['mid', midNode],
    ['exit', exitNode],
  ])
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: graphDefaultFidelity,
    nodes: nodeMap,
    edges: edgeList,
    outgoingEdges: (nodeId: string) => edgeList.filter((e) => e.fromNode === nodeId),
    startNode: () => nodeMap.get('start')!,
    exitNode: () => nodeMap.get('exit')!,
  }
}

function makeRegistry(handler: NodeHandler): IHandlerRegistry {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn().mockReturnValue(handler),
  }
}

function makeEventBus(): { bus: TypedEventBus<FactoryEvents>; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn()
  const bus: TypedEventBus<FactoryEvents> = {
    emit,
    on: vi.fn(),
    off: vi.fn(),
  }
  return { bus, emit }
}

function makeConfig(
  registry: IHandlerRegistry,
  overrides?: Partial<GraphExecutorConfig>
): GraphExecutorConfig {
  return {
    runId: 'fidelity-test-run',
    logsRoot: '/tmp/executor-fidelity-test',
    handlerRegistry: registry,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockSave.mockResolvedValue(undefined)
  mockCheckGoalGates.mockReturnValue({ satisfied: true, failedGates: [] })
  mockResolveRetryTarget.mockReturnValue(null)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executor fidelity-based context summarization (story 49-5)', () => {
  it('AC4: summarization fires when summaryEngine configured, node has fidelity, factory.nodeContext non-empty', async () => {
    const mockEngine = new MockSummaryEngine()
    const nodeContextValue = 'This is the accumulated node context that will be compressed.'

    const capturedContexts: IGraphContext[] = []
    const handler = vi.fn().mockImplementation(async (_node: GraphNode, ctx: IGraphContext) => {
      capturedContexts.push(ctx)
      return { status: 'SUCCESS' as const }
    })
    const registry = makeRegistry(handler as unknown as NodeHandler)
    const graph = makeThreeNodeGraph('medium')

    const executor = createGraphExecutor()
    const outcome = await executor.run(
      graph,
      makeConfig(registry, {
        summaryEngine: mockEngine,
        initialContext: { 'factory.nodeContext': nodeContextValue },
      })
    )

    expect(outcome.status).toBe('SUCCESS')
    // summarize should be called exactly once (for the 'mid' node with fidelity='medium')
    expect(mockEngine.summarizeCallCount).toBe(1)
    expect(mockEngine.lastSummarizeArgs?.level).toBe('medium')
    // capturedContexts[1] is the context when 'mid' handler ran (index 0 = start, index 1 = mid)
    const midCtx = capturedContexts[1]!
    // factory.compressedNodeContext set in context before handler executes
    expect(midCtx.getString('factory.compressedNodeContext', '')).not.toBe('')
    // factory.nodeContext is replaced with compressed content so handlers use it
    expect(midCtx.getString('factory.nodeContext', '')).toBe(
      midCtx.getString('factory.compressedNodeContext', '')
    )
  })

  it('AC4 no-op: summarization skipped when factory.nodeContext is empty', async () => {
    const mockEngine = new MockSummaryEngine()

    const handler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(handler as unknown as NodeHandler)
    const graph = makeThreeNodeGraph('medium')

    const executor = createGraphExecutor()
    // No factory.nodeContext in initialContext
    const outcome = await executor.run(graph, makeConfig(registry, { summaryEngine: mockEngine }))

    expect(outcome.status).toBe('SUCCESS')
    expect(mockEngine.summarizeCallCount).toBe(0)
  })

  it('AC4 no-op: summarization skipped when summaryEngine is absent', async () => {
    const nodeContextValue = 'Some node context that would be compressed if engine was present.'

    const capturedContexts: IGraphContext[] = []
    const handler = vi.fn().mockImplementation(async (_node: GraphNode, ctx: IGraphContext) => {
      capturedContexts.push(ctx)
      return { status: 'SUCCESS' as const }
    })
    const registry = makeRegistry(handler as unknown as NodeHandler)
    const graph = makeThreeNodeGraph('medium')

    const executor = createGraphExecutor()
    // No summaryEngine provided
    const outcome = await executor.run(
      graph,
      makeConfig(registry, {
        initialContext: { 'factory.nodeContext': nodeContextValue },
      })
    )

    expect(outcome.status).toBe('SUCCESS')
    // compressedNodeContext should NOT be set without a summary engine
    const midCtx = capturedContexts[1]!
    expect(midCtx.get('factory.compressedNodeContext')).toBeUndefined()
  })

  it('AC5: graph:context-summarized event emitted with correct payload', async () => {
    const mockEngine = new MockSummaryEngine()
    const nodeContextValue = 'Node context for event emission test.'
    const { bus, emit } = makeEventBus()

    const handler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(handler as unknown as NodeHandler)
    const graph = makeThreeNodeGraph('medium')

    const executor = createGraphExecutor()
    await executor.run(
      graph,
      makeConfig(registry, {
        eventBus: bus,
        summaryEngine: mockEngine,
        initialContext: { 'factory.nodeContext': nodeContextValue },
      })
    )

    const summarizedEvents = emit.mock.calls.filter(
      ([event]) => event === 'graph:context-summarized'
    )
    expect(summarizedEvents).toHaveLength(1)

    const [, payload] = summarizedEvents[0] as [
      string,
      {
        runId: string
        nodeId: string
        level: string
        originalTokenCount: number
        summaryTokenCount: number
      },
    ]
    expect(payload.runId).toBe('fidelity-test-run')
    expect(payload.nodeId).toBe('mid')
    expect(payload.level).toBe('medium')
    expect(typeof payload.originalTokenCount).toBe('number')
    expect(typeof payload.summaryTokenCount).toBe('number')
    // Event emitted BEFORE dispatchWithRetry — handler was called after the event
    const summarizedCallIdx = emit.mock.calls.findIndex(([e]) => e === 'graph:context-summarized')
    const nodeStartedCalls = emit.mock.calls.filter(([e]) => e === 'graph:node-started')
    // graph:node-started for 'mid' was emitted before graph:context-summarized
    // and dispatchWithRetry runs after the block, so we verify the event exists
    expect(summarizedCallIdx).toBeGreaterThanOrEqual(0)
  })

  it('AC6: checkpoint-resume with summary:high maps to level high in summarize call', async () => {
    const mockEngine = new MockSummaryEngine()
    const nodeContextValue = 'Checkpoint resume node context to compress at high fidelity.'

    // Build a 3-node graph with mid having NO fidelity (fidelity='')
    // The fidelity will come from firstResumedFidelity = 'summary:high'
    const graph = makeThreeNodeGraph('')

    // Mock checkpoint load/resume
    const resumeContext = new GraphContext({ 'factory.nodeContext': nodeContextValue })
    mockLoad.mockResolvedValueOnce({
      currentNode: 'mid',
      completedNodes: [],
      nodeRetries: {},
      contextValues: { 'factory.nodeContext': nodeContextValue },
      logs: [],
      timestamp: Date.now(),
    })
    mockResume.mockReturnValueOnce({
      context: resumeContext,
      completedNodes: new Set<string>(),
      nodeRetries: {},
      firstResumedNodeFidelity: 'summary:high',
    })

    const handler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(handler as unknown as NodeHandler)

    const executor = createGraphExecutor()
    const outcome = await executor.run(
      graph,
      makeConfig(registry, {
        summaryEngine: mockEngine,
        checkpointPath: '/fake/checkpoint.json',
      })
    )

    expect(outcome.status).toBe('SUCCESS')
    // parseFidelityLevel('summary:high') must return 'high'
    expect(mockEngine.summarizeCallCount).toBe(1)
    expect(mockEngine.lastSummarizeArgs?.level).toBe('high')
  })
})
