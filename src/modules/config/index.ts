/**
 * Barrel exports for the config module.
 */

export { createConfigSystem, ConfigSystemImpl } from './config-system-impl.js'
export type { ConfigSystem, ConfigSystemOptions } from './config-system.js'
export {
  SubstrateConfigSchema,
  PartialSubstrateConfigSchema,
  CURRENT_CONFIG_FORMAT_VERSION,
  CURRENT_TASK_GRAPH_VERSION,
  SUPPORTED_CONFIG_FORMAT_VERSIONS,
  SUPPORTED_TASK_GRAPH_VERSIONS,
} from './config-schema.js'
export type { SubstrateConfig, PartialSubstrateConfig } from './config-schema.js'
export { DEFAULT_CONFIG } from './defaults.js'
export { ConfigWatcher } from './config-watcher.js'
export {
  ConfigMigrator,
  defaultConfigMigrator,
} from './config-migrator.js'
export type { MigrationResult } from './config-migrator.js'
export {
  parseVersion,
  isVersionSupported,
  getNextVersion,
  formatUnsupportedVersionError,
} from './version-utils.js'
