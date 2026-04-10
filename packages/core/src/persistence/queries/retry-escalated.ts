/**
 * Query functions for retryable escalated stories.
 *
 * Reads escalation-diagnosis decisions from the decision store and classifies
 * each story as retryable (retry-targeted) or skipped (human-intervention /
 * split-story).
 *
 * All functions are async and accept a DatabaseAdapter, making them
 * compatible with both the SqliteDatabaseAdapter and DoltDatabaseAdapter.
 */

import type { DatabaseAdapter } from '../types.js'
import { getDecisionsByCategory } from './decisions.js'
import { ESCALATION_DIAGNOSIS } from '../schemas/operational.js'

// ---------------------------------------------------------------------------
// Local type alias (avoids cross-package src/ import)
// ---------------------------------------------------------------------------

interface EscalationDiagnosis {
  recommendedAction: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkippedStory {
  key: string
  reason: string
}

export interface RetryableEscalationsResult {
  retryable: string[]
  skipped: SkippedStory[]
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Query the decision store for escalation-diagnosis decisions and classify
 * each story key as retryable or skipped.
 *
 * Key format in the DB: `{storyKey}:{runId}`
 *
 * - When `runId` is provided, only decisions whose key contains that runId
 *   are considered (AC5 scoping).
 * - When `runId` is omitted, the runId of the last (most recently created)
 *   escalation-diagnosis decision is used as the default (AC1 defaulting).
 *
 * @param adapter  The database adapter
 * @param runId    Optional run ID to scope the query
 */
export async function getRetryableEscalations(
  adapter: DatabaseAdapter,
  runId?: string
): Promise<RetryableEscalationsResult> {
  const decisions = await getDecisionsByCategory(adapter, ESCALATION_DIAGNOSIS)
  const result: RetryableEscalationsResult = { retryable: [], skipped: [] }

  if (decisions.length === 0) {
    return result
  }

  // Parse each decision row into a structured form
  interface ParsedDecision {
    storyKey: string
    decisionRunId: string
    diagnosis: EscalationDiagnosis
  }

  const parsed: ParsedDecision[] = []

  for (const decision of decisions) {
    const colonIdx = decision.key.indexOf(':')
    if (colonIdx === -1) continue // skip malformed keys

    const storyKey = decision.key.slice(0, colonIdx)
    const decisionRunId = decision.key.slice(colonIdx + 1)

    let diagnosis: EscalationDiagnosis
    try {
      diagnosis = JSON.parse(decision.value) as EscalationDiagnosis
    } catch {
      continue // skip malformed values
    }

    parsed.push({ storyKey, decisionRunId, diagnosis })
  }

  if (parsed.length === 0) {
    return result
  }

  // Determine effective runId:
  // - If caller supplies a runId, use it (AC5)
  // - Otherwise, use the runId of the last decision (most recently created = latest run) (AC1)
  const effectiveRunId: string = runId ?? parsed[parsed.length - 1]!.decisionRunId

  // Deduplicate by storyKey: keep the last entry per storyKey (last write wins since the
  // list is ordered by created_at ASC — later entries in the array are more recent).
  const lastEntryByKey = new Map<string, ParsedDecision>()

  for (const entry of parsed) {
    if (entry.decisionRunId !== effectiveRunId) continue
    // Overwrite so the last occurrence wins
    lastEntryByKey.set(entry.storyKey, entry)
  }

  for (const [storyKey, entry] of lastEntryByKey.entries()) {
    const { recommendedAction } = entry.diagnosis

    if (recommendedAction === 'retry-targeted') {
      result.retryable.push(storyKey)
    } else if (recommendedAction === 'human-intervention') {
      result.skipped.push({ key: storyKey, reason: 'needs human review' })
    } else if (recommendedAction === 'split-story') {
      result.skipped.push({ key: storyKey, reason: 'story should be split' })
    }
    // Unknown recommendedAction values are silently ignored
  }

  return result
}
