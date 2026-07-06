#!/usr/bin/env node
/**
 * Fixture-matrix pipeline e2e harness (H2.2, hardening program).
 *
 * Drives the REAL substrate pipeline (bundled dist) against the consumer
 * fixtures with the deterministic StubAdapter, and asserts the hardening
 * gates fire on exactly the failure shapes from the 2026-07-04 field run.
 *
 * Usage:
 *   node scripts/e2e-fixture-matrix/run.mjs                 # full matrix
 *   node scripts/e2e-fixture-matrix/run.mjs python-uv       # one fixture
 *   node scripts/e2e-fixture-matrix/run.mjs python-uv red-suite  # one cell
 *
 * Exit 0 = every asserted cell green. Non-zero = at least one cell failed;
 * per-cell logs are left under the workspace root for inspection.
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CLI = join(REPO, 'dist', 'cli', 'index.js')
const STUB = join(HERE, 'stub-agent.mjs')

const FIXTURES = {
  'python-uv': { dir: 'consumer-python-uv', suite: 'uv run pytest -q', bootstrap: true },
  'node-ts': { dir: 'consumer-node-ts', suite: 'npm test', bootstrap: false },
  go: { dir: 'consumer-go', suite: 'go test ./...', bootstrap: false },
}

// Failure-shape scenarios run on the python fixture only (the gates are
// language-agnostic; the matrix's other fixtures prove the SUCCESS path per
// stack, which is where language-specific detection actually varies).
const SCENARIOS_BY_FIXTURE = {
  'python-uv': ['success', 'zero-impl', 'contamination', 'red-suite', 'auth-error', 'no-file'],
  'node-ts': ['success'],
  go: ['success'],
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function setupWorkspace(fixtureKey) {
  const fx = FIXTURES[fixtureKey]
  const ws = mkdtempSync(join(tmpdir(), `substrate-e2e-${fixtureKey}-`))
  // Exclude env/build dirs: a copied .venv carries an editable install
  // pointing at the SOURCE fixture path — the workspace must bootstrap its
  // own env so imports resolve inside the workspace.
  const EXCLUDE = new Set(['.venv', 'node_modules', '__pycache__', '.substrate-worktrees', '.git'])
  cpSync(join(REPO, 'fixtures', fx.dir), ws, {
    recursive: true,
    filter: (src) => !src.split('/').some((seg) => EXCLUDE.has(seg)),
  })
  if (fx.bootstrap) sh('./bootstrap.sh', { cwd: ws })
  sh('git init -q -b main && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "fixture baseline"', { cwd: ws, shell: '/bin/bash' })
  execFileSync('node', [CLI, 'init', '--yes'], { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] })
  sh('git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "chore: substrate init scaffolding"', { cwd: ws, shell: '/bin/bash' })
  return ws
}

function runPipeline(ws, fixtureKey, scenario) {
  const env = {
    ...process.env,
    SUBSTRATE_STUB_ADAPTER: '1',
    SUBSTRATE_STUB_SCRIPT: STUB,
    SUBSTRATE_STUB_SCENARIO: scenario,
    SUBSTRATE_STUB_FIXTURE: fixtureKey,
  }
  let stdout = ''
  let code = 0
  try {
    stdout = execFileSync(
      'node',
      [CLI, 'run', '--events', '--stories', '1-1', '--agent', 'stub', '--non-interactive', '--halt-on', 'none'],
      { cwd: ws, env, encoding: 'utf-8', timeout: 600_000 },
    )
  } catch (err) {
    stdout = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    code = typeof err.status === 'number' ? err.status : 1
  }
  return { code, log: stdout }
}

function mainLog(ws) {
  return sh('git log --oneline -5', { cwd: ws })
}

// ---------------------------------------------------------------------------
// Per-scenario assertions — each returns a list of failure strings.
// ---------------------------------------------------------------------------

const ASSERTIONS = {
  success(ws, fixtureKey, { code, log }) {
    const errs = []
    if (code !== 0) errs.push(`expected exit 0, got ${code}`)
    if (!log.includes('"succeeded":["1-1"]')) errs.push('pipeline:complete does not list 1-1 as succeeded')
    if (!mainLog(ws).includes('feat(story-1-1)')) errs.push('feat(story-1-1) commit not merged to main')
    const fx = FIXTURES[fixtureKey]
    try {
      sh(fx.suite, { cwd: ws, shell: '/bin/bash' })
    } catch {
      errs.push(`post-merge suite (${fx.suite}) is red on main`)
    }
    // The real-suite gate must have actually run (not skipped).
    if (!/"checkName":"test-suite","status":"pass"/.test(log)) errs.push('test-suite check did not pass/run')
    return errs
  },

  'zero-impl'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('no-implementation')) errs.push('expected no-implementation escalation (finding #13 gate)')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('zero-impl story must not merge')
    return errs
  },

  contamination(ws, _fixtureKey, { log }) {
    const errs = []
    if (!/"checkName":"scope-contamination","status":"fail"/.test(log)) {
      errs.push('expected scope-contamination check to FAIL (findings #12/#16/#18 gate)')
    }
    if (!log.includes('contamination-toolchain') && !log.includes('contamination-language')) {
      errs.push('expected a contamination finding category in the log')
    }
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('contaminated story must not merge')
    return errs
  },

  'red-suite'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!/"checkName":"test-suite","status":"fail"/.test(log)) {
      errs.push('expected test-suite check to FAIL on a red suite (finding #11 gate)')
    }
    if (!log.includes('tests-claim-mismatch')) {
      errs.push('expected tests-claim-mismatch finding (agent claimed pass over red suite)')
    }
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('red-suite story must not merge')
    // H0.1: the work must still be durable on the branch (wip or feat commit).
    const branches = sh('git branch --list "substrate/story-1-1"', { cwd: ws })
    if (branches.trim() === '') errs.push('story branch missing — failed work must stay recoverable')
    return errs
  },

  'auth-error'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('"decisionType":"auth-failure"')) {
      errs.push('expected a decision:halt with decisionType auth-failure (finding #10 gate)')
    }
    if (!log.includes('auth-failure')) errs.push('expected auth-failure classification in the log')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('auth-failed story must not merge')
    return errs
  },

  'no-file'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('create-story-no-file')) errs.push('expected create-story-no-file escalation')
    return errs
  },
}

// ---------------------------------------------------------------------------
// Matrix driver
// ---------------------------------------------------------------------------

const wantFixture = process.argv[2]
const wantScenario = process.argv[3]

let failures = 0
for (const [fixtureKey, scenarios] of Object.entries(SCENARIOS_BY_FIXTURE)) {
  if (wantFixture !== undefined && fixtureKey !== wantFixture) continue
  for (const scenario of scenarios) {
    if (wantScenario !== undefined && scenario !== wantScenario) continue
    const label = `${fixtureKey} × ${scenario}`
    let ws
    try {
      ws = setupWorkspace(fixtureKey)
      const result = runPipeline(ws, fixtureKey, scenario)
      const errs = ASSERTIONS[scenario](ws, fixtureKey, result)
      if (errs.length === 0) {
        console.log(`PASS  ${label}`)
        rmSync(ws, { recursive: true, force: true })
      } else {
        failures += 1
        console.error(`FAIL  ${label}`)
        for (const e of errs) console.error(`      - ${e}`)
        console.error(`      workspace preserved: ${ws}`)
        // CI debuggability: the run log is the only forensic artifact on a
        // remote runner — dump its tail.
        console.error('      --- run log tail ---')
        for (const line of result.log.split('\n').slice(-40)) console.error(`      ${line}`)
      }
    } catch (err) {
      failures += 1
      console.error(`FAIL  ${label} — harness error: ${err instanceof Error ? err.message : String(err)}`)
      if (ws) console.error(`      workspace preserved: ${ws}`)
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} cell(s) failed`)
  process.exit(1)
}
console.log('\nfixture matrix green')
