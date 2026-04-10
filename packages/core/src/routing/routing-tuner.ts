/**
 * RoutingTuner — automatically applies conservative model downgrades based on
 * historical phase token breakdown data.
 *
 * When `config.auto_tune` is true and enough historical data exists, RoutingTuner
 * selects the highest-confidence downgrade recommendation, updates the YAML config
 * file in place, and appends an audit log entry to the IStateStore.
 *
 * At most one phase is changed per invocation.
 *
 * References:
 *  - Epic 28, Story 28-8: Feedback Loop — Telemetry-Driven Routing Tuning
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { load as yamlLoad, dump as yamlDump } from 'js-yaml'

import type { ILogger } from '../dispatch/types.js'
import type { TypedEventBus } from '../events/event-bus.js'
import type { CoreEvents } from '../events/core-events.js'
import type { ModelRoutingConfig } from './model-routing-config.js'
import type { IStateStore, PhaseTokenBreakdown, TuneLogEntry } from './types.js'
import { RoutingRecommender } from './routing-recommender.js'
import { getModelTier } from './model-tier.js'

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Minimum number of breakdowns required before auto-tuning is attempted. */
const MIN_BREAKDOWNS_FOR_TUNING = 5

/** Key used to store the list of known run IDs in the IStateStore. */
const RUN_INDEX_KEY = 'phase_token_breakdown_runs'

/** Key used to store the tune log in the IStateStore. */
const TUNE_LOG_KEY = 'routing_tune_log'

// ---------------------------------------------------------------------------
// RoutingTuner
// ---------------------------------------------------------------------------

/**
 * Auto-applies a single conservative model downgrade per invocation when
 * `config.auto_tune` is `true` and sufficient historical data is available.
 *
 * The tuner reads the current routing YAML config, applies the change in memory,
 * and writes it back to disk synchronously. It also appends a `TuneLogEntry`
 * to the IStateStore for audit purposes, and emits a `routing:auto-tuned` event.
 */
export class RoutingTuner {
  private readonly _stateStore: IStateStore
  private readonly _recommender: RoutingRecommender
  private readonly _eventEmitter: TypedEventBus<CoreEvents>
  private readonly _configPath: string
  private readonly _logger: ILogger

  constructor(
    stateStore: IStateStore,
    recommender: RoutingRecommender,
    eventEmitter: TypedEventBus<CoreEvents>,
    configPath: string,
    logger: ILogger
  ) {
    this._stateStore = stateStore
    this._recommender = recommender
    this._eventEmitter = eventEmitter
    this._configPath = configPath
    this._logger = logger
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Called at the end of a pipeline run. When auto_tune is enabled and sufficient
   * historical data exists, applies a single conservative model downgrade to the
   * routing config YAML file.
   *
   * @param runId  - ID of the just-completed pipeline run
   * @param config - Current model routing config (already loaded from disk)
   */
  async maybeAutoTune(runId: string, config: ModelRoutingConfig): Promise<void> {
    if (config.auto_tune !== true) {
      this._logger.debug({ runId }, 'auto_tune_disabled — skipping RoutingTuner')
      return
    }

    // Register the current run in the run index
    await this._registerRunId(runId)

    // Load recent breakdowns
    const breakdowns = await this._loadRecentBreakdowns(10)
    if (breakdowns.length < MIN_BREAKDOWNS_FOR_TUNING) {
      this._logger.debug(
        { runId, available: breakdowns.length, required: MIN_BREAKDOWNS_FOR_TUNING },
        'insufficient_data — not enough breakdowns for auto-tuning'
      )
      return
    }

    // Compute recommendations
    const analysis = this._recommender.analyze(breakdowns, config)

    if (analysis.insufficientData) {
      this._logger.debug({ runId }, 'Recommender returned insufficientData')
      return
    }

    // Filter to downgrade-only, one-step transitions (|currentTier - suggestedTier| === 1).
    // The one-step check uses getModelTier() to prevent opus→haiku two-step jumps even
    // if a recommender were to emit such a recommendation.
    const downgradeCandidates = analysis.recommendations.filter((rec) => {
      if (rec.direction !== 'downgrade') return false
      const tierDiff = Math.abs(getModelTier(rec.currentModel) - getModelTier(rec.suggestedModel))
      return tierDiff === 1
    })

    if (downgradeCandidates.length === 0) {
      this._logger.debug({ runId }, 'no_safe_recommendation')
      return
    }

    // Pick the highest-confidence candidate
    const topRec = downgradeCandidates.sort((a, b) => b.confidence - a.confidence)[0]!

    // Apply the change to the YAML config
    let rawContent: string
    try {
      rawContent = readFileSync(this._configPath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._logger.warn(
        { err: msg, configPath: this._configPath },
        'Failed to read routing config for auto-tune'
      )
      return
    }

    let rawObject: unknown
    try {
      rawObject = yamlLoad(rawContent)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._logger.warn({ err: msg }, 'Failed to parse routing config YAML for auto-tune')
      return
    }

    // Mutate the phase model
    const configObj = rawObject as {
      phases?: Record<string, { model?: string; max_tokens?: number } | undefined>
    }
    if (configObj.phases === undefined) {
      configObj.phases = {}
    }
    const existingPhase = configObj.phases[topRec.phase]
    if (existingPhase !== undefined) {
      existingPhase.model = topRec.suggestedModel
    } else {
      configObj.phases[topRec.phase] = { model: topRec.suggestedModel }
    }

    // Write the updated config back to disk
    try {
      writeFileSync(this._configPath, yamlDump(rawObject, { lineWidth: 120 }), 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._logger.warn(
        { err: msg, configPath: this._configPath },
        'Failed to write updated routing config'
      )
      return
    }

    // Append audit log entry
    const tuneEntry: TuneLogEntry = {
      id: crypto.randomUUID(),
      runId,
      phase: topRec.phase,
      oldModel: topRec.currentModel,
      newModel: topRec.suggestedModel,
      estimatedSavingsPct: topRec.estimatedSavingsPct,
      appliedAt: new Date().toISOString(),
    }

    await this._appendTuneLog(tuneEntry)

    // Emit event
    this._eventEmitter.emit('routing:auto-tuned', {
      runId,
      phase: topRec.phase,
      oldModel: topRec.currentModel,
      newModel: topRec.suggestedModel,
      estimatedSavingsPct: topRec.estimatedSavingsPct,
    })

    this._logger.info(
      {
        runId,
        phase: topRec.phase,
        oldModel: topRec.currentModel,
        newModel: topRec.suggestedModel,
      },
      'Auto-tuned routing config — applied downgrade'
    )
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Register a run ID in the stored run index so future calls can discover
   * all historical breakdowns without a separate run listing endpoint.
   */
  private async _registerRunId(runId: string): Promise<void> {
    const existing = await this._stateStore.getMetric('__global__', RUN_INDEX_KEY)
    const runIds: string[] = Array.isArray(existing) ? (existing as string[]) : []
    if (!runIds.includes(runId)) {
      runIds.push(runId)
      await this._stateStore.setMetric('__global__', RUN_INDEX_KEY, runIds)
    }
  }

  /**
   * Load the most recent `lookback` PhaseTokenBreakdown records from the IStateStore.
   *
   * Each breakdown is stored by RoutingTokenAccumulator under the key
   * `'phase_token_breakdown'` scoped to the run ID. The run IDs themselves are
   * tracked in a global index stored under `('__global__', RUN_INDEX_KEY)`.
   *
   * @param lookback - Maximum number of recent runs to inspect
   */
  private async _loadRecentBreakdowns(lookback: number): Promise<PhaseTokenBreakdown[]> {
    const existing = await this._stateStore.getMetric('__global__', RUN_INDEX_KEY)
    const allRunIds: string[] = Array.isArray(existing) ? (existing as string[]) : []

    // Take the most recent `lookback` run IDs
    const recentRunIds = allRunIds.slice(-lookback)

    const breakdowns: PhaseTokenBreakdown[] = []
    for (const runId of recentRunIds) {
      try {
        const raw = await this._stateStore.getMetric(runId, 'phase_token_breakdown')
        if (raw !== undefined && raw !== null) {
          // The value may be stored as an object or as a JSON string
          const parsed: PhaseTokenBreakdown =
            typeof raw === 'string'
              ? (JSON.parse(raw) as PhaseTokenBreakdown)
              : (raw as PhaseTokenBreakdown)
          breakdowns.push(parsed)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this._logger.debug({ runId, err: msg }, 'Failed to load breakdown for run — skipping')
      }
    }

    return breakdowns
  }

  /**
   * Append a TuneLogEntry to the persisted tune log in the IStateStore.
   *
   * NOTE: This uses `'__global__'` as the scope key (codebase convention) rather
   * than the literal `'global'` mentioned in AC6. The tune log is stored as a raw
   * array (not a JSON-stringified string) for internal consistency with how other
   * array values are stored in this IStateStore.
   */
  private async _appendTuneLog(entry: TuneLogEntry): Promise<void> {
    const existing = await this._stateStore.getMetric('__global__', TUNE_LOG_KEY)
    const log: TuneLogEntry[] = Array.isArray(existing) ? (existing as TuneLogEntry[]) : []
    log.push(entry)
    await this._stateStore.setMetric('__global__', TUNE_LOG_KEY, log)
  }
}
