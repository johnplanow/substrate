/**
 * phase-detection — Auto-detect which pipeline phase to start from.
 *
 * Inspects the artifacts table to determine how far the pipeline has
 * progressed, then returns the next phase that needs to run.
 *
 * Used by `substrate run` (no --from) to intelligently route to the
 * right phase instead of always jumping to implementation.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { resolveStoryKeys } from '../implementation-orchestrator/story-discovery.js'

// Phase artifact types produced by each phase on successful completion.
// Research is optional — its absence doesn't block the pipeline.
const PHASE_ARTIFACTS: Array<{ phase: string; type: string; optional: boolean }> = [
  { phase: 'research', type: 'research-findings', optional: true },
  { phase: 'analysis', type: 'product-brief', optional: false },
  { phase: 'planning', type: 'prd', optional: false },
  { phase: 'solutioning', type: 'stories', optional: false },
]

export interface PhaseDetectionResult {
  /** The phase to start from */
  phase: string
  /** Human-readable reason for the detection */
  reason: string
  /** If true, this phase needs a concept/brief to start */
  needsConcept: boolean
}

/**
 * Detect the next phase to run based on DB state.
 *
 * Detection logic:
 * 1. If stories exist (decisions/epics.md) → implementation
 * 2. Walk forward through phases checking for completion artifacts
 * 3. Skip optional phases (research) if no artifact found
 * 4. The first required phase WITHOUT an artifact is where we start
 * 5. If nothing exists → analysis (needs concept)
 */
export async function detectStartPhase(
  db: DatabaseAdapter,
  projectRoot: string,
  epicNumber?: number
): Promise<PhaseDetectionResult> {
  // Fast path: if stories are discoverable, go straight to implementation
  try {
    const storyKeys = await resolveStoryKeys(db, projectRoot, { epicNumber })
    if (storyKeys.length > 0) {
      const scopeLabel = epicNumber !== undefined ? ` (epic ${epicNumber})` : ''
      return {
        phase: 'implementation',
        reason: `${storyKeys.length} stories ready for implementation${scopeLabel}`,
        needsConcept: false,
      }
    }
  } catch {
    // DB or file errors — fall through to artifact inspection
  }

  // Walk forward through phases, find the first incomplete required phase
  let lastCompletedPhase: string | undefined

  try {
    for (const entry of PHASE_ARTIFACTS) {
      const rows = await db.query<{ id: string }>(
        'SELECT id FROM artifacts WHERE phase = ? AND type = ? LIMIT 1',
        [entry.phase, entry.type]
      )
      const row = rows[0]

      if (row !== undefined) {
        lastCompletedPhase = entry.phase
      } else if (!entry.optional) {
        // Required phase not completed — this is where we need to start
        const needsConcept = entry.phase === 'analysis'
        const reason =
          lastCompletedPhase !== undefined
            ? `${lastCompletedPhase} phase complete — continuing with ${entry.phase}`
            : 'No pipeline state found — starting from the beginning'
        return { phase: entry.phase, needsConcept, reason }
      }
      // Optional phase not found — skip and continue scanning
    }
  } catch {
    // DB errors — default to analysis
    return {
      phase: 'analysis',
      reason: 'No pipeline state found — starting from the beginning',
      needsConcept: true,
    }
  }

  // All phases have artifacts but no stories found — re-run solutioning
  if (lastCompletedPhase !== undefined) {
    return {
      phase: 'solutioning',
      reason: 'All phases completed but no stories found — re-running solutioning',
      needsConcept: false,
    }
  }

  // Nothing at all
  return {
    phase: 'analysis',
    reason: 'No pipeline state found — starting from the beginning',
    needsConcept: true,
  }
}
