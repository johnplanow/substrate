/**
 * Acceptance Gate — ratification + registry diffing (RP1.2/RP1.3,
 * registry-provenance program).
 *
 * `ratifyCandidate` is the ONLY code path in substrate that produces a
 * registry from a candidate — and it is pure: the CLI invokes it strictly
 * downstream of an explicit operator action (`substrate acceptance ratify`).
 * No pipeline, orchestrator, or recovery path calls it (NEVER-AUTO-RATIFY
 * cardinal rule — grep for callers to audit).
 *
 * `diffJourneySets` renders a re-derivation as a reviewable delta so
 * re-ratification is a review of what CHANGED, not a re-read of the world.
 */

import { createHash } from 'node:crypto'
import { JourneyRegistrySchema } from './registry.js'
import type { JourneyCandidate, CandidateJourney } from './candidate.js'
import type {
  Journey,
  JourneyRegistry,
  RegistryProvenanceExclusion,
  RegistryValidationIssue,
} from './types.js'

export interface RatifyOptions {
  /** Journey ids from the candidate the operator excludes, each with a reason. */
  excludes: RegistryProvenanceExclusion[]
  /** Recorded ack — who performed the ratify action. */
  ratifiedBy: string
  /** Content of `derived_from` AT RATIFY TIME (hash becomes the staleness baseline). */
  sourceContent: string
  /** ISO-8601 timestamp of the ratification. */
  now: string
  /** Present when replacing an existing registry (re-ratification): version bumps, exclusions carry. */
  existingRegistry?: JourneyRegistry
  /** Epic assignments supplied at ratify time (journey id → epic number). */
  epicAssignments?: Record<string, number>
}

export type RatifyResult =
  | { ok: true; registry: JourneyRegistry; warnings: string[] }
  | { ok: false; issues: RegistryValidationIssue[] }

function candidateToJourney(c: CandidateJourney, epicAssignments?: Record<string, number>): Journey {
  const epic = epicAssignments?.[c.id] ?? c.epic
  return {
    id: c.id,
    title: c.title,
    criticality: c.criticality,
    surfaces: c.surfaces,
    ...(epic !== undefined ? { epic } : {}),
    // criticality_rationale is ratify-review material — it informed the
    // operator's read of the candidate and is deliberately not carried into
    // the registry (the registry states WHAT holds, not why it was proposed).
    end_states: c.end_states,
  }
}

/**
 * Build the ratified registry from a candidate. Pure — no fs, no prompts.
 *
 * Validation is the REGISTRY schema's (critical-needs-epic, non-empty
 * end_states, duplicate ids …): a candidate that would ratify into an
 * invalid registry comes back as issues for the operator to resolve by
 * editing the candidate (it is editable by design) or excluding journeys.
 */
export function ratifyCandidate(candidate: JourneyCandidate, options: RatifyOptions): RatifyResult {
  const issues: RegistryValidationIssue[] = []
  const warnings: string[] = []

  // Excludes must reference candidate journeys — a dangling exclusion is a typo.
  const candidateIds = new Set(candidate.journeys.map((j) => j.id))
  for (const ex of options.excludes) {
    if (!candidateIds.has(ex.candidate)) {
      issues.push({
        path: 'excluded',
        message: `--exclude "${ex.candidate}" does not match any candidate journey id (known: ${[...candidateIds].join(', ')})`,
      })
    }
  }
  if (issues.length > 0) return { ok: false, issues }

  const excludedIds = new Set(options.excludes.map((e) => e.candidate))
  const kept = candidate.journeys.filter((j) => !excludedIds.has(j.id))
  if (kept.length === 0) {
    return { ok: false, issues: [{ path: 'journeys', message: 'every candidate journey was excluded — nothing to ratify' }] }
  }

  // Re-ratification: carry forward prior exclusions that are still absent
  // from the new registry (dropping them silently would turn previously-
  // dispositioned journeys undispositioned in the RP3 completeness check).
  const carried: RegistryProvenanceExclusion[] = (options.existingRegistry?.provenance?.excluded ?? []).filter(
    (prior) => !kept.some((j) => j.id === prior.candidate || j.title === prior.candidate) && !excludedIds.has(prior.candidate),
  )

  const sourceShaNow = createHash('sha256').update(options.sourceContent, 'utf-8').digest('hex')
  if (sourceShaNow !== candidate.source_sha256) {
    warnings.push(
      `source ${candidate.derived_from} changed between derive (sha256 ${candidate.source_sha256.slice(0, 12)}…) and ratify ` +
        `(sha256 ${sourceShaNow.slice(0, 12)}…) — the provenance records the CURRENT content; consider re-deriving so the ` +
        'candidate reflects what you are ratifying against',
    )
  }

  const registry: JourneyRegistry = {
    version: options.existingRegistry !== undefined ? options.existingRegistry.version + 1 : 1,
    journeys: kept.map((j) => candidateToJourney(j, options.epicAssignments)),
    provenance: {
      derived_from: candidate.derived_from,
      source_sha256: sourceShaNow,
      derived_at: options.now,
      ratified_by: options.ratifiedBy,
      ...(options.excludes.length + carried.length > 0 ? { excluded: [...options.excludes, ...carried] } : {}),
    },
  }

  // The registry schema is the final arbiter (critical-needs-epic, empty
  // end_states = needs-elaboration unresolved, …).
  const validated = JourneyRegistrySchema.safeParse(registry)
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        message: issue.message,
      })),
    }
  }

  return { ok: true, registry: validated.data as JourneyRegistry, warnings }
}

// ---------------------------------------------------------------------------
// RP1.3 — registry diffing (re-derivation delta view)
// ---------------------------------------------------------------------------

export interface RegistryDiffChange {
  id: string
  /** Which journey fields differ: title | criticality | surfaces | end_states. */
  fields: string[]
}

export interface RegistryDiff {
  /** Journey ids present in the candidate but not the current registry. */
  added: string[]
  /** Journey ids present in the current registry but not the candidate. */
  removed: string[]
  changed: RegistryDiffChange[]
  unchanged: string[]
}

function endStatesEqual(a: Journey['end_states'], b: CandidateJourney['end_states']): boolean {
  if (a.length !== b.length) return false
  const key = (es: { id: string; given: string; walk: string; then: string }): string =>
    JSON.stringify([es.id, es.given, es.walk, es.then])
  // RP5.1 F3: MULTISET equality, not set-subset. The prior `b.every(k in
  // setOf(a))` returned true for [X,Y] vs [X,X] (dropped Y, duplicated X) —
  // a semantic end-state rewrite rendering as a diff no-op (invariant #7:
  // the diff must never be blinded). Sorted key arrays compare exact
  // contents including duplicates.
  const aKeys = a.map(key).sort()
  const bKeys = b.map(key).sort()
  return aKeys.every((k, i) => k === bKeys[i])
}

/**
 * Diff the current registry's journeys against a candidate's. Field-level on
 * the shared ids so a semantic change (criticality flip, end-state rewrite,
 * surface add) can never render as a no-op; ordering and the candidate-only
 * criticality_rationale are deliberately ignored (not semantic).
 */
export function diffJourneySets(current: Journey[], candidate: CandidateJourney[]): RegistryDiff {
  const currentById = new Map(current.map((j) => [j.id, j]))
  const candidateById = new Map(candidate.map((j) => [j.id, j]))

  const added = candidate.filter((j) => !currentById.has(j.id)).map((j) => j.id)
  const removed = current.filter((j) => !candidateById.has(j.id)).map((j) => j.id)

  const changed: RegistryDiffChange[] = []
  const unchanged: string[] = []
  for (const [id, cur] of currentById) {
    const cand = candidateById.get(id)
    if (cand === undefined) continue
    const fields: string[] = []
    if (cur.title !== cand.title) fields.push('title')
    if (cur.criticality !== cand.criticality) fields.push('criticality')
    if ([...cur.surfaces].sort().join(',') !== [...cand.surfaces].sort().join(',')) fields.push('surfaces')
    if (!endStatesEqual(cur.end_states, cand.end_states)) fields.push('end_states')
    // RP5.1 minor (epic): deliberately NOT diffed. Candidates from `derive`
    // never carry an epic (it is assigned via `--epic` at ratify, not read
    // from the PRD), so comparing a set registry epic against an always-
    // undefined candidate epic would flag every journey as epic-changed on
    // every re-derive — pure noise. Epic changes surface in the ratify
    // summary line instead.
    if (fields.length > 0) changed.push({ id, fields })
    else unchanged.push(id)
  }

  return { added, removed, changed, unchanged }
}

// ---------------------------------------------------------------------------
// RP2.1 — staleness detection (the PRD moved; the registry didn't)
// ---------------------------------------------------------------------------

export type RegistryStaleness =
  | { status: 'no-provenance' }
  | { status: 'fresh'; sha: string; derivedFrom: string }
  | { status: 'stale'; recordedSha: string; currentSha: string; derivedFrom: string }
  | { status: 'source-missing'; derivedFrom: string }
  | { status: 'source-escapes-project'; derivedFrom: string }

/**
 * A provenance `derived_from` must resolve INSIDE the project: relative, no
 * traversal, no absolute/drive/scheme forms. The staleness check re-reads
 * this recorded path — an escaping path would let a hostile provenance block
 * point the re-hash at content outside the repo (RP5 catalog item 5).
 */
export function isProjectContainedPath(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/') || relPath.startsWith('\\')) return false
  if (/^[a-zA-Z]:[\\/]/.test(relPath)) return false // windows drive
  if (/^[a-z][a-z0-9+.-]*:/i.test(relPath)) return false // url scheme
  const segments = relPath.split(/[\\/]/)
  return !segments.includes('..')
}

/**
 * Compare the recorded `source_sha256` against the CURRENT content of
 * `derived_from`. Pure: the caller supplies the content (fs for operator
 * lint, trusted-tree `git show` for the orchestrator) — pass `undefined`
 * when the source could not be read.
 *
 * ADVISORY by construction: every status is information for the operator;
 * nothing here blocks. Registry rot must be LOUD, not fatal.
 */
export function checkRegistryStaleness(
  registry: JourneyRegistry,
  sourceContent: string | undefined,
): RegistryStaleness {
  const prov = registry.provenance
  if (prov === undefined) return { status: 'no-provenance' }
  if (!isProjectContainedPath(prov.derived_from)) {
    return { status: 'source-escapes-project', derivedFrom: prov.derived_from }
  }
  if (sourceContent === undefined) {
    return { status: 'source-missing', derivedFrom: prov.derived_from }
  }
  const currentSha = createHash('sha256').update(sourceContent, 'utf-8').digest('hex')
  if (currentSha === prov.source_sha256) {
    return { status: 'fresh', sha: currentSha, derivedFrom: prov.derived_from }
  }
  return { status: 'stale', recordedSha: prov.source_sha256, currentSha, derivedFrom: prov.derived_from }
}

// ---------------------------------------------------------------------------
// RP3.1 — deterministic completeness pre-pass (set arithmetic, no agent)
// ---------------------------------------------------------------------------

export interface JourneyDisposition {
  id: string
  disposition: 'registered' | 'excluded' | 'undispositioned'
}

/**
 * Map known journey ids (from structured planning artifacts — RP4.1) against
 * the registry's dispositions: registered (a journey entry) or excluded (a
 * provenance exclusion, matched on id-or-title candidate string). Anything
 * else is UNDISPOSITIONED — a journey the planning lineage emitted that the
 * registry neither covers nor consciously excludes.
 *
 * Pure set arithmetic: no LLM, nothing to game, guaranteed catches. The
 * checker agent (RP3.2) covers the fuzzy remainder (journeys only expressed
 * in PRD prose).
 */
export function computeUndispositioned(knownJourneyIds: string[], registry: JourneyRegistry): JourneyDisposition[] {
  const registered = new Set(registry.journeys.map((j) => j.id))
  const excluded = new Set((registry.provenance?.excluded ?? []).map((e) => e.candidate))
  const excludedTitles = excluded // candidate strings may be ids or titles; one set serves both
  const out: JourneyDisposition[] = []
  const seen = new Set<string>()
  for (const id of knownJourneyIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (registered.has(id)) out.push({ id, disposition: 'registered' })
    else if (excludedTitles.has(id)) out.push({ id, disposition: 'excluded' })
    else out.push({ id, disposition: 'undispositioned' })
  }
  return out
}

/** Render a diff for humans (derive/ratify CLI output). */
export function renderRegistryDiff(diff: RegistryDiff): string {
  const lines: string[] = []
  for (const id of diff.added) lines.push(`  + ${id} (new journey)`)
  for (const id of diff.removed) lines.push(`  - ${id} (REMOVED — was in the ratified registry; removal needs a hard look)`)
  for (const c of diff.changed) lines.push(`  ~ ${c.id} (changed: ${c.fields.join(', ')})`)
  for (const id of diff.unchanged) lines.push(`  = ${id} (unchanged)`)
  return lines.join('\n')
}
