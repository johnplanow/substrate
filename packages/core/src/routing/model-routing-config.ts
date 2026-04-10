/**
 * ModelRoutingConfig — Zod schema, types, error, and loader for substrate.routing.yml.
 *
 * The routing config YAML controls which model is used for each pipeline phase
 * (explore / generate / review) and supports per-task-type overrides.
 *
 * References:
 *  - Epic 28, Story 28-4: Model Routing Configuration Schema
 */

import { readFileSync } from 'node:fs'
import { load as yamlLoad } from 'js-yaml'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Per-phase model configuration.
 */
export const ModelPhaseConfigSchema = z.object({
  model: z
    .string()
    .regex(
      MODEL_NAME_PATTERN,
      'Model name contains invalid characters (must match /^[a-zA-Z0-9._-]+$/)'
    ),
  max_tokens: z.number().int().positive().optional(),
})

export type ModelPhaseConfig = z.infer<typeof ModelPhaseConfigSchema>

/**
 * Complete model routing configuration document.
 *
 * All three phase keys (explore, generate, review) are optional — an absent
 * phase causes resolveModel() to return null, signalling callers to use their
 * own default model.
 */
export const ModelRoutingConfigSchema = z.object({
  version: z.literal(1),
  phases: z.object({
    explore: ModelPhaseConfigSchema.optional(),
    generate: ModelPhaseConfigSchema.optional(),
    review: ModelPhaseConfigSchema.optional(),
  }),
  baseline_model: z
    .string()
    .regex(
      MODEL_NAME_PATTERN,
      'Baseline model name contains invalid characters (must match /^[a-zA-Z0-9._-]+$/)'
    ),
  overrides: z.record(z.string(), ModelPhaseConfigSchema).optional(),
  /**
   * When true, RoutingTuner will automatically apply conservative model downgrades
   * at the end of each pipeline run based on historical phase token data.
   */
  auto_tune: z.boolean().optional(),
})

export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

type RoutingConfigErrorCode = 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID'

/**
 * Error thrown by loadModelRoutingConfig() for all failure modes.
 *
 * Extends plain Error (not SubstrateError) to keep core package free of monolith imports.
 */
export class RoutingConfigError extends Error {
  readonly code: 'CONFIG_NOT_FOUND' | 'INVALID_YAML' | 'SCHEMA_INVALID'

  constructor(
    message: string,
    code: RoutingConfigErrorCode,
    readonly context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'RoutingConfigError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate a model routing config YAML file.
 *
 * @param filePath - Absolute or relative path to substrate.routing.yml
 * @returns Parsed and validated ModelRoutingConfig object
 * @throws {RoutingConfigError} with code CONFIG_NOT_FOUND if the file cannot be read
 * @throws {RoutingConfigError} with code INVALID_YAML if the file contains invalid YAML
 * @throws {RoutingConfigError} with code SCHEMA_INVALID if validation fails
 *
 * @example
 * const config = loadModelRoutingConfig('.substrate/routing.yml')
 */
export function loadModelRoutingConfig(filePath: string): ModelRoutingConfig {
  // Read the file
  let rawContent: string
  try {
    rawContent = readFileSync(filePath, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new RoutingConfigError(
      `Cannot read routing config file at "${filePath}": ${message}`,
      'CONFIG_NOT_FOUND',
      { filePath }
    )
  }

  // Parse YAML
  let rawObject: unknown
  try {
    rawObject = yamlLoad(rawContent)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new RoutingConfigError(
      `Invalid YAML in routing config file at "${filePath}": ${message}`,
      'INVALID_YAML',
      { filePath }
    )
  }

  // Validate with Zod
  const result = ModelRoutingConfigSchema.safeParse(rawObject)
  if (!result.success) {
    const issues = result.error.issues
    const details = issues.map((e) => `  - ${e.path.join('.')}: ${e.message}`).join('\n')
    throw new RoutingConfigError(
      `Routing config validation failed for "${filePath}":\n${details}`,
      'SCHEMA_INVALID',
      { filePath }
    )
  }

  return result.data
}
