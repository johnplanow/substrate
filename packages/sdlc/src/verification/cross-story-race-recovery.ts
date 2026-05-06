/**
 * Cross-story race recovery — Story 70-1.
 *
 * Provides `detectStaleVerifications` (pure, no I/O) and
 * `runStaleVerificationRecovery` (action handler) for detecting and resolving
 * verification races that occur when concurrent story commits land after the
 * earlier story's verification already ran.
 *
 * Motivating incidents:
 *   - Epic 66 run a832487a: 66-1+66-2+66-7 concurrent dispatch — concurrent
 *     stories modifying shared test files caused transient verification failures
 *     when the later-committing story's changes affected the earlier story's
 *     already-recorded verification verdict.
 *   - Epic 67 run a59e4c96: 67-1+67-2 concurrent dispatch — the
 *     methodology-pack.test.ts BUDGET_LIMIT constant (30000 vs 32000) was
 *     updated by story 67-1 AFTER 67-2's verification ran on the un-bumped
 *     tree, causing a false pipeline failure verdict despite fully coherent
 *     on-disk state. Budget-bump pattern documented in:
 *     packages/sdlc/src/__tests__/methodology-pack.test.ts
 *
 * This primitive eliminates manual Path A recovery on the cross-story-race
 * class going forward.
 */

import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import type { TypedEventBus } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { SdlcEvents } from '../events.js'
import type { RunManifest } from '../run-model/run-manifest.js'
import { createDefaultVerificationPipeline } from './verification-pipeline.js'
import type { VerificationContext } from './types.js'

// ---------------------------------------------------------------------------
// BatchEntry — per-story pre-resolved data for stale detection
// ---------------------------------------------------------------------------

/**
 * Pre-resolved per-story entry for stale-verification detection.
 *
 * All fields are pre-resolved by the caller so `detectStaleVerifications`
 * remains a pure function with no I/O. `runStaleVerificationRecovery`
 * populates these fields from the run manifest and git log.
 */
export interface BatchEntry {
  /** Story key (e.g. "70-1"). */
  storyKey: string
  /**
   * ISO timestamp of when this story's verification result was recorded.
   * Falls back to `completed_at` from PerStoryState when absent from
   * verification_result metadata (Risk: Assumption 2).
   */
  verifiedAt?: string
  /**
   * ISO timestamp of when this story's implementation commit landed.
   * Resolved from `git log --format=%cI --grep="feat(story-<storyKey>):" -1`.
   */
  committedAt?: string
  /** Files modified by this story's implementation (from dev_story_signals). */
  modifiedFiles?: string[]
  /** Test files associated with this story (subset of modifiedFiles). */
  testFiles?: string[]
  /**
   * Fallback file list when `modifiedFiles` is absent (AC9-f).
   * Populated from verification_result or dev_story_signals when the primary
   * modifiedFiles field is not available in the manifest.
   */
  verificationResultFiles?: string[]
}

// ---------------------------------------------------------------------------
// detectStaleVerifications — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Detect stories whose verification results were recorded before concurrent
 * story commits landed.
 *
 * Stale-verification boundary condition:
 *   t.committedAt > s.verifiedAt
 *   AND
 *   t.modifiedFiles ∩ (s.modifiedFiles ∪ s.testFiles) ≠ ∅
 *
 * Where:
 *   s = the story we're checking for staleness
 *   t = another story in the batch that may have committed after s verified
 *
 * Pure function — all data must be pre-resolved in the `batch` entries.
 * Returns empty array when no stale stories are detected (idempotent, no-op).
 *
 * @param batch    Pre-resolved story data for all stories in the concurrent batch.
 * @param _manifest Manifest instance (accepted for API symmetry; not used in pure logic).
 * @returns Array of story keys that have stale verification results.
 */
export function detectStaleVerifications(
  batch: BatchEntry[],
  _manifest: RunManifest | Record<string, unknown>,
): string[] {
  if (batch.length < 2) {
    // Cannot have a race with fewer than 2 stories
    return []
  }

  const staleKeys: string[] = []

  for (const s of batch) {
    const sVerifiedAt = s.verifiedAt
    if (sVerifiedAt === undefined) {
      // Story was never verified — not a staleness case
      continue
    }

    // Effective file set for story s: modifiedFiles ∪ testFiles, with fallback
    const sPrimaryFiles = s.modifiedFiles ?? s.verificationResultFiles ?? []
    const sTestFiles = s.testFiles ?? []
    const sAllFiles = new Set([...sPrimaryFiles, ...sTestFiles])

    if (sAllFiles.size === 0) {
      // No files tracked for story s — cannot detect overlap
      continue
    }

    for (const t of batch) {
      if (t.storyKey === s.storyKey) continue

      const tCommittedAt = t.committedAt
      if (tCommittedAt === undefined) continue

      // Race condition: t committed AFTER s had already verified.
      // Use Date objects for comparison to handle timezone-offset strings
      // (git log may emit local-timezone format while manifest timestamps are UTC).
      let tTime: number, sTime: number
      try {
        tTime = new Date(tCommittedAt).getTime()
        sTime = new Date(sVerifiedAt).getTime()
      } catch {
        continue // unparseable timestamp — skip
      }
      if (isNaN(tTime) || isNaN(sTime)) continue
      if (tTime <= sTime) continue

      // Check file overlap: t modified files that s also worked on
      const tFiles = t.modifiedFiles ?? []
      const hasOverlap = tFiles.some((f) => sAllFiles.has(f))

      if (hasOverlap) {
        staleKeys.push(s.storyKey)
        break // found at least one race partner — no need to check more
      }
    }
  }

  return staleKeys
}

// ---------------------------------------------------------------------------
// CommittedAtResolver — git log helper
// ---------------------------------------------------------------------------

/**
 * Resolves the commit timestamp for a story's implementation commit.
 *
 * Uses the canonical `feat(story-<storyKey>):` commit message pattern to
 * locate the story's auto-commit in git history.
 *
 * @param storyKey   Story key (e.g. "70-1")
 * @param workingDir Absolute path to the git repo root
 * @returns ISO-8601 commit timestamp string, or `undefined` if not found
 */
export function CommittedAtResolver(
  storyKey: string,
  workingDir: string,
): string | undefined {
  try {
    const result = execSync(
      `git log --format=%cI --grep="feat(story-${storyKey}):" -1`,
      {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim()
    return result.length > 0 ? result : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// runStaleVerificationRecovery — action handler
// ---------------------------------------------------------------------------

/**
 * Input for `runStaleVerificationRecovery`.
 */
export interface StaleVerificationRecoveryInput {
  /** Run ID for event emission and manifest access. */
  runId: string
  /**
   * Batch entries with pre-resolved story data. `committedAt` values are
   * resolved internally from git log; do NOT pre-populate them.
   * Other fields (verifiedAt, modifiedFiles, testFiles) are populated from
   * the manifest's per_story_state when absent from the caller's batch.
   */
  batch: BatchEntry[]
  /** Absolute path to the project working directory. */
  workingDir: string
  /** Typed event bus for emitting recovery lifecycle events. */
  bus: TypedEventBus<SdlcEvents>
  /** RunManifest instance for state reads and writes. */
  manifest: RunManifest
  /**
   * Database adapter for Dolt persistence (canonical helper per AC3).
   *
   * Reserved for future Dolt writes (e.g. storing recovery audit records).
   * `RunManifest.patchStoryState` currently handles all necessary persistence
   * for this recovery handler, so `adapter` is wired through at the interface
   * boundary to preserve the canonical-helper contract without forcing callers
   * to update their call sites when a Dolt write is added later.
   *
   * Do NOT remove this parameter — it is part of the public AC3-mandated
   * interface shape. Add a leading underscore if a linter flags it as unused.
   */
  adapter: DatabaseAdapter
}

/**
 * Result of a `runStaleVerificationRecovery` invocation.
 */
export interface StaleVerificationRecoveryResult {
  /** Story keys whose fresh verification passed → transitioned to 'complete'. */
  recovered: string[]
  /** Story keys whose fresh verification still failed → transitioned to 'failed'. */
  stillFailed: string[]
  /** True when no stale verifications were detected (idempotent no-op exit). */
  noStale: boolean
}

/**
 * Cross-story race recovery action handler.
 *
 * Orchestrates the full recovery arc for stories with stale verification
 * results caused by concurrent story commits landing after verification ran:
 *
 *   1. Resolves `committedAt` for each batch story via git log.
 *   2. Enriches BatchEntry[] from manifest per_story_state when fields absent.
 *   3. Calls `detectStaleVerifications` to identify stale story keys.
 *   4. Returns `{ noStale: true }` immediately when none are stale (idempotent).
 *   5. For each stale story:
 *      a. Transitions status to `verification-stale` in manifest.
 *      b. Re-runs `createDefaultVerificationPipeline` against current tree.
 *      c. On pass: transitions to `complete`, emits `pipeline:cross-story-race-recovered`.
 *      d. On fail: transitions to `failed` with `verification_re_run: true`,
 *         emits `pipeline:cross-story-race-still-failed`.
 *
 * Implements AC3 canonical-helper discipline: all state reads use RunManifest,
 * all persistence uses the injected adapter. No direct file reads of manifest.json.
 *
 * @param input Recovery input (see StaleVerificationRecoveryInput)
 * @returns Recovery summary
 */
export async function runStaleVerificationRecovery(
  input: StaleVerificationRecoveryInput,
): Promise<StaleVerificationRecoveryResult> {
  const { runId, batch, workingDir, bus, manifest } = input

  // --- Step 1: Resolve committedAt for each story via git log ---
  const enrichedBatch: BatchEntry[] = []

  let manifestData: Awaited<ReturnType<RunManifest['read']>> | null = null
  try {
    manifestData = await manifest.read()
  } catch {
    // manifest unreadable — proceed with batch data as-is
  }

  for (const entry of batch) {
    const committedAt = CommittedAtResolver(entry.storyKey, workingDir)

    // Enrich verifiedAt and modifiedFiles from manifest when absent in batch entry
    let verifiedAt = entry.verifiedAt
    let modifiedFiles = entry.modifiedFiles
    let testFiles = entry.testFiles
    let verificationResultFiles = entry.verificationResultFiles

    if (manifestData !== null) {
      const perStory = manifestData.per_story_state[entry.storyKey]
      if (perStory !== undefined) {
        // Fall back to completed_at as verifiedAt when absent (Risk: Assumption 2)
        if (verifiedAt === undefined) {
          verifiedAt = perStory.completed_at
        }
        // Fall back to dev_story_signals.files_modified when modifiedFiles absent
        if (modifiedFiles === undefined && perStory.dev_story_signals?.files_modified !== undefined) {
          modifiedFiles = perStory.dev_story_signals.files_modified
        }
        // Populate verificationResultFiles from dev_story_signals as the AC9-f fallback
        if (verificationResultFiles === undefined && perStory.dev_story_signals?.files_modified !== undefined) {
          verificationResultFiles = perStory.dev_story_signals.files_modified
        }
      }
    }

    // Build enriched entry using exactOptionalPropertyTypes-safe spread:
    // only include optional fields when they have a concrete value.
    const enriched: BatchEntry = { storyKey: entry.storyKey }
    if (committedAt !== undefined) enriched.committedAt = committedAt
    if (verifiedAt !== undefined) enriched.verifiedAt = verifiedAt
    if (modifiedFiles !== undefined) enriched.modifiedFiles = modifiedFiles
    if (testFiles !== undefined) enriched.testFiles = testFiles
    if (verificationResultFiles !== undefined) enriched.verificationResultFiles = verificationResultFiles
    enrichedBatch.push(enriched)
  }

  // --- Step 2: Detect stale verifications (pure) ---
  const staleKeys = detectStaleVerifications(enrichedBatch, manifest)

  if (staleKeys.length === 0) {
    // Idempotent no-op: no stale verifications detected
    return { recovered: [], stillFailed: [], noStale: true }
  }

  // --- Step 3: Recovery loop — re-verify each stale story ---
  const recovered: string[] = []
  const stillFailed: string[] = []

  // Build a fresh verification pipeline bound to this bus
  const verificationPipeline = createDefaultVerificationPipeline(bus)

  for (const storyKey of staleKeys) {
    const recoveryStart = Date.now()

    // Collect original findings from manifest
    let originalFindings: unknown[] = []
    if (manifestData !== null) {
      const perStory = manifestData.per_story_state[storyKey]
      if (perStory?.verification_result !== undefined) {
        originalFindings = (perStory.verification_result.checks ?? []).flatMap(
          (c) => c.findings ?? [],
        )
      }
    }

    // Transition to verification-stale
    await manifest
      .patchStoryState(storyKey, { status: 'verification-stale' })
      .catch(() => {
        // Non-fatal — continue recovery even if manifest patch fails
      })

    // Build a minimal verification context against current HEAD
    let commitSha: string
    try {
      commitSha = execSync('git rev-parse HEAD', {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      commitSha = 'unknown'
    }

    // Read story content if available (best-effort)
    let storyContent: string | undefined
    try {
      const artifactsDir = `${workingDir}/_bmad-output/implementation-artifacts`
      if (existsSync(artifactsDir)) {
        const STALE_SUFFIX = /\.stale-\d+\.md$/
        const files = readdirSync(artifactsDir)
        const match = files.find(
          (f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md') && !STALE_SUFFIX.test(f),
        )
        if (match !== undefined) {
          storyContent = readFileSync(`${artifactsDir}/${match}`, 'utf-8')
        }
      }
    } catch {
      // Story content is optional — proceed without it
    }

    // exactOptionalPropertyTypes-safe construction: only include optional
    // fields when they have a concrete non-undefined value.
    const verifContext: VerificationContext = {
      storyKey,
      workingDir,
      commitSha,
      timeout: 60_000,
      ...(storyContent !== undefined ? { storyContent } : {}),
    }

    // Re-run verification pipeline against fresh tree
    const freshSummary = await verificationPipeline.run(verifContext, 'A')

    const freshFindings: unknown[] = (freshSummary.checks ?? []).flatMap(
      (c) => c.findings ?? [],
    )
    const recoveryDurationMs = Date.now() - recoveryStart

    if (freshSummary.status === 'pass' || freshSummary.status === 'warn') {
      // Fresh verification passed — story is genuinely complete
      await manifest
        .patchStoryState(storyKey, {
          status: 'complete',
          verification_result: freshSummary,
          completed_at: new Date().toISOString(),
        })
        .catch(() => {
          // Non-fatal
        })

      bus.emit('pipeline:cross-story-race-recovered', {
        runId,
        storyKey,
        originalFindings,
        freshFindings,
        recoveryDurationMs,
      })

      recovered.push(storyKey)
    } else {
      // Fresh verification still failed — genuine failure, not a race artefact
      await manifest
        .patchStoryState(storyKey, {
          status: 'failed',
          verification_result: freshSummary,
          verification_re_run: true,
          completed_at: new Date().toISOString(),
        })
        .catch(() => {
          // Non-fatal
        })

      bus.emit('pipeline:cross-story-race-still-failed', {
        runId,
        storyKey,
        freshFindings,
        recoveryDurationMs,
      })

      stillFailed.push(storyKey)
    }
  }

  return { recovered, stillFailed, noStale: false }
}
