/**
 * Learning loop — deterministic failure classifier.
 *
 * Story 53-5: Root Cause Taxonomy and Failure Classification
 *
 * classifyFailure applies a rule chain in strict priority order (§3.4).
 * buildFinding constructs a validated Finding from a classification result.
 */

import { FindingSchema } from './types.js'
import type { Finding, RootCauseCategory, StoryFailureContext } from './types.js'

// ---------------------------------------------------------------------------
// Classification rule chain — canonical priority order, do not reorder
// ---------------------------------------------------------------------------

/**
 * Deterministic, synchronous rule chain that maps a StoryFailureContext to a
 * RootCauseCategory. Rules are evaluated in order; the first match wins.
 */
export function classifyFailure(ctx: StoryFailureContext): RootCauseCategory {
  if (ctx.error?.includes('already exists')) return 'namespace-collision'
  if (ctx.error?.includes('depends on') || ctx.error?.includes('not found')) return 'dependency-ordering'
  if ((ctx.outputTokens ?? Infinity) < 100) return 'resource-exhaustion'
  if (ctx.buildFailed === true) return 'build-failure'
  if (ctx.testsFailed === true) return 'test-failure'
  if (ctx.adapterError === true) return 'adapter-format'
  if (/heap out of memory|ENOSPC|EACCES|SIGKILL/.test(ctx.error ?? '')) return 'infrastructure'
  return 'unclassified'
}

// ---------------------------------------------------------------------------
// Human-readable descriptions per category
// ---------------------------------------------------------------------------

const CATEGORY_DESCRIPTIONS: Record<RootCauseCategory, string> = {
  'namespace-collision': 'Identifier or namespace collision detected during story dispatch',
  'dependency-ordering': 'Story depends on a missing or not-yet-available dependency',
  'spec-staleness': 'Story spec references outdated or stale interface definitions',
  'adapter-format': 'Adapter output format was not recognized or could not be parsed',
  'build-failure': 'Build failed after story dispatch',
  'test-failure': 'Tests failed after story implementation',
  'resource-exhaustion': 'Story produced fewer than 100 output tokens (resource exhaustion suspected)',
  'infrastructure': 'System-level infrastructure error (OOM, disk, permissions, or SIGKILL)',
  'unclassified': 'No error text available', // overridden in buildFinding with raw ctx.error when present
}

// ---------------------------------------------------------------------------
// Finding builder
// ---------------------------------------------------------------------------

/**
 * Construct a validated Finding from a StoryFailureContext and classification result.
 *
 * - confidence: 'low' for 'unclassified', 'high' for all other categories
 * - description: raw ctx.error for 'unclassified'; human-readable text otherwise
 * - expires_after_runs: 5 (default)
 */
export function buildFinding(
  ctx: StoryFailureContext,
  rootCause: RootCauseCategory,
  runId: string,
): Finding {
  const confidence = rootCause === 'unclassified' ? 'low' : 'high'

  const description =
    rootCause === 'unclassified'
      ? (ctx.error ?? 'No error text available')
      : CATEGORY_DESCRIPTIONS[rootCause]

  return FindingSchema.parse({
    id: crypto.randomUUID(),
    run_id: runId,
    story_key: ctx.storyKey,
    root_cause: rootCause,
    affected_files: ctx.affectedFiles ?? [],
    description,
    confidence,
    created_at: new Date().toISOString(),
    expires_after_runs: 5,
  })
}
