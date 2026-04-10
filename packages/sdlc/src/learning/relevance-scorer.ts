/**
 * RelevanceScorer — deterministic relevance scoring for learning findings.
 *
 * Story 53-6: Findings Injector with Relevance Scoring
 *
 * Computes a [0, 1] relevance score for a Finding relative to an injection
 * context using a three-component weighted formula:
 *   0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch
 */

import type { Finding, RootCauseCategory } from './types.js'

// ---------------------------------------------------------------------------
// InjectionContext
// ---------------------------------------------------------------------------

export interface InjectionContext {
  storyKey: string
  runId: string
  targetFiles?: string[]
  packageName?: string
  riskProfile?: RootCauseCategory[]
}

// ---------------------------------------------------------------------------
// scoreRelevance — pure synchronous relevance scoring
// ---------------------------------------------------------------------------

/**
 * Score the relevance of a Finding to the given InjectionContext.
 *
 * @returns A number in [0, 1] computed as:
 *   0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch
 */
export function scoreRelevance(finding: Finding, context: InjectionContext): number {
  // --- Jaccard file overlap ---
  // Cap target files to the 20 shortest paths (sorted ascending by length)
  const cappedTargets = (context.targetFiles ?? []).sort((a, b) => a.length - b.length).slice(0, 20)
  const targetSet = new Set(cappedTargets)
  const intersectionCount = finding.affected_files.filter((f) => targetSet.has(f)).length
  const jaccardFileOverlap =
    cappedTargets.length === 0 || finding.affected_files.length === 0
      ? 0
      : intersectionCount / Math.min(finding.affected_files.length, cappedTargets.length)

  // --- Package match ---
  // Extract package name from each path in affected_files via packages/<name>/
  const pkgRegex = /packages\/([^/]+)\//
  const inferredPackages = finding.affected_files
    .map((f) => pkgRegex.exec(f)?.[1])
    .filter((p): p is string => p !== undefined)
  const packageMatch =
    context.packageName === undefined || inferredPackages.length === 0
      ? 0.5
      : inferredPackages.includes(context.packageName)
        ? 1.0
        : 0.0

  // --- Root cause match ---
  const rootCauseMatch =
    !context.riskProfile || context.riskProfile.length === 0
      ? 0.5
      : context.riskProfile.includes(finding.root_cause)
        ? 1.0
        : 0.0

  return Math.min(
    1,
    Math.max(0, 0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch)
  )
}
