/**
 * ContaminationCheck tests (H1.5, hardening program — field findings #12/#16/#18).
 *
 * On a Python/uv field project, stories emitted TypeScript, scaffolded a JS
 * toolchain, and merged 1,885 node_modules/dist files to main. These tests pin
 * the gate that makes that a verification FAILURE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

import { existsSync, readFileSync } from 'node:fs'
import {
  ContaminationCheck,
  classifyContamination,
  readProfileLanguages,
} from '../../verification/checks/contamination-check.js'
import type { VerificationContext } from '../../verification/types.js'

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

const PY_PROFILE = 'project:\n  type: single\n  language: python\n  buildTool: uv\n'

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    storyKey: 'h1-5',
    workingDir: '/wt',
    commitSha: 'abc',
    timeout: 30_000,
    ...overrides,
  }
}

describe('classifyContamination (pure)', () => {
  it('finding #18: node_modules and dist in a python diff are droppings', () => {
    const v = classifyContamination(
      ['node_modules/react/index.js', 'dist/red-team/prompt.js', 'machine/cli.py'],
      ['python'],
    )
    expect(v.droppings).toEqual(['node_modules/react/index.js', 'dist/red-team/prompt.js'])
    expect(v.foreignSourceFiles).toEqual([])
  })

  it('finding #12: package.json/tsconfig on a python project are toolchain contamination', () => {
    const v = classifyContamination(['package.json', 'tsconfig.json', 'src/config/loader.py'], ['python'])
    expect(v.foreignToolchainManifests).toEqual(['package.json', 'tsconfig.json'])
  })

  it('finding #16: TypeScript sources on a python project are foreign-language files', () => {
    const v = classifyContamination(['src/config/env.ts', 'src/actions/db.py'], ['python'])
    expect(v.foreignSourceFiles).toEqual([{ file: 'src/config/env.ts', language: 'typescript' }])
  })

  it('legit polyglot: a profile declaring both languages passes both', () => {
    const v = classifyContamination(['api/server.ts', 'ml/train.py'], ['python', 'typescript'])
    expect(v.foreignSourceFiles).toEqual([])
    expect(v.foreignToolchainManifests).toEqual([])
  })

  it('TS project: .js config files and dist are not contamination', () => {
    const v = classifyContamination(['vite.config.js', 'dist/index.js', 'src/a.ts'], ['typescript'])
    expect(v.foreignSourceFiles).toEqual([])
    expect(v.foreignToolchainManifests).toEqual([])
    expect(v.droppings).toEqual([])
  })

  it('.venv and __pycache__ are droppings even on python projects', () => {
    const v = classifyContamination(['.venv/bin/python', 'machine/__pycache__/x.pyc'], ['python'])
    expect(v.droppings).toHaveLength(2)
  })

  it('neutral files (md/toml/yaml) never flag', () => {
    const v = classifyContamination(['README.md', 'pyproject.toml', 'conf/settings.yaml'], ['python'])
    expect(v.foreignSourceFiles).toEqual([])
    expect(v.foreignToolchainManifests).toEqual([])
    expect(v.droppings).toEqual([])
  })
})

describe('readProfileLanguages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the single-project language', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(PY_PROFILE)
    expect(readProfileLanguages('/wt')).toEqual(['python'])
  })

  it('collects monorepo package languages', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      'project:\n  type: monorepo\n  packages:\n    - path: apps/web\n      language: typescript\n    - path: apps/ml\n      language: python\n',
    )
    expect(readProfileLanguages('/wt').sort()).toEqual(['python', 'typescript'])
  })

  it('returns [] when the profile is absent', () => {
    mockExistsSync.mockReturnValue(false)
    expect(readProfileLanguages('/wt')).toEqual([])
  })
})

describe('ContaminationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(PY_PROFILE)
  })

  it('has name "scope-contamination" and tier "A"', () => {
    const check = new ContaminationCheck()
    expect(check.name).toBe('scope-contamination')
    expect(check.tier).toBe('A')
  })

  it('FAILS the finding-#18 shape with all three categories named', async () => {
    const check = new ContaminationCheck()
    const result = await check.run(
      makeContext({
        changedFiles: [
          'node_modules/vite/index.js',
          'dist/db.js',
          'package.json',
          'src/rubric.ts',
          'machine/ledger.py',
        ],
      }),
    )
    expect(result.status).toBe('fail')
    const categories = result.findings.map((f) => f.category).sort()
    expect(categories).toEqual([
      'contamination-droppings',
      'contamination-language',
      'contamination-toolchain',
    ])
  })

  it('passes a clean python diff', async () => {
    const check = new ContaminationCheck()
    const result = await check.run(
      makeContext({ changedFiles: ['machine/red_team/runner.py', 'tests/red_team/test_runner.py'] }),
    )
    expect(result.status).toBe('pass')
  })

  it('passes trivially with no changedFiles (nothing to inspect)', async () => {
    const check = new ContaminationCheck()
    const result = await check.run(makeContext())
    expect(result.status).toBe('pass')
  })

  it('warn-skips when no profile declares languages', async () => {
    mockExistsSync.mockReturnValue(false)
    const check = new ContaminationCheck()
    const result = await check.run(makeContext({ changedFiles: ['src/a.ts'] }))
    expect(result.status).toBe('warn')
    expect(result.findings[0]?.category).toBe('contamination-skip')
  })

  it('H7: uses context.trustedLanguages over the (agent-controlled) worktree profile', async () => {
    // The worktree profile has been tampered to whitelist typescript, but the
    // TRUSTED languages (from the main tree) are python-only — the JS
    // contraband must still FAIL.
    mockReadFileSync.mockReturnValue('language: python\nlanguage: typescript\n')
    const check = new ContaminationCheck()
    const result = await check.run(
      makeContext({
        trustedLanguages: ['python'],
        changedFiles: ['package.json', 'src/app.ts', 'dist/app.js'],
      }),
    )
    expect(result.status).toBe('fail')
    const categories = result.findings.map((f) => f.category).sort()
    expect(categories).toContain('contamination-toolchain')
    expect(categories).toContain('contamination-language')
  })

  it('H7: profile-language-injection is neutralized — worktree whitelist is ignored', async () => {
    // Attack shape: agent appends `language: typescript` to its worktree profile.
    // Without trustedLanguages the check would read that and pass JS; with it,
    // the trusted python-only list governs.
    mockReadFileSync.mockReturnValue('language: python\nlanguage: typescript\n')
    const check = new ContaminationCheck()
    const result = await check.run(
      makeContext({ trustedLanguages: ['python'], changedFiles: ['src/backdoor.ts'] }),
    )
    expect(result.status).toBe('fail')
  })
})
