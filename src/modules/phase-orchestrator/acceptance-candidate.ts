/**
 * emitAcceptanceCandidateFromPlanning — RP4.2 (registry-provenance program).
 *
 * At solutioning close, synthesize a journey-registry CANDIDATE from the
 * structured `user_journeys` the UX phase emitted (RP4.1) — the vision stays
 * machine-shaped instead of being discarded as prose and re-transcribed by
 * hand later (the transcription-loss class).
 *
 * DETERMINISTIC, no agent: structured journeys map 1:1 to candidate entries
 * (end_states stay empty = needs-elaboration — the operator or a
 * `substrate acceptance derive` run against the PRD elaborates them).
 *
 * NEVER-AUTO-RATIFY (cardinal rule): this hook writes journeys.CANDIDATE.yaml
 * and its planning-journeys source snapshot ONLY. It never touches
 * journeys.yaml, and it never overwrites an existing candidate (an operator
 * may be mid-review).
 *
 * ADVISORY: any failure here warns and returns — a candidate hiccup must
 * never fail a solutioning phase that succeeded on its own terms.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dump as dumpYaml } from 'js-yaml'
import {
  JOURNEY_CANDIDATE_PATH,
  JOURNEY_REGISTRY_PATH,
  computeUndispositioned,
  parseJourneyRegistry,
} from '@substrate-ai/sdlc'
import { getDecisionsByPhaseForRun } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import { StructuredUserJourneySchema } from './phases/schemas.js'
import type { StructuredUserJourney } from './phases/schemas.js'
import type { PhaseDeps } from './phases/types.js'

const logger = createLogger('phase-orchestrator:acceptance-candidate')

/** Source snapshot the candidate's provenance points at (hashable, committable). */
export const PLANNING_JOURNEYS_PATH = '.substrate/acceptance/planning-journeys.yaml'

export type AcceptanceCandidateOutcome =
  | { status: 'skipped'; reason: string }
  | {
      status: 'written'
      candidatePath: string
      journeyCount: number
      criticalCount: number
      sourceSha256: string
      undispositioned: string[]
    }

/** Extract structured journeys from the persisted ux-design decision (prose entries are legal and skipped). */
export function extractStructuredJourneys(rawDecisionValue: string): StructuredUserJourney[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawDecisionValue)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: StructuredUserJourney[] = []
  for (const entry of parsed) {
    const result = StructuredUserJourneySchema.safeParse(entry)
    if (result.success) out.push(result.data)
  }
  return out
}

export async function emitAcceptanceCandidateFromPlanning(
  deps: PhaseDeps,
  runId: string,
  projectRoot: string,
): Promise<AcceptanceCandidateOutcome> {
  try {
    // 1. Structured journeys from the ux-design decision store (RP4.1).
    const decisions = await getDecisionsByPhaseForRun(deps.db, runId, 'ux-design')
    const journeysDecision = decisions.find((d) => d.category === 'ux-design' && d.key === 'user_journeys')
    if (journeysDecision === undefined) return { status: 'skipped', reason: 'no ux-design user_journeys decision' }
    const structured = extractStructuredJourneys(journeysDecision.value)
    if (structured.length === 0) {
      return { status: 'skipped', reason: 'user_journeys are prose-only (structured emission not available) — derive from the PRD by hand' }
    }

    // 2. Never clobber a candidate under operator review.
    const candidateAbs = join(projectRoot, JOURNEY_CANDIDATE_PATH)
    try {
      await readFile(candidateAbs, 'utf-8')
      logger.warn({ candidatePath: JOURNEY_CANDIDATE_PATH }, 'RP4.2: a journey candidate already exists — leaving it untouched (review it, or delete it and re-run)')
      return { status: 'skipped', reason: 'candidate already exists' }
    } catch {
      // absent — proceed
    }

    // 3. Write the source snapshot (the candidate's provenance target).
    const snapshot =
      '# Structured user journeys emitted by the UX phase (RP4.1).\n' +
      '# This file is the derivation SOURCE of journeys.candidate.yaml — its\n' +
      '# hash is recorded at ratify time as the staleness baseline. COMMIT it.\n' +
      dumpYaml({ source: 'ux-design', run_id: runId, journeys: structured }, { lineWidth: 120 })
    const snapshotAbs = join(projectRoot, PLANNING_JOURNEYS_PATH)
    await mkdir(dirname(snapshotAbs), { recursive: true })
    await writeFile(snapshotAbs, snapshot, 'utf-8')
    const sourceSha256 = createHash('sha256').update(snapshot, 'utf-8').digest('hex')

    // 4. Write the CANDIDATE (deterministic mapping; end_states stay empty =
    //    needs-elaboration, resolved by the operator before ratify).
    const candidateDoc = {
      candidate: true,
      derived_from: PLANNING_JOURNEYS_PATH,
      source_sha256: sourceSha256,
      derived_at: new Date().toISOString(),
      journeys: structured.map((j) => ({
        id: j.id,
        title: j.title,
        criticality: j.criticality,
        criticality_rationale: 'as emitted by the UX planning phase (RP4.1 structured journey)',
        surfaces: j.surfaces,
        end_states: [],
      })),
    }
    const header =
      '# CANDIDATE journey registry — NOT authoritative.\n' +
      '# Synthesized at solutioning close from the UX phase\'s structured journeys;\n' +
      '# the acceptance gate IGNORES this file. Elaborate end_states, then promote\n' +
      '# via your explicit `substrate acceptance ratify` — nothing does it for you.\n'
    await writeFile(candidateAbs, header + dumpYaml(candidateDoc, { lineWidth: 120 }), 'utf-8')

    // 5. RP3.1 pre-pass: when a ratified registry exists, every structured
    //    journey id must be registered or excluded — anything else is the
    //    journey-undispositioned advisory, caught at solutioning close where
    //    a fix costs a YAML edit.
    let undispositioned: string[] = []
    try {
      const registryContent = await readFile(join(projectRoot, JOURNEY_REGISTRY_PATH), 'utf-8')
      const parsedRegistry = parseJourneyRegistry(registryContent)
      if (parsedRegistry.ok) {
        undispositioned = computeUndispositioned(structured.map((j) => j.id), parsedRegistry.registry)
          .filter((d) => d.disposition === 'undispositioned')
          .map((d) => d.id)
        if (undispositioned.length > 0) {
          logger.warn(
            { undispositioned },
            'RP4.2: journey-undispositioned (advisory) — the planning lineage emitted journey(s) the ratified registry neither covers nor excludes; register them (ratify the new candidate) or exclude them with a reason',
          )
        }
      }
    } catch {
      // no ratified registry — nothing to disposition against (legal)
    }

    const criticalCount = structured.filter((j) => j.criticality === 'critical').length
    logger.info(
      { candidatePath: JOURNEY_CANDIDATE_PATH, journeyCount: structured.length, criticalCount },
      'RP4.2: journey candidate synthesized from planning artifacts — review + ratify to arm the acceptance gate',
    )
    deps.eventBus?.emit('solutioning:acceptance-candidate', {
      runId,
      candidatePath: JOURNEY_CANDIDATE_PATH,
      journeyCount: structured.length,
      criticalCount,
      sourceSha256,
      undispositioned,
    })
    return {
      status: 'written',
      candidatePath: JOURNEY_CANDIDATE_PATH,
      journeyCount: structured.length,
      criticalCount,
      sourceSha256,
      undispositioned,
    }
  } catch (err) {
    // Advisory by design: a candidate hiccup never fails solutioning.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RP4.2: acceptance-candidate hook failed (non-fatal)')
    return { status: 'skipped', reason: `hook error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
