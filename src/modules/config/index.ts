/**
 * Barrel re-export shim for the config module.
 *
 * Implementation has moved to @substrate-ai/core. This shim re-exports
 * all symbols that monolith callers depend on, pulling from core for
 * implementation files and from local shims for SDLC-extended schemas
 * (token_ceilings) and monolith-specific types (RoutingPolicy).
 */

// Implementation symbols from core
export { createConfigSystem, ConfigSystemImpl } from '@substrate-ai/core'
export type { ConfigSystem, ConfigSystemOptions } from '@substrate-ai/core'

// Schemas — re-export from local shim which includes token_ceilings + strict
export {
  SubstrateConfigSchema,
  PartialSubstrateConfigSchema,
  CURRENT_CONFIG_FORMAT_VERSION,
  CURRENT_TASK_GRAPH_VERSION,
  SUPPORTED_CONFIG_FORMAT_VERSIONS,
  SUPPORTED_TASK_GRAPH_VERSIONS,
} from './config-schema.js'
export type { SubstrateConfig, PartialSubstrateConfig } from './config-schema.js'

// Defaults
export { DEFAULT_CONFIG } from './defaults.js'

// ConfigWatcher (interface + factory from core)
export type { ConfigWatcher } from '@substrate-ai/core'
export { createConfigWatcher, flattenObject, computeChangedKeys } from '@substrate-ai/core'

// ConfigMigrator from core
export { ConfigMigrator, defaultConfigMigrator } from '@substrate-ai/core'
export type { MigrationResult } from '@substrate-ai/core'

// Version utilities from core
export {
  parseVersion,
  isVersionSupported,
  getNextVersion,
  formatUnsupportedVersionError,
} from '@substrate-ai/core'
