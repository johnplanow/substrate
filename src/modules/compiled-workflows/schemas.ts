/**
 * Zod schemas for compiled-workflow YAML output contracts.
 *
 * These schemas validate the structured YAML emitted by sub-agents
 * during compiled workflow execution.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// CreateStoryResultSchema
// ---------------------------------------------------------------------------

/**
 * Schema for the YAML output contract of the create-story sub-agent.
 * The agent must emit YAML matching this shape.
 */
export const CreateStoryResultSchema = z.object({
  result: z.enum(['success', 'failed']),
  story_file: z.string().optional(),
  story_key: z.string().optional(),
  story_title: z.string().optional(),
})

export type CreateStorySchemaOutput = z.infer<typeof CreateStoryResultSchema>

// ---------------------------------------------------------------------------
// DevStoryResultSchema
// ---------------------------------------------------------------------------

/**
 * Coerce a YAML value to a plain string. Agents sometimes emit
 * `ac_failures: [AC7: explanation]` which YAML parses as a mapping
 * `{ AC7: "explanation" }` instead of a string. This flattens it.
 */
const coerceToString = z.preprocess((val) => {
  if (typeof val === 'string') return val
  if (val !== null && typeof val === 'object') {
    return Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ')
  }
  return String(val)
}, z.string())

/**
 * Schema for the YAML output contract of the dev-story sub-agent.
 * The agent must emit YAML matching this shape.
 */
export const DevStoryResultSchema = z.object({
  result: z.enum(['success', 'failed']),
  ac_met: z.array(coerceToString),
  ac_failures: z.array(coerceToString),
  files_modified: z.array(z.string()),
  tests: z.enum(['pass', 'fail']),
  notes: z.string().optional(),
})

export type DevStorySchemaOutput = z.infer<typeof DevStoryResultSchema>

// ---------------------------------------------------------------------------
// CodeReviewResultSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single issue in the code review output.
 */
export const CodeReviewIssueSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  description: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
})

export type CodeReviewIssueSchemaOutput = z.infer<typeof CodeReviewIssueSchema>

/**
 * Schema for the YAML output contract of the code-review sub-agent.
 *
 * The agent must emit YAML with verdict, issues count, and issue_list.
 * Example:
 *   verdict: NEEDS_MINOR_FIXES
 *   issues: 3
 *   issue_list:
 *     - severity: minor
 *       description: "Missing error handling in createFoo()"
 *       file: "src/modules/foo/foo.ts"
 *       line: 42
 *   notes: "Generally clean implementation."
 */
export const CodeReviewResultSchema = z
  .object({
    verdict: z.enum(['SHIP_IT', 'NEEDS_MINOR_FIXES', 'NEEDS_MAJOR_REWORK']),
    issues: z.number(),
    issue_list: z.array(CodeReviewIssueSchema),
    notes: z.string().optional(),
  })
  .refine(
    (data) => data.issues === data.issue_list.length,
    (data) => ({
      message: `issues count (${data.issues}) must equal issue_list.length (${data.issue_list.length})`,
      path: ['issues'],
    }),
  )

export type CodeReviewSchemaOutput = z.infer<typeof CodeReviewResultSchema>
