/**
 * Zod schemas for task graph YAML/JSON files.
 *
 * Defines the structure of task graph files produced by the plan generation
 * output (Architecture section). Used for validation during parsing.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Supported graph versions
// ---------------------------------------------------------------------------

export const SUPPORTED_GRAPH_VERSIONS = ['1', '1.0'] as const

// ---------------------------------------------------------------------------
// SessionMetaSchema
// ---------------------------------------------------------------------------

export const SessionMetaSchema = z.object({
  name: z.string().min(1, 'Session name is required'),
  budget_usd: z.number().positive().optional(),
})

export type SessionMeta = z.infer<typeof SessionMetaSchema>

// ---------------------------------------------------------------------------
// TaskDefinitionSchema
// ---------------------------------------------------------------------------

export const TaskTypeSchema = z.enum(['coding', 'testing', 'docs', 'debugging', 'refactoring'])

export const TaskDefinitionSchema = z.object({
  name: z.string().min(1, 'Task name is required'),
  description: z.string().optional(),
  prompt: z.string().min(1, 'Task prompt is required'),
  type: TaskTypeSchema,
  depends_on: z.array(z.string()).default([]),
  budget_usd: z.number().positive().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
})

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>

// ---------------------------------------------------------------------------
// TaskGraphFileSchema
// ---------------------------------------------------------------------------

export const TaskGraphFileSchema = z.object({
  version: z.string().superRefine((v, ctx) => {
    if (!(SUPPORTED_GRAPH_VERSIONS as readonly string[]).includes(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Task graph version '${v}' is not supported. This toolkit supports: ${SUPPORTED_GRAPH_VERSIONS.join(', ')}`,
      })
    }
  }),
  session: SessionMetaSchema,
  tasks: z.record(z.string(), TaskDefinitionSchema),
})

export type TaskGraphFile = z.infer<typeof TaskGraphFileSchema>

// ---------------------------------------------------------------------------
// RawTaskGraph (pre-validation)
// ---------------------------------------------------------------------------

/** Raw parsed object before Zod validation */
export type RawTaskGraph = unknown
