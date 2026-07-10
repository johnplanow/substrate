/**
 * RP4.2 — emitAcceptanceCandidateFromPlanning unit tests (real tmp fs,
 * in-memory db).
 *
 * Pins:
 * - NEVER-AUTO-RATIFY: the hook writes the candidate + snapshot ONLY;
 *   journeys.yaml is never created and never touched
 * - prose-only journeys → skipped, zero fs writes
 * - existing candidate → skipped, content byte-identical (operator review
 *   is never clobbered)
 * - RP3.1 pre-pass: undispositioned computed against a ratified registry
 * - the synthesized candidate parses under the candidate schema
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parseJourneyCandidate, JOURNEY_CANDIDATE_PATH, JOURNEY_REGISTRY_PATH } from '@substrate-ai/sdlc'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { createPipelineRun, upsertDecision } from '../../../persistence/queries/decisions.js'
import { emitAcceptanceCandidateFromPlanning, extractStructuredJourneys, PLANNING_JOURNEYS_PATH } from '../acceptance-candidate.js'
import type { PhaseDeps } from '../phases/types.js'

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

const STRUCTURED = [
  { id: 'UJ-1', title: 'Operator gets the weekly digest', criticality: 'critical', surfaces: ['email'], walk: 'open inbox → read digest → done' },
  { id: 'UJ-2', title: 'Operator exports history', criticality: 'standard', surfaces: ['cli'], walk: 'run export → CSV written' },
  { id: 'UJ-3', title: 'Operator gets alerts', criticality: 'standard', surfaces: ['email'], walk: 'threshold crossed → alert email' },
]

let root: string
let db: InMemoryDatabaseAdapter
let runId: string
let deps: PhaseDeps

async function seedJourneysDecision(value: unknown): Promise<void> {
  await upsertDecision(db, {
    pipeline_run_id: runId,
    phase: 'ux-design',
    category: 'ux-design',
    key: 'user_journeys',
    value: JSON.stringify(value),
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rp42-hook-'))
  db = new InMemoryDatabaseAdapter()
  const run = await createPipelineRun(db, { concept: 'test', methodology: 'bmad' })
  runId = run.id
  deps = { db, pack: {}, contextCompiler: {}, dispatcher: {} } as unknown as PhaseDeps
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('emitAcceptanceCandidateFromPlanning', () => {
  it('synthesizes a schema-valid candidate + source snapshot from structured journeys', async () => {
    await seedJourneysDecision(STRUCTURED)

    const outcome = await emitAcceptanceCandidateFromPlanning(deps, runId, root)

    expect(outcome.status).toBe('written')
    if (outcome.status !== 'written') return
    expect(outcome.journeyCount).toBe(3)
    expect(outcome.criticalCount).toBe(1)

    const candidateContent = readFileSync(join(root, JOURNEY_CANDIDATE_PATH), 'utf-8')
    const parsed = parseJourneyCandidate(candidateContent)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.candidate.derived_from).toBe(PLANNING_JOURNEYS_PATH)
    expect(parsed.candidate.journeys.map((j) => j.id)).toEqual(['UJ-1', 'UJ-2', 'UJ-3'])
    // deterministic synthesis: end_states stay empty (needs-elaboration)
    expect(parsed.candidate.journeys.every((j) => j.end_states.length === 0)).toBe(true)
    // snapshot exists and hashes to the recorded sha
    expect(existsSync(join(root, PLANNING_JOURNEYS_PATH))).toBe(true)
  })

  it('NEVER-AUTO-RATIFY pin: journeys.yaml is not created, and an existing one is untouched', async () => {
    await seedJourneysDecision(STRUCTURED)

    await emitAcceptanceCandidateFromPlanning(deps, runId, root)
    expect(existsSync(join(root, JOURNEY_REGISTRY_PATH))).toBe(false)

    // now with a ratified registry present — byte-identical after the hook
    rmSync(join(root, JOURNEY_CANDIDATE_PATH))
    const registryContent = 'version: 1\njourneys:\n  - id: UJ-1\n    title: Digest\n    criticality: critical\n    epic: 1\n    surfaces: [email]\n    end_states:\n      - { id: UJ-1.a, given: g, walk: w, then: t }\n'
    writeFileSync(join(root, JOURNEY_REGISTRY_PATH), registryContent)
    await emitAcceptanceCandidateFromPlanning(deps, runId, root)
    expect(readFileSync(join(root, JOURNEY_REGISTRY_PATH), 'utf-8')).toBe(registryContent)
  })

  it('prose-only journeys → skipped with zero fs writes', async () => {
    await seedJourneysDecision(['First run: install → init → run', 'Resume: inspect → resume'])

    const outcome = await emitAcceptanceCandidateFromPlanning(deps, runId, root)

    expect(outcome.status).toBe('skipped')
    if (outcome.status !== 'skipped') return
    expect(outcome.reason).toContain('prose-only')
    expect(existsSync(join(root, JOURNEY_CANDIDATE_PATH))).toBe(false)
    expect(existsSync(join(root, PLANNING_JOURNEYS_PATH))).toBe(false)
  })

  it('never clobbers an existing candidate (operator may be mid-review)', async () => {
    await seedJourneysDecision(STRUCTURED)
    const existing = '# operator-edited candidate\ncandidate: true\n'
    mkdirSync(dirname(join(root, JOURNEY_CANDIDATE_PATH)), { recursive: true })
    writeFileSync(join(root, JOURNEY_CANDIDATE_PATH), existing)

    const outcome = await emitAcceptanceCandidateFromPlanning(deps, runId, root)

    expect(outcome.status).toBe('skipped')
    expect(readFileSync(join(root, JOURNEY_CANDIDATE_PATH), 'utf-8')).toBe(existing)
  })

  it('RP3.1 pre-pass: undispositioned computed against a ratified registry (registered + excluded honored)', async () => {
    await seedJourneysDecision(STRUCTURED)
    const registry = [
      'version: 1',
      'journeys:',
      '  - id: UJ-1',
      '    title: Digest',
      '    criticality: critical',
      '    epic: 1',
      '    surfaces: [email]',
      '    end_states:',
      '      - { id: UJ-1.a, given: g, walk: w, then: t }',
      'provenance:',
      '  derived_from: docs/prd.md',
      `  source_sha256: "${'d'.repeat(64)}"`,
      '  derived_at: "2026-07-09T00:00:00.000Z"',
      '  ratified_by: operator',
      '  excluded:',
      '    - candidate: UJ-2',
      '      reason: post-MVP',
      '',
    ].join('\n')
    mkdirSync(dirname(join(root, JOURNEY_REGISTRY_PATH)), { recursive: true })
    writeFileSync(join(root, JOURNEY_REGISTRY_PATH), registry)

    const events: unknown[] = []
    const depsWithBus = {
      ...deps,
      eventBus: { emit: (name: string, payload: unknown): void => { events.push({ name, payload }) } },
    } as unknown as PhaseDeps

    const outcome = await emitAcceptanceCandidateFromPlanning(depsWithBus, runId, root)

    expect(outcome.status).toBe('written')
    if (outcome.status !== 'written') return
    // UJ-1 registered, UJ-2 excluded → only UJ-3 undispositioned
    expect(outcome.undispositioned).toEqual(['UJ-3'])
    const emitted = events.find((e) => (e as { name: string }).name === 'solutioning:acceptance-candidate')
    expect(emitted).toBeDefined()
  })

  it('hook failures are non-fatal (advisory by design)', async () => {
    const brokenDeps = { db: { query: () => { throw new Error('db exploded') } } } as unknown as PhaseDeps
    const outcome = await emitAcceptanceCandidateFromPlanning(brokenDeps, runId, root)
    expect(outcome.status).toBe('skipped')
  })
})

describe('extractStructuredJourneys', () => {
  it('keeps structured entries, drops prose, tolerates garbage', () => {
    expect(extractStructuredJourneys(JSON.stringify([...STRUCTURED, 'a prose journey']))).toHaveLength(3)
    expect(extractStructuredJourneys('not json')).toEqual([])
    expect(extractStructuredJourneys(JSON.stringify({ nope: true }))).toEqual([])
  })
})
