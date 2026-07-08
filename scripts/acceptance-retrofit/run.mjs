#!/usr/bin/env node
/**
 * Acceptance-gate retro-fit regression harness (A3.3).
 *
 * Re-executes the A3.2 corpus: materializes the income-sources golden
 * snapshots + live seeded renders at the pinned SHAs, dispatches the REAL
 * acceptance judge over each, and asserts the full verdict matrix:
 *
 *   DETECTION 5/5 (founding misses) · POST-FIX FALSE FAILS 0 · PRECISION 1
 *
 * WHEN TO RUN (ship checklist, conditional — like Step 4.5): any diff touching
 * packs/bmad/prompts/acceptance-judge.md, the AcceptanceJudge schemas, or
 * runAcceptanceJudge. Operator-workstation only (needs the local
 * income-sources clone + real agent auth) — same locality rationale as the
 * eval gate (ship.md Step 4.7).
 *
 * Cost: 7 real judge dispatches (~$0.10–0.50), ~5–10 min (clones cached).
 *
 * Usage: node scripts/acceptance-retrofit/run.mjs [--corpus ~/code/jplanow/income-sources]
 * Exit 0 = matrix holds; 1 = regression (matrix broken); 2 = harness error.
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const CLI = join(REPO, 'dist', 'cli', 'index.js')
const REGISTRY = join(REPO, '_planning', 'acceptance-gate', 'retrofit', 'journeys.yaml')
const RENDER_DRIVER = join(REPO, '_planning', 'acceptance-gate', 'retrofit', 'phase-b-render.py')

const corpusArg = process.argv.indexOf('--corpus')
const CORPUS = resolve(
  corpusArg !== -1 ? process.argv[corpusArg + 1] : join(homedir(), 'code', 'jplanow', 'income-sources'),
)

const PRE_TAPS = 'ef1c0c8' // episode 1 pre-fix (UJ-2 taps absent)
const PRE = 'a6ff1ca' // episode 2 pre-fix (review commit; misses 2-5)
const POST = '82f4fe7' // post-fix (tree ≡ 8d115d7)
const SNAP = '_bmad-output/implementation-artifacts/acceptance-renders'

// Persistent work area so uv sync / clones amortize across runs.
const WORK = join(tmpdir(), 'substrate-acceptance-retrofit')

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: '/bin/bash', ...opts })
}

function gitShow(ref, path, out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, execFileSync('git', ['-C', CORPUS, 'show', `${ref}:${path}`], { encoding: 'utf-8' }))
}

function materializeSnapshots() {
  const pre = join(WORK, 'artifacts', 'snap-pre')
  const post = join(WORK, 'artifacts', 'snap-post')
  rmSync(pre, { recursive: true, force: true })
  rmSync(post, { recursive: true, force: true })
  const preFiles = ['packet-weekly.html', 'packet-weekly.txt', 'packet-weekly-subject.txt', 'packet-monthly.html', 'packet-monthly.txt', 'pre-claim.html', 'pre-claim.txt', 'verification-checklist.html', 'verification-checklist.txt']
  for (const f of preFiles) gitShow(PRE, `${SNAP}/${f}`, join(pre, f))
  for (const f of [...preFiles, 'confirm-interstitials.html']) gitShow(POST, `${SNAP}/v2/${f}`, join(post, f))
  return { pre, post }
}

function liveRender(sha, scenario, outDir) {
  const clone = join(WORK, 'clones', sha)
  if (!existsSync(join(clone, 'pyproject.toml'))) {
    rmSync(clone, { recursive: true, force: true })
    sh(`git clone -q "${CORPUS}" "${clone}" && git -C "${clone}" checkout -q ${sha}`)
    sh('uv sync -q', { cwd: clone })
  }
  cpSync(RENDER_DRIVER, join(clone, 'phase-b-render.py'))
  sh(`uv run python phase-b-render.py ${scenario} "${outDir}"`, {
    cwd: clone,
    env: { ...process.env, ACTION_LINK_SIGNING_KEY: 'retrofit-test-key', ACTION_BASE_URL: 'https://actions.local' },
  })
}

function judge(journey, artifactsDir, label) {
  const out = execFileSync(
    'node',
    [CLI, 'acceptance', 'judge', '--journey', journey, '--artifacts-dir', artifactsDir, '--registry-file', REGISTRY],
    { encoding: 'utf-8', cwd: REPO, timeout: 600_000, env: (() => { const e = { ...process.env }; delete e.ANTHROPIC_API_KEY; return e })() },
  )
  const parsed = JSON.parse(out)
  const verdicts = Object.fromEntries((parsed.data.verdicts ?? []).map((v) => [v.end_state_id, v.verdict]))
  console.log(`  ${label}: ${JSON.stringify(verdicts)}`)
  return verdicts
}

const failures = []
function expect(cond, msg) {
  if (!cond) failures.push(msg)
}

try {
  console.log('acceptance retro-fit regression — materializing corpus…')
  const snaps = materializeSnapshots()
  const liveTaps = join(WORK, 'artifacts', 'live-taps')
  const liveAbsencePre = join(WORK, 'artifacts', 'live-absence-pre')
  const liveAbsencePost = join(WORK, 'artifacts', 'live-absence-post')
  for (const d of [liveTaps, liveAbsencePre, liveAbsencePost]) rmSync(d, { recursive: true, force: true })
  liveRender(PRE_TAPS, 'packet', liveTaps)
  liveRender(PRE, 'absence', liveAbsencePre)
  liveRender(PRE, 'return-summary', liveAbsencePre)
  liveRender(POST, 'absence', liveAbsencePost)
  liveRender(POST, 'return-summary', liveAbsencePost)

  console.log('dispatching the judge (7 runs)…')
  const uj2Pre = judge('UJ-2', snaps.pre, `UJ-2 @ ${PRE} (snapshots)`)
  expect(uj2Pre['UJ-2.a'] === 'FAIL', 'miss 2 NOT detected: UJ-2.a should FAIL at pre-fix')
  expect(uj2Pre['UJ-2.b'] === 'PASS', `precision broken: UJ-2.b should PASS at ${PRE} (taps already fixed) — got ${uj2Pre['UJ-2.b']}`)
  expect(uj2Pre['UJ-2.c'] !== 'PASS', 'miss 3 NOT detected: UJ-2.c should not PASS at pre-fix')

  const uj3Pre = judge('UJ-3', snaps.pre, `UJ-3 @ ${PRE} (snapshots)`)
  expect(uj3Pre['UJ-3.a'] !== 'PASS' && uj3Pre['UJ-3.b'] !== 'PASS', 'miss 4 NOT detected: UJ-3 end-states should not PASS at pre-fix')

  const uj2Taps = judge('UJ-2', liveTaps, `UJ-2 @ ${PRE_TAPS} (live render)`)
  expect(uj2Taps['UJ-2.b'] !== 'PASS', 'miss 1 NOT detected: UJ-2.b should not PASS at the pre-taps pin')

  const uj4Pre = judge('UJ-4', liveAbsencePre, `UJ-4 @ ${PRE} (live renders)`)
  expect(uj4Pre['UJ-4.a'] !== 'PASS' && uj4Pre['UJ-4.b'] !== 'PASS', 'miss 5 NOT detected: UJ-4 end-states should not PASS at pre-fix')

  const post = { ...judge('UJ-2', snaps.post, `UJ-2 @ ${POST} (snapshots)`), ...judge('UJ-3', snaps.post, `UJ-3 @ ${POST} (snapshots)`), ...judge('UJ-4', liveAbsencePost, `UJ-4 @ ${POST} (live renders)`) }
  for (const [id, v] of Object.entries(post)) {
    expect(v === 'PASS', `FALSE FAIL at post-fix: ${id} = ${v} (must PASS)`)
  }

  if (failures.length > 0) {
    console.error('\nRETRO-FIT REGRESSION — the verdict matrix is broken:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\nretro-fit matrix HOLDS: detection 5/5, post-fix false FAILs 0, precision 1/1')
} catch (err) {
  console.error('retro-fit harness error:', err instanceof Error ? err.message : err)
  process.exit(2)
}
