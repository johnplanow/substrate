/**
 * Zod schemas for the phase_outputs table.
 *
 * Captures raw LLM output per dispatch step so eval and other consumers can
 * judge the actual artifact produced, not a post-hoc reconstruction from
 * parsed decisions. See `docs/eval-system.md` and deferred-work item G2.
 */

import { z } from 'zod'

export const PhaseOutputSchema = z.object({
  id: z.string().uuid(),
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  step_name: z.string().min(1),
  raw_output: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type PhaseOutput = z.infer<typeof PhaseOutputSchema>

export const CreatePhaseOutputInputSchema = z.object({
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  step_name: z.string().min(1),
  raw_output: z.string(),
})
export type CreatePhaseOutputInput = z.infer<typeof CreatePhaseOutputInputSchema>
