/**
 * CliFlags — typed schema for CLI flags persisted in the run manifest — Story 52-3.
 *
 * These flags are written to `cli_flags` in the run manifest at run start so that
 * the supervisor can read the original scope on restart.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// CliFlagsSchema — Zod schema for CLI flags
// ---------------------------------------------------------------------------

/**
 * Zod schema for the CLI flags persisted in the run manifest.
 *
 * All fields are optional — only flags explicitly provided on the CLI are written.
 * `halt_on` defaults to `'none'` at write time; `cost_ceiling` is omitted when not provided.
 */
export const CliFlagsSchema = z.object({
  /** Explicit story keys provided via --stories (e.g. ['51-1', '51-2']). */
  stories: z.array(z.string()).optional(),
  /** Escalation severity level that halts the pipeline (--halt-on). */
  halt_on: z.enum(['all', 'critical', 'none']).optional(),
  /** Maximum spend in USD before the pipeline halts (--cost-ceiling). */
  cost_ceiling: z.number().positive().optional(),
  /** Agent backend ID (--agent), e.g. 'codex' or 'gemini'. */
  agent: z.string().optional(),
  /** When true, the post-dispatch verification pipeline was skipped (--skip-verification). */
  skip_verification: z.boolean().optional(),
  /** When true, NDJSON events were requested (--events). */
  events: z.boolean().optional(),
  /** When true, the run was started in non-interactive mode (--non-interactive). Story 72-2. */
  non_interactive: z.boolean().optional(),
  /** When true, a halt prompt was suppressed in non-interactive mode. Story 72-2. */
  halt_skipped: z.boolean().optional(),
  /** Decisions that would have halted the pipeline but were suppressed in non-interactive mode. Story 72-2. */
  halt_skipped_decisions: z
    .array(
      z.object({
        decisionType: z.string(),
        severity: z.string(),
        defaultAction: z.string(),
        reason: z.string(),
        skippedAt: z.string(),
      }),
    )
    .optional(),
  /** When true, per-story worktree creation was bypassed (--no-worktree). Story 75-3. */
  no_worktree: z.boolean().optional(),
})

export type CliFlags = z.infer<typeof CliFlagsSchema>
