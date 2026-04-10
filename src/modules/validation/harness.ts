/**
 * ValidationHarness interface and CascadeRunner implementation.
 *
 * The cascade runner executes pluggable `ValidationLevel` instances in
 * ascending level-number order, short-circuiting on the first failure.
 */

import { createLogger } from '../../utils/logger.js'
import type {
  CascadeRunnerConfig,
  LevelFailure,
  RemediationContext,
  StoryRecord,
  ValidationContext,
  ValidationLevel,
  ValidationResult,
} from './types.js'

const log = createLogger('validation:cascade')

// ---------------------------------------------------------------------------
// ValidationHarness interface
// ---------------------------------------------------------------------------

/**
 * Public interface consumed by the orchestrator (Story 33-4) and any other
 * caller that needs to run a validation cascade.
 */
export interface ValidationHarness {
  runCascade(story: StoryRecord, result: unknown, attempt: number): Promise<ValidationResult>
}

// ---------------------------------------------------------------------------
// CascadeRunner
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `ValidationHarness`.
 *
 * Levels are registered via `registerLevel()` and executed in ascending
 * `level` order.  Execution short-circuits on the first failing level.
 */
export class CascadeRunner implements ValidationHarness {
  private readonly levels: ValidationLevel[] = []
  private readonly config: CascadeRunnerConfig

  constructor(config: CascadeRunnerConfig) {
    this.config = config
  }

  /**
   * Register a validation level.  Levels may be registered in any order —
   * they are sorted before execution.
   */
  registerLevel(level: ValidationLevel): void {
    this.levels.push(level)
  }

  /**
   * Run the validation cascade against a story result.
   *
   * 1. Sorts registered levels by `level` ascending.
   * 2. Filters out levels whose `level` > `config.maxLevel` (if set).
   * 3. Executes each level in order; stops immediately on the first failure.
   * 4. Returns a `ValidationResult` summarising the outcome.
   */
  async runCascade(
    story: StoryRecord,
    result: unknown,
    attempt: number
  ): Promise<ValidationResult> {
    const sortedLevels = [...this.levels].sort((a, b) => a.level - b.level)

    const activeLevels =
      this.config.maxLevel !== undefined
        ? sortedLevels.filter((l) => l.level <= this.config.maxLevel!)
        : sortedLevels

    const context: ValidationContext = {
      story,
      result,
      attempt,
      projectRoot: this.config.projectRoot,
    }

    let highestLevelReached = -1
    let allFailures: LevelFailure[] = []

    for (const level of activeLevels) {
      const start = Date.now()
      let passed: boolean
      let failures: LevelFailure[]
      let canAutoRemediate: boolean
      let levelRemediationContext: RemediationContext | undefined

      try {
        const levelResult = await level.run(context)
        passed = levelResult.passed
        failures = levelResult.failures
        canAutoRemediate = levelResult.canAutoRemediate
        levelRemediationContext = levelResult.remediationContext
      } catch (err: unknown) {
        // Unhandled exceptions are treated as failures with the error as evidence
        const message = err instanceof Error ? err.message : String(err)
        passed = false
        failures = [
          {
            category: 'invariant',
            description: `Unhandled exception in level "${level.name}"`,
            evidence: message,
          },
        ]
        canAutoRemediate = false
        levelRemediationContext = undefined
      }

      const elapsed = Date.now() - start
      const resultLabel = passed ? 'pass' : 'fail'

      log.debug(
        {
          levelNumber: level.level,
          levelName: level.name,
          result: resultLabel,
          elapsedMs: elapsed,
        },
        `Level ${level.level} (${level.name}): ${resultLabel} [${elapsed}ms]`
      )

      highestLevelReached = level.level

      if (!passed) {
        allFailures = failures
        // Use the level's pre-built remediationContext when available (e.g.
        // BuildValidationLevel provides precise scope); fall back to generic.
        const remediationContext =
          levelRemediationContext !== undefined
            ? levelRemediationContext
            : buildRemediationContext(level.level, failures, canAutoRemediate)

        return {
          passed: false,
          highestLevelReached,
          failures,
          canAutoRemediate,
          remediationContext,
        }
      }
    }

    // All levels passed (or no levels were registered / active)
    return {
      passed: true,
      highestLevelReached: highestLevelReached === -1 ? 0 : highestLevelReached,
      failures: allFailures,
      canAutoRemediate: false,
      remediationContext: null,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a `RemediationContext` from the first failing level's data.
 *
 * `retryBudget` defaults to `{ spent: 0, remaining: 3 }` — the orchestrator
 * (Story 33-4) overwrites this with real budget values when it wires up
 * `RetryStrategy`.
 *
 * `scope` defaults to `'partial'`; specialised levels (33-2 through 33-6)
 * will set it precisely.
 */
function buildRemediationContext(
  level: number,
  failures: LevelFailure[],
  canAutoRemediate: boolean
): RemediationContext {
  return {
    level,
    failures,
    retryBudget: { spent: 0, remaining: 3 },
    scope: 'partial',
    canAutoRemediate,
  }
}
