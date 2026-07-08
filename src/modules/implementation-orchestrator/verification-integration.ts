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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /**
   * H1.5: ground-truth changed-file list (git capture) for ContaminationCheck.
   */
  changedFiles?: string[]
  /**
   * H1.7: pre-existing tracked files the story modified (TestMutationCheck).
   */
  modifiedTrackedFiles?: string[]
  /**
   * H7 (trust-boundary hardening): directory whose `.substrate/project-profile.yaml`
   * is TRUSTED for security-relevant fields (declared languages, testCommand).
   * The orchestrator passes its main tree (`projectRoot`), which lives OUTSIDE
   * every per-story worktree — so the dispatched agent cannot whitelist its own
   * contamination or launder the test command by editing its worktree copy.
   * Absent → falls back to `workingDir` (backward compat / --no-worktree, where
   * the agent runs in the main tree and the threat model differs).
   *
   * NOTE: this closes the WORKTREE-EDIT vector only. An agent with the (still
   * unscoped) Bash tool can write the main-tree profile directly — that vector
   * is closed only by the container backend (H4.4). See the red-team review.
   */
  trustedProfileDir?: string
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

  // H1.2 (hardening): populate the build/test command overrides from the
  // project profile in the WORKING DIR (the worktree — the profile reaches it
  // via H1.1). BuildCheck/TestSuiteCheck also read the profile themselves as
  // a fallback; setting the context here makes the resolution explicit and
  // testable at the orchestrator seam. Left undefined when the profile has no
  // such key so the checks' own detection still applies.
  // H7: read security-relevant profile fields from the TRUSTED dir (the
  // orchestrator's main tree), not the agent-controlled worktree copy.
  const trustedDir = opts.trustedProfileDir ?? opts.workingDir
  const profileBuildCommand = readProfileKey(trustedDir, 'buildCommand')
  const profileTestCommand = readProfileKey(trustedDir, 'testCommand')
  const trustedLanguages = readProfileLanguagesLocal(trustedDir)

  // A1.3 (acceptance-gate): trusted snapshots of the acceptance-gate inputs
  // for AcceptanceSpecCheck (spec-tamper tripwire). RAW contents only — the
  // check (in @substrate-ai/sdlc, where the parsers live) does the comparing;
  // this module never value-imports from sdlc (mock fragility, see
  // readProfileLanguagesLocal). Only under worktree dispatch — a self-compare
  // against workingDir is vacuous.
  let acceptanceSpecGuard: VerificationContext['acceptanceSpecGuard']
  if (opts.trustedProfileDir !== undefined) {
    const readOrNull = (rel: string): string | null => {
      try {
        const content = readFileSync(join(trustedDir, rel), 'utf-8')
        return content.trim().length > 0 ? content : null
      } catch {
        return null
      }
    }
    const journeysTrusted = readOrNull('.substrate/acceptance/journeys.yaml')
    // Arm the guard ONLY when the trusted tree has a journey registry —
    // acceptance is adopted there and its specs deserve the tripwire. On
    // registry-less projects a worktree-introduced spec only takes effect
    // after an operator-visible merge lands it, and arming unconditionally
    // turns environment noise (mocked/absent trusted dirs in tests,
    // --no-worktree self-compares) into false verification failures.
    if (journeysTrusted !== null) {
      const profileTrusted = readOrNull('.substrate/project-profile.yaml')
      const fixturesPath = readAcceptanceFixturesPathLocal(profileTrusted)
      acceptanceSpecGuard = {
        journeysTrusted,
        deferralsTrusted: readOrNull('.substrate/acceptance/deferrals.yaml'),
        profileTrusted,
        ...(fixturesPath !== undefined ? { fixturesPath } : {}),
      }
    }
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
    ...(opts.changedFiles !== undefined ? { changedFiles: opts.changedFiles } : {}),
    ...(opts.modifiedTrackedFiles !== undefined ? { modifiedTrackedFiles: opts.modifiedTrackedFiles } : {}),
    ...(profileBuildCommand !== undefined ? { buildCommand: profileBuildCommand } : {}),
    ...(profileTestCommand !== undefined ? { testCommand: profileTestCommand } : {}),
    ...(trustedLanguages.length > 0 ? { trustedLanguages } : {}),
    ...(acceptanceSpecGuard !== undefined ? { acceptanceSpecGuard } : {}),
  }
}

/**
 * A1.3: extract `fixtures:` from the `acceptance:` block of profile content.
 * Line-based (no yaml dependency, no sdlc value import) — tracks entry/exit
 * of the top-level acceptance block by indentation.
 */
function readAcceptanceFixturesPathLocal(profileContent: string | null): string | undefined {
  if (profileContent === null) return undefined
  let inAcceptance = false
  for (const line of profileContent.split('\n')) {
    if (/^acceptance:\s*$/.test(line)) {
      inAcceptance = true
      continue
    }
    if (inAcceptance && /^\S/.test(line)) inAcceptance = false
    if (inAcceptance) {
      const m = /^\s+fixtures:\s*['"]?([^'"\n#]+?)['"]?\s*$/.exec(line)
      if (m?.[1] !== undefined) return m[1].trim()
    }
  }
  return undefined
}

/**
 * Read a single `<key>: value` line from `.substrate/project-profile.yaml`
 * under `workingDir` (H1.2). Line-based parse — no yaml dependency.
 */
function readProfileLanguagesLocal(dir: string): string[] {
  // H7: local mirror of ContaminationCheck.readProfileLanguages — kept in this
  // module to avoid importing a value from @substrate-ai/sdlc (orchestrator
  // tests mock that package with partial exports; a value import would be
  // undefined under the mock and throw during context assembly).
  const profilePath = join(dir, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) return []
  try {
    const content = readFileSync(profilePath, 'utf-8')
    const langs = new Set<string>()
    for (const m of content.matchAll(/^\s*(?:-\s+)?language:\s*['"]?([a-z]+)['"]?\s*$/gm)) {
      if (m[1] !== undefined) langs.add(m[1])
    }
    return [...langs]
  } catch {
    return []
  }
}

function readProfileKey(workingDir: string, key: 'buildCommand' | 'testCommand'): string | undefined {
  const profilePath = join(workingDir, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) return undefined
  try {
    const content = readFileSync(profilePath, 'utf-8')
    const match = content.match(new RegExp(`^\\s*${key}:\\s*['"]?(.+?)['"]?\\s*$`, 'm'))
    if (match?.[1] && match[1].length > 0) return match[1]
  } catch {
    // Unreadable — fall back to the checks' own detection.
  }
  return undefined
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
