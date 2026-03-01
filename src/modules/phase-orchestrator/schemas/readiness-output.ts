/**
 * Zod schema for readiness check agent output.
 *
 * Defines the structured output contract for the adversarial readiness
 * check sub-agent dispatched at the end of the solutioning phase.
 * The agent evaluates FR coverage, architecture compliance, story quality,
 * UX alignment (if applicable), and dependency validity — then emits a
 * verdict with scored findings.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// ReadinessFindingSchema
// ---------------------------------------------------------------------------

/**
 * A single finding identified by the readiness check agent.
 */
export const ReadinessFindingSchema = z.object({
  /**
   * Category of the finding:
   * - fr_coverage: A functional requirement is not covered by any story
   * - architecture_compliance: A story contradicts architecture decisions
   * - story_quality: ACs are vague, untestable, or tasks are insufficiently granular
   * - ux_alignment: Story does not account for UX decisions
   * - dependency_validity: Story depends on a story or artifact that doesn't exist
   */
  category: z.enum([
    'fr_coverage',
    'architecture_compliance',
    'story_quality',
    'ux_alignment',
    'dependency_validity',
  ]),
  /** Severity of the finding */
  severity: z.enum(['blocker', 'major', 'minor']),
  /** Human-readable description of the gap or issue */
  description: z.string().min(1),
  /** FR IDs, story keys, or decision keys affected by this finding */
  affected_items: z.array(z.string()).default([]),
})

export type ReadinessFinding = z.infer<typeof ReadinessFindingSchema>

// ---------------------------------------------------------------------------
// ReadinessOutputSchema
// ---------------------------------------------------------------------------

/**
 * Full output schema for the readiness check agent.
 *
 * The agent must emit a YAML block matching this schema.
 * - READY: all FRs covered, no blockers, acceptable quality — pipeline may proceed
 * - NEEDS_WORK: gaps identified but fixable via targeted story regeneration
 * - NOT_READY: critical failures that cannot be auto-remediated
 */
export const ReadinessOutputSchema = z.object({
  /** Overall go/no-go verdict */
  verdict: z.enum(['READY', 'NEEDS_WORK', 'NOT_READY']),
  /**
   * Percentage of FRs with clear story traceability (0–100).
   * Used to quantify coverage even when some stories are missing.
   */
  coverage_score: z.number().min(0).max(100),
  /** Ordered list of findings (blockers first, then major, then minor) */
  findings: z.array(ReadinessFindingSchema).default([]),
})

export type ReadinessOutput = z.infer<typeof ReadinessOutputSchema>
