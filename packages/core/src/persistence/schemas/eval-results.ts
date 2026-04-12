/**
 * Zod schemas for the eval_results table (V1b-2).
 *
 * Stores eval reports alongside pipeline run data for queryable score
 * history and run-to-run comparison.
 */

import { z } from 'zod'

export const EvalResultRowSchema = z.object({
  id: z.number().optional(),
  run_id: z.string().min(1),
  eval_id: z.string().uuid(),
  depth: z.enum(['standard', 'deep']),
  timestamp: z.string().min(1),
  overall_score: z.number(),
  pass: z.union([z.number(), z.boolean()]).transform((v) => (typeof v === 'boolean' ? v : v !== 0)),
  phases_json: z.string(),
  metadata_json: z.string().nullable().optional(),
  created_at: z.string().optional(),
})
export type EvalResultRow = z.infer<typeof EvalResultRowSchema>

export const CreateEvalResultInputSchema = z.object({
  run_id: z.string().min(1),
  eval_id: z.string().uuid(),
  depth: z.enum(['standard', 'deep']),
  timestamp: z.string().min(1),
  overall_score: z.number(),
  pass: z.boolean(),
  phases_json: z.string(),
  metadata_json: z.string().nullable().optional(),
})
export type CreateEvalResultInput = z.infer<typeof CreateEvalResultInputSchema>
