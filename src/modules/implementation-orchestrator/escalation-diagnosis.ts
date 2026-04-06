/**
 * Escalation diagnosis generator.
 *
 * Analyzes issue lists from code-review escalations to produce structured
 * diagnoses with root-cause classification and recommended actions.
 */

// ---------------------------------------------------------------------------
// Adapter-format root cause bridge (story 53-10)
//
// Story 53-5 will define the full RootCauseCategory union and classifyFailure().
// This bridge exposes the adapter-format detection surface so that once 53-5
// ships, it can import detectAdapterFormatRootCause() instead of duplicating
// the adapterError check.
// ---------------------------------------------------------------------------

/**
 * Minimal result shape for adapter-format root cause detection.
 * Compatible with both TaskResult (adapters/types.ts) and DispatchResult
 * (dispatch/types.ts) since both have adapterError?: boolean (story 53-10).
 */
export interface HasAdapterError {
  adapterError?: boolean
}

/**
 * Detect whether a dispatch result represents an adapter-format failure.
 *
 * Returns `'adapter-format'` when `adapterError` is true, otherwise null.
 * Story 53-5's classifyFailure() should call this before evaluating issue lists.
 *
 * @param result - Any result object that may carry adapterError (TaskResult or DispatchResult)
 * @returns `'adapter-format'` | null
 */
export function detectAdapterFormatRootCause(result: HasAdapterError): 'adapter-format' | null {
  if (result.adapterError === true) {
    return 'adapter-format'
  }
  return null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationIssue {
  severity?: string
  description?: string
  file?: string
  line?: number
}

export type IssueDistribution = 'concentrated' | 'widespread'
export type SeverityProfile = 'blocker-present' | 'major-only' | 'minor-only' | 'no-structured-issues'
export type RecommendedAction = 'retry-targeted' | 'split-story' | 'human-intervention'

export interface EscalationDiagnosis {
  /** Root cause classification */
  issueDistribution: IssueDistribution
  severityProfile: SeverityProfile
  /** Summary counts */
  totalIssues: number
  blockerCount: number
  majorCount: number
  minorCount: number
  /** Files with the most issues */
  affectedFiles: string[]
  /** Number of review cycles exhausted */
  reviewCycles: number
  /** Actionable recommendation */
  recommendedAction: RecommendedAction
  /** Human-readable rationale for the recommendation */
  rationale: string
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a structured diagnosis from escalation data.
 *
 * Handles both structured issue lists (from code-review) and plain string
 * arrays (from create-story/dev-story failures).
 */
export function generateEscalationDiagnosis(
  issues: unknown[],
  reviewCycles: number,
  lastVerdict: string,
): EscalationDiagnosis {
  // Normalize issues: may be structured objects or plain strings
  const structured: EscalationIssue[] = issues.map((issue) => {
    if (typeof issue === 'string') {
      return { severity: 'major', description: issue }
    }
    const iss = issue as EscalationIssue
    return {
      severity: iss.severity ?? 'unknown',
      description: iss.description ?? '',
      file: iss.file,
      line: iss.line,
    }
  })

  // Count by severity
  const blockerCount = structured.filter((i) => i.severity === 'blocker').length
  const majorCount = structured.filter((i) => i.severity === 'major').length
  const minorCount = structured.filter((i) => i.severity === 'minor').length
  const totalIssues = structured.length

  // Group by file
  const fileCounts = new Map<string, number>()
  for (const issue of structured) {
    if (issue.file) {
      fileCounts.set(issue.file, (fileCounts.get(issue.file) ?? 0) + 1)
    }
  }

  // Sort files by issue count descending
  const sortedFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file)

  // Classify distribution: "concentrated" if >50% of issues in top 2 files
  const issuesWithFiles = structured.filter((i) => i.file).length
  let issueDistribution: IssueDistribution = 'widespread'
  if (issuesWithFiles > 0 && sortedFiles.length > 0) {
    const topTwoCount = sortedFiles
      .slice(0, 2)
      .reduce((sum, file) => sum + (fileCounts.get(file) ?? 0), 0)
    if (topTwoCount > issuesWithFiles * 0.5) {
      issueDistribution = 'concentrated'
    }
  }

  // Classify severity profile
  let severityProfile: SeverityProfile
  if (totalIssues === 0) {
    severityProfile = 'no-structured-issues'
  } else if (blockerCount > 0) {
    severityProfile = 'blocker-present'
  } else if (majorCount > 0) {
    severityProfile = 'major-only'
  } else {
    severityProfile = 'minor-only'
  }

  // Generate recommendation
  const { action, rationale } = pickRecommendation(
    issueDistribution,
    severityProfile,
    totalIssues,
    reviewCycles,
    lastVerdict,
  )

  return {
    issueDistribution,
    severityProfile,
    totalIssues,
    blockerCount,
    majorCount,
    minorCount,
    affectedFiles: sortedFiles.slice(0, 5),
    reviewCycles,
    recommendedAction: action,
    rationale,
  }
}

// ---------------------------------------------------------------------------
// Recommendation logic
// ---------------------------------------------------------------------------

function pickRecommendation(
  distribution: IssueDistribution,
  profile: SeverityProfile,
  totalIssues: number,
  reviewCycles: number,
  lastVerdict: string,
): { action: RecommendedAction; rationale: string } {
  // Create-story or dev-story failures — no structured review data
  if (lastVerdict.startsWith('create-story') || lastVerdict.startsWith('dev-story')) {
    return {
      action: 'human-intervention',
      rationale: `Pipeline failed during ${lastVerdict.replace(/-/g, ' ')} before code review. Manual investigation needed.`,
    }
  }

  // Fix dispatch timeout — partial work may exist
  if (lastVerdict === 'fix-dispatch-timeout') {
    return {
      action: 'retry-targeted',
      rationale: 'Fix dispatch timed out. Retry with a targeted prompt focusing on the remaining issues.',
    }
  }

  // No structured issues but escalated — likely schema parse failure
  if (profile === 'no-structured-issues') {
    return {
      action: 'retry-targeted',
      rationale: 'Review produced no structured issues — likely a schema parse failure. Retry may resolve.',
    }
  }

  // Blockers present — needs human eyes
  if (profile === 'blocker-present') {
    return {
      action: 'human-intervention',
      rationale: `${totalIssues} issues including blockers after ${reviewCycles} review cycles. Fundamental problems remain — human review recommended.`,
    }
  }

  // Concentrated issues in few files — retry with targeted prompt
  if (distribution === 'concentrated' && profile === 'major-only' && totalIssues <= 5) {
    return {
      action: 'retry-targeted',
      rationale: `${totalIssues} major issues concentrated in few files. A targeted retry prompt could resolve them.`,
    }
  }

  // Widespread issues or many majors — story may be too large
  if (distribution === 'widespread' && totalIssues > 3) {
    return {
      action: 'split-story',
      rationale: `${totalIssues} issues spread across many files after ${reviewCycles} cycles. Consider splitting into smaller stories.`,
    }
  }

  // Default: retry
  return {
    action: 'retry-targeted',
    rationale: `${totalIssues} issues (${profile}) after ${reviewCycles} cycles. Retry with focused prompt.`,
  }
}
