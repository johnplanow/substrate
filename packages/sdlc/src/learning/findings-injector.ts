/**
 * FindingsInjector — relevance-scored learning findings injector.
 *
 * Story 53-6: Findings Injector with Relevance Scoring
 *
 * Queries structured findings from the decisions table, scores each finding
 * against an injection context, applies threshold/saturation guards, and
 * serializes the top-ranked findings with budget enforcement.
 */

import type { DatabaseAdapter } from '@substrate-ai/core'
import { getDecisionsByCategory, LEARNING_FINDING } from '@substrate-ai/core'
import type { Finding } from './types.js'
import { FindingSchema } from './types.js'
import type { InjectionContext } from './relevance-scorer.js'
import { scoreRelevance } from './relevance-scorer.js'
import { FindingLifecycleManager } from './finding-lifecycle.js'

// ---------------------------------------------------------------------------
// FindingsInjectorConfig
// ---------------------------------------------------------------------------

export interface FindingsInjectorConfig {
  threshold?: number
  maxChars?: number
  saturationLimit?: number
}

// ---------------------------------------------------------------------------
// FindingsInjector
// ---------------------------------------------------------------------------

export class FindingsInjector {
  /**
   * Query relevance-scored findings from the decisions table and serialize
   * them as a prompt-injection string within the given character budget.
   *
   * Returns '' if no findings survive filtering or on any DB error.
   */
  static async inject(
    db: DatabaseAdapter,
    context: InjectionContext,
    config?: FindingsInjectorConfig,
  ): Promise<string> {
    // Resolve config defaults
    const threshold = config?.threshold ?? 0.3
    const maxChars = config?.maxChars ?? 2000
    const saturationLimit = config?.saturationLimit ?? 10

    // Query decisions table for LEARNING_FINDING rows
    let rows: Array<{ value: string }>
    try {
      rows = await getDecisionsByCategory(db, LEARNING_FINDING)
    } catch {
      return ''
    }

    // Parse valid findings; skip malformed rows silently
    const validFindings: Finding[] = []
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.value)
        const result = FindingSchema.safeParse(parsed)
        if (!result.success) continue
        validFindings.push(result.data)
      } catch {
        // Malformed JSON — skip this row
        continue
      }
    }

    // === Story 53-7: Lifecycle preprocessing ===
    // Step 3a: Deduplicate by root_cause + files fingerprint
    let candidates = FindingLifecycleManager.deduplicate(validFindings)
    // Step 3b: Exclude tombstoned (contradicted/archived) findings
    candidates = candidates.filter((f) => f.contradicted_by === undefined)
    // Step 3c: File existence validation (demote if missing)
    const projectRoot = process.cwd()
    candidates = candidates.map((f) => {
      try {
        return FindingLifecycleManager.validateFiles(f, projectRoot)
      } catch {
        return f
      }
    })
    // Step 3d: Expiry check — archive and exclude expired findings
    const survivingCandidates: Finding[] = []
    for (const f of candidates) {
      try {
        const runCount = await FindingLifecycleManager.countRunsSinceCreation(f, db)
        if (FindingLifecycleManager.isExpired(f, runCount)) {
          await FindingLifecycleManager.archiveFinding(f, context.runId, db)
          continue // excluded from injection
        }
      } catch {
        // Non-fatal: include the finding
      }
      survivingCandidates.push(f)
    }
    const scoredInput = survivingCandidates
    // === End lifecycle preprocessing ===

    // Score surviving candidates
    const scored: Array<{ finding: Finding; score: number }> = scoredInput.map((f) => ({
      finding: f,
      score: scoreRelevance(f, context),
    }))

    // Initial threshold filter
    let dynamicThreshold = threshold
    let filtered = scored.filter(({ score }) => score >= dynamicThreshold)

    // Saturation guard: raise threshold in 0.1 increments until ≤ saturationLimit remain
    while (filtered.length > saturationLimit && dynamicThreshold <= 1.0) {
      dynamicThreshold = Math.round((dynamicThreshold + 0.1) * 10) / 10
      filtered = scored.filter(({ score }) => score >= dynamicThreshold)
    }
    // If still over limit after threshold > 1.0, take top saturationLimit by score
    if (filtered.length > saturationLimit) {
      filtered = filtered.sort((a, b) => b.score - a.score).slice(0, saturationLimit)
    }

    // Sort by score descending
    filtered.sort((a, b) => b.score - a.score)

    // Serialize with maxChars budget enforcement
    const prefix = 'Prior run findings (most relevant first):\n\n'
    const lines: string[] = []
    let usedChars = prefix.length

    for (const { finding } of filtered) {
      const line =
        finding.confidence === 'high'
          ? `[${finding.root_cause}] Directive: ${finding.description}`
          : `[${finding.root_cause}] Note (low confidence): ${finding.description}`
      // Separator: '\n' between lines (not before the first)
      const addedLen = lines.length === 0 ? line.length : 1 + line.length
      if (usedChars + addedLen > maxChars) break
      lines.push(line)
      usedChars += addedLen
    }

    if (lines.length === 0) return ''
    return prefix + lines.join('\n')
  }
}

// ---------------------------------------------------------------------------
// extractTargetFilesFromStoryContent
// ---------------------------------------------------------------------------

/**
 * Extract file paths referenced in a story document for use as targetFiles
 * in relevance scoring.
 *
 * Matches paths starting with `packages/` or `src/` with common code extensions.
 * Returns up to 30 unique paths.
 */
export function extractTargetFilesFromStoryContent(storyContent: string): string[] {
  // Note: 'json' must appear before 'js' to prevent '.js' from matching '.json' files
  const pattern = /(?:packages\/|src\/)[\w/.~-]+\.(?:ts|json|js|md)/g
  const matches = storyContent.match(pattern) ?? []
  const unique = [...new Set(matches)]
  return unique.slice(0, 30)
}
