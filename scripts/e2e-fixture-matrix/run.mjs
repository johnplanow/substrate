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
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, basename } from 'node:path'
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
  'python-uv': ['success', 'zero-impl', 'contamination', 'red-suite', 'auth-error', 'no-file', 'branch-mode', 'pr-degrade', 'epic-gate-pass', 'epic-gate-fail', 'profile-language-injection', 'testcommand-launder'],
  'node-ts': ['success'],
  go: ['success'],
}

// H3.1: cells that reuse a stub scenario but change how substrate is invoked.
// stub = SUBSTRATE_STUB_SCENARIO fed to the agent; args = extra CLI flags.
const SCENARIO_OVERRIDES = {
  'branch-mode': { stub: 'success', args: ['--finalization', 'branch'] },
  // No remote in the workspace → `git push` fails → pr mode must degrade to
  // branch semantics without blocking the story.
  'pr-degrade': { stub: 'success', args: ['--finalization', 'pr'] },
  // H3.4: epic gate hook — 1-1 is trivially the last story of epic 1 in a
  // single-story run, so the gate fires before the merge.
  'epic-gate-pass': {
    stub: 'success',
    configAppend: 'finalization:\n  epic_gate_command: "touch .epic-gate-ran"\n',
  },
  'epic-gate-fail': {
    stub: 'success',
    configAppend: 'finalization:\n  epic_gate_command: "sh -c \'echo EPIC-GATE-RED >&2; exit 1\'"\n',
  },
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

function setupWorkspace(fixtureKey, scenario) {
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
  const configAppend = SCENARIO_OVERRIDES[scenario]?.configAppend
  if (configAppend !== undefined) {
    appendFileSync(join(ws, '.substrate', 'config.yaml'), `\n${configAppend}`)
  }
  sh('git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm "chore: substrate init scaffolding"', { cwd: ws, shell: '/bin/bash' })
  return ws
}

function runPipeline(ws, fixtureKey, scenario) {
  const override = SCENARIO_OVERRIDES[scenario]
  const env = {
    ...process.env,
    SUBSTRATE_STUB_ADAPTER: '1',
    SUBSTRATE_STUB_SCRIPT: STUB,
    SUBSTRATE_STUB_SCENARIO: override?.stub ?? scenario,
    SUBSTRATE_STUB_FIXTURE: fixtureKey,
  }
  let stdout = ''
  let code = 0
  try {
    stdout = execFileSync(
      'node',
      [CLI, 'run', '--events', '--stories', '1-1', '--agent', 'stub', '--non-interactive', '--halt-on', 'none', ...(override?.args ?? [])],
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

// H4.2: the default worktree base is EXTERNAL — mirror the resolver's formula
// so cells can assert on (and the driver can clean up) the real location.
function externalWorktreeBase(ws) {
  const hash = createHash('sha256').update(resolve(ws)).digest('hex').slice(0, 8)
  return join(homedir(), '.substrate', 'worktrees', `${basename(ws)}-${hash}`)
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

  // H3.1: branch finalization — the story branch is the deliverable; main
  // must NOT advance and nothing self-merges.
  'branch-mode'(ws, _fixtureKey, { code, log }) {
    const errs = []
    if (code !== 0) errs.push(`expected exit 0, got ${code}`)
    if (!log.includes('"succeeded":["1-1"]')) errs.push('pipeline:complete does not list 1-1 as succeeded')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('branch mode must NOT merge to main')
    const branchLog = sh('git log --oneline -3 substrate/story-1-1', { cwd: ws })
    if (!branchLog.includes('feat(story-1-1)')) errs.push('feat commit missing from the deliverable branch')
    if (!/"type":"story:finalized"[^\n]*"mode":"branch"/.test(log)) errs.push('expected story:finalized event with mode branch')
    // H4.2: worktree may live in-repo or at the external base — both must be gone.
    if (existsSync(join(ws, '.substrate-worktrees', '1-1')) || existsSync(join(externalWorktreeBase(ws), '1-1'))) {
      errs.push('worktree should be removed after branch finalization')
    }
    return errs
  },

  // H3.4: epic gate passes → the last story of the epic merges normally and
  // the gate command demonstrably ran.
  'epic-gate-pass'(ws, _fixtureKey, { code, log }) {
    const errs = []
    if (code !== 0) errs.push(`expected exit 0, got ${code}`)
    if (!log.includes('"succeeded":["1-1"]')) errs.push('pipeline:complete does not list 1-1 as succeeded')
    if (!existsSync(join(ws, '.epic-gate-ran'))) errs.push('epic gate command did not run (.epic-gate-ran missing)')
    if (!mainLog(ws).includes('feat(story-1-1)')) errs.push('gated story should still merge after gate pass')
    return errs
  },

  // H3.4: epic gate fails → escalate epic-gate-failed with the command
  // output; no merge; branch preserved.
  'epic-gate-fail'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('epic-gate-failed')) errs.push('expected epic-gate-failed escalation')
    if (!log.includes('EPIC-GATE-RED')) errs.push('expected gate command output in the escalation')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('gate-failed story must NOT merge')
    const branches = sh('git branch --list "substrate/story-1-1"', { cwd: ws })
    if (branches.trim() === '') errs.push('story branch missing — gated work must stay recoverable')
    return errs
  },

  // H7 red-team: agent whitelists typescript in its WORKTREE profile + ships JS
  // contraband. The trusted profile (main tree) is python-only → contamination
  // must still FAIL and the story must not merge.
  'profile-language-injection'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!/"checkName":"scope-contamination","status":"fail"/.test(log)) {
      errs.push('expected scope-contamination to FAIL despite the worktree profile whitelist (H7)')
    }
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('profile-tampered contaminated story must not merge')
    return errs
  },

  // H7 red-team: agent launders the worktree profile testCommand (`|| true`)
  // over a red suite. Trusted testCommand (main tree) runs the real red suite,
  // and the laundering detector rejects the wrapper → test-suite must FAIL.
  'testcommand-launder'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!/"checkName":"test-suite","status":"fail"/.test(log)) {
      errs.push('expected test-suite to FAIL despite the laundered worktree testCommand (H7)')
    }
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('laundered-suite story must not merge')
    return errs
  },

  // H3.1: pr finalization with no remote — push fails, degrades to branch
  // semantics, never blocks the story.
  'pr-degrade'(ws, _fixtureKey, { code, log }) {
    const errs = []
    if (code !== 0) errs.push(`expected exit 0 (pr failure must not block), got ${code}`)
    if (!log.includes('"succeeded":["1-1"]')) errs.push('pipeline:complete does not list 1-1 as succeeded')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('pr mode must NOT merge to main')
    const branchLog = sh('git log --oneline -3 substrate/story-1-1', { cwd: ws })
    if (!branchLog.includes('feat(story-1-1)')) errs.push('feat commit missing from the deliverable branch')
    const finalized = log.split('\n').find((l) => l.includes('"type":"story:finalized"'))
    if (finalized === undefined) {
      errs.push('expected story:finalized event')
    } else {
      if (!finalized.includes('"mode":"pr"')) errs.push('expected finalized mode pr')
      if (finalized.includes('pr_url')) errs.push('degraded pr must not carry a pr_url')
    }
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
      ws = setupWorkspace(fixtureKey, scenario)
      const result = runPipeline(ws, fixtureKey, scenario)
      const errs = ASSERTIONS[scenario](ws, fixtureKey, result)
      if (errs.length === 0) {
        console.log(`PASS  ${label}`)
        rmSync(ws, { recursive: true, force: true })
        // H4.2: also remove the workspace's external worktree base so matrix
        // runs don't accumulate orphans under ~/.substrate/worktrees/.
        rmSync(externalWorktreeBase(ws), { recursive: true, force: true })
      } else {
        failures += 1
        console.error(`FAIL  ${label}`)
        for (const e of errs) console.error(`      - ${e}`)
        console.error(`      workspace preserved: ${ws}`)
        console.error(`      external worktree base: ${externalWorktreeBase(ws)}`)
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
