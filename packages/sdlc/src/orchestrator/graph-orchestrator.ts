/**
 * GraphOrchestrator — drives the SDLC pipeline as a factory graph.
 *
 * Story 43-7: GraphOrchestrator multi-story orchestration.
 * Story 43-8: applyConfigToGraph config-to-graph mapping (duck-typed, ADR-003 compliant).
 * Story 43-10: resolveGraphPath helper; eventBus/pipelineRunId/maxReviewCycles in config;
 *              per-story outcome tracking in GraphRunSummary.
 *
 * ADR-003: NO imports from @substrate-ai/factory in this file.
 * All factory-side types are accepted via locally-defined duck-typed
 * interfaces injected through GraphOrchestratorConfig.
 */

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSdlcEventBridge } from '../handlers/event-bridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Story 43-10: resolveGraphPath helper
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the bundled SDLC pipeline DOT file.
 *
 * Resolution order:
 *   1. Relative to __dirname (works in source/unbundled: __dirname = packages/sdlc/src/orchestrator/)
 *   2. Via createRequire to locate @substrate-ai/sdlc package.json, then graphs/ relative to it
 *      (works when bundled: __dirname points to dist/ but createRequire finds the real package)
 *
 * @throws {Error} if the DOT file cannot be found by any method.
 */
export function resolveGraphPath(): string {
  const candidates = [
    // Method 1: relative to source file (works in unbundled / workspace mode)
    join(__dirname, '../../graphs/sdlc-pipeline.dot'),
    // Method 2: relative to dist/ directory (works when bundled via tsdown postbuild copy)
    join(__dirname, '../graphs/sdlc-pipeline.dot'),
    join(__dirname, 'graphs/sdlc-pipeline.dot'),
  ]

  // Method 3: resolve via createRequire (works in npm-installed mode)
  try {
    const require = createRequire(import.meta.url)
    const sdlcPkgPath = require.resolve('@substrate-ai/sdlc/package.json')
    candidates.push(join(dirname(sdlcPkgPath), 'graphs', 'sdlc-pipeline.dot'))
  } catch {
    // createRequire resolution failed — continue with other candidates
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `Cannot locate sdlc-pipeline.dot. Searched:\n${candidates.map((c) => `  ${c}`).join('\n')}`,
  )
}

// ---------------------------------------------------------------------------
// Story 43-7: Duck-typed factory shapes (ADR-003: NO imports from @substrate-ai/factory)
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for a factory graph object.
 * Duck-typed from `@substrate-ai/factory`'s `Graph` — no direct import.
 */
export interface GraphShape {
  nodes: Array<{ id: string; type: string; label: string; prompt: string }>
  edges: Array<{ from: string; to: string; label?: string }>
}

/**
 * Configuration passed to the executor for a single graph run.
 * Duck-typed from `@substrate-ai/factory`'s `GraphExecutorConfig`.
 */
export interface GraphRunConfig {
  runId: string
  logsRoot: string
  handlerRegistry: unknown
  initialContext?: Record<string, unknown>
  eventBus?: unknown
}

/**
 * Result returned by the executor for a single graph run.
 * Duck-typed from `@substrate-ai/factory`'s `Outcome`.
 * Maps StageStatus: 'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED'
 */
export interface GraphRunResult {
  status: 'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED' | string
}

/**
 * Duck-typed executor contract — structurally compatible with `GraphExecutor` from factory.
 */
export interface IGraphExecutorLocal {
  run(graph: GraphShape, config: GraphRunConfig): Promise<GraphRunResult>
}

// ---------------------------------------------------------------------------
// Story 43-7: Conflict grouper types
// ---------------------------------------------------------------------------

/**
 * Batched conflict groups: outer = batches (sequential), middle = groups
 * (sequential within batch), inner = story keys (sequential within group).
 */
export type ConflictGroupBatches = string[][][]

/**
 * Function that partitions story keys into ordered batches of conflict groups.
 * Injected by the CLI composition root (story 43-10).
 */
export type ConflictGrouperFn = (storyKeys: string[]) => ConflictGroupBatches

// ---------------------------------------------------------------------------
// Story 43-7/43-10: Public config / result / orchestrator types
// ---------------------------------------------------------------------------

/**
 * Configuration for `createGraphOrchestrator`.
 *
 * All factory-side objects (`graph`, `executor`, `handlerRegistry`) are injected
 * here — the orchestrator never imports `@substrate-ai/factory` directly (ADR-003).
 */
export interface GraphOrchestratorConfig {
  /** Pre-parsed graph object (structurally compatible with factory's Graph). */
  graph: GraphShape
  /** Executor that runs a single story graph instance. */
  executor: IGraphExecutorLocal
  /** Handler registry passed through to executor config. */
  handlerRegistry: unknown
  /** Absolute path to the project root. */
  projectRoot: string
  /** Methodology pack identifier passed to each story graph instance. */
  methodologyPack: string
  /** Maximum number of concurrent story graph executor instances. */
  maxConcurrency: number
  /** Directory under which per-story run logs are written. */
  logsRoot: string
  /** Unique identifier for this orchestration run. */
  runId: string
  /**
   * Optional conflict group partitioner. If omitted, each story runs in its own
   * single-item group within a single batch (fully parallel up to maxConcurrency).
   */
  conflictGrouper?: ConflictGrouperFn
  /**
   * Milliseconds to pause between stories within the same conflict group.
   * Reduces memory pressure during long runs. Defaults to 2000.
   */
  gcPauseMs?: number
  /**
   * Optional SDLC event bus that receives translated orchestrator events via the
   * SDLC event bridge (story 43-9). When provided, graph executor lifecycle events
   * are translated into `orchestrator:story-phase-*` events for downstream consumers.
   * (story 43-10: wired by CLI composition root)
   */
  eventBus?: unknown
  /**
   * Optional pipeline run ID forwarded to SDLC event bridge payloads.
   * Included as `pipelineRunId` in `orchestrator:story-phase-start/complete` events.
   * (story 43-10)
   */
  pipelineRunId?: string
  /**
   * Maximum number of code-review + fix cycles per story.
   * Forwarded to the graph via `applyConfigToGraph` before execution and
   * stored here for observability / testing (AC7, story 43-10).
   */
  maxReviewCycles?: number
}

/**
 * Per-story outcome detail in `GraphRunSummary`.
 * Story 43-10: added for normalisation by the CLI composition root.
 */
export interface GraphStoryOutcome {
  outcome: 'SUCCESS' | 'FAILED' | 'ESCALATED'
  error?: string
}

/** Summary returned by `GraphOrchestrator.run()` after all stories complete. */
export interface GraphRunSummary {
  successCount: number
  failureCount: number
  totalStories: number
  /**
   * Per-story outcome map.
   * Key = story key passed to `run()`; value = outcome detail.
   * Added in story 43-10 so the CLI composition root can map results to the
   * linear orchestrator's `{ stories: Record<string, { phase: string }> }` shape.
   */
  stories: Record<string, GraphStoryOutcome>
}

/** Multi-story graph orchestrator interface (story 43-7). */
export interface GraphOrchestrator {
  run(storyKeys: string[]): Promise<GraphRunSummary>
}

/** Thrown by `createGraphOrchestrator` when the supplied graph is structurally invalid. */
export class GraphOrchestratorInitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphOrchestratorInitError'
  }
}

// ---------------------------------------------------------------------------
// Story 43-7/43-10: Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a `GraphOrchestrator` that runs one graph executor instance per
 * concurrent story slot, with conflict-group serialization and bounded concurrency.
 *
 * When `config.eventBus` is provided, a per-story SDLC event bridge is created
 * to translate factory `graph:*` events into `orchestrator:story-*` events (AC4,
 * story 43-10).
 *
 * @throws {GraphOrchestratorInitError} if `config.graph` is missing `nodes` or `edges`.
 */
export function createGraphOrchestrator(config: GraphOrchestratorConfig): GraphOrchestrator {
  if (!config.graph?.nodes || !config.graph?.edges) {
    throw new GraphOrchestratorInitError('Invalid graph: missing nodes or edges arrays')
  }

  const gcPauseMs = config.gcPauseMs ?? 2000

  async function runStoryGraph(
    storyKey: string,
    summary: { s: number; f: number; stories: Record<string, GraphStoryOutcome> },
  ): Promise<void> {
    const initialContext = {
      storyKey,
      projectRoot: config.projectRoot,
      methodologyPack: config.methodologyPack,
      ...(config.pipelineRunId !== undefined ? { runId: config.pipelineRunId, pipelineRunId: config.pipelineRunId } : {}),
    }

    // Create a per-story factory event bus so each story's graph events are scoped
    // to its own execution. The executor emits graph:* events on this bus.
    const factoryBus = new EventEmitter()

    // Wire up the SDLC event bridge if an SDLC event bus has been provided (story 43-9).
    // The bridge translates factory graph:* events into orchestrator:story-* events.
    const bridge =
      config.eventBus != null
        ? createSdlcEventBridge({
            storyKey,
            ...(config.pipelineRunId !== undefined ? { pipelineRunId: config.pipelineRunId } : {}),
            sdlcBus: config.eventBus as { emit(event: string, payload: unknown): void },
            graphEvents: factoryBus as unknown as {
              on(event: string, handler: (data: unknown) => void): typeof factoryBus
              off(event: string, handler: (data: unknown) => void): typeof factoryBus
            },
          })
        : undefined

    // Track whether the executor escalated this story (goal gate unsatisfied after max retries)
    let escalated = false
    factoryBus.on('graph:goal-gate-unsatisfied', () => { escalated = true })

    let result: GraphRunResult | undefined
    try {
      result = await config.executor.run(config.graph, {
        runId: `${config.runId}:${storyKey}`,
        logsRoot: config.logsRoot,
        handlerRegistry: config.handlerRegistry,
        initialContext,
        eventBus: factoryBus,
      })
    } catch (err: unknown) {
      // Record failure — bridge teardown happens in finally
      const errMsg = err instanceof Error ? err.message : String(err)
      summary.stories[storyKey] = { outcome: escalated ? 'ESCALATED' : 'FAILED', error: errMsg }
      summary.f++
    } finally {
      // Always teardown the bridge to remove graph event listeners (AC7)
      bridge?.teardown()
    }

    if (result === undefined) {
      // Executor threw — outcome already recorded in catch block
      return
    }

    if (result.status === 'SUCCESS') {
      summary.stories[storyKey] = { outcome: 'SUCCESS' }
      summary.s++
    } else if (escalated) {
      summary.stories[storyKey] = { outcome: 'ESCALATED' }
      summary.f++
    } else {
      summary.stories[storyKey] = { outcome: 'FAILED' }
      summary.f++
    }
  }

  async function runGroup(
    group: string[],
    summary: { s: number; f: number; stories: Record<string, GraphStoryOutcome> },
  ): Promise<void> {
    for (const storyKey of group) {
      await runStoryGraph(storyKey, summary)
      if (gcPauseMs > 0) await new Promise<void>((r) => setTimeout(r, gcPauseMs))
    }
  }

  async function runBatch(
    groups: string[][],
    summary: { s: number; f: number; stories: Record<string, GraphStoryOutcome> },
  ): Promise<void> {
    const queue = [...groups]
    const active: Promise<void>[] = []

    while (queue.length > 0 || active.length > 0) {
      while (active.length < config.maxConcurrency && queue.length > 0) {
        const group = queue.shift()!
        const p: Promise<void> = runGroup(group, summary).finally(() => {
          active.splice(active.indexOf(p), 1)
        })
        active.push(p)
      }
      if (active.length > 0) await Promise.race(active)
    }
  }

  return {
    async run(storyKeys: string[]): Promise<GraphRunSummary> {
      const grouper = config.conflictGrouper ?? ((keys) => [keys.map((k) => [k])])
      const batches = grouper(storyKeys)
      const summary: { s: number; f: number; stories: Record<string, GraphStoryOutcome> } = {
        s: 0,
        f: 0,
        stories: {},
      }
      for (const batchGroups of batches) {
        await runBatch(batchGroups, summary)
      }
      return {
        successCount: summary.s,
        failureCount: summary.f,
        totalStories: storyKeys.length,
        stories: summary.stories,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Story 43-8: applyConfigToGraph
// ---------------------------------------------------------------------------

/**
 * Duck-typed graph interface for config patching.
 * Structurally compatible with `@substrate-ai/factory`'s `Graph` (Map-based nodes)
 * without requiring a direct import (ADR-003 compliant).
 */
interface PatchableGraph {
  nodes: { get(id: string): { maxRetries?: number } | undefined }
}

/**
 * Options accepted by `applyConfigToGraph`.
 */
export interface ApplyConfigOptions {
  maxReviewCycles: number
}

/**
 * Patches the loaded SDLC pipeline graph to reflect runtime configuration.
 *
 * Currently maps `maxReviewCycles` → `dev_story.maxRetries` (1:1 mapping).
 * Both values represent the number of *additional* retry attempts (not total).
 *
 * Must be called after parseGraph() and before any story graph instance runs.
 *
 * @param graph  A factory Graph (Map-based nodes) duck-typed as PatchableGraph.
 * @param options  Runtime configuration to apply.
 * @throws {Error} if the graph does not contain a `dev_story` node.
 */
export function applyConfigToGraph(graph: PatchableGraph, options: ApplyConfigOptions): void {
  const devStoryNode = graph.nodes.get('dev_story')
  if (!devStoryNode) {
    throw new Error("applyConfigToGraph: graph does not contain a 'dev_story' node")
  }
  devStoryNode.maxRetries = options.maxReviewCycles
}
