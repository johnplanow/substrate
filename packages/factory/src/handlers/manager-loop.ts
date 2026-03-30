/**
 * Manager Loop handler — supervises and repeatedly executes a body subgraph,
 * implementing autonomous refinement cycles with configurable stop conditions
 * and stall-recovery steering.
 *
 * Story 50-8.
 *
 * Reads:  `node.attrs['graph_file']`   — path to the body .dot file
 * Reads:  `node.attrs['max_cycles']`   — maximum number of loop iterations (default 10)
 * Reads:  `node.attrs['stop_condition']` — context key or `llm:` prefixed question
 * Writes: `manager_loop.cycle`          — current 1-based cycle number
 * Writes: `manager_loop.cycles_completed` — count of completed cycles
 * Writes: `manager_loop.last_outcome`  — body executor outcome status
 * Writes: `manager_loop.stop_reason`   — "max_cycles" or "stop_condition"
 * Writes: `manager_loop.steering.mode`  — "normal" or "recovery"
 * Writes: `manager_loop.steering.hints` — hint strings for stall recovery
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseGraph } from '../graph/parser.js'
import { createGraphExecutor } from '../graph/executor.js'
import { createValidator } from '../graph/validator.js'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from './types.js'
import { isLlmCondition, evaluateLlmCondition, extractLlmQuestion } from '../graph/llm-evaluator.js'

// ---------------------------------------------------------------------------
// ManagerLoopHandlerOptions
// ---------------------------------------------------------------------------

export interface ManagerLoopHandlerOptions {
  /** Registry used to resolve node handlers inside the body graph each cycle. */
  handlerRegistry: IHandlerRegistry
  /**
   * Injectable LLM call function for `llm:` prefix stop conditions.
   * When absent, LLM stop conditions always evaluate to `false`.
   */
  llmCall?: (prompt: string) => Promise<string>
  /** Base directory for resolving relative graph_file paths. Default: process.cwd() */
  baseDir?: string
  /**
   * Injectable file loader for testability.
   * Defaults to `(fp) => readFile(fp, 'utf-8')`.
   */
  graphFileLoader?: (filePath: string) => Promise<string>
  /**
   * Root directory for body executor checkpoint/log files.
   * Defaults to `os.tmpdir()`.
   */
  logsRoot?: string
  /**
   * Number of consecutive non-SUCCESS cycles before steering is injected.
   * Default: 2.
   */
  maxStallCycles?: number
}

// ---------------------------------------------------------------------------
// createManagerLoopHandler
// ---------------------------------------------------------------------------

/**
 * Factory function that creates a handler for `type="stack.manager_loop"` nodes.
 *
 * Each invocation loads the body graph once, then executes it in a loop for up
 * to `max_cycles` cycles (default 10). Stop conditions (context key or LLM-based)
 * allow early exit. Stall detection injects recovery steering after consecutive
 * non-SUCCESS body executions.
 */
export function createManagerLoopHandler(options: ManagerLoopHandlerOptions): NodeHandler {
  return async (node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // -----------------------------------------------------------------------
    // Step 1: Validate graph_file attribute
    // -----------------------------------------------------------------------
    const graphFile = node.attrs?.['graph_file']
    if (!graphFile) {
      return {
        status: 'FAILURE',
        failureReason: `Manager loop node "${node.id}" is missing required attribute graph_file`,
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Parse max_cycles (default 10, NaN → 10, clamp to ≥1)
    // -----------------------------------------------------------------------
    const rawMaxCycles = node.attrs?.['max_cycles']
    let maxCycles = 10
    if (rawMaxCycles !== undefined && rawMaxCycles !== '') {
      const parsed = parseInt(rawMaxCycles, 10)
      maxCycles = isNaN(parsed) ? 10 : Math.max(1, parsed)
    }

    // -----------------------------------------------------------------------
    // Step 3: Resolve body graph file path
    // -----------------------------------------------------------------------
    const filePath = path.isAbsolute(graphFile)
      ? graphFile
      : path.join(options.baseDir ?? process.cwd(), graphFile)

    // -----------------------------------------------------------------------
    // Step 4: Load body graph ONCE (injectable loader for testability)
    // -----------------------------------------------------------------------
    const loader = options.graphFileLoader ?? ((fp) => readFile(fp, 'utf-8'))
    let dotSource: string
    try {
      dotSource = await loader(filePath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Manager loop node "${node.id}": failed to load "${filePath}": ${msg}`,
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: Parse body graph
    // -----------------------------------------------------------------------
    let bodyGraph: Graph
    try {
      bodyGraph = parseGraph(dotSource)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Manager loop node "${node.id}": failed to parse "${filePath}": ${msg}`,
      }
    }

    // -----------------------------------------------------------------------
    // Step 6: Validate body graph
    // -----------------------------------------------------------------------
    try {
      createValidator().validateOrRaise(bodyGraph)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        status: 'FAILURE',
        failureReason: `Manager loop node "${node.id}": validation failed for "${filePath}": ${msg}`,
      }
    }

    // -----------------------------------------------------------------------
    // Step 7: Read stop condition attribute
    // -----------------------------------------------------------------------
    const stopCondition = node.attrs?.['stop_condition']

    // -----------------------------------------------------------------------
    // Step 8: Main cycle loop
    // -----------------------------------------------------------------------
    let consecutiveFailures = 0

    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      // 8.1: Update current cycle number
      context.set('manager_loop.cycle', cycle)

      // 8.2: Build body executor config (no checkpointPath — always fresh)
      const bodyConfig = {
        runId: randomUUID(),
        logsRoot: options.logsRoot ?? tmpdir(),
        handlerRegistry: options.handlerRegistry,
        initialContext: context.snapshot(),
      }

      // 8.3: Execute body graph
      const bodyOutcome = await createGraphExecutor().run(bodyGraph, bodyConfig)

      // 8.4: Merge body context updates into parent
      if (bodyOutcome.contextUpdates) {
        context.applyUpdates(bodyOutcome.contextUpdates)
      }

      // 8.5: Update telemetry
      context.set('manager_loop.cycles_completed', cycle)
      context.set('manager_loop.last_outcome', bodyOutcome.status)

      // 8.6: Stall detection (before stop condition evaluation)
      if (bodyOutcome.status === 'SUCCESS') {
        consecutiveFailures = 0
        context.set('manager_loop.steering.mode', 'normal')
        context.set('manager_loop.steering.hints', [])
      } else {
        consecutiveFailures++
        if (consecutiveFailures >= (options.maxStallCycles ?? 2)) {
          context.set('manager_loop.steering.mode', 'recovery')
          context.set('manager_loop.steering.hints', [
            `Previous ${consecutiveFailures} attempts returned ${bodyOutcome.status}. Consider a different strategy.`,
            'Review context state and adjust approach before retrying.',
          ])
        }
      }

      // 8.7: Stop condition evaluation (after stall detection)
      if (stopCondition) {
        let shouldStop = false

        if (isLlmCondition(stopCondition)) {
          // LLM-evaluated stop condition
          if (options.llmCall !== undefined) {
            const question = extractLlmQuestion(stopCondition)
            shouldStop = await evaluateLlmCondition(question, context.snapshot(), options.llmCall)
          }
          // If no llmCall provided, always false — loop continues
        } else {
          // Context key truthiness
          shouldStop = Boolean(context.get(stopCondition))
        }

        if (shouldStop) {
          context.set('manager_loop.stop_reason', 'stop_condition')
          return { status: 'SUCCESS' }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 9: Max cycles reached
    // -----------------------------------------------------------------------
    context.set('manager_loop.stop_reason', 'max_cycles')
    return { status: 'SUCCESS' }
  }
}
