/**
 * DispatchGate — pre-dispatch conflict gating for story dispatch.
 *
 * Story 53-9: Dispatch Pre-Condition Gating
 *
 * Evaluates three gating conditions in order:
 *   1. Learning pre-emption (AC6): high-confidence namespace-collision findings
 *      from the learning store that overlap with the pending story's files.
 *   2. File-level overlap (AC2): completed-story modified files overlap with
 *      the pending story's target files (warn, no block).
 *   3. Namespace collision (AC3): a symbol targeted by the pending story already
 *      exists in a file modified by a completed story.
 *
 * All DB and file I/O is wrapped in a single outer try-catch so that gate
 * failures never block the pipeline (AC7 — graceful degradation).
 */

import { getDecisionsByCategory, LEARNING_FINDING } from '@substrate-ai/core'
import type { GateResult, DispatchGateOptions } from './types.js'
import { FindingSchema } from '../learning/types.js'
import { ConflictDetector } from './conflict-detector.js'

// ---------------------------------------------------------------------------
// DispatchGate
// ---------------------------------------------------------------------------

export class DispatchGate {
  /**
   * Evaluate all pre-dispatch gating conditions for a pending story.
   *
   * Entry point: called once per story before agent dispatch.
   *
   * Steps (in order):
   *   1. Learning pre-emption check (AC6)
   *   2. Per-completed-story file overlap + collision scan (AC2/AC3)
   *   3. Return proceed if no issues found
   *
   * Outer try-catch ensures any unexpected error returns `{ decision: 'proceed' }`
   * so the pipeline is never blocked by gate failures (AC7).
   */
  static async check(options: DispatchGateOptions): Promise<GateResult> {
    try {
      const { storyKey, storyContent, pendingFiles, completedStories, db, projectRoot } = options

      // -----------------------------------------------------------------------
      // Step 1 — Learning pre-emption (AC6)
      // Query the learning store for high-confidence namespace-collision findings
      // whose affected_files overlap with the pending story's target files.
      // -----------------------------------------------------------------------
      try {
        const rows = await getDecisionsByCategory(db, LEARNING_FINDING)

        for (const row of rows) {
          try {
            const parsed: unknown = JSON.parse(row.value)
            const result = FindingSchema.safeParse(parsed)
            if (!result.success) continue

            const finding = result.data

            // Only consider high-confidence namespace-collision findings
            if (finding.root_cause !== 'namespace-collision') continue
            if (finding.confidence !== 'high') continue
            // Skip tombstoned findings
            if (finding.contradicted_by !== undefined) continue

            // Check file overlap between finding's affected_files and pending files
            const overlap = ConflictDetector.findOverlappingFiles(pendingFiles, finding.affected_files)
            if (overlap.length === 0) continue

            // Pre-emptive block via auto-resolution
            const extensionNote = `${storyKey} already exists in ${overlap[0]}. Extend the existing implementation instead of creating a new class.`
            const autoResolved = DispatchGate.attemptAutoResolution(storyContent, extensionNote)
            if (autoResolved !== null) {
              return {
                decision: 'block',
                conflictType: 'learning-preemption',
                reason: `learning-preemption: high-confidence finding — ${finding.description}`,
                modifiedPrompt: autoResolved,
              }
            }

            // Auto-resolution failed
            return {
              decision: 'gated',
              conflictType: 'learning-preemption',
              reason: `learning-preemption: high-confidence finding — ${finding.description}`,
            }
          } catch {
            // Non-fatal: malformed row — skip
            continue
          }
        }
      } catch {
        // Non-fatal: DB error during learning query — proceed to next step (AC7)
      }

      // -----------------------------------------------------------------------
      // Step 2 — File overlap + namespace collision (AC2/AC3)
      // Iterate completed stories and check for file overlaps.
      // For each overlap, check if any target symbol already exists in those files.
      // -----------------------------------------------------------------------

      // Extract symbols declared / targeted in the pending story
      const targetSymbols = ConflictDetector.extractTargetSymbols(storyContent)

      let warnResult: GateResult | null = null

      for (const completed of completedStories) {
        const overlappingFiles = ConflictDetector.findOverlappingFiles(
          pendingFiles,
          completed.modifiedFiles,
        )

        if (overlappingFiles.length === 0) continue

        // If storyContent is empty we cannot extract symbols to verify whether
        // a namespace collision exists. Gate proactively — cannot proceed without
        // knowing whether auto-resolution would be needed (AC5: "story content
        // cannot be retrieved or modified").
        if (storyContent.trim().length === 0) {
          return {
            decision: 'gated',
            conflictType: 'namespace-collision',
            reason: `namespace-collision: story content is empty — cannot verify conflict with files from story ${completed.key}`,
            completedStoryKey: completed.key,
          }
        }

        // File overlap detected — check for namespace collisions in overlapping files
        for (const symbol of targetSymbols) {
          let collision: { file: string; symbol: string } | null = null
          try {
            collision = await ConflictDetector.detectNamespaceCollision(
              symbol,
              overlappingFiles,
              projectRoot,
            )
          } catch {
            // Non-fatal: file-read error — skip this symbol (AC7)
            continue
          }

          if (collision !== null) {
            // Namespace collision found — attempt auto-resolution (AC4)
            const extensionNote = `${collision.symbol} already exists in ${collision.file}. Extend the existing implementation instead of creating a new class.`
            const autoResolved = DispatchGate.attemptAutoResolution(storyContent, extensionNote)

            if (autoResolved !== null) {
              return {
                decision: 'block',
                conflictType: 'namespace-collision',
                reason: `namespace-collision: ${collision.symbol} exists in ${collision.file} from story ${completed.key}`,
                modifiedPrompt: autoResolved,
                completedStoryKey: completed.key,
              }
            }

            // Auto-resolution failed (AC5)
            return {
              decision: 'gated',
              conflictType: 'namespace-collision',
              reason: `namespace-collision: ${collision.symbol} exists in ${collision.file} from story ${completed.key}`,
              completedStoryKey: completed.key,
            }
          }
        }

        // File overlap with no collision — record a warn result (AC2)
        // We'll emit the warning but continue checking other completed stories for collisions.
        if (warnResult === null) {
          warnResult = {
            decision: 'warn',
            conflictType: 'file-overlap',
            reason: `file-overlap: pending story shares files with completed story ${completed.key}`,
            completedStoryKey: completed.key,
            overlappingFiles,
          }
        }
      }

      // Return warn if we found overlap but no collision
      if (warnResult !== null) {
        return warnResult
      }

      // -----------------------------------------------------------------------
      // Step 3 — No issues found
      // -----------------------------------------------------------------------
      return { decision: 'proceed' }
    } catch {
      // AC7: outer catch — any unexpected error degrades gracefully to proceed
      return { decision: 'proceed' }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Attempt to auto-resolve a conflict by appending an extension note to the
   * story content.
   *
   * Returns the modified prompt string on success, or null if the content is
   * empty or the append fails for any reason (AC4/AC5).
   */
  private static attemptAutoResolution(storyContent: string, extensionNote: string): string | null {
    if (storyContent.trim().length === 0) {
      return null
    }
    try {
      return `${storyContent}\n\n${extensionNote}`
    } catch {
      return null
    }
  }
}
