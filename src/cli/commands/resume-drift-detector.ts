/**
 * Manifest drift detector for `substrate resume` — Story 66-3.
 *
 * Detects when the run manifest's per-story phase is stale relative to working-tree
 * files, indicating the orchestrator died after writing output but before persisting
 * the phase advancement (obs_2026-05-03_022 class).
 *
 * This module has no side effects on import. All functions are async.
 */

import { glob } from 'glob'
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import type { RunManifestData } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DriftEvidence {
  storyKey: string
  sampleFiles: string[]
  /**
   * Total number of working-tree files whose mtime is newer than the story's
   * `started_at` timestamp. May exceed `sampleFiles.length` (which is capped at 3).
   */
  totalNewerFiles: number
}

export interface DriftDetectionResult {
  drifted: boolean
  evidence: DriftEvidence[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SCAN_GLOBS = ['packages/*/src/**/*.ts', 'src/**/*.ts']

// ---------------------------------------------------------------------------
// Public: detectManifestDriftAgainstWorkingTree
// ---------------------------------------------------------------------------

/**
 * Detect manifest-vs-working-tree drift for `substrate resume`.
 *
 * Scans files matching the configured glob patterns using the `glob` library.
 * For each story entry in `manifest.per_story_state` where
 * `phase === 'IN_STORY_CREATION'` AND `status === 'dispatched'`, checks whether
 * any scanned file has an mtime newer than the story's `started_at` timestamp.
 * If so, the manifest is considered drifted.
 *
 * Scan globs are read from the `SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS` environment
 * variable (comma-separated), falling back to the defaults:
 * "packages/&#42;/src/&#42;&#42;/&#42;.ts" and "src/&#42;&#42;/&#42;.ts"
 *
 * @param manifest    - The run manifest data (parsed and validated from disk)
 * @param projectRoot - Absolute path to the project root for glob scanning
 * @returns `{ drifted, evidence }` where `evidence` contains up to 3 sample
 *          newer files per drifted story entry.
 */
export async function detectManifestDriftAgainstWorkingTree(
  manifest: RunManifestData,
  projectRoot: string,
): Promise<DriftDetectionResult> {
  const envGlobs = process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS']
  const scanGlobs =
    envGlobs !== undefined && envGlobs.trim() !== ''
      ? envGlobs
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean)
      : DEFAULT_SCAN_GLOBS

  // Collect qualifying story entries (IN_STORY_CREATION + dispatched only)
  const qualifying = Object.entries(manifest.per_story_state).filter(
    ([, s]) => s.phase === 'IN_STORY_CREATION' && s.status === 'dispatched',
  )

  if (qualifying.length === 0) {
    return { drifted: false, evidence: [] }
  }

  // Gather all matching file paths using the glob library (supports full glob
  // syntax including brace expansion, character classes, and extended patterns).
  // Returns absolute paths for reliable stat() calls.
  const scannedAbsPaths: string[] = await glob(scanGlobs, {
    cwd: projectRoot,
    absolute: true,
    nodir: true,
  })

  if (scannedAbsPaths.length === 0) {
    return { drifted: false, evidence: [] }
  }

  const evidence: DriftEvidence[] = []

  for (const [storyKey, storyState] of qualifying) {
    // Use started_at as the per-story comparison timestamp.
    //
    // Rationale: PerStoryState (packages/sdlc/src/run-model/per-story-state.ts)
    // carries `started_at` and `completed_at` but does NOT carry `updated_at`.
    // The Dev Notes referenced `updated_at` anticipating a potential future field;
    // since the field does not exist on the schema, `started_at` (the ISO-8601
    // timestamp recorded when the story was dispatched to IN_STORY_CREATION) is
    // the most accurate per-story timestamp available for drift comparison.
    const storyTimestampMs = new Date(storyState.started_at).getTime()
    const newerFiles: string[] = []

    for (const absPath of scannedAbsPaths) {
      try {
        const { mtimeMs } = await fs.stat(absPath)
        if (mtimeMs > storyTimestampMs) {
          newerFiles.push(relative(projectRoot, absPath).replace(/\\/g, '/'))
        }
      } catch {
        // Skip inaccessible files
      }
    }

    if (newerFiles.length > 0) {
      evidence.push({
        storyKey,
        sampleFiles: newerFiles.slice(0, 3),
        totalNewerFiles: newerFiles.length,
      })
    }
  }

  return {
    drifted: evidence.length > 0,
    evidence,
  }
}
