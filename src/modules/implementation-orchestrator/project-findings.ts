/**
 * Project findings query for the learning loop (Story 22-1).
 *
 * Queries the decision store for prior run findings (story outcomes,
 * operational findings, story metrics, escalation diagnoses) and formats
 * them as a markdown summary for prompt injection.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { getDecisionsByCategory } from '../../persistence/queries/decisions.js'
import {
  OPERATIONAL_FINDING,
  STORY_METRICS,
  ESCALATION_DIAGNOSIS,
  STORY_OUTCOME,
  ADVISORY_NOTES,
} from '../../persistence/schemas/operational.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('project-findings')

/** Maximum character length for the findings summary */
const MAX_CHARS = 2000

/**
 * Query the decision store for prior project findings and return a formatted
 * markdown summary suitable for prompt injection.
 *
 * Returns an empty string if no findings exist (AC5: graceful fallback).
 */
export async function getProjectFindings(db: DatabaseAdapter): Promise<string> {
  try {
    const outcomes = await getDecisionsByCategory(db, STORY_OUTCOME)
    const operational = await getDecisionsByCategory(db, OPERATIONAL_FINDING)
    const metrics = await getDecisionsByCategory(db, STORY_METRICS)
    const diagnoses = await getDecisionsByCategory(db, ESCALATION_DIAGNOSIS)
    const advisoryNotes = await getDecisionsByCategory(db, ADVISORY_NOTES)

    // No findings at all — return empty (AC5)
    if (
      outcomes.length === 0 &&
      operational.length === 0 &&
      metrics.length === 0 &&
      diagnoses.length === 0 &&
      advisoryNotes.length === 0
    ) {
      return ''
    }

    const sections: string[] = []

    // Analyze story outcomes for recurring patterns
    if (outcomes.length > 0) {
      const patterns = extractRecurringPatterns(outcomes)
      if (patterns.length > 0) {
        sections.push('**Recurring patterns from prior runs:**')
        for (const p of patterns) {
          sections.push(`- ${p}`)
        }
      }
    }

    // Summarize escalation diagnoses with specific issue details when available.
    // The full issue list was added in v0.19.15 so retry prompts can target exact gaps.
    if (diagnoses.length > 0) {
      sections.push('**Prior escalations:**')
      for (const d of diagnoses.slice(-3)) {
        try {
          const val = JSON.parse(d.value)
          const storyId = (d.key ?? '').split(':')[0]
          sections.push(`- ${storyId}: ${val.recommendedAction} — ${val.rationale}`)
          // Include specific issues if persisted (v0.19.15+)
          if (Array.isArray(val.issues) && val.issues.length > 0) {
            for (const issue of val.issues.slice(0, 5)) {
              const sev = issue.severity ? `[${issue.severity}]` : ''
              const file = issue.file ? ` (${issue.file})` : ''
              const desc = issue.description ?? 'no description'
              sections.push(`  - ${sev} ${desc}${file}`)
            }
          }
        } catch {
          sections.push(`- ${d.key ?? 'unknown'}: escalated`)
        }
      }
    }

    // Summarize high review-cycle stories
    const highCycleStories = metrics
      .filter((m) => {
        try {
          const val = JSON.parse(m.value)
          return val.review_cycles >= 2
        } catch {
          return false
        }
      })
      .slice(-5)

    if (highCycleStories.length > 0) {
      sections.push('**Stories with high review cycles:**')
      for (const m of highCycleStories) {
        try {
          const val = JSON.parse(m.value)
          sections.push(`- ${(m.key ?? '').split(':')[0]}: ${val.review_cycles} cycles`)
        } catch {
          /* skip */
        }
      }
    }

    // Summarize operational findings (stalls)
    const stalls = operational.filter((o) => o.key?.startsWith('stall:'))
    if (stalls.length > 0) {
      sections.push(`**Prior stalls:** ${stalls.length} stall event(s) recorded`)
    }

    // Summarize advisory notes from LGTM_WITH_NOTES reviews
    if (advisoryNotes.length > 0) {
      sections.push('**Advisory notes from prior reviews (LGTM_WITH_NOTES):**')
      for (const n of advisoryNotes.slice(-3)) {
        try {
          const val = JSON.parse(n.value)
          const storyId = (n.key ?? '').split(':')[0]
          if (typeof val.notes === 'string' && val.notes.length > 0) {
            sections.push(`- ${storyId}: ${val.notes}`)
          }
        } catch {
          sections.push(`- ${n.key}: advisory notes available`)
        }
      }
    }

    if (sections.length === 0) {
      return ''
    }

    let summary = sections.join('\n')
    if (summary.length > MAX_CHARS) {
      summary = summary.slice(0, MAX_CHARS - 3) + '...'
    }
    return summary
  } catch (err) {
    logger.warn({ err }, 'Failed to query project findings (graceful fallback)')
    return ''
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract recurring patterns from story-outcome decisions.
 *
 * Looks for patterns that appear across multiple story outcomes
 * (e.g., "missing error handling" flagged in 3/5 stories).
 */
function extractRecurringPatterns(outcomes: Array<{ value: string }>): string[] {
  const patternCounts = new Map<string, number>()

  for (const o of outcomes) {
    try {
      const val = JSON.parse(o.value)
      if (Array.isArray(val.recurringPatterns)) {
        for (const pattern of val.recurringPatterns) {
          if (typeof pattern === 'string') {
            patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1)
          }
        }
      }
    } catch {
      /* skip malformed entries */
    }
  }

  // Only report patterns that appeared in 2+ stories
  return [...patternCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => `${pattern} (${count} occurrences)`)
}
