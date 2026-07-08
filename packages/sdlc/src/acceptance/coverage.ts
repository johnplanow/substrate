/**
 * Acceptance Gate — journey coverage ledger (story A0.3).
 *
 * THE SPINE OF THE GATE: pure ledger arithmetic over registry + story claims
 * + verdicts + operator deferrals. No LLM in the loop — nothing to game.
 * A journey NO story claims becomes a loud `unclaimed` (the UJ-2 class,
 * caught structurally); a claimed journey the gate never walked is
 * `unwalked`. Verdicts arrive with the judge (epic A2) — until then every
 * non-deferred journey is unclaimed or unwalked by construction, which is
 * why the gate ships advisory-first (ADVISORY-UNTIL-PROVEN).
 */

import { load as loadYaml, YAMLException } from 'js-yaml'
import { z } from 'zod'
import type { JourneyCriticality, JourneyRegistry, RegistryValidationIssue } from './types.js'

// ---------------------------------------------------------------------------
// Coverage states
// ---------------------------------------------------------------------------

/** The five-state invariant: every audited journey is in exactly one. */
export type JourneyCoverageState =
  | 'walked-pass'
  | 'walked-fail'
  | 'deferred'
  | 'unclaimed'
  | 'unwalked'

export interface JourneyClaim {
  journeyId: string
  storyKey: string
}

export interface JourneyVerdictInput {
  journeyId: string
  verdict: 'pass' | 'fail'
}

export interface JourneyCoverageEntry {
  journeyId: string
  title: string
  criticality: JourneyCriticality
  epic?: number
  state: JourneyCoverageState
  /** Stories that claimed this journey via `journeys:` frontmatter tags. */
  ownerStories: string[]
}

/** Audit scope: one epic's close, or the final close (audits ALL journeys). */
export type CoverageScope = { epic: number } | { final: true }

/**
 * Compute the coverage state of every journey audited at this scope.
 *
 * - `{epic: n}` audits journeys declaring `epic: n`.
 * - `{final: true}` audits the FULL registry (epicless journeys have no
 *   earlier audit point; epic-scoped ones are re-audited — idempotent).
 *
 * State precedence: deferred > walked-fail > walked-pass > unwalked/unclaimed.
 * An operator deferral wins over everything (explicit scope decision); a fail
 * verdict wins over a pass (any failing end-state fails the journey).
 */
export function computeJourneyCoverage(input: {
  registry: JourneyRegistry
  claims: JourneyClaim[]
  verdicts: JourneyVerdictInput[]
  deferredJourneyIds: string[]
  scope: CoverageScope
}): JourneyCoverageEntry[] {
  const { registry, claims, verdicts, deferredJourneyIds, scope } = input

  const audited = registry.journeys.filter((j) =>
    'final' in scope ? true : j.epic === scope.epic,
  )

  const claimsByJourney = new Map<string, string[]>()
  for (const claim of claims) {
    const owners = claimsByJourney.get(claim.journeyId) ?? []
    if (!owners.includes(claim.storyKey)) owners.push(claim.storyKey)
    claimsByJourney.set(claim.journeyId, owners)
  }
  const deferred = new Set(deferredJourneyIds)
  const verdictByJourney = new Map<string, 'pass' | 'fail'>()
  for (const v of verdicts) {
    // fail wins: one failing end-state walk fails the journey
    const existing = verdictByJourney.get(v.journeyId)
    verdictByJourney.set(v.journeyId, existing === 'fail' ? 'fail' : v.verdict)
  }

  return audited.map((journey) => {
    const ownerStories = claimsByJourney.get(journey.id) ?? []
    let state: JourneyCoverageState
    if (deferred.has(journey.id)) {
      state = 'deferred'
    } else {
      const verdict = verdictByJourney.get(journey.id)
      if (verdict === 'fail') state = 'walked-fail'
      else if (verdict === 'pass') state = 'walked-pass'
      else state = ownerStories.length > 0 ? 'unwalked' : 'unclaimed'
    }
    return {
      journeyId: journey.id,
      title: journey.title,
      criticality: journey.criticality,
      ...(journey.epic !== undefined ? { epic: journey.epic } : {}),
      state,
      ownerStories,
    }
  })
}

/** Aggregate counts for the `acceptance:coverage` event payload. */
export function summarizeCoverage(entries: JourneyCoverageEntry[]): Record<JourneyCoverageState, number> {
  const summary: Record<JourneyCoverageState, number> = {
    'walked-pass': 0,
    'walked-fail': 0,
    deferred: 0,
    unclaimed: 0,
    unwalked: 0,
  }
  for (const entry of entries) summary[entry.state] += 1
  return summary
}

// ---------------------------------------------------------------------------
// Deferrals (`.substrate/acceptance/deferrals.yaml`)
// ---------------------------------------------------------------------------

/** Repo-relative path of the operator deferral file. */
export const JOURNEY_DEFERRALS_PATH = '.substrate/acceptance/deferrals.yaml'

export const JourneyDeferralSchema = z.object({
  journey: z.string().min(1),
  reason: z.string().min(1, 'a deferral must carry an operator reason'),
  deferred_at: z.string().optional(),
})

export const JourneyDeferralsFileSchema = z.object({
  deferrals: z.array(JourneyDeferralSchema),
})

export type JourneyDeferral = z.infer<typeof JourneyDeferralSchema>

export type DeferralsParseResult =
  | { ok: true; deferrals: JourneyDeferral[] }
  | { ok: false; issues: RegistryValidationIssue[] }

/** Parse deferrals YAML. Never throws; malformed content comes back as issues. */
export function parseJourneyDeferrals(yamlContent: string): DeferralsParseResult {
  let doc: unknown
  try {
    doc = loadYaml(yamlContent)
  } catch (err) {
    const message = err instanceof YAMLException ? err.message : String(err)
    return { ok: false, issues: [{ path: '(root)', message: `malformed YAML: ${message}` }] }
  }
  if (doc === null || doc === undefined) return { ok: true, deferrals: [] }
  const result = JourneyDeferralsFileSchema.safeParse(doc)
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        message: issue.message,
      })),
    }
  }
  return { ok: true, deferrals: result.data.deferrals }
}
