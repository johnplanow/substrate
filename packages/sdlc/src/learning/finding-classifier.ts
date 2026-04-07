/**
 * Learning loop — top-level classify-and-persist orchestrator.
 *
 * Story 53-5: Root Cause Taxonomy and Failure Classification
 *
 * classifyAndPersist is the primary entry point for the learning loop:
 * it classifies a story failure, constructs a Finding, and persists it to
 * Dolt — all non-fatally (persistence errors are swallowed so the in-memory
 * result is always returned to the caller).
 */

import type { DatabaseAdapter } from '@substrate-ai/core'
import { classifyFailure, buildFinding } from './failure-classifier.js'
import { persistFinding } from './finding-store.js'
import type { Finding, StoryFailureContext } from './types.js'

// ---------------------------------------------------------------------------
// Classify and persist a story failure
// ---------------------------------------------------------------------------

/**
 * Classify a story failure, build a Finding, and attempt to persist it.
 *
 * Persistence is non-fatal: if `db` is null or the persist call rejects,
 * the Finding is still returned. This ensures that Dolt unavailability
 * never blocks the learning loop from producing an in-memory classification.
 *
 * @param ctx - Contextual failure information from the orchestrator
 * @param db - DatabaseAdapter to persist to, or null if unavailable
 * @returns A validated Finding with root_cause, confidence, and metadata
 */
export async function classifyAndPersist(
  ctx: StoryFailureContext,
  db: DatabaseAdapter | null,
): Promise<Finding> {
  const rootCause = classifyFailure(ctx)
  const finding = buildFinding(ctx, rootCause, ctx.runId)

  if (db !== null) {
    persistFinding(finding, db).catch(() => {
      // Non-fatal: Dolt may be unavailable; in-memory finding is always returned
    })
  }

  return finding
}
