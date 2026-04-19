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
import type { PipelineRunStatus } from '../schemas/decisions.js'

/**
 * Pipeline-run statuses that make escalation-diagnosis decisions non-actionable.
 * Runs in these states are terminated (abandoned / stopped manually) and their
 * per-story escalations are historical noise — the work either shipped in a
 * later run or was never going to be retried in this run's lifetime.
 */
const TERMINAL_RUN_STATUSES: readonly PipelineRunStatus[] = ['failed', 'stopped']

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
 * Scoping:
 * - When `runId` is provided, only decisions whose key contains that runId
 *   are considered (AC5). The caller is explicit; no status filter is applied
 *   so a user can still inspect diagnoses from a terminal run by naming it.
 * - When `runId` is omitted, the latest run whose `pipeline_runs.status` is
 *   NOT terminal (`failed` / `stopped`) is used. Terminal runs are abandoned
 *   or manually stopped — their per-story diagnoses are historical noise and
 *   would generate false-positive retry proposals for work that either
 *   shipped in a later run or will never be retried in that run's lifetime.
 *
 * @param adapter  The database adapter
 * @param runId    Optional run ID to scope the query
 */
export async function getRetryableEscalations(
  adapter: DatabaseAdapter,
  runId?: string,
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
  //   - caller-supplied runId: honor it verbatim (explicit scoping)
  //   - omitted: walk decisions newest-first, pick the first whose referenced
  //     pipeline run is NOT in a terminal status
  let effectiveRunId: string
  if (runId !== undefined) {
    effectiveRunId = runId
  } else {
    const candidateRunId = await pickLatestNonTerminalRunId(adapter, parsed)
    if (candidateRunId === undefined) {
      // All referenced runs are terminal (or missing) → no actionable retries.
      return result
    }
    effectiveRunId = candidateRunId
  }

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ParsedEscalationEntry {
  storyKey: string
  decisionRunId: string
}

/**
 * Walk the parsed decision list newest-last (as supplied), map distinct runIds
 * to their pipeline-run status, and return the runId of the newest decision
 * whose run is NOT in a terminal status.
 *
 * Returns `undefined` when every referenced run is terminal or missing —
 * signalling "nothing retryable" to the caller.
 *
 * The adapter query is a single SELECT against `pipeline_runs` restricted to
 * the distinct runIds we actually care about; keeps the cost O(unique-runs)
 * rather than O(decisions).
 */
async function pickLatestNonTerminalRunId(
  adapter: DatabaseAdapter,
  parsed: ParsedEscalationEntry[],
): Promise<string | undefined> {
  const uniqueRunIds = Array.from(new Set(parsed.map((p) => p.decisionRunId)))
  if (uniqueRunIds.length === 0) return undefined

  // Bulk-fetch statuses. Use OR chain rather than IN-clause for
  // InMemoryDatabaseAdapter compatibility (its WHERE parser doesn't support IN).
  const statusByRunId = new Map<string, PipelineRunStatus>()
  for (const id of uniqueRunIds) {
    const rows = await adapter.query<{ id: string; status: PipelineRunStatus }>(
      'SELECT id, status FROM pipeline_runs WHERE id = ?',
      [id],
    )
    if (rows.length > 0 && rows[0]) {
      statusByRunId.set(rows[0].id, rows[0].status)
    }
  }

  // Scan newest-last (parsed is ordered created_at ASC). Return the first
  // (i.e. most-recent) entry whose run is NOT known-terminal.
  //
  // Treatment of missing runs: if a decision references a runId that has
  // no `pipeline_runs` row at all (deleted, or never persisted because the
  // pipeline ran without writing a run record), we *include* it. The filter's
  // purpose is to skip KNOWN-abandoned runs; an unknown status is treated as
  // "status available elsewhere or caller's choice" to preserve backward
  // compatibility with callers that seed decisions without run rows.
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const entry = parsed[i]!
    const status = statusByRunId.get(entry.decisionRunId)
    if (status !== undefined && TERMINAL_RUN_STATUSES.includes(status)) continue
    return entry.decisionRunId
  }

  return undefined
}
