/**
 * A1.1 — acceptance contract schema + injection-safe argv builder.
 *
 * The injection tests are the point (AC4): hostile placeholder values must
 * stay single literal argv tokens — never evaluated, never token-splitting.
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parseAcceptanceContract, buildRenderArgv, ACCEPTANCE_CONTRACT_PROFILE_PATH } from '../contract.js'
import { loadAcceptanceContractFromTrustedTree } from '../loader.js'

const VALID_PROFILE = `project:
  type: single
  language: python
  buildCommand: ""
  testCommand: uv run pytest
acceptance:
  fixtures: eval/fixtures/acceptance
  surfaces:
    cli:
      render: "uv run python -m dossier.cli report --fixtures {fixtures} --out {artifacts}"
    email:
      render: "uv run python -m dossier.render --out {artifacts}"
`

describe('parseAcceptanceContract', () => {
  it('parses a valid acceptance block out of the project profile', () => {
    const result = parseAcceptanceContract(VALID_PROFILE)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.contract.fixtures).toBe('eval/fixtures/acceptance')
    expect(result.contract.surfaces.cli?.render).toContain('{artifacts}')
    expect(result.contract.surfaces.email).toBeDefined()
    expect(result.contract.surfaces.web).toBeUndefined()
  })

  it('reports absent when the profile has no acceptance block', () => {
    expect(parseAcceptanceContract('project:\n  type: single\n  buildCommand: ""\n  testCommand: x\n').status).toBe('absent')
  })

  it('reports invalid with pathed issues for unknown surfaces / missing render', () => {
    const result = parseAcceptanceContract('acceptance:\n  surfaces:\n    carrier-pigeon:\n      render: x\n')

    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.issues[0]?.path).toContain('acceptance.surfaces')
  })

  it('reports invalid for malformed YAML', () => {
    expect(parseAcceptanceContract('acceptance: [unclosed').status).toBe('invalid')
  })
})

describe('buildRenderArgv (injection safety)', () => {
  it('splits BEFORE substitution — a value with spaces stays ONE argv token', () => {
    const result = buildRenderArgv('render --out {artifacts}', { artifacts: '/tmp/dir with spaces' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.argv).toEqual(['render', '--out', '/tmp/dir with spaces'])
  })

  it.each([
    ['/tmp/x; rm -rf /', 'semicolon command chain'],
    ['/tmp/$(touch /tmp/pwned)', 'command substitution'],
    ['/tmp/`touch /tmp/pwned`', 'backtick substitution'],
    ['/tmp/x && curl evil', 'conjunction'],
    ['/tmp/x | tee /etc/passwd', 'pipe'],
  ])('hostile artifacts value %s (%s) stays a single literal token', (hostile) => {
    const result = buildRenderArgv('render --out {artifacts}', { artifacts: hostile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.argv).toHaveLength(3)
    expect(result.argv[2]).toBe(hostile)
  })

  it('unknown placeholder is a HARD error (typo safety, no silent literal)', () => {
    const result = buildRenderArgv('render --out {artifcats}', { artifacts: '/tmp/a' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('{artifcats}')
  })

  it('{fixtures} without a declared fixtures dir is a HARD error', () => {
    const result = buildRenderArgv('render {fixtures}', { artifacts: '/tmp/a' })

    expect(result.ok).toBe(false)
  })

  it('empty command is an error', () => {
    expect(buildRenderArgv('   ', { artifacts: '/tmp/a' }).ok).toBe(false)
  })
})

describe('loadAcceptanceContractFromTrustedTree', () => {
  let repo: string

  function git(cmd: string): void {
    execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
  }

  it('reads the COMMITTED contract; an agent-tampered working-tree profile is invisible (H7)', async () => {
    repo = mkdtempSync(join(tmpdir(), 'a11-contract-'))
    try {
      git('init -q -b main')
      git('config user.email t@t && git config user.name t')
      const profileAbs = join(repo, ACCEPTANCE_CONTRACT_PROFILE_PATH)
      mkdirSync(dirname(profileAbs), { recursive: true })
      writeFileSync(profileAbs, VALID_PROFILE)
      git('add -A && git commit -qm profile')

      // Tamper: agent rewrites the working-tree render command.
      writeFileSync(profileAbs, VALID_PROFILE.replace('dossier.cli report', 'echo FAKE'))

      const result = await loadAcceptanceContractFromTrustedTree(repo)

      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      expect(result.contract.surfaces.cli?.render).toContain('dossier.cli report')

      // Absent when no profile was ever committed.
      const empty = mkdtempSync(join(tmpdir(), 'a11-empty-'))
      try {
        execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -qm seed --allow-empty', { cwd: empty })
        expect((await loadAcceptanceContractFromTrustedTree(empty)).status).toBe('absent')
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
