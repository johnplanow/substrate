/**
 * Acceptance Gate — Journey Registry types (story A0.1).
 *
 * The registry (`.substrate/acceptance/journeys.yaml`) is the machine-readable
 * enumeration of the PRD's user journeys. It is authored at planning time,
 * versioned with the PRD, and read from the TRUSTED main tree at dispatch
 * snapshot — never from an agent-writable worktree copy (H7 posture).
 *
 * Design: _planning/2026-07-07-acceptance-gate-design-brief.md (rev 2, Layer 1).
 */

/** Merge-policy tier for a journey. Critical journeys hard-block on FAIL. */
export type JourneyCriticality = 'critical' | 'standard'

/**
 * Surface types the acceptance stage knows how to render/walk.
 * `web` is registered in the schema but its interactive driver is explicitly
 * out of program scope (deferred pending cost data + a real web consumer).
 */
export type JourneySurface = 'email' | 'cli' | 'file' | 'web'

/**
 * A concrete, artifact-grounded end-state: a thing that exists or doesn't in
 * a rendered surface. NEVER a prose "does this look good?".
 */
export interface JourneyEndState {
  /** Unique within the journey, conventionally `<journey-id>.<letter>` (e.g. `UJ-2.a`). */
  id: string
  /** Precondition: the fixture/state the walk starts from. */
  given: string
  /** The action(s) the walker performs against the rendered surface. */
  walk: string
  /** The observable end-state the judge must find (or not) in the artifact. */
  then: string
}

/** A single named user journey derived from the PRD. */
export interface Journey {
  /** Stable PRD-derived identifier (e.g. `UJ-2`). */
  id: string
  title: string
  criticality: JourneyCriticality
  surfaces: JourneySurface[]
  /**
   * Epic expected to deliver this journey. Audited at that epic's close;
   * journeys without an epic are audited at the final epic close of the run.
   */
  epic?: number
  end_states: JourneyEndState[]
}

/**
 * A candidate journey the operator explicitly declined to register (RP0.1).
 * A reasonless exclusion is unauditable, so `reason` is mandatory.
 */
export interface RegistryProvenanceExclusion {
  /** The candidate journey (id or title) that was excluded at ratify time. */
  candidate: string
  /** Why it was excluded (e.g. "post-MVP, PRD §7 explicitly defers"). */
  reason: string
}

/**
 * Provenance block (RP0.1, registry-provenance program): records WHAT the
 * registry was derived from and WHO ratified it. Written by
 * `substrate acceptance ratify` — never by any pipeline path (the
 * NEVER-AUTO-RATIFY cardinal rule). Additive and optional: hand-authored
 * registries without it remain valid (`provenance-absent` is an advisory
 * lint finding, not an error).
 */
export interface RegistryProvenance {
  /** Project-relative path of the source document (PRD) the registry was derived from. */
  derived_from: string
  /** SHA-256 of the source document content at ratify time (staleness baseline, RP2). */
  source_sha256: string
  /** Optional PRD revision counter, when the source document carries one. */
  prd_revision?: number
  /** ISO-8601 timestamp of the derivation. */
  derived_at: string
  /** Who performed the ratify action (recorded ack — never assumed). */
  ratified_by: string
  /** Candidate journeys the operator declined to register, each with a reason. */
  excluded?: RegistryProvenanceExclusion[]
}

/** The full registry document. */
export interface JourneyRegistry {
  /** Bumped with PRD revisions; verdicts cite the version they judged against. */
  version: number
  journeys: Journey[]
  /** Derivation + ratification record (RP0.1). Absent on hand-authored registries. */
  provenance?: RegistryProvenance
}

/** One named validation problem, with a YAML-ish path for operator lint output. */
export interface RegistryValidationIssue {
  path: string
  message: string
}

/** Result of parsing + validating registry YAML content. */
export type RegistryParseResult =
  | { ok: true; registry: JourneyRegistry }
  | { ok: false; issues: RegistryValidationIssue[] }

/**
 * Result of a trusted-tree registry load.
 * - `absent`: no registry at the ref — acceptance is simply not configured (legal).
 * - `invalid`: a registry exists but fails validation — LOUD, never silently skipped.
 * - `error`: the read itself failed (bad ref, not a repo) — also loud.
 */
export type RegistryLoadResult =
  | { status: 'ok'; registry: JourneyRegistry }
  | { status: 'absent' }
  | { status: 'invalid'; issues: RegistryValidationIssue[] }
  | { status: 'error'; message: string }
