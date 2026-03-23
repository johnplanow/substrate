/**
 * RunStateManager — persists per-run artifacts to `.substrate/runs/{runId}/`.
 *
 * Writes:
 *   - `graph.dot`                              — raw DOT source on initRun()
 *   - `{nodeId}/status.json`                   — execution metadata for every node
 *   - `{nodeId}/prompt.md`                     — raw prompt template (codergen nodes)
 *   - `{nodeId}/response.md`                   — outcome.notes (codergen nodes)
 *   - `scenarios/{iteration}/manifest.json`    — captured ScenarioManifest
 *   - `scenarios/{iteration}/results.json`     — ScenarioRunResult (when provided)
 *
 * Does NOT replace CheckpointManager — both write to the same `logsRoot` directory
 * using idempotent `mkdir({ recursive: true })` calls.
 *
 * Story 44-7.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ScenarioManifest } from '../scenarios/index.js'
import type { ScenarioRunResult } from '../events.js'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RunStateManagerOptions {
  /** Absolute or relative path to the run directory (e.g. `.substrate/runs/r1`). */
  runDir: string
}

export interface NodeArtifacts {
  nodeId: string
  nodeType: string
  status: string          // StageStatus string value
  startedAt: number       // Date.now() before dispatch
  completedAt: number     // Date.now() after dispatch
  durationMs: number
  prompt?: string         // Raw prompt template (codergen nodes)
  response?: string       // outcome.notes (codergen nodes)
}

export interface ScenarioIterationArtifacts {
  iteration: number
  manifest: ScenarioManifest
  results?: ScenarioRunResult
}

// ---------------------------------------------------------------------------
// RunStateManager
// ---------------------------------------------------------------------------

export class RunStateManager {
  readonly runDir: string

  constructor(options: RunStateManagerOptions) {
    this.runDir = options.runDir
  }

  /**
   * Initialize the run directory and write the raw DOT source to `graph.dot`.
   * Idempotent — safe to call multiple times.
   */
  async initRun(dotSource: string): Promise<void> {
    await mkdir(this.runDir, { recursive: true })
    await writeFile(path.join(this.runDir, 'graph.dot'), dotSource)
  }

  /**
   * Write per-node artifacts to `{nodeId}/` within the run directory.
   *
   * Always writes `status.json`.
   * Writes `prompt.md` when `artifacts.prompt` is truthy.
   * Writes `response.md` when `artifacts.response` is truthy.
   */
  async writeNodeArtifacts(artifacts: NodeArtifacts): Promise<void> {
    const nodeDir = path.join(this.runDir, artifacts.nodeId)
    await mkdir(nodeDir, { recursive: true })

    // Always write status.json
    const statusPayload = {
      nodeId: artifacts.nodeId,
      nodeType: artifacts.nodeType,
      status: artifacts.status,
      startedAt: artifacts.startedAt,
      completedAt: artifacts.completedAt,
      durationMs: artifacts.durationMs,
    }
    await writeFile(
      path.join(nodeDir, 'status.json'),
      JSON.stringify(statusPayload, null, 2),
    )

    // Conditionally write prompt.md
    if (artifacts.prompt) {
      await writeFile(path.join(nodeDir, 'prompt.md'), artifacts.prompt)
    }

    // Conditionally write response.md
    if (artifacts.response) {
      await writeFile(path.join(nodeDir, 'response.md'), artifacts.response)
    }
  }

  /**
   * Write per-iteration scenario artifacts to `scenarios/{iteration}/` within the run directory.
   *
   * Always writes `manifest.json`.
   * Writes `results.json` when `artifacts.results` is provided (truthy).
   */
  async writeScenarioIteration(artifacts: ScenarioIterationArtifacts): Promise<void> {
    const iterDir = path.join(this.runDir, 'scenarios', String(artifacts.iteration))
    await mkdir(iterDir, { recursive: true })

    await writeFile(
      path.join(iterDir, 'manifest.json'),
      JSON.stringify(artifacts.manifest, null, 2),
    )

    if (artifacts.results) {
      await writeFile(
        path.join(iterDir, 'results.json'),
        JSON.stringify(artifacts.results, null, 2),
      )
    }
  }
}
