/**
 * A1.3 — AcceptanceSpecCheck: spec-tamper tripwire + fixture-mutation warn.
 *
 * Real files in a tmp worktree; the guard carries the "trusted" contents.
 * Covers: clean pass (no false positives), edit/delete/introduce tampering
 * for the registry and deferrals, acceptance-block laundering in the profile
 * (with non-acceptance profile edits explicitly NOT flagged here), fixture
 * mutations (warn), and the no-guard trivial pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { AcceptanceSpecCheck } from '../../verification/checks/acceptance-spec-check.js'
import type { VerificationContext } from '../../verification/types.js'

let worktree: string

const REGISTRY = 'version: 1\njourneys:\n  - id: UJ-1\n    title: T\n    criticality: critical\n    surfaces: [cli]\n    end_states:\n      - { id: UJ-1.a, given: g, walk: w, then: t }\n'
const DEFERRALS = 'deferrals:\n  - journey: UJ-2\n    reason: post-MVP\n'
const PROFILE = 'project:\n  type: single\n  buildCommand: ""\n  testCommand: pytest\nacceptance:\n  fixtures: eval/fixtures\n  surfaces:\n    cli:\n      render: "python -m report --out {artifacts}"\n'

function writeWorktreeFile(rel: string, content: string): void {
  const abs = join(worktree, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function makeContext(overrides?: Partial<VerificationContext>): VerificationContext {
  return {
    storyKey: '1-1',
    workingDir: worktree,
    commitSha: 'abc',
    timeout: 5_000,
    acceptanceSpecGuard: {
      journeysTrusted: REGISTRY,
      deferralsTrusted: DEFERRALS,
      profileTrusted: PROFILE,
      fixturesPath: 'eval/fixtures',
    },
    ...overrides,
  }
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'a13-wt-'))
  // Worktree mirrors the trusted tree (worktrees carry tracked files).
  writeWorktreeFile('.substrate/acceptance/journeys.yaml', REGISTRY)
  writeWorktreeFile('.substrate/acceptance/deferrals.yaml', DEFERRALS)
  writeWorktreeFile('.substrate/project-profile.yaml', PROFILE)
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

const check = new AcceptanceSpecCheck()

describe('AcceptanceSpecCheck', () => {
  it('passes when worktree copies match the trusted tree (no false positives)', async () => {
    const result = await check.run(makeContext())

    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
  })

  it('passes trivially without a guard (acceptance not configured / no worktree)', async () => {
    const result = await check.run(makeContext({ acceptanceSpecGuard: undefined }))

    expect(result.status).toBe('pass')
  })

  it('FAILS when the worktree registry is EDITED (weakened end-states shape)', async () => {
    writeWorktreeFile('.substrate/acceptance/journeys.yaml', REGISTRY.replace('then: t', 'then: anything at all'))

    const result = await check.run(makeContext())

    expect(result.status).toBe('fail')
    expect(result.findings.some((f) => f.category === 'acceptance-spec-tampered' && f.message.includes('journeys.yaml') && f.message.includes('DIVERGES'))).toBe(true)
  })

  it('FAILS when the worktree registry is DELETED', async () => {
    rmSync(join(worktree, '.substrate/acceptance/journeys.yaml'))

    const result = await check.run(makeContext())

    expect(result.status).toBe('fail')
    expect(result.findings.some((f) => f.message.includes('DELETED'))).toBe(true)
  })

  it('FAILS when deferrals are INTRODUCED from the worktree (defer-the-journey-you-did-not-wire shape)', async () => {
    // Trusted tree has no deferrals; the agent adds one for the journey it skipped.
    rmSync(join(worktree, '.substrate/acceptance/deferrals.yaml'))
    const ctx = makeContext({
      acceptanceSpecGuard: {
        journeysTrusted: REGISTRY,
        deferralsTrusted: null,
        profileTrusted: PROFILE,
      },
    })
    writeWorktreeFile('.substrate/acceptance/deferrals.yaml', 'deferrals:\n  - journey: UJ-1\n    reason: totally legit\n')

    const result = await check.run(ctx)

    expect(result.status).toBe('fail')
    expect(result.findings.some((f) => f.message.includes('deferrals.yaml') && f.message.includes('INTRODUCED'))).toBe(true)
  })

  it('FAILS when the profile acceptance block is laundered (render command swapped)', async () => {
    writeWorktreeFile('.substrate/project-profile.yaml', PROFILE.replace('python -m report', 'echo FAKE-RENDER'))

    const result = await check.run(makeContext())

    expect(result.status).toBe('fail')
    expect(result.findings.some((f) => f.message.includes('acceptance: contract block'))).toBe(true)
  })

  it('does NOT flag profile edits OUTSIDE the acceptance block (that is H7/contamination territory)', async () => {
    writeWorktreeFile('.substrate/project-profile.yaml', PROFILE.replace('testCommand: pytest', 'testCommand: pytest -q'))

    const result = await check.run(makeContext())

    expect(result.status).toBe('pass')
  })

  it('WARNS on fixture mutations, naming the files (never silent, never a lone fail)', async () => {
    const result = await check.run(
      makeContext({ changedFiles: ['eval/fixtures/portfolio.json', 'src/report.py'] }),
    )

    expect(result.status).toBe('warn')
    const finding = result.findings.find((f) => f.category === 'acceptance-fixture-mutation')
    expect(finding?.severity).toBe('warn')
    expect(finding?.message).toContain('eval/fixtures/portfolio.json')
    expect(finding?.message).not.toContain('src/report.py')
  })

  it('does not warn for changes merely PREFIX-similar to the fixtures path', async () => {
    const result = await check.run(makeContext({ changedFiles: ['eval/fixtures-other/x.json'] }))

    expect(result.status).toBe('pass')
  })
})
