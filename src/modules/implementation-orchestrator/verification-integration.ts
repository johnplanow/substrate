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
import type {
  VerificationContext,
  VerificationFinding,
  VerificationSummary,
  ReviewSignals,
  DevStorySignals,
} from '@substrate-ai/sdlc'
import { renderFindings } from '@substrate-ai/sdlc'
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
  /**
   * Raw content of the source epic file for SourceAcFidelityCheck (Story 58-2).
   *
   * Populated from the epics file corresponding to the current story's epic.
   * `undefined` when epic file is absent or unreadable — non-fatal.
   */
  sourceEpicContent?: string
  /**
   * Pipeline run id used by the verification → learning feedback bridge
   * (Story 74-2). Stamped into the `run_id` field of every Finding the bridge
   * appends to the decisions table; left undefined for callers (tests) that
   * don't have one — the bridge falls back to `'unknown'`.
   */
  runId?: string
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
    sourceEpicContent: opts.sourceEpicContent,
    runId: opts.runId,
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
 * - Non-fatal: the `.catch()` handler swallows any rejection and logs at warn.
 * - Returns a `Promise<void>` so callers can optionally `await` it to ensure
 *   ordering (Story 57-2). Fire-and-forget callers that discard the return
 *   value continue to compile and work correctly.
 * - Reuses the single RunManifest instance injected by the orchestrator to
 *   avoid concurrent-write conflicts with the atomic-write lock.
 * - `runManifest` is optional (`undefined | null`) — callers from contexts
 *   where no manifest is configured pass `null` and this function returns a
 *   resolved promise (no-op).
 *
 * @param storyKey    - Story key being verified (e.g. '52-7')
 * @param summary     - VerificationSummary returned by VerificationPipeline.run()
 * @param runManifest - RunManifest instance to write to, or null/undefined to skip
 */
export function persistVerificationResult(
  storyKey: string,
  summary: VerificationSummary,
  runManifest: RunManifest | null | undefined,
): Promise<void> {
  if (runManifest == null) {
    return Promise.resolve()
  }
  return runManifest
    .patchStoryState(storyKey, { verification_result: summary })
    .catch((err: unknown) =>
      _logger.warn({ err, storyKey }, 'manifest verification_result write failed — pipeline continues'),
    )
}

// ---------------------------------------------------------------------------
// persistDevStorySignals — Story 60-8
// ---------------------------------------------------------------------------

/**
 * Non-fatally persist dev-story signals to the run manifest.
 *
 * Called right before each verification dispatch so the signals that fed
 * into the verification context are durably recorded. Closes a manifest-as-
 * source-of-truth gap (Epic 52 design contract): Story 60-3's under-delivery
 * detection in source-ac-fidelity reads `context.devStoryResult.files_modified`,
 * which the orchestrator passes in-memory at dispatch time but never wrote
 * to the manifest. Resume / retry-escalated / supervisor-restart / post-mortem
 * paths read state from the manifest and saw `dev_story_signals: undefined`,
 * forcing the under-delivery check into "benefit of doubt" warn mode rather
 * than the intended error.
 *
 * Surfaced strata Run a880f201 (2026-04-26): manifest's per_story_state["1-12"]
 * had no `dev_story_signals` field even though dev-story shipped 3 files.
 *
 * Same non-fatal / fire-and-forget semantics as persistVerificationResult.
 *
 * @param storyKey    - Story key being verified
 * @param signals     - Normalized DevStorySignals from the orchestrator's
 *                      replaceDevStorySignals / mergeDevStorySignals helpers
 * @param runManifest - RunManifest instance to write to, or null/undefined to skip
 */
export function persistDevStorySignals(
  storyKey: string,
  signals: DevStorySignals | undefined,
  runManifest: RunManifest | null | undefined,
): Promise<void> {
  if (runManifest == null || signals === undefined) {
    return Promise.resolve()
  }
  return runManifest
    .patchStoryState(storyKey, { dev_story_signals: signals })
    .catch((err: unknown) =>
      _logger.warn({ err, storyKey }, 'manifest dev_story_signals write failed — pipeline continues'),
    )
}

// ---------------------------------------------------------------------------
// renderVerificationFindingsForPrompt — Story 55-3
// ---------------------------------------------------------------------------

/**
 * Flatten every finding from a VerificationSummary's checks into a single
 * prompt-ready string. Returns '' when the summary is undefined, contains
 * no checks, or every check emits zero findings (e.g. every check passed).
 *
 * The output is intended for direct injection into retry/rework/fix
 * prompt templates via a `{{verification_findings}}` section — kept
 * human-readable and minimal. Each finding is rendered as a single
 * `ERROR [category] message` / `WARN [...]` / `INFO [...]` line via the
 * renderFindings helper from the verification module; lines are grouped
 * by check name for readability.
 */
export function renderVerificationFindingsForPrompt(
  summary: VerificationSummary | undefined,
): string {
  if (!summary) return ''

  const blocks: string[] = []
  for (const check of summary.checks) {
    const findings: VerificationFinding[] = check.findings ?? []
    if (findings.length === 0) continue
    const rendered = renderFindings(findings)
    blocks.push(`- ${check.checkName}:\n${rendered.replace(/^/gm, '    ')}`)
  }
  return blocks.join('\n')
}
