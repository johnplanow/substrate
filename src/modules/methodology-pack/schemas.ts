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
  /**
   * Optional conflict group mappings for the implementation orchestrator.
   * Maps story key prefixes to module names for serialization control.
   */
  conflictGroups: z.record(z.string(), z.string()).optional(),
  /**
   * Build verification command to run after dev-story and before code-review.
   * Set to empty string or false to skip the build gate.
   * Defaults to "npm run build" when absent. (Story 24-2)
   */
  verifyCommand: z.union([z.string(), z.literal(false)]).optional(),
  /**
   * Timeout in milliseconds for the build verification command.
   * Defaults to 60000 when absent. (Story 24-2)
   */
  verifyTimeoutMs: z.number().optional(),
  /**
   * RP4 fix (2026-07-09): these two flags existed in manifests and in the
   * MethodologyPack manifest TYPE since their phases shipped, but were never
   * declared HERE — zod's default strip mode silently discarded them, so
   * `uxDesign: true` never enabled the UX phase from a manifest and
   * `research: true` never enabled research (only the CLI `--research`
   * override worked). Caught by the RP4.2 live pipeline run
   * (detection-vs-contract lesson: documented flag, never audited).
   */
  uxDesign: z.boolean().optional(),
  research: z.boolean().optional(),
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
