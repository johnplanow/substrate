/**
 * Plateau detection for the convergence loop.
 * Story 45-6: provides pure plateau detection primitives — no I/O, no side effects.
 *
 * Algorithm: Track the last N satisfaction scores (N = `window`, default 3).
 * If max−min of the window falls strictly below threshold, declare plateau.
 *
 * Consumed by:
 *   - Story 45-8 (convergence controller integration)
 */

import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for configuring a PlateauDetector.
 * Both fields are optional; defaults are window=3 and threshold=0.05.
 */
export interface PlateauDetectorOptions {
  /** Number of most-recent scores to consider. Default: 3. */
  window?: number
  /** Minimum spread (max−min) required to NOT declare a plateau. Default: 0.05. */
  threshold?: number
}

/**
 * Tracks the last N satisfaction scores. If max−min of the window falls
 * strictly below threshold, declare plateau.
 *
 * Pure in-memory data structure — no I/O, no event emission, no global state.
 * Event emission is isolated to `checkPlateauAndEmit`.
 */
export interface PlateauDetector {
  /**
   * Record a new satisfaction score for the given iteration.
   * After recording, only the last `window` scores are retained.
   */
  recordScore(iteration: number, score: number): void

  /**
   * Return `true` when the current window of scores qualifies as a plateau:
   * - The window is full (at least `window` scores recorded), AND
   * - `Math.max(...scores) - Math.min(...scores) < threshold` (strictly less than)
   *
   * Returns `false` when insufficient data or when the spread meets/exceeds the threshold.
   */
  isPlateaued(): boolean

  /**
   * Return the configured window size.
   * Used by `checkPlateauAndEmit` to construct the event payload.
   */
  getWindow(): number

  /**
   * Return a defensive copy of the current score window.
   * Callers cannot mutate the detector's internal array via this method.
   */
  getScores(): number[]
}

/**
 * Context passed to `checkPlateauAndEmit`.
 */
export interface PlateauCheckContext {
  runId: string
  nodeId: string
  /** Optional event bus. When provided and a plateau is detected, emits `convergence:plateau-detected`. */
  eventBus?: TypedEventBus<FactoryEvents>
}

/**
 * Result returned by `checkPlateauAndEmit`.
 */
export interface PlateauCheckResult {
  plateaued: boolean
  scores: number[]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW = 3
const DEFAULT_THRESHOLD = 0.05

/**
 * Create a new PlateauDetector with the given options.
 *
 * **Defaults:** `window=3`, `threshold=0.05` — matching `FactoryConfigSchema.plateau_window`
 * and `FactoryConfigSchema.plateau_threshold`. Story 45-8 will read these values from
 * `FactoryConfig` and pass them in.
 *
 * **Insufficient-data guard:** `isPlateaued()` always returns `false` when fewer than
 * `window` scores have been recorded. A plateau can only be declared once the window is full.
 *
 * @param options - Optional configuration for window size and threshold.
 */
export function createPlateauDetector(options?: PlateauDetectorOptions): PlateauDetector {
  const window = options?.window ?? DEFAULT_WINDOW
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD
  let scores: number[] = []

  return {
    recordScore(_iteration: number, score: number): void {
      scores.push(score)
      scores = scores.slice(-window)
    },

    isPlateaued(): boolean {
      if (scores.length < window) {
        return false
      }
      const delta = Math.max(...scores) - Math.min(...scores)
      return delta < threshold
    },

    getWindow(): number {
      return window
    },

    getScores(): number[] {
      return [...scores]
    },
  }
}

// ---------------------------------------------------------------------------
// Event emission helper
// ---------------------------------------------------------------------------

/**
 * Check whether the detector has reached a plateau and, if so, emit the
 * `convergence:plateau-detected` event on the provided event bus.
 *
 * This mirrors the `checkGoalGates()` pattern:
 * - Pure detection is isolated in `PlateauDetector` (no side effects).
 * - Event emission is isolated here in this wrapper.
 * - Callers may omit `eventBus` for pure check behavior (no event is emitted).
 *
 * @param detector - A `PlateauDetector` instance.
 * @param context  - Run/node identifiers and an optional event bus.
 * @returns `{ plateaued: true, scores }` with event emitted when plateaued;
 *          `{ plateaued: false, scores }` with no event emitted otherwise.
 */
export function checkPlateauAndEmit(
  detector: PlateauDetector,
  context: PlateauCheckContext
): PlateauCheckResult {
  const { runId, nodeId, eventBus } = context
  const scores = detector.getScores()

  if (detector.isPlateaued()) {
    eventBus?.emit('convergence:plateau-detected', {
      runId,
      nodeId,
      scores,
      window: detector.getWindow(),
    })
    return { plateaued: true, scores }
  }

  return { plateaued: false, scores }
}
