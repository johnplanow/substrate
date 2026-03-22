/**
 * ModelRoutingConfig — Zod schema, types, and error for substrate.routing.yml.
 *
 * The routing config YAML controls which model is used for each pipeline phase
 * (explore / generate / review) and supports per-task-type overrides.
 *
 * References:
 *  - Epic 28, Story 28-4: Model Routing Configuration Schema
 */

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
  model: z.string().regex(
    MODEL_NAME_PATTERN,
    'Model name contains invalid characters (must match /^[a-zA-Z0-9._-]+$/)',
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
  baseline_model: z.string().regex(
    MODEL_NAME_PATTERN,
    'Baseline model name contains invalid characters (must match /^[a-zA-Z0-9._-]+$/)',
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
    readonly context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RoutingConfigError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
