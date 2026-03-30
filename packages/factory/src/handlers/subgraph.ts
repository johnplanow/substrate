/**
 * Subgraph handler — executes a referenced .dot graph file as a nested sub-pipeline.
 *
 * Story 50-5.
 *
 * Reads:  `node.attrs['graph_file']` — relative or absolute path to a .dot file
 * Reads:  `context.getNumber('subgraph._depth', 0)` — current nesting depth
 * Writes: `subOutcome.contextUpdates` merged back into parent context
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseGraph } from '../graph/parser.js'
import { createGraphExecutor } from '../graph/executor.js'
import { createValidator } from '../graph/validator.js'
import { parseStylesheet } from '../stylesheet/parser.js'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from './types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'

// ---------------------------------------------------------------------------
// SubgraphHandlerOptions
// ---------------------------------------------------------------------------

/**
 * Configuration for `createSubgraphHandler`.
 */
export interface SubgraphHandlerOptions {
  /** Registry used to resolve node handlers inside the subgraph. */
  handlerRegistry: IHandlerRegistry
  /** Base directory for resolving relative graph_file paths. */
  baseDir: string
  /** Maximum nested subgraph depth (inclusive). Default: 5. */
  maxDepth?: number
  /**
   * Injectable file loader for testability.
   * Defaults to `(fp) => readFile(fp, 'utf-8')`.
   */
  graphFileLoader?: (filePath: string) => Promise<string>
  /**
   * Root directory for sub-executor checkpoint files.
   * Defaults to `os.tmpdir()`.
   */
  logsRoot?: string
  /** Optional event bus for emitting subgraph lifecycle events (story 50-9). */
  eventBus?: TypedEventBus<FactoryEvents>
  /** Optional run identifier threaded to event payloads (story 50-9). */
  runId?: string
}

// ---------------------------------------------------------------------------
// Status conversion helper
// ---------------------------------------------------------------------------

/**
 * Converts the sub-executor's `events.ts:StageStatus` back to the handler
 * return type `types.ts:OutcomeStatus`.
 *
 * Mapping:
 *   'SUCCESS'        → 'SUCCESS'
 *   'PARTIAL_SUCCESS'→ 'PARTIAL_SUCCESS'
 *   all others       → 'FAILURE'  (covers 'FAIL', 'RETRY', 'SKIPPED')
 */
function denormalizeStatus(status: string): Outcome['status'] {
  if (status === 'SUCCESS') return 'SUCCESS'
  if (status === 'PARTIAL_SUCCESS') return 'PARTIAL_SUCCESS'
  return 'FAILURE'
}

// ---------------------------------------------------------------------------
// createSubgraphHandler
// ---------------------------------------------------------------------------

/**
 * Factory function that creates a handler for `type="subgraph"` nodes.
 *
 * Each subgraph node references an external `.dot` file, loads and validates
 * it, then executes it as a nested sub-pipeline. Parent context is seeded into
 * the sub-executor and context updates from the subgraph are propagated back.
 */
export function createSubgraphHandler(options: SubgraphHandlerOptions): NodeHandler {
  return async (node: GraphNode, context: IGraphContext, graph: Graph): Promise<Outcome> => {
    // Step 1: Validate graph_file attribute
    const graphFile = node.attrs?.['graph_file']
    if (!graphFile) {
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}" is missing required attribute graph_file`,
      }
    }

    // Step 2: Depth guard
    const currentDepth = context.getNumber('subgraph._depth', 0)
    const maxDepth = options.maxDepth ?? 5
    if (currentDepth >= maxDepth) {
      return {
        status: 'FAILURE',
        failureReason: `Subgraph depth limit exceeded (max ${maxDepth}): node "${node.id}"`,
      }
    }

    // Step 3: Resolve file path
    const filePath = path.isAbsolute(graphFile)
      ? graphFile
      : path.join(options.baseDir, graphFile)

    // Step 4: Load file
    const loader = options.graphFileLoader ?? ((fp) => readFile(fp, 'utf-8'))
    let dotSource: string
    try {
      dotSource = await loader(filePath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": failed to load "${filePath}": ${msg}`,
      }
    }

    // Step 5: Parse
    let subgraph: Graph
    try {
      subgraph = parseGraph(dotSource)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": failed to parse "${filePath}": ${msg}`,
      }
    }

    // Step 6: Validate
    try {
      createValidator().validateOrRaise(subgraph)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": validation failed for "${filePath}": ${msg}`,
      }
    }

    // Read runId from context (written by executor, story 50-9 AC4)
    const runId = context.getString('__runId', options.runId ?? 'unknown')

    // Emit graph:subgraph-started before sub-executor runs (story 50-9 AC2)
    options.eventBus?.emit('graph:subgraph-started', {
      runId,
      nodeId: node.id,
      graphFile: filePath,
      depth: currentDepth,
    })
    const subgraphStart = Date.now()

    // Step 7: Execute
    // Parse the parent graph's stylesheet to pass as inherited rules to the sub-executor.
    // `graph` here is the parent graph (third argument of the NodeHandler signature).
    const parentStylesheet = graph.modelStylesheet
      ? parseStylesheet(graph.modelStylesheet)
      : undefined
    const subConfig = {
      runId: randomUUID(),
      logsRoot: options.logsRoot ?? tmpdir(),
      handlerRegistry: options.handlerRegistry,
      initialContext: { ...context.snapshot(), 'subgraph._depth': currentDepth + 1 },
      // Pass eventBus through so nested graph events flow on the same bus (story 50-9 AC2)
      ...(options.eventBus !== undefined ? { eventBus: options.eventBus } : {}),
      // Only include inheritedStylesheet when defined (exactOptionalPropertyTypes: true)
      ...(parentStylesheet !== undefined ? { inheritedStylesheet: parentStylesheet } : {}),
    }

    let subOutcome: { status: string; contextUpdates?: Record<string, unknown>; notes?: string; failureReason?: string }
    try {
      subOutcome = await createGraphExecutor().run(subgraph, subConfig)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const durationMs = Date.now() - subgraphStart
      // Emit subgraph-completed on the failure/exception path (story 50-9 AC2)
      options.eventBus?.emit('graph:subgraph-completed', {
        runId,
        nodeId: node.id,
        graphFile: filePath,
        depth: currentDepth,
        status: 'FAIL',
        durationMs,
      })
      return {
        status: 'FAILURE',
        failureReason: `Subgraph node "${node.id}": executor threw: ${msg}`,
      }
    }

    const durationMs = Date.now() - subgraphStart

    // Emit graph:subgraph-completed after sub-executor returns (story 50-9 AC2)
    options.eventBus?.emit('graph:subgraph-completed', {
      runId,
      nodeId: node.id,
      graphFile: filePath,
      depth: currentDepth,
      status: subOutcome.status === 'SUCCESS' ? 'SUCCESS'
        : subOutcome.status === 'PARTIAL_SUCCESS' ? 'PARTIAL_SUCCESS'
        : 'FAIL',
      durationMs,
    })

    // Step 8: Merge context updates back to parent
    if (subOutcome.contextUpdates) {
      context.applyUpdates(subOutcome.contextUpdates)
    }

    // Step 9: Return translated outcome (only include optional fields when present)
    return {
      status: denormalizeStatus(subOutcome.status),
      ...(subOutcome.contextUpdates !== undefined && { contextUpdates: subOutcome.contextUpdates }),
      ...(subOutcome.notes !== undefined && { notes: subOutcome.notes }),
      ...(subOutcome.failureReason !== undefined && { failureReason: subOutcome.failureReason }),
    }
  }
}
