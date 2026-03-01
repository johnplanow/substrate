/**
 * Zod schemas for methodology pack manifest and constraint validation.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Step Context Reference Schema
// ---------------------------------------------------------------------------

/**
 * A reference to a context value to inject into a step prompt.
 * Sources can be params (runtime parameters) or decisions (from the decision store).
 */
export const ContextRefSchema = z.object({
  /** Placeholder name in the template, e.g. "concept" for {{concept}} */
  placeholder: z.string().min(1),
  /** Source path: "param:key" for runtime params, "decision:phase.category" for decisions */
  source: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Step Definition Schema
// ---------------------------------------------------------------------------

/**
 * A single step within a multi-step phase decomposition.
 */
export const StepDefinitionSchema = z.object({
  /** Unique name for this step within the phase */
  name: z.string().min(1),
  /** Prompt template key (must exist in the manifest prompts section) */
  template: z.string().min(1),
  /** Context references to inject into the template */
  context: z.array(ContextRefSchema).default([]),
})

// ---------------------------------------------------------------------------
// Phase Definition Schema
// ---------------------------------------------------------------------------

export const PhaseDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  entryGates: z.array(z.string()),
  exitGates: z.array(z.string()),
  artifacts: z.array(z.string()),
  /** Optional multi-step decomposition. If present, the phase uses step-by-step execution. */
  steps: z.array(StepDefinitionSchema).optional(),
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
