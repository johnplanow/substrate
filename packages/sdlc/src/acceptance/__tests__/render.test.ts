/**
 * A1.2 — render executor against REAL spawned processes (no mocks — the
 * spawn/timeout/artifact-capture behavior IS the contract).
 *
 * Uses `node -e` as the render command (guaranteed present in the test env,
 * argv-safe). The -e payloads are deliberately WHITESPACE-FREE: render
 * commands are whitespace-split with no quoting support (the documented
 * "no shell features; wrap complex commands in a script file" contract).
 *
 * Covers: happy path + stdout capture, non-zero exit forensics, timeout with
 * process-group kill, hostile value passed as literal argv, determinism probe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSurface, renderSurfaceDeterministic } from '../render.js'
import type { AcceptanceContract } from '../contract.js'

let workDir: string
let artifactsBase: string

function contractWith(render: string): AcceptanceContract {
  return { surfaces: { cli: { render } } }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'a12-work-'))
  artifactsBase = mkdtempSync(join(tmpdir(), 'a12-art-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(artifactsBase, { recursive: true, force: true })
})

describe('renderSurface', () => {
  it('renders: runs the command in the worktree, captures files + stdout as artifacts', async () => {
    const script = 'require("fs").writeFileSync(process.argv[1]+"/report.txt","13_conviction_fields");console.log("rendered_ok")'
    const result = await renderSurface({
      surface: 'cli',
      contract: contractWith(`node -e ${script} {artifacts}`),
      workingDirectory: workDir,
      artifactsDir: join(artifactsBase, 'out'),
    })

    expect(result.status).toBe('rendered')
    expect(result.artifacts).toContain('report.txt')
    expect(result.artifacts).toContain('cli-stdout.txt')
    expect(readFileSync(join(result.artifactsDir, 'report.txt'), 'utf-8')).toContain('conviction')
    expect(readFileSync(join(result.artifactsDir, 'cli-stdout.txt'), 'utf-8')).toContain('rendered_ok')
  })

  it('failed: non-zero exit carries exit code + stderr tail (H0.4 forensics parity)', async () => {
    const result = await renderSurface({
      surface: 'cli',
      contract: contractWith('node -e console.error("RENDER-RED:missing-fixture");process.exit(3)'),
      workingDirectory: workDir,
      artifactsDir: join(artifactsBase, 'out'),
    })

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(3)
    expect(result.stderrTail).toContain('RENDER-RED:missing-fixture')
  })

  it('failed: timeout kills the process group and names the timeout', async () => {
    const result = await renderSurface({
      surface: 'cli',
      contract: contractWith('node -e setTimeout(()=>{},60000)'),
      workingDirectory: workDir,
      artifactsDir: join(artifactsBase, 'out'),
      timeoutMs: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('timed out')
  })

  it('failed: unspawnable command is a named error, never a throw', async () => {
    const result = await renderSurface({
      surface: 'cli',
      contract: contractWith('no-such-binary-xyz {artifacts}'),
      workingDirectory: workDir,
      artifactsDir: join(artifactsBase, 'out'),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('could not be spawned')
  })

  it('failed: surface not declared in the contract', async () => {
    const result = await renderSurface({
      surface: 'email',
      contract: contractWith('node -e 1'),
      workingDirectory: workDir,
      artifactsDir: join(artifactsBase, 'out'),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('no email surface')
  })

  it('INJECTION: a hostile artifacts path reaches the child as ONE literal argv token', async () => {
    const hostile = join(artifactsBase, 'x; touch PWNED')
    const script = 'require("fs").writeFileSync(require("path").join(process.argv[1],"argv.json"),JSON.stringify(process.argv.slice(1)))'
    const result = await renderSurface({
      surface: 'cli',
      contract: contractWith(`node -e ${script} {artifacts}`),
      workingDirectory: workDir,
      artifactsDir: hostile,
    })

    expect(result.status).toBe('rendered')
    const argv = JSON.parse(readFileSync(join(hostile, 'argv.json'), 'utf-8')) as string[]
    expect(argv).toEqual([hostile]) // exactly one arg, semicolon and all — literal bytes
    expect(existsSync(join(workDir, 'PWNED'))).toBe(false)
    expect(existsSync('PWNED')).toBe(false)
  })
})

describe('renderSurfaceDeterministic', () => {
  it('deterministic render → deterministic: true, no mismatches', async () => {
    const script = 'require("fs").writeFileSync(process.argv[1]+"/r.txt","stable_content")'
    const result = await renderSurfaceDeterministic({
      surface: 'cli',
      contract: contractWith(`node -e ${script} {artifacts}`),
      workingDirectory: workDir,
      artifactsBaseDir: artifactsBase,
    })

    expect(result.first.status).toBe('rendered')
    expect(result.deterministic).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('divergent render (per-run entropy in output) → deterministic: false, names the file', async () => {
    const script = 'require("fs").writeFileSync(process.argv[1]+"/r.txt",String(process.hrtime.bigint()))'
    const result = await renderSurfaceDeterministic({
      surface: 'cli',
      contract: contractWith(`node -e ${script} {artifacts}`),
      workingDirectory: workDir,
      artifactsBaseDir: artifactsBase,
    })

    expect(result.deterministic).toBe(false)
    expect(result.mismatches).toContain('r.txt')
  })
})
