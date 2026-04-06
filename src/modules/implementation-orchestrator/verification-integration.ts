/**
 * Verification integration helpers — Story 51-5.
 *
 * Provides:
 * - `assembleVerificationContext`: builds a VerificationContext from orchestrator data
 * - `VerificationStore`: in-memory store for VerificationSummary results
 *
 * No LLM calls in this file (FR-V9). All logic is pure orchestration.
 */

import { execSync } from 'node:child_process'
import type { VerificationContext, VerificationSummary, ReviewSignals } from '@substrate-ai/sdlc'

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
 * to Dolt, SQLite, or any file system — persistence is Epic 52 scope.
 * Future consumers (story 52-7) read from this store to persist results.
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
