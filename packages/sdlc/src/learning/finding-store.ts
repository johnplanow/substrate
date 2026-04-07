/**
 * Learning loop — finding persistence to the Dolt decisions table.
 *
 * Story 53-5: Root Cause Taxonomy and Failure Classification
 */

import { createDecision, LEARNING_FINDING } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { Finding } from './types.js'

// ---------------------------------------------------------------------------
// Persist a Finding to the decisions table
// ---------------------------------------------------------------------------

/**
 * Persist a classified Finding to the decisions table using the LEARNING_FINDING
 * category. Key format: '{story_key}:{run_id}'.
 *
 * @param finding - The Finding to persist (from buildFinding)
 * @param db - A live DatabaseAdapter (Dolt or InMemory)
 */
export async function persistFinding(finding: Finding, db: DatabaseAdapter): Promise<void> {
  await createDecision(db, {
    category: LEARNING_FINDING,
    key: `${finding.story_key}:${finding.run_id}`,
    phase: 'implementation',
    pipeline_run_id: finding.run_id,
    value: JSON.stringify(finding),
  })
}
