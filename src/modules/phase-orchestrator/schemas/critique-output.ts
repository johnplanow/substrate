/**
 * Zod schema for critique agent output.
 *
 * Defines the structured output contract for critique prompts
 * dispatched during the critique loop in each phase. The critique
 * agent evaluates an artifact and returns a verdict along with a
 * list of issues that need to be addressed.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// CritiqueIssueSchema
// ---------------------------------------------------------------------------

/**
 * A single issue identified by the critique agent.
 */
export const CritiqueIssueSchema = z.object({
  /** Severity level of the issue */
  severity: z.enum(['blocker', 'major', 'minor']),
  /** Category of the issue (e.g., 'clarity', 'completeness', 'consistency') */
  category: z.string().min(1),
  /** Human-readable description of the issue */
  description: z.string().min(5),
  /** Suggested fix or improvement */
  suggestion: z.string().min(5),
})

export type CritiqueIssue = z.infer<typeof CritiqueIssueSchema>

// ---------------------------------------------------------------------------
// CritiqueOutputSchema
// ---------------------------------------------------------------------------

/**
 * Full output schema for critique agent responses.
 *
 * The critique agent must emit a YAML block matching this schema.
 * - `pass` means the artifact meets quality standards with no blocking issues.
 * - `needs_work` means one or more issues must be addressed before the artifact
 *   can be considered complete.
 */
export const CritiqueOutputSchema = z.object({
  /** Overall verdict on the artifact quality */
  verdict: z.enum(['pass', 'needs_work']),
  /** Total count of issues found (must match issues array length) */
  issue_count: z.number().int().min(0),
  /** Array of specific issues found (empty when verdict is 'pass') */
  issues: z.array(CritiqueIssueSchema).default([]),
})

export type CritiqueOutput = z.infer<typeof CritiqueOutputSchema>
