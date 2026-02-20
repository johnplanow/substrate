/**
 * Zod validation schemas for WorkerAdapter types
 * Enables runtime validation and extensibility for custom adapters (NFR13)
 */

import { z } from 'zod'
import { AdtError } from '../core/errors.js'

// ---------------------------------------------------------------------------
// Base schemas
// ---------------------------------------------------------------------------

/**
 * Schema for BillingMode values
 */
export const BillingModeSchema = z.enum(['subscription', 'api', 'free'])

/**
 * Schema for SpawnCommand — the descriptor used to spawn a CLI agent process.
 */
export const SpawnCommandSchema = z.object({
  binary: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

/**
 * Schema for AdapterOptions — per-invocation execution configuration.
 */
export const AdapterOptionsSchema = z.object({
  worktreePath: z.string().min(1),
  billingMode: BillingModeSchema,
  model: z.string().optional(),
  additionalFlags: z.array(z.string()).optional(),
  apiKey: z.string().optional(),
})

/**
 * Schema for AdapterCapabilities — what a CLI agent supports.
 * Custom adapters can extend this schema with additional fields (NFR13).
 */
export const AdapterCapabilitiesSchema = z.object({
  supportsJsonOutput: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsSubscriptionBilling: z.boolean(),
  supportsApiBilling: z.boolean(),
  supportsPlanGeneration: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  supportedTaskTypes: z.array(z.string()),
  supportedLanguages: z.array(z.string()),
})

/**
 * Schema for AdapterHealthResult — health check output.
 */
export const AdapterHealthResultSchema = z.object({
  healthy: z.boolean(),
  version: z.string().optional(),
  cliPath: z.string().optional(),
  error: z.string().optional(),
  detectedBillingModes: z.array(BillingModeSchema).optional(),
  supportsHeadless: z.boolean(),
})

/**
 * Schema for TokenEstimate
 */
export const TokenEstimateSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

/**
 * Schema for TaskResult — normalized CLI output.
 */
export const TaskResultSchema = z.object({
  taskId: z.string().optional(),
  success: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  exitCode: z.number().int(),
  metadata: z
    .object({
      executionTime: z.number().optional(),
      tokensUsed: TokenEstimateSchema.optional(),
    })
    .optional(),
})

/**
 * Schema for PlannedTask — a single task in a generated plan.
 */
export const PlannedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  complexity: z.number().int().min(1).max(10).optional(),
  dependencies: z.array(z.string()).optional(),
})

/**
 * Schema for PlanParseResult — plan generation output.
 */
export const PlanParseResultSchema = z.object({
  success: z.boolean(),
  tasks: z.array(PlannedTaskSchema),
  error: z.string().optional(),
  rawOutput: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

/**
 * Generic validator that wraps Zod parse and throws AdtError on failure.
 * @param schema  Zod schema to validate against
 * @param data    Unknown data to parse
 * @param label   Human-readable label for error messages
 * @returns Parsed and typed data
 */
export function validateWithSchema<T>(
  schema: z.ZodType<T>,
  data: unknown,
  label: string
): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new AdtError(
      `Validation failed for ${label}: ${issues}`,
      'VALIDATION_ERROR',
      { label, issues: result.error.issues }
    )
  }
  return result.data
}

/**
 * Validate a SpawnCommand object, throwing AdtError on failure.
 */
export function validateSpawnCommand(data: unknown): z.infer<typeof SpawnCommandSchema> {
  return validateWithSchema(SpawnCommandSchema, data, 'SpawnCommand')
}

/**
 * Validate AdapterCapabilities, throwing AdtError on failure.
 */
export function validateAdapterCapabilities(data: unknown): z.infer<typeof AdapterCapabilitiesSchema> {
  return validateWithSchema(
    AdapterCapabilitiesSchema,
    data,
    'AdapterCapabilities'
  )
}

/**
 * Validate AdapterHealthResult, throwing AdtError on failure.
 */
export function validateAdapterHealthResult(data: unknown): z.infer<typeof AdapterHealthResultSchema> {
  return validateWithSchema(
    AdapterHealthResultSchema,
    data,
    'AdapterHealthResult'
  )
}
