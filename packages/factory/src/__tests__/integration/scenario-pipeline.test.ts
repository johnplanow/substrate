/**
 * Integration tests: Scenario routing and convergence (Story 44-10 AC1, AC2).
 *
 * Verifies that the full pipeline — parse → validate → tool handler → edge routing — works
 * end-to-end with a mocked child_process.spawn:
 *
 *   AC1: 2/3 pass → satisfaction_score ≈ 0.667 → condition false → route → implement (retry)
 *   AC2: 3/3 pass on second iteration → satisfaction_score = 1.0 → route → exit (converges)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock is hoisted automatically — must appear before imports that use spawn
// Use importOriginal to preserve exec/execFile/etc. — @substrate-ai/core uses them
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

import { spawn } from 'child_process'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { conditionalHandler } from '../../handlers/conditional.js'
import { createToolHandler } from '../../handlers/tool.js'
import { evaluateCondition } from '../../graph/condition-parser.js'
import {
  makeTmpDir,
  cleanDir,
  makeEventSpy,
  buildScenarioRunResult,
  createMockSpawnProcess,
  readFixtureDot,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn)

/** Create a registry suitable for scenario pipeline integration tests.
 *
 * - start/exit/conditional use real handlers
 * - tool nodes use the real tool handler (spawn is mocked at module level)
 * - codergen (box shape) / default use a synchronous mock SUCCESS handler
 */
function createTestRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  // Real handlers for structural nodes
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register('conditional', conditionalHandler)
  // Real tool handler — child_process.spawn is mocked in this module
  registry.register('tool', createToolHandler())
  // Mock handler for codergen / unrecognised nodes (e.g. implement [shape=box])
  const mockSuccess = async () => ({ status: 'SUCCESS' as const })
  registry.register('codergen', mockSuccess)
  // Shape mappings
  registry.registerShape('Mdiamond', 'start')
  registry.registerShape('Msquare', 'exit')
  registry.registerShape('diamond', 'conditional')
  registry.registerShape('box', 'codergen')
  registry.registerShape('parallelogram', 'tool')
  // Default fallback: mock success
  registry.setDefault(mockSuccess)
  return registry
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let logsRoot: string

beforeEach(async () => {
  logsRoot = await makeTmpDir()
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanDir(logsRoot)
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// AC1: First iteration routes back to implement
// ---------------------------------------------------------------------------

describe('AC1: first iteration — 2/3 pass, route to implement', () => {
  it('AC1a: edge-selected from route points to implement on first iteration', async () => {
    // Mock spawn: call 1 → 2/3, call 2 → 3/3 (needed for the executor to terminate)
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readFixtureDot())
    const { bus, events } = makeEventSpy()
    const registry = createTestRegistry()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac1a',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    // Collect all graph:edge-selected events from the route node
    const routeEdgeSelections = events.filter(
      (e) =>
        e.event === 'graph:edge-selected' &&
        (e.payload as Record<string, unknown>)['fromNode'] === 'route',
    )
    // The FIRST route selection should be the retry path back to implement
    expect(routeEdgeSelections.length).toBeGreaterThanOrEqual(1)
    expect((routeEdgeSelections[0]?.payload as Record<string, unknown>)['toNode']).toBe('implement')
  })

  it('AC1b: satisfaction_score ≈ 2/3 after first validate node execution', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readFixtureDot())
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac1b',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus: bus,
    })

    // Find the first graph:node-completed event for the validate node
    const validateCompletions = events.filter(
      (e) =>
        e.event === 'graph:node-completed' &&
        (e.payload as Record<string, unknown>)['nodeId'] === 'validate',
    )
    expect(validateCompletions.length).toBeGreaterThanOrEqual(1)
    const firstValidateOutcome = (
      validateCompletions[0]?.payload as Record<string, unknown>
    )['outcome'] as Record<string, unknown>
    const contextUpdates = firstValidateOutcome['contextUpdates'] as Record<string, number>
    expect(contextUpdates['satisfaction_score']).toBeCloseTo(2 / 3, 5)
  })

  it('AC1c: satisfaction_score>=0.8 condition evaluates to false for score 0.667', () => {
    // Direct condition evaluator test — no executor needed
    const context = { satisfaction_score: 2 / 3 }
    expect(evaluateCondition('satisfaction_score>=0.8', context)).toBe(false)
  })

  it('AC1c-variant: condition evaluates to true for score 1.0', () => {
    const context = { satisfaction_score: 1.0 }
    expect(evaluateCondition('satisfaction_score>=0.8', context)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC2: Two-iteration convergence — graph terminates at exit
// ---------------------------------------------------------------------------

describe('AC2: two-iteration convergence', () => {
  it('AC2a: executor returns SUCCESS when second iteration passes all scenarios', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readFixtureDot())
    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-ac2a',
      logsRoot,
      handlerRegistry: createTestRegistry(),
    })

    expect(outcome.status).toBe('SUCCESS')
  })

  it('AC2b: satisfaction_score equals 1.0 after second validate execution', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readFixtureDot())
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac2b',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus: bus,
    })

    const validateCompletions = events.filter(
      (e) =>
        e.event === 'graph:node-completed' &&
        (e.payload as Record<string, unknown>)['nodeId'] === 'validate',
    )
    expect(validateCompletions.length).toBe(2)
    // Second validate should have satisfaction_score = 1.0
    const secondValidateOutcome = (
      validateCompletions[1]?.payload as Record<string, unknown>
    )['outcome'] as Record<string, unknown>
    const contextUpdates = secondValidateOutcome['contextUpdates'] as Record<string, number>
    expect(contextUpdates['satisfaction_score']).toBe(1.0)
  })

  it('AC2c: last edge-selected from route targets exit node', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readFixtureDot())
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac2c',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus: bus,
    })

    // Collect all route→* edge selections
    const routeEdgeSelections = events.filter(
      (e) =>
        e.event === 'graph:edge-selected' &&
        (e.payload as Record<string, unknown>)['fromNode'] === 'route',
    )
    expect(routeEdgeSelections.length).toBe(2)
    // The LAST selection should be to exit
    const lastRouteEdge = routeEdgeSelections[routeEdgeSelections.length - 1]
    expect((lastRouteEdge?.payload as Record<string, unknown>)['toNode']).toBe('exit')
  })

  it('AC2d: validate node is executed exactly twice across both iterations', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readFixtureDot())
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac2d',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus: bus,
    })

    const validateCompletions = events.filter(
      (e) =>
        e.event === 'graph:node-completed' &&
        (e.payload as Record<string, unknown>)['nodeId'] === 'validate',
    )
    expect(validateCompletions).toHaveLength(2)
  })

  it('graph is valid per the validator (zero error diagnostics)', () => {
    const graph = parseGraph(readFixtureDot())
    const validator = createValidator()
    const diagnostics = validator.validate(graph)
    const errors = diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  it('fixture graph has exactly 5 nodes', () => {
    const graph = parseGraph(readFixtureDot())
    expect(graph.nodes.size).toBe(5)
  })

  it('fixture graph has start and exit nodes', () => {
    const graph = parseGraph(readFixtureDot())
    expect(graph.startNode().id).toBe('start')
    expect(graph.exitNode().id).toBe('exit')
  })

  it('spawn is called exactly twice for a two-iteration convergence run', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    await createGraphExecutor().run(parseGraph(readFixtureDot()), {
      runId: 'test-spawn-count',
      logsRoot,
      handlerRegistry: createTestRegistry(),
    })

    expect(mockSpawn).toHaveBeenCalledTimes(2)
  })
})
