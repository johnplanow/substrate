/**
 * Acceptance Gate — journey CANDIDATE file (RP1.1, registry-provenance program).
 *
 * `substrate acceptance derive` writes `.substrate/acceptance/journeys.candidate.yaml`
 * — a machine-derived, NON-AUTHORITATIVE proposal the operator reviews and
 * turns into the real registry via `substrate acceptance ratify` (the
 * NEVER-AUTO-RATIFY cardinal rule: no code path promotes a candidate without
 * that explicit operator action).
 *
 * The gate ignores candidates by construction: every runtime loader reads
 * JOURNEY_REGISTRY_PATH only (pinned by test) — a candidate file alone
 * produces zero acceptance behavior.
 *
 * Differences from the registry schema, both deliberate:
 * - `epic` is never required (even on critical journeys): the derive agent
 *   reads a PRD, not an epic plan. Ratify enforces registry validity — a
 *   critical journey needs its epic supplied at ratify time.
 * - `end_states` may be empty ("needs-elaboration"): a journey the agent
 *   identified but could not ground in concrete end-states is still worth
 *   surfacing for the operator to elaborate — dropping it silently would
 *   recurse the exact transcription loss this program exists to close.
 */

import { load as loadYaml, YAMLException } from 'js-yaml'
import { z } from 'zod'
import type { RegistryValidationIssue } from './types.js'

/** Repo-relative path of the candidate — sibling of the registry, never read by the gate. */
export const JOURNEY_CANDIDATE_PATH = '.substrate/acceptance/journeys.candidate.yaml'

const CandidateEndStateSchema = z.object({
  id: z.string().min(1),
  given: z.string().min(1),
  walk: z.string().min(1),
  then: z.string().min(1),
})

const CandidateJourneySchema = z.object({
  id: z.string().min(1, 'journey id must be a non-empty string'),
  title: z.string().min(1),
  criticality: z.enum(['critical', 'standard']),
  /** One-line WHY for the criticality call — ratify-review material. */
  criticality_rationale: z.string().optional(),
  surfaces: z.array(z.enum(['email', 'cli', 'file', 'web'])).min(1),
  epic: z.number().int().positive().optional(),
  /** May be empty: a needs-elaboration journey is surfaced, not dropped. */
  end_states: z.array(CandidateEndStateSchema),
})

export const JourneyCandidateSchema = z
  .object({
    /** Hard marker distinguishing a candidate from a registry — never both shapes. */
    candidate: z.literal(true),
    /** Project-relative source-document path the candidate was derived from. */
    derived_from: z.string().min(1),
    /** SHA-256 of the source content at derive time (carried into provenance at ratify). */
    source_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'source_sha256 must be 64 lowercase hex characters'),
    /** ISO-8601 derive timestamp. */
    derived_at: z.string().min(1),
    journeys: z.array(CandidateJourneySchema).min(1, 'a candidate with zero journeys is not worth ratifying — re-run derive'),
  })
  .superRefine((candidate, ctx) => {
    const seen = new Map<string, number>()
    candidate.journeys.forEach((journey, i) => {
      const first = seen.get(journey.id)
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['journeys', i, 'id'],
          message: `duplicate journey id "${journey.id}" (first declared at journeys[${first}])`,
        })
      } else {
        seen.set(journey.id, i)
      }
    })
  })

export type JourneyCandidate = z.infer<typeof JourneyCandidateSchema>
export type CandidateJourney = z.infer<typeof CandidateJourneySchema>

export type CandidateParseResult =
  | { ok: true; candidate: JourneyCandidate }
  | { ok: false; issues: RegistryValidationIssue[] }

/** Parse + validate candidate YAML. Never throws (mirrors parseJourneyRegistry). */
export function parseJourneyCandidate(yamlContent: string): CandidateParseResult {
  let doc: unknown
  try {
    doc = loadYaml(yamlContent)
  } catch (err) {
    const message = err instanceof YAMLException ? err.message : String(err)
    return { ok: false, issues: [{ path: '(root)', message: `malformed YAML: ${message}` }] }
  }
  if (doc === null || doc === undefined) {
    return { ok: false, issues: [{ path: '(root)', message: 'candidate file is empty' }] }
  }
  const result = JourneyCandidateSchema.safeParse(doc)
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        message: issue.message,
      })),
    }
  }
  return { ok: true, candidate: result.data }
}
