/**
 * RP1.1 — journey candidate schema + the GATE-IGNORES-CANDIDATE pin.
 *
 * The candidate file is non-authoritative by construction: every runtime
 * loader reads JOURNEY_REGISTRY_PATH only. The centerpiece test here proves
 * a candidate file ALONE (no registry) produces `absent` from both the
 * working-tree and trusted-tree loaders — zero acceptance behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parseJourneyCandidate, JOURNEY_CANDIDATE_PATH } from '../candidate.js'
import { JOURNEY_REGISTRY_PATH } from '../registry.js'
import { loadJourneyRegistryFromTrustedTree, loadJourneyRegistryFromFile } from '../loader.js'

const SHA = 'b'.repeat(64)

const VALID_CANDIDATE = `
candidate: true
derived_from: docs/prd.md
source_sha256: "${SHA}"
derived_at: "2026-07-09T12:00:00.000Z"
journeys:
  - id: UJ-1
    title: Operator receives the weekly report
    criticality: critical
    criticality_rationale: "PRD names this the core loop"
    surfaces: [email]
    end_states:
      - { id: UJ-1.a, given: fixture week, walk: open the email, then: report table present }
  - id: UJ-2
    title: Operator exports history
    criticality: standard
    surfaces: [cli]
    end_states: []
`

describe('parseJourneyCandidate', () => {
  it('parses a valid candidate (rationale, empty end_states both legal)', () => {
    const result = parseJourneyCandidate(VALID_CANDIDATE)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidate.candidate).toBe(true)
    expect(result.candidate.derived_from).toBe('docs/prd.md')
    expect(result.candidate.source_sha256).toBe(SHA)
    expect(result.candidate.journeys).toHaveLength(2)
    expect(result.candidate.journeys[0]?.criticality_rationale).toContain('core loop')
    // needs-elaboration journeys are surfaced, not dropped
    expect(result.candidate.journeys[1]?.end_states).toEqual([])
  })

  it('rejects a registry-shaped document (candidate: true marker is mandatory)', () => {
    const result = parseJourneyCandidate(`
version: 1
journeys:
  - id: UJ-1
    title: Looks like a registry
    criticality: standard
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: g, walk: w, then: t }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path === 'candidate')).toBe(true)
  })

  it('rejects a candidate with zero journeys (not worth ratifying)', () => {
    const result = parseJourneyCandidate(`
candidate: true
derived_from: docs/prd.md
source_sha256: "${SHA}"
derived_at: "2026-07-09T12:00:00.000Z"
journeys: []
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.message.includes('re-run derive'))).toBe(true)
  })

  it('rejects duplicate journey ids', () => {
    const result = parseJourneyCandidate(`
candidate: true
derived_from: docs/prd.md
source_sha256: "${SHA}"
derived_at: "2026-07-09T12:00:00.000Z"
journeys:
  - { id: UJ-1, title: First, criticality: standard, surfaces: [cli], end_states: [] }
  - { id: UJ-1, title: Dup, criticality: standard, surfaces: [cli], end_states: [] }
`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.message.includes('duplicate journey id'))).toBe(true)
  })

  it('rejects a malformed source_sha256', () => {
    const result = parseJourneyCandidate(VALID_CANDIDATE.replace(SHA, 'nothex'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((i) => i.path === 'source_sha256')).toBe(true)
  })

  it('never throws on malformed YAML / empty input', () => {
    expect(parseJourneyCandidate('candidate: [unclosed').ok).toBe(false)
    expect(parseJourneyCandidate('').ok).toBe(false)
  })
})

describe('GATE IGNORES CANDIDATES (RP1.1 cardinal pin)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'rp11-cand-'))
    execSync('git init -q -b main', { cwd: repo })
    execSync('git config user.email t@t && git config user.name t', { cwd: repo })
    writeFileSync(join(repo, 'README.md'), 'seed\n')
    execSync('git add -A && git commit -qm seed', { cwd: repo })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('candidate path is a distinct sibling of the registry path', () => {
    expect(JOURNEY_CANDIDATE_PATH).toBe('.substrate/acceptance/journeys.candidate.yaml')
    expect(JOURNEY_CANDIDATE_PATH).not.toBe(JOURNEY_REGISTRY_PATH)
  })

  it('a candidate file ALONE produces zero acceptance behavior: both loaders report absent', async () => {
    const abs = join(repo, JOURNEY_CANDIDATE_PATH)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, VALID_CANDIDATE)
    execSync('git add -A && git commit -qm candidate', { cwd: repo })

    const fromFile = await loadJourneyRegistryFromFile(repo)
    expect(fromFile.status).toBe('absent')

    const fromTrustedTree = await loadJourneyRegistryFromTrustedTree(repo, 'HEAD')
    expect(fromTrustedTree.status).toBe('absent')
  })
})
