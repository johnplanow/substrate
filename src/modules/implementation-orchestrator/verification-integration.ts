/**
 * Verification integration helpers — Story 51-5 / 52-7.
 *
 * Provides:
 * - `assembleVerificationContext`: builds a VerificationContext from orchestrator data
 * - `VerificationStore`: in-memory store for VerificationSummary results
 * - `persistVerificationResult`: non-fatal manifest persistence for Story 52-7
 *
 * No LLM calls in this file (FR-V9). All logic is pure orchestration.
 */

import { execSync } from 'node:child_process'
import type { VerificationContext, VerificationSummary, ReviewSignals, DevStorySignals } from '@substrate-ai/sdlc'
import type { RunManifest } from '@substrate-ai/sdlc'
import { createLogger } from '../../utils/logger.js'

const _logger = createLogger('verification-integration')

// ---------------------------------------------------------------------------
// assembleVerificationContext
// ---------------------------------------------------------------------------

/**
 * Options for assembling a VerificationContext.
 */
export interface AssembleVerificationContextOpts {
  /** Story key being verified (e.g. "51-5"). */
  storyKey: string
  /** Absolute path to the project working directory. */
  workingDir: string
  /** Optional code-review dispatch signals for PhantomReviewCheck. */
  reviewResult?: ReviewSignals
  /** Optional story markdown for AcceptanceCriteriaEvidenceCheck. */
  storyContent?: string
  /** Optional dev-story output for AcceptanceCriteriaEvidenceCheck. */
  devStoryResult?: DevStorySignals
  /** Total output tokens produced by the story dispatch. */
  outputTokenCount?: number
}

/**
 * Build a VerificationContext from orchestrator dispatch data.
 *
 * Resolves the current HEAD SHA via `git rev-parse HEAD` (falls back to
 * `'unknown'` on error). Timeout is hardcoded to 60_000 ms to match
 * BuildCheck's hard limit.
 */
export function assembleVerificationContext(
  opts: AssembleVerificationContextOpts,
): VerificationContext {
  let commitSha: string
  try {
    commitSha = execSync('git rev-parse HEAD', {
      cwd: opts.workingDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    commitSha = 'unknown'
  }

  return {
    storyKey: opts.storyKey,
    workingDir: opts.workingDir,
    commitSha,
    timeout: 60_000,
    reviewResult: opts.reviewResult,
    storyContent: opts.storyContent,
    devStoryResult: opts.devStoryResult,
    outputTokenCount: opts.outputTokenCount,
  }
}

// ---------------------------------------------------------------------------
// VerificationStore
// ---------------------------------------------------------------------------

/**
 * In-memory store for VerificationSummary results, keyed by story key.
 *
 * Persists for the lifetime of the orchestrator instance. Does NOT write
 * to Dolt, SQLite, or any file system — the manifest persistence path
 * is provided by `persistVerificationResult` (Story 52-7).
 */
export class VerificationStore {
  private readonly _map = new Map<string, VerificationSummary>()

  /** Store a VerificationSummary for the given story key. */
  set(storyKey: string, summary: VerificationSummary): void {
    this._map.set(storyKey, summary)
  }

  /** Retrieve the VerificationSummary for a story key, or `undefined` if not found. */
  get(storyKey: string): VerificationSummary | undefined {
    return this._map.get(storyKey)
  }

  /** Return a read-only view of all stored summaries. */
  getAll(): ReadonlyMap<string, VerificationSummary> {
    return this._map
  }
}

// ---------------------------------------------------------------------------
// persistVerificationResult — Story 52-7
// ---------------------------------------------------------------------------

/**
 * Non-fatally persist a VerificationSummary to the run manifest.
 *
 * Called immediately after `VerificationPipeline.run()` returns, before any
 * terminal phase transition. Records both pass/warn and fail outcomes so all
 * verification results survive process crashes.
 *
 * Design notes:
 * - Non-fatal: the returned promise is wrapped in `.catch()` at the call site
 *   so a manifest write failure never aborts the pipeline.
 * - Reuses the single RunManifest instance injected by the orchestrator to
 *   avoid concurrent-write conflicts with the atomic-write lock.
 * - `runManifest` is optional (`undefined | null`) — callers from contexts
 *   where no manifest is configured pass `null` and this function is a no-op.
 *
 * @param storyKey    - Story key being verified (e.g. '52-7')
 * @param summary     - VerificationSummary returned by VerificationPipeline.run()
 * @param runManifest - RunManifest instance to write to, or null/undefined to skip
 */
export function persistVerificationResult(
  storyKey: string,
  summary: VerificationSummary,
  runManifest: RunManifest | null | undefined,
): void {
  if (runManifest == null) {
    return
  }
  runManifest
    .patchStoryState(storyKey, { verification_result: summary })
    .catch((err: unknown) =>
      _logger.warn({ err, storyKey }, 'manifest verification_result write failed — pipeline continues'),
    )
}
