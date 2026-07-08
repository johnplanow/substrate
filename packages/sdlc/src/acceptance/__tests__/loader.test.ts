/**
 * A0.1 — trusted-tree registry loader against REAL git repos (AC2).
 *
 * The centerpiece is the H7 semantics test: an agent-mutated WORKING-TREE
 * copy of journeys.yaml must have zero effect on what the trusted loader
 * reads — the committed tree at the ref is the only input.
 *
 * Real tmp repos (no mocks) — the git interaction IS the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { loadJourneyRegistryFromTrustedTree, loadJourneyRegistryFromFile } from '../loader.js'
import { JOURNEY_REGISTRY_PATH } from '../registry.js'

let repo: string

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
}

function writeRegistry(content: string): void {
  const abs = join(repo, JOURNEY_REGISTRY_PATH)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

const VALID_REGISTRY = `version: 2
journeys:
  - id: UJ-1
    title: Operator greets
    criticality: critical
    epic: 1
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: fixture data, walk: run greet, then: greeting printed }
`

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'a01-loader-'))
  git('init -q -b main')
  git('config user.email t@t && git config user.name t')
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git('add -A')
  git('commit -qm seed')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('loadJourneyRegistryFromTrustedTree', () => {
  it('loads a committed registry at HEAD', async () => {
    writeRegistry(VALID_REGISTRY)
    git('add -A')
    git('commit -qm "registry v2"')

    const result = await loadJourneyRegistryFromTrustedTree(repo)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.registry.version).toBe(2)
    expect(result.registry.journeys[0]?.id).toBe('UJ-1')
  })

  it('H7 SEMANTICS: ignores an agent-mutated working-tree copy — the committed tree is the only input', async () => {
    writeRegistry(VALID_REGISTRY)
    git('add -A')
    git('commit -qm "registry v2"')

    // An implementing agent rewrites the working-tree copy to weaken the
    // registry (the A1.3 tamper shape). The trusted read must not see it.
    writeRegistry('version: 99\njourneys: []\n')

    const result = await loadJourneyRegistryFromTrustedTree(repo)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.registry.version).toBe(2)
    expect(result.registry.journeys).toHaveLength(1)
  })

  it('reports absent when the registry exists ONLY uncommitted on disk (never committed = not trusted)', async () => {
    writeRegistry(VALID_REGISTRY) // on disk, never committed

    const result = await loadJourneyRegistryFromTrustedTree(repo)

    expect(result.status).toBe('absent')
  })

  it('reports absent when no registry was ever created', async () => {
    const result = await loadJourneyRegistryFromTrustedTree(repo)

    expect(result.status).toBe('absent')
  })

  it('reads at an explicit ref, not just HEAD', async () => {
    writeRegistry(VALID_REGISTRY)
    git('add -A')
    git('commit -qm "registry v2"')
    const pinned = git('rev-parse HEAD').trim()
    writeRegistry(VALID_REGISTRY.replace('version: 2', 'version: 3'))
    git('add -A')
    git('commit -qm "registry v3"')

    const atPinned = await loadJourneyRegistryFromTrustedTree(repo, pinned)
    const atHead = await loadJourneyRegistryFromTrustedTree(repo)

    expect(atPinned.status).toBe('ok')
    expect(atHead.status).toBe('ok')
    if (atPinned.status !== 'ok' || atHead.status !== 'ok') return
    expect(atPinned.registry.version).toBe(2)
    expect(atHead.registry.version).toBe(3)
  })

  it('reports invalid (with pathed issues) for a committed-but-broken registry — loud, never a silent skip', async () => {
    writeRegistry('version: 1\njourneys:\n  - id: UJ-1\n    title: broken\n    criticality: critical\n    surfaces: [cli]\n    end_states: []\n')
    git('add -A')
    git('commit -qm "broken registry"')

    const result = await loadJourneyRegistryFromTrustedTree(repo)

    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues.some((i) => i.path.startsWith('journeys.0.end_states'))).toBe(true)
  })

  it('reports error (not absent) for a bad ref', async () => {
    const result = await loadJourneyRegistryFromTrustedTree(repo, 'no-such-ref')

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('git show')
  })
})

describe('loadJourneyRegistryFromFile (operator lint only)', () => {
  it('reads the working-tree copy', async () => {
    writeRegistry(VALID_REGISTRY)

    const result = await loadJourneyRegistryFromFile(repo)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.registry.version).toBe(2)
  })

  it('reports absent when the file does not exist', async () => {
    const result = await loadJourneyRegistryFromFile(repo)

    expect(result.status).toBe('absent')
  })

  it('reports invalid with issues for broken content', async () => {
    writeRegistry('version: [unclosed')

    const result = await loadJourneyRegistryFromFile(repo)

    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.issues[0]?.message).toContain('malformed YAML')
  })
})
