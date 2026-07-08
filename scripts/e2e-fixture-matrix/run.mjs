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
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
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
  'python-uv': ['success', 'zero-impl', 'contamination', 'red-suite', 'auth-error', 'no-file', 'branch-mode', 'pr-degrade', 'epic-gate-pass', 'epic-gate-fail', 'profile-language-injection', 'testcommand-launder', 'merge-smuggle', 'empty-stub', 'journey-unclaimed', 'spec-tamper', 'journey-pass', 'journey-unreachable', 'acceptance-unrunnable'],
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
  // A2.3 (acceptance-gate): full stage happy path — tagged story, contract
  // renders the real farewell output, stub judge PASSes every end-state →
  // journey lands walked-pass and the story merges.
  'journey-pass': {
    stub: 'journey-pass',
    setup(ws) {
      writeAcceptanceRegistry(ws)
      writeAcceptanceContract(ws)
    },
  },
  // A2.3: same wiring but the judge finds the journey UNREACHABLE (the
  // never-wired shape) → verdicts recorded, journey lands walked-fail.
  // Blocking-on-walked-fail is A4.1 scope — advisory here.
  'journey-unreachable': {
    stub: 'journey-unreachable',
    setup(ws) {
      writeAcceptanceRegistry(ws)
      writeAcceptanceContract(ws)
    },
  },
  // A1.1/A2.3: registry + CLAIMED journey + blocking, but NO contract —
  // claimed journeys can never be walked → acceptance-unrunnable escalation.
  'acceptance-unrunnable': {
    stub: 'journey-pass',
    configAppend: 'acceptance:\n  mode: blocking\n',
    setup(ws) {
      writeAcceptanceRegistry(ws)
    },
  },
  // A1.3 (acceptance-gate): agent edits its WORKTREE journeys.yaml (weakens
  // the end-state) alongside a legit implementation. AcceptanceSpecCheck must
  // FAIL verification on the trusted-vs-worktree divergence — no merge.
  'spec-tamper': {
    stub: 'spec-tamper',
    setup(ws) {
      mkdirSync(join(ws, '.substrate', 'acceptance'), { recursive: true })
      writeFileSync(
        join(ws, '.substrate', 'acceptance', 'journeys.yaml'),
        [
          'version: 1',
          'journeys:',
          '  - id: UJ-9',
          '    title: Operator hears a farewell nobody wired',
          '    criticality: critical',
          '    surfaces: [cli]',
          '    epic: 1',
          '    end_states:',
          '      - { id: UJ-9.a, given: fixture venv, walk: call the farewell path, then: farewell output present }',
          '',
        ].join('\n'),
      )
    },
  },
  // A0.3 (acceptance-gate): a COMMITTED registry declares journey UJ-9 for
  // epic 1, but no story claims it (the stub's artifact is untagged). In
  // blocking mode the LAST story of the epic must escalate journey-unclaimed
  // BEFORE integrating — the never-wired-journey class (UJ-2) caught live.
  'journey-unclaimed': {
    stub: 'success',
    configAppend: 'acceptance:\n  mode: blocking\n',
    setup(ws) {
      mkdirSync(join(ws, '.substrate', 'acceptance'), { recursive: true })
      writeFileSync(
        join(ws, '.substrate', 'acceptance', 'journeys.yaml'),
        [
          'version: 1',
          'journeys:',
          '  - id: UJ-9',
          '    title: Operator hears a farewell nobody wired',
          '    criticality: critical',
          '    surfaces: [cli]',
          '    epic: 1',
          '    end_states:',
          '      - { id: UJ-9.a, given: fixture venv, walk: call the unwired farewell path, then: farewell output present }',
          '',
        ].join('\n'),
      )
    },
  },
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

// A2.3: shared workspace fixtures for the acceptance-stage cells.
function writeAcceptanceRegistry(ws) {
  mkdirSync(join(ws, '.substrate', 'acceptance'), { recursive: true })
  writeFileSync(
    join(ws, '.substrate', 'acceptance', 'journeys.yaml'),
    [
      'version: 1',
      'journeys:',
      '  - id: UJ-9',
      '    title: Library consumer says goodbye',
      '    criticality: critical',
      '    surfaces: [cli]',
      '    epic: 1',
      '    end_states:',
      '      - { id: UJ-9.a, given: fixture venv, walk: run the farewell render, then: "Goodbye, world! printed" }',
      '',
    ].join('\n'),
  )
}

function writeAcceptanceContract(ws) {
  writeFileSync(join(ws, 'render_cli.py'), 'from greeter import farewell\nprint(farewell("world"))\n')
  appendFileSync(
    join(ws, '.substrate', 'project-profile.yaml'),
    '\nacceptance:\n  surfaces:\n    cli:\n      render: "uv run python render_cli.py"\n',
  )
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
  // A0.3: scenario-specific workspace files (e.g. a committed journey
  // registry). Runs before the scaffolding commit so the files land in the
  // TRUSTED tree — the acceptance loaders read via `git show`, never the
  // working copy.
  SCENARIO_OVERRIDES[scenario]?.setup?.(ws)
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

  // A2.3: full acceptance stage happy path — render + judge + walked-pass.
  'journey-pass'(ws, _fixtureKey, { code, log }) {
    const errs = []
    if (code !== 0) errs.push(`expected exit 0, got ${code}`)
    if (!/"type":"acceptance:started"[^\n]*"journeys":\["UJ-9"\]/.test(log)) errs.push('expected acceptance:started for UJ-9')
    if (!/"type":"acceptance:rendered"[^\n]*"status":"rendered"/.test(log)) errs.push('expected a successful acceptance:rendered event')
    if (!/"type":"acceptance:verdict"[^\n]*"verdict":"PASS"/.test(log)) errs.push('expected PASS verdicts in acceptance:verdict')
    if (!/"type":"acceptance:coverage"[^\n]*"state":"walked-pass"/.test(log)) errs.push('expected UJ-9 walked-pass in the coverage event')
    if (!mainLog(ws).includes('feat(story-1-1)')) errs.push('walked-pass story should merge')
    return errs
  },

  // A2.3: judge finds the journey UNREACHABLE — verdicts recorded, journey
  // walked-fail. (Blocking on walked-fail is A4.1; advisory here.)
  'journey-unreachable'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!/"type":"acceptance:verdict"[^\n]*"verdict":"UNREACHABLE"/.test(log)) errs.push('expected UNREACHABLE verdicts in acceptance:verdict')
    if (!/"type":"acceptance:coverage"[^\n]*"state":"walked-fail"/.test(log)) errs.push('expected UJ-9 walked-fail in the coverage event')
    return errs
  },

  // A1.1/A2.3: claimed journey + blocking + NO contract → acceptance-unrunnable.
  'acceptance-unrunnable'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('acceptance-unrunnable')) errs.push('expected acceptance-unrunnable escalation')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('unrunnable-gate story must NOT merge in blocking mode')
    const branches = sh('git branch --list "substrate/story-1-1"', { cwd: ws })
    if (branches.trim() === '') errs.push('story branch missing — blocked work must stay recoverable')
    return errs
  },

  // A1.3 (acceptance-gate): worktree journeys.yaml edit → AcceptanceSpecCheck
  // FAILS verification (acceptance-spec-tampered); no merge; branch durable.
  'spec-tamper'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!/"checkName":"acceptance-spec","status":"fail"/.test(log)) {
      errs.push('expected acceptance-spec check to FAIL on the worktree registry edit')
    }
    if (!log.includes('acceptance-spec-tampered')) errs.push('expected acceptance-spec-tampered finding in the log')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('spec-tampered story must NOT merge')
    const branches = sh('git branch --list "substrate/story-1-1"', { cwd: ws })
    if (branches.trim() === '') errs.push('story branch missing — tampered work must stay recoverable for inspection')
    return errs
  },

  // A0.3 (acceptance-gate): committed registry declares UJ-9 for epic 1; no
  // story claims it; acceptance.mode: blocking → the last story of the epic
  // escalates journey-unclaimed and does NOT merge. This cell IS the UJ-2
  // never-wired-journey class caught structurally, live, on every CI run.
  'journey-unclaimed'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('journey-unclaimed')) errs.push('expected journey-unclaimed escalation')
    if (!log.includes('UJ-9')) errs.push('expected the unclaimed journey id (UJ-9) in the escalation issues')
    if (!/"type":"acceptance:coverage"/.test(log)) errs.push('expected acceptance:coverage NDJSON event')
    if (!/"acceptance:coverage"[^\n]*"state":"unclaimed"/.test(log)) errs.push('expected an unclaimed entry in the coverage event')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('story must NOT merge while an epic journey is unclaimed (blocking mode)')
    const branches = sh('git branch --list "substrate/story-1-1"', { cwd: ws })
    if (branches.trim() === '') errs.push('story branch missing — blocked work must stay recoverable')
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

  // H7 red-team: an empty stub file is not implementation — the
  // whitespace-insensitive line-count gate must escalate no-implementation.
  'empty-stub'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('no-implementation')) errs.push('expected no-implementation escalation for an empty stub file')
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('empty-stub story must not merge')
    return errs
  },

  // H7 red-team: dev agent writes an undisclosed backdoor file (not in
  // files_modified). The finalize disclosure gate must escalate and NOT merge.
  'merge-smuggle'(ws, _fixtureKey, { log }) {
    const errs = []
    if (!log.includes('undisclosed-files-in-merge')) {
      errs.push('expected undisclosed-files-in-merge escalation (H7 disclosure gate)')
    }
    if (mainLog(ws).includes('feat(story-1-1)')) errs.push('story with an undisclosed file must not merge')
    // The work stays recoverable on the branch.
    if (sh('git branch --list "substrate/story-1-1"', { cwd: ws }).trim() === '') {
      errs.push('story branch missing — smuggle-blocked work must stay recoverable')
    }
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
