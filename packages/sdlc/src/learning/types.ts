/**
 * Learning loop — root cause taxonomy types.
 *
 * Story 53-5: Root Cause Taxonomy and Failure Classification
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Root cause category enum
// ---------------------------------------------------------------------------

export const RootCauseCategorySchema = z.enum([
  'namespace-collision',
  'dependency-ordering',
  'spec-staleness',
  'adapter-format',
  'build-failure',
  'test-failure',
  'resource-exhaustion',
  'infrastructure',
  'unclassified',
])

export type RootCauseCategory = z.infer<typeof RootCauseCategorySchema>

// ---------------------------------------------------------------------------
// Finding schema
// ---------------------------------------------------------------------------

export const FindingSchema = z.object({
  id: z.string().uuid(),
  run_id: z.string(),
  story_key: z.string(),
  root_cause: RootCauseCategorySchema,
  affected_files: z.array(z.string()),
  description: z.string(),
  confidence: z.enum(['high', 'low']),
  created_at: z.string(),
  expires_after_runs: z.number().int().positive().default(5),
  contradicted_by: z.string().optional(),
})

export type Finding = z.infer<typeof FindingSchema>

// ---------------------------------------------------------------------------
// Story failure context (plain TypeScript interface — no Zod validation needed
// at call sites; this is the input to the classifier)
// ---------------------------------------------------------------------------

export interface StoryFailureContext {
  storyKey: string
  runId: string
  error?: string
  outputTokens?: number
  buildFailed?: boolean
  testsFailed?: boolean
  adapterError?: boolean
  affectedFiles?: string[]
}
