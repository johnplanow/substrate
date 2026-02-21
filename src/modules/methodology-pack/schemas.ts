/**
 * Zod schemas for methodology pack manifest and constraint validation.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Phase Definition Schema
// ---------------------------------------------------------------------------

export const PhaseDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  entryGates: z.array(z.string()),
  exitGates: z.array(z.string()),
  artifacts: z.array(z.string()),
})

// ---------------------------------------------------------------------------
// Pack Manifest Schema
// ---------------------------------------------------------------------------

export const PackManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  phases: z.array(PhaseDefinitionSchema),
  prompts: z.record(z.string(), z.string()),
  constraints: z.record(z.string(), z.string()),
  templates: z.record(z.string(), z.string()),
})

// ---------------------------------------------------------------------------
// Constraint Rule Schema
// ---------------------------------------------------------------------------

export const ConstraintSeveritySchema = z.enum(['required', 'recommended', 'optional'])

export const ConstraintRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  severity: ConstraintSeveritySchema,
  check: z.string().min(1),
})

export const ConstraintFileSchema = z.array(ConstraintRuleSchema)
