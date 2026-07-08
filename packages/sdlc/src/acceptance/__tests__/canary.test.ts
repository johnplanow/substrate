/**
 * A6.1 — canary engine against a REAL git repo (the revert is the contract).
 *
 * A tiny repo with a "wiring" commit that adds the farewell line the render
 * prints. The canary reverts that commit in a scratch clone, re-renders (the
 * render now prints nothing / errors), and an injected judge returns verdicts.
 * caught = the verdict flipped away from all-PASS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCanary } from '../canary.js'
import type { CanaryJudge } from '../canary.js'
import type { Journey } from '../types.js'
import type { AcceptanceContract } from '../contract.js'

let repo: string
let wiringSha: string

const JOURNEY: Journey = {
  id: 'UJ-9',
  title: 'says goodbye',
  criticality: 'critical',
  epic: 1,
  surfaces: ['cli'],
  end_states: [{ id: 'UJ-9.a', given: 'g', walk: 'run render', then: 'Goodbye printed' }],
}

// Render prints the farewell if wired, nothing if the wiring is reverted.
const CONTRACT: AcceptanceContract = {
  surfaces: { cli: { render: 'node render.js {artifacts}' } },
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'canary-repo-'))
  git('init -q -b main')
  git('config user.email t@t && git config user.name t')
  // render.js writes farewell.txt IF the wiring module says goodbye.
  writeFileSync(join(repo, 'render.js'), 'const fs=require("fs");const p=process.argv[2];fs.mkdirSync(p,{recursive:true});try{const w=require("./wiring.js");fs.writeFileSync(p+"/farewell.txt",w.farewell());}catch(e){/* de-wired: nothing to render */}')
  writeFileSync(join(repo, 'seed.txt'), 'seed')
  git('add -A && git commit -qm seed')
  // The WIRING commit: adds the module the render depends on.
  writeFileSync(join(repo, 'wiring.js'), 'module.exports.farewell=()=>"Goodbye, world!";')
  git('add -A && git commit -qm "feat: wire the farewell (UJ-9)"')
  wiringSha = git('rev-parse HEAD').trim()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

const passJudge: CanaryJudge = (_j, _dir, _artifacts) =>
  Promise.resolve({ ok: true, verdicts: [{ end_state_id: 'UJ-9.a', verdict: 'PASS' }] })

describe('runCanary', () => {
  it('CAUGHT: reverting the wiring makes the render empty → journey unreachable → caught (even a PASS-only judge)', async () => {
    // With no wiring, render.js catches and writes nothing → 0 artifacts →
    // structurally unreachable → caught, without even consulting the judge.
    const result = await runCanary({ repoRoot: repo, journey: JOURNEY, contract: CONTRACT, wiringCommits: [wiringSha], judge: passJudge })

    expect(result.caught).toBe(true)
    expect(result.inconclusive).toBeUndefined()
    expect(result.detail).toMatch(/unreachable|flipped/i)
  })

  it('MISS: if the judge rates PASS even with artifacts present after de-wiring, caught=false', async () => {
    // Make render independent of the wiring (always emits) so artifacts exist
    // post-revert; a judge that still says PASS is the blind-gate case.
    writeFileSync(join(repo, 'render.js'), 'const fs=require("fs");const p=process.argv[2];fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/farewell.txt","Goodbye, world!");')
    git('add -A && git commit -qm "render no longer depends on wiring"')

    const result = await runCanary({ repoRoot: repo, journey: JOURNEY, contract: CONTRACT, wiringCommits: [wiringSha], judge: passJudge })

    expect(result.caught).toBe(false)
    expect(result.inconclusive).toBeUndefined()
    expect(result.detail).toMatch(/MISS/i)
  })

  it('CAUGHT via judge flip: judge returns UNREACHABLE post-revert', async () => {
    writeFileSync(join(repo, 'render.js'), 'const fs=require("fs");const p=process.argv[2];fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+"/x.txt","stub");')
    git('add -A && git commit -qm "render always emits"')
    const flipJudge: CanaryJudge = () => Promise.resolve({ ok: true, verdicts: [{ end_state_id: 'UJ-9.a', verdict: 'UNREACHABLE' }] })

    const result = await runCanary({ repoRoot: repo, journey: JOURNEY, contract: CONTRACT, wiringCommits: [wiringSha], judge: flipJudge })

    expect(result.caught).toBe(true)
  })

  it('INCONCLUSIVE: an unrevertable commit is not a miss', async () => {
    const result = await runCanary({ repoRoot: repo, journey: JOURNEY, contract: CONTRACT, wiringCommits: ['0000000000000000000000000000000000000000'], judge: passJudge })

    expect(result.inconclusive).toBe(true)
    expect(result.caught).toBe(false)
  })
})
