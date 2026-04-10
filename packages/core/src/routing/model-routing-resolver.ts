/**
 * RoutingResolver — resolves the appropriate model for each pipeline task type.
 *
 * Uses ModelRoutingConfig to map task types to pipeline phases and return
 * the configured model (with optional per-task-type overrides).
 *
 * References:
 *  - Epic 28, Story 28-4: Model Routing Configuration Schema
 */

import type { ILogger } from '../dispatch/types.js'
import { loadModelRoutingConfig, RoutingConfigError } from './model-routing-config.js'
import type { ModelRoutingConfig } from './model-routing-config.js'
import type { ModelResolution } from './routing-engine.js'
// TASK_TYPE_PHASE_MAP already defined in routing-engine.ts (story 40-6); import from there
import { TASK_TYPE_PHASE_MAP } from './routing-engine.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PHASE = 'generate' as const

// ---------------------------------------------------------------------------
// RoutingResolver
// ---------------------------------------------------------------------------

/**
 * Resolves which model to use for each pipeline task type.
 *
 * Constructed with a ModelRoutingConfig and a logger. Use the static
 * createWithFallback() factory to construct from a file path with graceful
 * handling of missing config files.
 */
export class RoutingResolver {
  private readonly config: ModelRoutingConfig
  private readonly logger: ILogger

  constructor(config: ModelRoutingConfig, logger: ILogger) {
    this.config = config
    this.logger = logger
  }

  /**
   * Resolve the model for a given task type.
   *
   * Resolution order:
   *  1. config.overrides[taskType] (source: 'override')
   *  2. config.phases[phase] via TASK_TYPE_PHASE_MAP (source: 'phase')
   *  3. null if the phase key is absent in config.phases
   *
   * @returns ModelResolution if a model is configured, null if in fallback mode
   */
  resolveModel(taskType: string): ModelResolution | null {
    // Check overrides first
    const override = this.config.overrides?.[taskType]
    if (override) {
      const phase = TASK_TYPE_PHASE_MAP[taskType] ?? DEFAULT_PHASE
      const resolution: ModelResolution = {
        model: override.model,
        phase,
        source: 'override',
        ...(override.max_tokens !== undefined ? { maxTokens: override.max_tokens } : {}),
      }
      this.logger.debug(
        { taskType, phase: resolution.phase, model: resolution.model, source: 'override' },
        'Resolved model'
      )
      return resolution
    }

    // Look up phase
    const phase = TASK_TYPE_PHASE_MAP[taskType] ?? DEFAULT_PHASE
    const phaseConfig = this.config.phases[phase]

    if (!phaseConfig) {
      return null
    }

    const resolution: ModelResolution = {
      model: phaseConfig.model,
      phase,
      source: 'phase',
      ...(phaseConfig.max_tokens !== undefined ? { maxTokens: phaseConfig.max_tokens } : {}),
    }
    this.logger.debug(
      { taskType, phase, model: resolution.model, source: 'phase' },
      'Resolved model'
    )
    return resolution
  }

  /**
   * Static factory that loads a routing config from a file with graceful fallback.
   *
   * If the config file does not exist (CONFIG_NOT_FOUND), emits a single debug
   * log and returns a resolver in fallback mode where all resolveModel() calls
   * return null. Other errors are rethrown.
   *
   * @param filePath - Path to the substrate.routing.yml file
   * @param logger - Logger instance
   */
  static createWithFallback(filePath: string, logger: ILogger): RoutingResolver {
    try {
      const config = loadModelRoutingConfig(filePath)
      return new RoutingResolver(config, logger)
    } catch (err) {
      if (err instanceof RoutingConfigError && err.code === 'CONFIG_NOT_FOUND') {
        logger.debug(
          { configPath: filePath, component: 'routing', reason: 'config not found' },
          `Model routing config not found at "${filePath}"; using fallback mode (all resolveModel calls will return null)`
        )
        // Construct a sentinel config with empty phases so resolveModel always returns null
        const fallbackConfig: ModelRoutingConfig = {
          version: 1,
          phases: {},
          baseline_model: '',
        }
        return new RoutingResolver(fallbackConfig, logger)
      }
      throw err
    }
  }
}

// Export the module-level logger name for external callers
export const ROUTING_RESOLVER_LOGGER_NAME = 'routing:model-resolver'
