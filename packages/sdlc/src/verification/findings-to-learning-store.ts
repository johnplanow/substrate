/**
 * Verification-to-Learning feedback bridge.
 *
 * Original spec: Phase D Story 54-8 (2026-04-05)
 * Root-cause taxonomy consumed: Story 53-5 (v0.19.31)
 *
 * Closes the feedback circuit: verification pipeline findings →
 * learning store (Dolt decisions table) → FindingsInjector →
 * future dispatch context.
 *
 * Story 74-2:
 *   - Consumes the existing `VerificationSummary` shape (no new aggregate format).
 *   - Maps each `fail` / `warn` check to a `RootCauseCategory` via a static map
 *     (AC2). Unmapped check names are skipped — verification keeps growing new
 *     checks; we'd rather drop unrelated noise than mis-classify it.
 *   - Writes Finding rows via `appendFinding` from
 *     `@substrate-ai/core/persistence/queries/decisions`. That helper inserts
 *     into the same `decisions` table (`category = 'finding'`) that
 *     `FindingsInjector` already reads via `getDecisionsByCategory`, so future
 *     dispatches automatically pick up verification-derived signal.
 *
 * Wiring (AC6):
 *   - Invoked by `VerificationPipeline.run()` AFTER it emits
 *     `verification:story-complete`. Fire-and-forget — Dolt write errors are
 *     logged at warn but never propagate to the verification result.
 */

import type { DatabaseAdapter } from '@substrate-ai/core'
import { appendFinding, createDatabaseAdapter } from '@substrate-ai/core'
import type { Finding, RootCauseCategory } from '../learning/types.js'
import { FindingSchema } from '../learning/types.js'
import type { VerificationSummary, VerificationCheckResult } from './types.js'

// ---------------------------------------------------------------------------
// Root-cause derivation map (AC2)
// ---------------------------------------------------------------------------

/**
 * Maps verification check names → learning-store root cause categories.
 *
 * Only checks present in this map produce findings. Any other check name is
 * silently skipped (the verification result is unaffected).
 */
export const ROOT_CAUSE_MAP: Record<string, RootCauseCategory> = {
  'phantom-review': 'build-failure',
  'trivial-output': 'resource-exhaustion',
  build: 'build-failure',
  'acceptance-criteria-evidence': 'ac-missing-evidence',
  'runtime-probes': 'runtime-probe-fail',
  'source-ac-fidelity': 'source-ac-drift',
  'cross-story-consistency': 'cross-story-concurrent-modification',
}

// ---------------------------------------------------------------------------
// StoryContext
// ---------------------------------------------------------------------------

/**
 * Minimal story-scoped context needed to stamp a Finding row.
 *
 * Sourced by callers from the orchestrator's per-story state — the dev-story
 * `files_modified` array and the active pipeline run id.
 */
export interface StoryContext {
  /** Pipeline run id; falls back to `'unknown'` when not supplied. */
  runId: string
  /** Files the dev-story dispatch reported as modified. */
  filesModified: string[]
}

// ---------------------------------------------------------------------------
// injectVerificationFindings (AC1, AC2, AC3, AC4, AC7)
// ---------------------------------------------------------------------------

/**
 * Inject verification-derived findings into the learning store.
 *
 * For each check in `summary.checks` whose `status` is `'fail'` or `'warn'`
 * AND whose `checkName` is mapped in `ROOT_CAUSE_MAP`, append a Finding row
 * to the existing `decisions` table via `appendFinding`. Findings are stamped
 * with:
 *   - `confidence: 'high'` — verification is static analysis, not heuristic
 *     (AC3).
 *   - `affected_files: storyContext.filesModified` (AC4).
 *   - `root_cause: ROOT_CAUSE_MAP[check.checkName]` (AC2).
 *
 * Adapter resolution:
 *   - Production: callers (e.g., the orchestrator-wired VerificationPipeline)
 *     pass an explicit adapter built from the monolith's
 *     `createDatabaseAdapter` shim (which injects DoltClient).
 *   - Standalone (e.g., the runtime probe in this story): when `adapter` is
 *     omitted we fall back to `@substrate-ai/core`'s `createDatabaseAdapter`
 *     with `backend: 'auto'`. Without a Dolt client factory the core factory
 *     returns InMemoryDatabaseAdapter — fine for tests, surfaces a no-op for
 *     the runtime probe (which uses an explicit adapter via the wiring).
 *
 * Errors are surfaced to the caller's `.catch` handler. The production wiring
 * in `VerificationPipeline.run` swallows them at warn so verification never
 * blocks on Dolt unavailability.
 */
export async function injectVerificationFindings(
  verificationSummary: VerificationSummary,
  storyContext: StoryContext,
  adapter?: DatabaseAdapter,
): Promise<void> {
  const findings = buildFindingsFromSummary(verificationSummary, storyContext)

  if (findings.length === 0) return

  const ownAdapter = adapter === undefined
  const dbAdapter: DatabaseAdapter =
    adapter ?? createDatabaseAdapter({ backend: 'auto' })

  try {
    for (const finding of findings) {
      await appendFinding(dbAdapter, finding)
    }
  } finally {
    // Only close adapters we created. Caller owns adapters they passed in.
    if (ownAdapter) {
      try {
        await dbAdapter.close()
      } catch {
        // Non-fatal — close errors must not propagate
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the list of Finding objects that should be persisted for this summary.
 * Pure function — no I/O — to keep unit tests simple.
 */
export function buildFindingsFromSummary(
  summary: VerificationSummary,
  storyContext: StoryContext,
): Finding[] {
  const findings: Finding[] = []

  for (const check of summary.checks) {
    if (!shouldInjectCheck(check)) continue
    const rootCause = ROOT_CAUSE_MAP[check.checkName]
    if (rootCause === undefined) continue

    const finding = FindingSchema.parse({
      id: crypto.randomUUID(),
      run_id: storyContext.runId.length > 0 ? storyContext.runId : 'unknown',
      story_key: summary.storyKey,
      root_cause: rootCause,
      affected_files: storyContext.filesModified,
      description: buildDescription(check),
      confidence: 'high',
      created_at: new Date().toISOString(),
      expires_after_runs: 5,
    })

    findings.push(finding)
  }

  return findings
}

/**
 * Returns true when a verification check should produce a finding.
 *
 * AC2 / AC9 require both `fail` and `warn` to inject (Task 5 case d). `pass`
 * and any unrecognized status are skipped — silence is signal.
 */
function shouldInjectCheck(check: VerificationCheckResult): boolean {
  return check.status === 'fail' || check.status === 'warn'
}

/**
 * Compose a stable, human-readable description from the check result.
 * `details` is preferred when present; otherwise we fall back to a synthetic
 * one-liner so retry prompts always have something to render.
 */
function buildDescription(check: VerificationCheckResult): string {
  const detailText = check.details?.trim() ?? ''
  if (detailText.length > 0) {
    return `[${check.checkName}/${check.status}] ${detailText}`
  }
  return `[${check.checkName}/${check.status}] verification check produced no detail text`
}
