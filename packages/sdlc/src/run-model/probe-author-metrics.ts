/**
 * Probe-author per-story rollup — Story 60-15.
 *
 * Collapses every probe-author-relevant signal in a
 * StoredVerificationSummary (including any operator annotations on
 * probe-failures) into a flat `{dispatched, probesAuthoredCount,
 * authoredProbesFailedCount, authoredProbesCaughtConfirmedDefectCount}`
 * shape suitable for per-story surfacing in `substrate status`/`metrics`
 * JSON output and for cross-run aggregation in the `--probe-author-summary`
 * flag.
 *
 * Intentionally pure (mirrors `rollupFindingCounts` shape): no I/O, no
 * logger, no throw. Backward-compat is load-bearing — pre-60-15 manifests
 * have no `_authoredBy` discriminator on their stored findings, no
 * `annotations` array, and probe-author wasn't actually running (Sprint
 * 13/Sprint 20 lesson — the manifest registration bug). The rollup must
 * produce sensible zero values on every legacy code path.
 */

import type { StoredVerificationSummary } from './verification-result.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Story 65-6: Discriminator that classifies what kind of AC triggered the
 * probe-author dispatch for a given story.
 *
 *  - `'event-driven'`      — AC matched `detectsEventDrivenAC()` only
 *  - `'state-integrating'` — AC matched `detectsStateIntegratingAC()` only
 *  - `'both'`              — AC matched both detectors
 *
 * Backward-compat: legacy events without `triggered_by` default to
 * `'event-driven'` (the only class that existed pre-Phase 3).
 */
export type ProbeAuthorTriggerClass = 'event-driven' | 'state-integrating' | 'both'

/**
 * Per-class aggregate for `--probe-author-class-summary` output.
 * Each entry groups stories dispatched under the same `triggered_by` class
 * into a single `ProbeAuthorAggregate`.
 */
export interface ProbeAuthorClassSummary {
  'event-driven': ProbeAuthorAggregate
  'state-integrating': ProbeAuthorAggregate
  both: ProbeAuthorAggregate
}

/** Per-story rollup of probe-author signals. */
export interface ProbeAuthorMetrics {
  /** True if probe-author dispatched against this story (any finding's
   *  `_authoredBy === 'probe-author'`, OR — when ANY annotation references
   *  a probe-author probe — true). False on legacy manifests, on stories
   *  whose AC wasn't event-driven, and on stories where probe-author was
   *  skipped via the feature flag. */
  dispatched: boolean
  /** Total number of probes appended to the story by probe-author. Computed
   *  from the verification summary's findings; counts each unique
   *  `_authoredBy: 'probe-author'` finding's probe. May undercount when
   *  probe-author authored probes that ALL passed (passing probes don't
   *  emit findings) — see {@link ProbeAuthorMetrics.dispatched} for
   *  presence-detection on that path. */
  probesAuthoredCount: number
  /** Probe-author-authored probes that failed at runtime (any
   *  `runtime-probe-*` finding's `_authoredBy === 'probe-author'`). NOT
   *  the same as defect-caught — a probe-author authoring bug, a flaky
   *  probe, or a real defect catch all surface as failures. The
   *  confirmed-defect count below distinguishes them post-hoc. */
  authoredProbesFailedCount: number
  /** Subset of `authoredProbesFailedCount` for which an operator added a
   *  `judgment: 'confirmed-defect'` annotation via `substrate annotate`.
   *  This is the load-bearing KPI numerator — the catch-rate is computed
   *  as `confirmed / dispatched`. Without operator annotations, this is
   *  always 0 (annotations are post-hoc; the rollup is honest about it). */
  authoredProbesCaughtConfirmedDefectCount: number
}

/** Zero rollup, used as default when no probe-author signal is present. */
export const ZERO_PROBE_AUTHOR_METRICS: Readonly<ProbeAuthorMetrics> = Object.freeze({
  dispatched: false,
  probesAuthoredCount: 0,
  authoredProbesFailedCount: 0,
  authoredProbesCaughtConfirmedDefectCount: 0,
})

/** Per-author breakdown of finding counts (the `byAuthor` shape surfaced
 *  on each story's `verification_findings` payload). Mirrors
 *  `VerificationFindingsCounts` but split by `_authoredBy`. */
export interface FindingsByAuthor {
  'probe-author': { error: number; warn: number; info: number }
  'create-story-ac-transfer': { error: number; warn: number; info: number }
}

export const ZERO_FINDINGS_BY_AUTHOR: Readonly<FindingsByAuthor> = Object.freeze({
  'probe-author': { error: 0, warn: 0, info: 0 },
  'create-story-ac-transfer': { error: 0, warn: 0, info: 0 },
})

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/**
 * Compute the per-story probe-author rollup from a verification summary.
 *
 * Inputs:
 *  - `summary`: the per-story stored verification summary (`per_story_state
 *    [storyKey].verification_result` in run manifest terms)
 *  - `dispatchedHint`: optional override — when the caller has direct
 *    knowledge that probe-author dispatched (e.g., from a captured
 *    `probe-author:appended-to-artifact` event on a fresh run), pass true.
 *    Useful when probe-author authored probes that all passed (no
 *    failure findings to attribute, but presence is real).
 *
 * Backward-compat: undefined/null summary → zero rollup. Missing
 * `_authoredBy` field on findings → counted under
 * `'create-story-ac-transfer'` per the schema's documented semantic.
 * Missing `annotations` array → confirmed-defect count is 0.
 */
export function rollupProbeAuthorMetrics(
  summary: StoredVerificationSummary | undefined | null,
  dispatchedHint?: boolean,
): ProbeAuthorMetrics {
  if (summary === undefined || summary === null) {
    return dispatchedHint === true
      ? { ...ZERO_PROBE_AUTHOR_METRICS, dispatched: true }
      : { ...ZERO_PROBE_AUTHOR_METRICS }
  }

  // Collect all runtime-probe findings authored by probe-author.
  const authoredFailures: { probeName: string; category: string }[] = []
  for (const check of summary.checks) {
    const findings = check.findings ?? []
    for (const f of findings) {
      const author = f._authoredBy ?? 'create-story-ac-transfer'
      if (author !== 'probe-author') continue
      if (!f.category.startsWith('runtime-probe-')) continue
      // Probe name surfaces in the message as `probe "..."`. Best-effort
      // extraction; falls back to category when absent.
      const probeName = extractProbeName(f.message) ?? f.category
      authoredFailures.push({ probeName, category: f.category })
    }
  }

  // Cross-reference with operator annotations to compute confirmed-defect count.
  const annotations = summary.annotations ?? []
  let confirmedDefectCount = 0
  for (const failure of authoredFailures) {
    const matched = annotations.find(
      (a) =>
        a.judgment === 'confirmed-defect' &&
        a.findingCategory === failure.category &&
        (a.probeName === undefined || a.probeName === failure.probeName),
    )
    if (matched !== undefined) confirmedDefectCount += 1
  }

  return {
    dispatched: dispatchedHint === true || authoredFailures.length > 0,
    probesAuthoredCount: authoredFailures.length,
    authoredProbesFailedCount: authoredFailures.length,
    authoredProbesCaughtConfirmedDefectCount: confirmedDefectCount,
  }
}

/**
 * Compute the byAuthor breakdown of finding counts on a verification summary.
 * Each finding's `_authoredBy` (default `'create-story-ac-transfer'` when
 * absent) routes its severity into the appropriate per-author bucket.
 */
export function rollupFindingsByAuthor(
  summary: StoredVerificationSummary | undefined | null,
): FindingsByAuthor {
  const result: FindingsByAuthor = {
    'probe-author': { error: 0, warn: 0, info: 0 },
    'create-story-ac-transfer': { error: 0, warn: 0, info: 0 },
  }
  if (summary === undefined || summary === null) return result
  for (const check of summary.checks) {
    const findings = check.findings ?? []
    for (const f of findings) {
      const author = f._authoredBy ?? 'create-story-ac-transfer'
      const bucket = result[author]
      switch (f.severity) {
        case 'error':
          bucket.error += 1
          break
        case 'warn':
          bucket.warn += 1
          break
        case 'info':
          bucket.info += 1
          break
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Cross-run aggregate (for `substrate metrics --probe-author-summary`)
// ---------------------------------------------------------------------------

/**
 * Aggregate probe-author metrics across multiple stories' rollups. Mirrors
 * the spec's `--probe-author-summary` flag output shape.
 */
export interface ProbeAuthorAggregate {
  totalStoriesDispatched: number
  probeAuthorDispatchedCount: number
  probeAuthorDispatchedPct: number
  totalAuthoredProbes: number
  totalAuthoredProbesFailed: number
  totalConfirmedDefectsCaught: number
  /** `failed / authored` — the raw signal (probes that fired). */
  catchRateByCount: number
  /** `confirmed / authored` — the load-bearing KPI for Phase 2 calibration. */
  catchRateByConfirmedDefect: number
}

/**
 * Sum per-story probe-author rollups into a single aggregate. `totalStories`
 * is the denominator for `probeAuthorDispatchedPct` (stories where dispatch
 * could have happened, regardless of outcome). Pass the count of stories
 * the run touched, NOT just the ones with successful dispatch.
 */
export function aggregateProbeAuthorMetrics(
  perStory: ProbeAuthorMetrics[],
  totalStories: number,
): ProbeAuthorAggregate {
  let dispatched = 0
  let authored = 0
  let failed = 0
  let confirmed = 0
  for (const story of perStory) {
    if (story.dispatched) dispatched += 1
    authored += story.probesAuthoredCount
    failed += story.authoredProbesFailedCount
    confirmed += story.authoredProbesCaughtConfirmedDefectCount
  }
  return {
    totalStoriesDispatched: totalStories,
    probeAuthorDispatchedCount: dispatched,
    probeAuthorDispatchedPct: totalStories > 0 ? dispatched / totalStories : 0,
    totalAuthoredProbes: authored,
    totalAuthoredProbesFailed: failed,
    totalConfirmedDefectsCaught: confirmed,
    catchRateByCount: authored > 0 ? failed / authored : 0,
    catchRateByConfirmedDefect: authored > 0 ? confirmed / authored : 0,
  }
}

// ---------------------------------------------------------------------------
// Per-class cross-run aggregate (for `substrate metrics --probe-author-class-summary`)
// ---------------------------------------------------------------------------

/**
 * Group entries by `triggered_by` class and compute a `ProbeAuthorAggregate`
 * for each class. Entries without a `triggered_by` field (legacy/pre-65-6)
 * default to the `'event-driven'` class per the backward-compat rule.
 *
 * Story 65-6: powers `substrate metrics --probe-author-class-summary`.
 *
 * @param entries - Array of objects carrying a per-story `metrics` rollup and
 *   an optional `triggered_by` class string (from the manifest's
 *   `probe_author_triggered_by` field).
 * @returns A record keyed by each of the three known trigger classes, each
 *   value being the `aggregateProbeAuthorMetrics` output for that class's
 *   stories. Classes with no stories still appear with zero aggregates.
 */
export function rollupProbeAuthorByClass(
  entries: Array<{ metrics: ProbeAuthorMetrics; triggered_by?: string }>,
): Record<ProbeAuthorTriggerClass, ProbeAuthorAggregate> {
  const groups: Record<ProbeAuthorTriggerClass, ProbeAuthorMetrics[]> = {
    'event-driven': [],
    'state-integrating': [],
    both: [],
  }

  for (const entry of entries) {
    const cls = (entry.triggered_by ?? 'event-driven') as ProbeAuthorTriggerClass
    // Unknown classes fold into 'event-driven' (backward-compat safety net).
    const bucket: ProbeAuthorTriggerClass =
      cls === 'state-integrating' ? 'state-integrating'
      : cls === 'both' ? 'both'
      : 'event-driven'
    groups[bucket].push(entry.metrics)
  }

  return {
    'event-driven': aggregateProbeAuthorMetrics(groups['event-driven'], groups['event-driven'].length),
    'state-integrating': aggregateProbeAuthorMetrics(groups['state-integrating'], groups['state-integrating'].length),
    both: aggregateProbeAuthorMetrics(groups['both'], groups['both'].length),
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract the probe name from a runtime-probe finding's message. The
 *  runtime-probe-check formatter writes `probe "<name>"...` as the leading
 *  pattern across all category branches (fail/timeout/assertion-fail/
 *  error-response). Returns undefined when the message doesn't match
 *  (fault tolerance — the rollup falls back to category-as-name). */
function extractProbeName(message: string): string | undefined {
  const match = /^probe\s+"([^"]+)"/.exec(message)
  return match?.[1]
}
