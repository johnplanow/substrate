/**
 * Acceptance Gate — canary engine (A6.1).
 *
 * Design principle 3, operationalized: "a gate is distrusted until it catches
 * a planted failure." A canary takes a journey the gate currently rates
 * walked-PASS, REVERTS the real commit(s) that wired it (in a throwaway git
 * worktree — a REAL regression, never a synthetic fixture; the v0.21.1
 * stub-fidelity lesson), re-renders the surfaces, re-judges, and requires the
 * verdict to FLIP away from all-PASS. If it does, the gate demonstrably
 * catches the never-wired class and keeps its blocking authority. If it does
 * NOT (the gate still says PASS on a journey whose wiring was just removed),
 * the gate is blind — `acceptance-canary-missed`, and it auto-demotes to
 * advisory until an operator diagnoses the miss.
 *
 * This module is the ORCHESTRATION-FREE core: git revert + render + judge are
 * injected so it is unit-testable and reusable by the CLI and a nightly step.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Journey } from './types.js'
import type { AcceptanceContract, RenderableSurface } from './contract.js'
import { renderSurface } from './render.js'

export interface CanaryVerdict {
  end_state_id: string
  verdict: 'PASS' | 'FAIL' | 'UNREACHABLE'
}

/** Injected judge: render artifacts already produced → per-end-state verdicts. */
export type CanaryJudge = (
  journey: Journey,
  artifactsDir: string,
  artifacts: string[],
) => Promise<{ ok: true; verdicts: CanaryVerdict[] } | { ok: false; error: string }>

export interface CanaryResult {
  journeyId: string
  /** true = the gate CAUGHT the planted regression (verdict flipped from all-PASS). */
  caught: boolean
  /** Why it was (not) caught — the post-revert verdicts, or a setup error. */
  detail: string
  postRevertVerdicts?: CanaryVerdict[]
  /** Set when the canary could not run (bad commit, render failure) — NOT a miss. */
  inconclusive?: boolean
}

interface GitRunResult {
  code: number | null
  stderr: string
  spawnError?: string
}

function git(args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let stderr = ''
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf-8')))
    proc.on('error', (err) => resolve({ code: null, stderr, spawnError: err.message }))
    proc.on('close', (code) => resolve({ code, stderr }))
  })
}

export interface RunCanaryOptions {
  /** TRUSTED repo root (the main tree) — the source for the scratch clone. */
  repoRoot: string
  journey: Journey
  contract: AcceptanceContract
  /** Commit SHA(s) that wired the journey — reverted in the scratch worktree. */
  wiringCommits: string[]
  judge: CanaryJudge
}

/**
 * Run one canary. Clones the repo into a scratch dir, reverts the wiring
 * commit(s), renders the journey's non-web surfaces, judges, and reports
 * whether the verdict flipped away from all-PASS.
 *
 * `caught: false` with `inconclusive: false` is the alarming case — the gate
 * rated a de-wired journey as passing. Setup failures (revert conflict, render
 * error, judge error) are `inconclusive: true` and are NOT treated as misses
 * (they mean "couldn't test", not "gate is blind").
 */
export async function runCanary(opts: RunCanaryOptions): Promise<CanaryResult> {
  const { repoRoot, journey, contract, wiringCommits, judge } = opts
  const scratch = await mkdtemp(join(tmpdir(), 'substrate-canary-'))
  try {
    const clone = await git(['clone', '--quiet', '--no-hardlinks', repoRoot, scratch], tmpdir())
    if (clone.code !== 0) {
      return { journeyId: journey.id, caught: false, inconclusive: true, detail: `clone failed: ${clone.stderr.trim() || clone.spawnError || 'unknown'}` }
    }
    await git(['config', 'user.email', 'canary@local'], scratch)
    await git(['config', 'user.name', 'canary'], scratch)
    // Revert the wiring commit(s) — a REAL regression, not a synthetic edit.
    for (const sha of wiringCommits) {
      const rev = await git(['revert', '--no-edit', sha], scratch)
      if (rev.code !== 0) {
        return { journeyId: journey.id, caught: false, inconclusive: true, detail: `git revert ${sha} failed (conflict?): ${rev.stderr.trim().slice(0, 300)}` }
      }
    }
    // Re-render the journey's renderable surfaces from the de-wired scratch tree.
    const artifactsDir = join(scratch, '.canary-artifacts')
    const artifacts: string[] = []
    for (const surface of journey.surfaces) {
      if (surface === 'web') continue
      if (contract.surfaces[surface as RenderableSurface] === undefined) continue
      const res = await renderSurface({
        surface: surface as RenderableSurface,
        contract,
        workingDirectory: scratch,
        artifactsDir: join(artifactsDir, surface),
      })
      // A de-wired product may legitimately FAIL to render (the removed code
      // was the entry point) — that is itself the journey becoming
      // unreachable, i.e. CAUGHT. Record and continue.
      if (res.status === 'rendered') artifacts.push(...res.artifacts.map((a) => join(surface, a)))
    }
    if (artifacts.length === 0) {
      // Nothing rendered after reverting the wiring → the journey is
      // structurally gone → the gate WOULD see it as unreachable → caught.
      return { journeyId: journey.id, caught: true, detail: 'no surfaces rendered after reverting the wiring commit — journey is structurally unreachable (caught)' }
    }
    const judged = await judge(journey, artifactsDir, artifacts)
    if (!judged.ok) {
      return { journeyId: journey.id, caught: false, inconclusive: true, detail: `judge error: ${judged.error}` }
    }
    const allPass = judged.verdicts.length > 0 && judged.verdicts.every((v) => v.verdict === 'PASS')
    return {
      journeyId: journey.id,
      caught: !allPass, // flipped away from all-PASS = caught
      detail: allPass
        ? 'MISS: judge still rated every end-state PASS after the wiring was reverted — the gate is blind to this journey'
        : `caught: verdict flipped to ${judged.verdicts.map((v) => `${v.end_state_id}=${v.verdict}`).join(', ')}`,
      postRevertVerdicts: judged.verdicts,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
