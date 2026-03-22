/**
 * Re-export shim: schemas.ts → @substrate-ai/core
 * Implementation migrated to packages/core/src/adapters/schemas.ts (Story 41-8)
 */
export {
  BillingModeSchema,
  SpawnCommandSchema,
  AdapterOptionsSchema,
  AdapterCapabilitiesSchema,
  AdapterHealthResultSchema,
  TokenEstimateSchema,
  TaskResultSchema,
  PlannedTaskSchema,
  PlanParseResultSchema,
  validateWithSchema,
  validateSpawnCommand,
  validateAdapterCapabilities,
  validateAdapterHealthResult,
} from '@substrate-ai/core'
