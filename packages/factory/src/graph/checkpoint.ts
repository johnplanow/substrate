/**
 * CheckpointManager — serializes and restores graph execution state.
 *
 * Writes a spec-compliant JSON checkpoint after each completed node and
 * can restore that state for resume, allowing graph runs to survive
 * process crashes without re-executing already-finished work.
 *
 * Story 42-13.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Checkpoint, ResumeState, Graph, IGraphContext } from './types.js'
import { GraphContext } from './context.js'

/**
 * Parameters passed to `CheckpointManager.save()`.
 */
export interface CheckpointSaveParams {
  currentNode: string
  completedNodes: string[]
  nodeRetries: Record<string, number>
  context: IGraphContext
  logs?: string[]
}

/**
 * Manages checkpoint serialization and restoration for the graph executor.
 */
export class CheckpointManager {
  /**
   * Persist execution state to `{logsRoot}/checkpoint.json`.
   *
   * Creates `logsRoot` (and any missing parent directories) if absent.
   * The resulting JSON file contains all six spec-mandated fields.
   *
   * @param logsRoot  Directory in which to write `checkpoint.json`.
   * @param params    Current execution state to serialize.
   */
  async save(logsRoot: string, params: CheckpointSaveParams): Promise<void> {
    // Create directory (and parents) if absent; no-op if already exists.
    await mkdir(logsRoot, { recursive: true })

    const checkpoint: Checkpoint = {
      timestamp: Date.now(),
      currentNode: params.currentNode,
      completedNodes: params.completedNodes,
      nodeRetries: params.nodeRetries,
      contextValues: params.context.snapshot(),
      logs: params.logs ?? [],
    }

    const json = JSON.stringify(checkpoint, null, 2)
    const filePath = path.join(logsRoot, 'checkpoint.json')
    await writeFile(filePath, json, 'utf-8')
  }

  /**
   * Load and deserialize a checkpoint from disk.
   *
   * Errors from `readFile` (file not found) or `JSON.parse` (corrupt file)
   * propagate naturally to the caller.
   *
   * @param checkpointPath  Absolute path to the `checkpoint.json` file.
   * @returns The deserialized `Checkpoint` object.
   */
  async load(checkpointPath: string): Promise<Checkpoint> {
    const raw = await readFile(checkpointPath, 'utf-8')
    return JSON.parse(raw) as Checkpoint
  }

  /**
   * Restore execution state from a checkpoint and return a `ResumeState`
   * that the executor uses to skip completed nodes and seed the context.
   *
   * If the last completed node used `fidelity="full"`, the first resumed
   * node must use `"summary:high"` because in-memory LLM sessions cannot
   * be serialized across process boundaries.
   *
   * This method is synchronous — all inputs are already in-memory.
   *
   * @param graph       The parsed factory graph for the current run.
   * @param checkpoint  The deserialized checkpoint to restore from.
   * @returns A `ResumeState` ready for use by the executor.
   */
  resume(graph: Graph, checkpoint: Checkpoint): ResumeState {
    const context = new GraphContext(checkpoint.contextValues)
    const completedNodes = new Set(checkpoint.completedNodes)
    const nodeRetries = { ...checkpoint.nodeRetries }

    // Determine fidelity degradation for the first resumed node.
    // If the last-executed node used 'full' fidelity, the LLM session cannot
    // be restored from disk, so the first resumed node must use 'summary:high'.
    const lastNode = graph.nodes.get(checkpoint.currentNode)
    const firstResumedNodeFidelity = lastNode?.fidelity === 'full' ? 'summary:high' : ''

    return { context, completedNodes, nodeRetries, firstResumedNodeFidelity }
  }
}
