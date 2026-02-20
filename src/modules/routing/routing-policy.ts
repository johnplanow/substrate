/**
 * RoutingPolicy — Zod schema and loader for the routing policy YAML file.
 *
 * The routing policy YAML (default: .substrate/routing-policy.yaml) controls:
 *  - Which agents are preferred for which task types
 *  - Subscription-first vs. API billing preference
 *  - Per-provider rate limits
 *  - Fallback chains when preferred agents are unavailable
 *
 * References:
 *  - Architecture Section 8: Subscription-first algorithm
 *  - FR22, FR23, FR25: Subscription routing toggles
 *  - NFR13: Schema validation with Zod
 */

import { readFileSync } from 'node:fs'
import { load as yamlLoad } from 'js-yaml'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * API billing configuration for a provider.
 */
export const ApiBillingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  api_key_env: z.string().optional(),
})

export type ApiBillingConfig = z.infer<typeof ApiBillingConfigSchema>

/**
 * Rate limit configuration for a provider.
 */
export const RateLimitConfigSchema = z.object({
  tokens_per_window: z.number().int().positive(),
  window_seconds: z.number().int().positive(),
})

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>

/**
 * Per-provider configuration.
 */
export const ProviderPolicySchema = z.object({
  enabled: z.boolean().default(true),
  cli_path: z.string().default(''),
  subscription_routing: z.boolean().default(false),
  max_concurrent: z.number().int().min(1).max(32).default(1),
  rate_limit: RateLimitConfigSchema.optional(),
  api_billing: ApiBillingConfigSchema.optional(),
})

export type ProviderPolicy = z.infer<typeof ProviderPolicySchema>

/**
 * Per-task-type routing configuration.
 * Specifies which agents are preferred for a given task type and optional model preferences.
 */
export const TaskTypePolicySchema = z.object({
  preferred_agents: z.array(z.string()).min(1),
  model_preferences: z.record(z.string(), z.string()).optional(),
})

export type TaskTypePolicy = z.infer<typeof TaskTypePolicySchema>

/**
 * Default routing configuration (used when no task-type-specific policy applies).
 */
export const DefaultRoutingPolicySchema = z.object({
  preferred_agents: z.array(z.string()).min(1),
  billing_preference: z.enum(['subscription_first', 'api_only', 'subscription_only']).default('subscription_first'),
  use_monitor_recommendations: z.boolean().default(false),
})

export type DefaultRoutingPolicy = z.infer<typeof DefaultRoutingPolicySchema>

/**
 * Global routing settings.
 */
export const GlobalRoutingSettingsSchema = z.object({
  max_concurrent_workers: z.number().int().min(1).max(100).default(5),
  fallback_enabled: z.boolean().default(true),
})

export type GlobalRoutingSettings = z.infer<typeof GlobalRoutingSettingsSchema>

/**
 * Complete routing policy document schema.
 * Supports optional fields gracefully (AC6 — extensibility).
 */
export const RoutingPolicySchema = z.object({
  default: DefaultRoutingPolicySchema,
  task_types: z.record(z.string(), TaskTypePolicySchema).optional().default({}),
  providers: z.record(z.string(), ProviderPolicySchema).refine(
    (providers) => Object.keys(providers).length > 0,
    { message: 'Routing policy must have at least one provider configured' }
  ),
  global: GlobalRoutingSettingsSchema.optional().default({ max_concurrent_workers: 5, fallback_enabled: true }),
})

export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when routing policy validation fails.
 */
export class RoutingPolicyValidationError extends Error {
  constructor(message: string, public readonly details?: string) {
    super(message)
    this.name = 'RoutingPolicyValidationError'
  }
}

// ---------------------------------------------------------------------------
// loadRoutingPolicy
// ---------------------------------------------------------------------------

/**
 * Load and validate a routing policy YAML file.
 *
 * @param filePath - Absolute or relative path to the routing policy YAML
 * @returns Parsed and validated RoutingPolicy object
 * @throws {RoutingPolicyValidationError} if the file cannot be parsed or the schema is invalid
 *
 * @example
 * const policy = loadRoutingPolicy('.substrate/routing-policy.yaml')
 */
export function loadRoutingPolicy(filePath: string): RoutingPolicy {
  // Read the file
  let rawContent: string
  try {
    rawContent = readFileSync(filePath, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new RoutingPolicyValidationError(
      `Cannot read routing policy file at "${filePath}": ${message}`
    )
  }

  // Parse YAML
  let rawObject: unknown
  try {
    rawObject = yamlLoad(rawContent)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new RoutingPolicyValidationError(
      `Invalid YAML in routing policy file at "${filePath}": ${message}`
    )
  }

  if (rawObject === null || typeof rawObject !== 'object') {
    throw new RoutingPolicyValidationError(
      `Routing policy file at "${filePath}" must contain a YAML object`
    )
  }

  // Validate with Zod
  const result = RoutingPolicySchema.safeParse(rawObject)
  if (!result.success) {
    // Zod v4 uses `.issues` instead of deprecated `.errors`
    const issues = result.error.issues ?? (result.error as unknown as { errors?: { path: PropertyKey[]; message: string }[] }).errors ?? []
    const details = issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n')
    throw new RoutingPolicyValidationError(
      `Routing policy validation failed for "${filePath}":\n${details}`,
      details
    )
  }

  // Validate that all task_type agents exist in providers
  const policy = result.data
  const providerNames = new Set(Object.keys(policy.providers))

  for (const [taskType, taskPolicy] of Object.entries(policy.task_types ?? {})) {
    for (const agent of taskPolicy.preferred_agents) {
      if (!providerNames.has(agent)) {
        throw new RoutingPolicyValidationError(
          `Task type "${taskType}" references agent "${agent}" which is not defined in the providers section`
        )
      }
    }
  }

  // Validate default agents
  for (const agent of policy.default.preferred_agents) {
    if (!providerNames.has(agent)) {
      throw new RoutingPolicyValidationError(
        `Default routing references agent "${agent}" which is not defined in the providers section`
      )
    }
  }

  return policy
}
