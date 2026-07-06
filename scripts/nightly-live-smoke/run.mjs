#!/usr/bin/env node
/**
 * Nightly live smoke (H2.3, hardening program).
 *
 * The fixture matrix (H2.2) proves the pipeline against a deterministic stub
 * on every PR. This job proves the LIVE path — a real claude dispatch — once
 * a day on the operator workstation (the only place subscription CLI auth
 * exists): one clean story on the Python/uv fixture, asserting the full
 * SHIP_IT → commit-first → 9-check verification → merge cycle, with the
 * fixture's real suite green on main afterwards.
 *
 * Cost posture: one story ≈ $0.01–$0.40 depending on routing. The systemd
 * timer is NOT enabled by substrate — enabling nightly quota spend is an
 * explicit operator decision (see README.md next to this script).
 *
 * Exit 0 = smoke green. Non-zero = failure; the workspace and log are
 * preserved under ~/.substrate-smoke/ and a summary line is appended to
 * ~/.substrate-smoke/history.log (dead-man-friendly: the LAST line carries
 * the date + verdict).
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, rmSync, cpSync, appendFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CLI = join(REPO, 'dist', 'cli', 'index.js')
const SMOKE_ROOT = join(homedir(), '.substrate-smoke')
const STAMP = new Date().toISOString().slice(0, 10)
const WS = join(SMOKE_ROOT, `ws-${STAMP}`)
const HISTORY = join(SMOKE_ROOT, 'history.log')

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash', ...opts })
}

function record(verdict, detail) {
  mkdirSync(SMOKE_ROOT, { recursive: true })
  appendFileSync(HISTORY, `${new Date().toISOString()} ${verdict} ${detail}\n`)
}

try {
  mkdirSync(SMOKE_ROOT, { recursive: true })
  rmSync(WS, { recursive: true, force: true })
  const EXCLUDE = new Set(['.venv', 'node_modules', '__pycache__', '.substrate-worktrees', '.git'])
  cpSync(join(REPO, 'fixtures', 'consumer-python-uv'), WS, {
    recursive: true,
    filter: (src) => !src.split('/').some((seg) => EXCLUDE.has(seg)),
  })
  sh('./bootstrap.sh', { cwd: WS })
  sh('git init -q -b main && git add -A && git -c user.email=smoke@local -c user.name=smoke commit -qm "fixture baseline"', { cwd: WS })
  execFileSync('node', [CLI, 'init', '--yes'], { cwd: WS, stdio: ['ignore', 'pipe', 'pipe'] })
  sh('git add -A && git -c user.email=smoke@local -c user.name=smoke commit -qm "chore: substrate init scaffolding"', { cwd: WS })

  // Real dispatch: no stub env — routes to the claude adapter via the
  // project's own provider config. Scrub ANTHROPIC_API_KEY defensively
  // (subscription auth; the adapter scrubs coding dispatches, this covers
  // everything else — field finding #10).
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  let log = ''
  let code = 0
  try {
    log = execFileSync(
      'node',
      [CLI, 'run', '--events', '--stories', '1-1', '--non-interactive', '--halt-on', 'none'],
      { cwd: WS, env, encoding: 'utf-8', timeout: 1_800_000 },
    )
  } catch (err) {
    log = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    code = typeof err.status === 'number' ? err.status : 1
  }
  appendFileSync(join(WS, 'smoke-run.log'), log)

  const errs = []
  if (code !== 0) errs.push(`exit ${code}`)
  if (!log.includes('"succeeded":["1-1"]')) errs.push('1-1 not succeeded')
  if (!sh('git log --oneline -5', { cwd: WS }).includes('feat(story-1-1)')) errs.push('no merged feat commit')
  try {
    sh('uv run pytest -q', { cwd: WS })
  } catch {
    errs.push('post-merge suite red')
  }

  if (errs.length > 0) {
    record('FAIL', `${errs.join('; ')} — workspace: ${WS}`)
    console.error(`nightly live smoke FAILED: ${errs.join('; ')}\nworkspace preserved: ${WS}`)
    process.exit(1)
  }

  record('PASS', 'full live cycle green (create→dev→verify→merge; suite green)')
  console.log('nightly live smoke PASS')
  rmSync(WS, { recursive: true, force: true })
} catch (err) {
  record('ERROR', err instanceof Error ? err.message : String(err))
  console.error('nightly live smoke harness error:', err)
  process.exit(2)
}
