/**
 * Re-export shim — routing/model-routing-config.ts
 *
 * Types and schema re-export from @substrate-ai/core.
 * RoutingConfigError is defined locally to extend SubstrateError for backwards
 * compatibility with existing monolith code that checks instanceof SubstrateError.
 * loadModelRoutingConfig wraps the core loader and maps errors to this class.
 */
import {
  loadModelRoutingConfig as _coreLoad,
  RoutingConfigError as CoreRoutingConfigError,
  ModelRoutingConfigSchema,
} from '@substrate-ai/core'
import type { ModelRoutingConfig, ModelPhaseConfig } from '@substrate-ai/core'
import { SubstrateError } from '../../errors/substrate-error.js'

export type { ModelRoutingConfig, ModelPhaseConfig }
export { ModelRoutingConfigSchema }

/**
 * RoutingConfigError — extends SubstrateError for backwards compatibility.
 * Structurally identical to @substrate-ai/core's RoutingConfigError but also
 * satisfies `instanceof SubstrateError` checks in existing monolith test/code.
 */
export class RoutingConfigError extends SubstrateError {
  override readonly code: 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID'

  constructor(
    message: string,
    code: 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID',
    context?: Record<string, unknown>,
  ) {
    super(message, code, context)
    this.name = 'RoutingConfigError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Load and validate a model routing config YAML file.
 * Wraps the core implementation and maps errors to the monolith's RoutingConfigError
 * (which extends SubstrateError).
 */
export function loadModelRoutingConfig(filePath: string): ModelRoutingConfig {
  try {
    return _coreLoad(filePath)
  } catch (err) {
    if (err instanceof CoreRoutingConfigError) {
      throw new RoutingConfigError(
        err.message,
        err.code as 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID',
        err.context,
      )
    }
    throw err
  }
}
