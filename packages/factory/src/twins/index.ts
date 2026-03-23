/**
 * Twin Registry — public API barrel export.
 *
 * Story 47-1: registry, types, schema.
 * Story 47-2: TwinManager, createTwinManager, TwinError (Docker Compose orchestration).
 */

export { createTwinRegistry, TwinRegistry } from './registry.js'
export type {
  TwinDefinition,
  PortMapping,
  TwinHealthcheck,
  HealthPollResult,
} from './types.js'
export { TwinDefinitionError, TwinRegistryError } from './types.js'
export { TwinDefinitionSchema } from './schema.js'
export type { TwinDefinitionInput } from './schema.js'

// Docker Compose orchestration (story 47-2)
export { createTwinManager, TwinError } from './docker-compose.js'
export type { TwinManager, TwinManagerOptions } from './docker-compose.js'

// Pre-built twin templates (story 47-4)
export { TWIN_TEMPLATES, getTwinTemplate, listTwinTemplates } from './templates.js'
export type { TwinTemplateEntry } from './templates.js'

// Run state management (story 47-5)
export { readRunState, writeRunState, clearRunState, runStatePath } from './run-state.js'
export type { TwinRunState } from './run-state.js'

// Twin health monitoring (story 47-6)
export { createTwinHealthMonitor } from './health-monitor.js'
export type { TwinHealthMonitor, TwinHealthStatus, TwinHealthMonitorOptions } from './health-monitor.js'

// Twin persistence — twin run state and health failure tracking (story 47-7)
export type {
  TwinRunInput,
  TwinRunRow,
  TwinRunSummary,
  TwinHealthFailureInput,
} from './persistence.js'
export {
  insertTwinRun,
  updateTwinRun,
  recordTwinHealthFailure,
  getTwinRunsForRun,
  TwinPersistenceCoordinator,
  createTwinPersistenceCoordinator,
} from './persistence.js'
