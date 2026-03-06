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
  result: z.preprocess(
    (val) => (val === 'failure' ? 'failed' : val),
    z.enum(['success', 'failed']),
  ),
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
  result: z.preprocess(
    (val) => (val === 'failure' ? 'failed' : val),
    z.enum(['success', 'failed']),
  ),
  ac_met: z.array(coerceToString),
  ac_failures: z.array(coerceToString),
  files_modified: z.array(z.string()),
  tests: z.preprocess((val) => {
    if (typeof val === 'string') {
      const lower = val.toLowerCase()
      if (lower.includes('fail')) return 'fail'
      return 'pass'
    }
    // Handle object form: { pass: N, fail: N }
    if (val !== null && typeof val === 'object') {
      const obj = val as Record<string, unknown>
      if (typeof obj.fail === 'number' && obj.fail > 0) return 'fail'
      return 'pass'
    }
    // Handle number: 0 = pass, >0 = fail count
    if (typeof val === 'number') return val > 0 ? 'fail' : 'pass'
    return 'pass'
  }, z.enum(['pass', 'fail'])),
  notes: z.string().optional(),
})

export type DevStorySchemaOutput = z.infer<typeof DevStoryResultSchema>

// ---------------------------------------------------------------------------
// CodeReviewResultSchema
// ---------------------------------------------------------------------------

/**
 * Coerce a YAML value to a number. Agents sometimes emit line numbers
 * as strings (`"42"` instead of `42`). This handles the conversion.
 */
const coerceOptionalNumber = z.preprocess(
  (val) => (typeof val === 'string' ? Number(val) : val),
  z.number().optional(),
)

const coerceNumber = z.preprocess(
  (val) => (typeof val === 'string' ? Number(val) : val),
  z.number(),
)

/**
 * Schema for a single issue in the code review output.
 */
export const CodeReviewIssueSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  description: z.string(),
  file: z.string().optional(),
  line: coerceOptionalNumber,
})

export type CodeReviewIssueSchemaOutput = z.infer<typeof CodeReviewIssueSchema>

/**
 * Compute the verdict from the issue list using deterministic rules.
 *
 * The agent reports issues with severities; the pipeline computes the
 * verdict. This decouples model-routing cost decisions (MAJOR_REWORK
 * triggers opus) from agent judgment, and scales naturally with story
 * size — severity classification is per-issue, not per-story.
 *
 * Rules:
 *  - Any blocker → NEEDS_MAJOR_REWORK (security, data loss, architectural breakage)
 *  - Any major or minor issues → NEEDS_MINOR_FIXES (fixable by sonnet with guidance)
 *  - No issues → SHIP_IT
 */
function computeVerdict(
  issueList: Array<{ severity: 'blocker' | 'major' | 'minor' }>,
): 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' {
  const hasBlocker = issueList.some((i) => i.severity === 'blocker')
  if (hasBlocker) return 'NEEDS_MAJOR_REWORK'
  if (issueList.length > 0) return 'NEEDS_MINOR_FIXES'
  return 'SHIP_IT'
}

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
 *
 * The transform auto-corrects the issues count and recomputes the verdict
 * from the issue list. The agent's original verdict is preserved as
 * `agentVerdict` for logging and debugging.
 */
export const CodeReviewResultSchema = z
  .object({
    verdict: z.enum(['SHIP_IT', 'NEEDS_MINOR_FIXES', 'NEEDS_MAJOR_REWORK']),
    issues: coerceNumber,
    issue_list: z.array(CodeReviewIssueSchema),
    notes: z.string().optional(),
  })
  .transform((data) => ({
    ...data,
    issues: data.issue_list.length,
    agentVerdict: data.verdict,
    verdict: computeVerdict(data.issue_list),
  }))

export type CodeReviewSchemaOutput = z.infer<typeof CodeReviewResultSchema>

// ---------------------------------------------------------------------------
// TestPlanResultSchema
// ---------------------------------------------------------------------------

/**
 * Schema for the YAML output contract of the test-plan sub-agent.
 *
 * The agent must emit YAML with result, test_files, test_categories, and coverage_notes.
 * Example:
 *   result: success
 *   test_files:
 *     - src/modules/foo/__tests__/foo.test.ts
 *   test_categories:
 *     - unit
 *     - integration
 *   coverage_notes: "AC1 covered by foo.test.ts"
 */
export const TestPlanResultSchema = z.object({
  result: z.preprocess(
    (val) => (val === 'failure' ? 'failed' : val),
    z.enum(['success', 'failed']),
  ),
  test_files: z.array(z.string()).default([]),
  test_categories: z.array(z.string()).default([]),
  coverage_notes: z.string().default(''),
})

export type TestPlanSchemaOutput = z.infer<typeof TestPlanResultSchema>

// ---------------------------------------------------------------------------
// TestExpansionResultSchema
// ---------------------------------------------------------------------------

/**
 * Schema for a single coverage gap identified during test expansion analysis.
 */
export const CoverageGapSchema = z.object({
  ac_ref: z.string(),
  description: z.string(),
  gap_type: z.enum(['missing-e2e', 'missing-integration', 'unit-only']),
})

export type CoverageGapSchemaOutput = z.infer<typeof CoverageGapSchema>

/**
 * Schema for a single suggested test generated during test expansion analysis.
 */
export const SuggestedTestSchema = z.object({
  test_name: z.string(),
  test_type: z.enum(['e2e', 'integration', 'unit']),
  description: z.string(),
  target_ac: z.string().optional(),
})

export type SuggestedTestSchemaOutput = z.infer<typeof SuggestedTestSchema>

/**
 * Schema for the YAML output contract of the test-expansion sub-agent.
 *
 * The agent must emit YAML with expansion_priority, coverage_gaps, and suggested_tests.
 * Example:
 *   expansion_priority: medium
 *   coverage_gaps:
 *     - ac_ref: AC1
 *       description: "Happy path not exercised at module boundary"
 *       gap_type: missing-integration
 *   suggested_tests:
 *     - test_name: "runFoo integration happy path"
 *       test_type: integration
 *       description: "Test runFoo with real DB to verify AC1 end-to-end"
 *       target_ac: AC1
 *   notes: "Unit coverage is solid but integration layer is untested."
 */
export const TestExpansionResultSchema = z.object({
  expansion_priority: z.preprocess(
    (val) => (['low', 'medium', 'high'].includes(val as string) ? val : 'low'),
    z.enum(['low', 'medium', 'high']),
  ),
  coverage_gaps: z.array(CoverageGapSchema).default([]),
  suggested_tests: z.array(SuggestedTestSchema).default([]),
  notes: z.string().optional(),
})

export type TestExpansionSchemaOutput = z.infer<typeof TestExpansionResultSchema>
