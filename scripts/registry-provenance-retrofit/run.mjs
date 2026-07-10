#!/usr/bin/env node
/**
 * RP3.3 — registry-provenance completeness regression harness.
 *
 * Re-executes the income-sources corpus checks with REAL checker dispatches
 * (2 dispatches, ~$0.05–0.30, ~3–8 min) and asserts the verdict matrix:
 *
 *  1. FLOOR (0-noise): checker vs the post-fix PRD + the A3.2 reference
 *     registry → every registered journey (UJ-2/3/4) maps registered
 *     (mapping recall 3/3), and every undispositioned finding grounds in a
 *     real PRD span (the workflow's deterministic grounding validator makes
 *     fabrications structurally impossible — a finding that reaches us IS
 *     grounded; the floor assertion is that NO registered journey is
 *     misreported as undispositioned = zero false positives on the
 *     registered set). 2026-07-09 baseline: 5 undispositioned findings, all
 *     adjudicated TRUE (the PRD's own UJ-1/UJ-5 + Overload/bulk-ratify/
 *     resume narratives — the reference registry deliberately covers only
 *     the founding-miss journeys).
 *  2. PLANTED OMISSION: delete UJ-2 (the founding journey) from the registry
 *     → an undispositioned claim about the Sunday Packet / yes-no-defer
 *     journey MUST appear, span-cited. The exact transcription-loss class
 *     the program exists to close.
 *
 * Operator-workstation only: needs ~/code/jplanow/income-sources and real
 * agent auth (same locality rationale as ship.md Steps 4.7/4.8).
 *
 * Retro-fit integrity: iterating the checker prompt to pass is legal;
 * editing the PRD or the reference registry to dodge findings is
 * training-on-the-test and is not.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(REPO, 'dist', 'cli.mjs')
const PRD_SOURCE = join(
  homedir(),
  'code/jplanow/income-sources/_bmad-output/planning-artifacts/prds/prd-income-sources-2026-07-04/prd.md',
)
const REFERENCE_REGISTRY = join(REPO, '_planning/acceptance-gate/retrofit/journeys.yaml')

function fail(msg) {
  console.error(`RP3.3 HARNESS RED: ${msg}`)
  process.exit(1)
}

function setupCorpus() {
  const ws = mkdtempSync(join(tmpdir(), 'rp33-corpus-'))
  mkdirSync(join(ws, 'docs'), { recursive: true })
  mkdirSync(join(ws, '.substrate', 'acceptance'), { recursive: true })
  cpSync(join(REPO, 'packs'), join(ws, 'packs'), { recursive: true })
  cpSync(PRD_SOURCE, join(ws, 'docs', 'prd.md'))
  cpSync(REFERENCE_REGISTRY, join(ws, '.substrate', 'acceptance', 'journeys.yaml'))
  return ws
}

function runChecker(ws) {
  // retry-once on dispatch flake (null output) — same policy as the A3.2 harness
  for (let attempt = 0; attempt < 2; attempt++) {
    let stdout
    try {
      stdout = execFileSync(
        'node',
        [CLI, 'acceptance', 'validate', '--against-prd', 'docs/prd.md', '--output-format', 'json'],
        { cwd: ws, encoding: 'utf-8', timeout: 900_000, env: { ...process.env, LOG_LEVEL: 'silent' } },
      )
    } catch (err) {
      stdout = String(err.stdout ?? '')
    }
    try {
      const parsed = JSON.parse(stdout)
      const completeness = parsed.data?.completeness
      if (completeness?.status === 'ran') return completeness.claims
      console.error(`[rp33] attempt ${attempt}: completeness did not run (${JSON.stringify(completeness ?? 'absent')}) — ${attempt === 0 ? 'retrying' : 'giving up'}`)
    } catch {
      console.error(`[rp33] attempt ${attempt}: unparseable CLI output (${stdout.slice(0, 200)}) — ${attempt === 0 ? 'retrying' : 'giving up'}`)
    }
  }
  return undefined
}

// --- Leg 1: floor -----------------------------------------------------------
console.error('[rp33] leg 1/2: floor (reference registry, mapping recall + zero false positives on registered set)')
let ws = setupCorpus()
let claims = runChecker(ws)
if (claims === undefined) fail('floor run: checker produced no claims')
{
  const registeredRefs = new Set(claims.filter((c) => c.disposition === 'registered').map((c) => c.registry_ref))
  for (const id of ['UJ-2', 'UJ-3', 'UJ-4']) {
    if (!registeredRefs.has(id)) fail(`floor run: registered journey ${id} was not mapped registered (mapping recall broken)`)
  }
  const undisp = claims.filter((c) => c.disposition === 'undispositioned')
  // Zero false positives on the registered set: no undispositioned claim may
  // describe a journey the registry covers (Packet decisions / Pre-Claim /
  // declared absence). Topic fingerprints, not exact phrasing.
  const coveredTopics = [/pre-?claim/i, /(sunday|weekly) packet.*\b(yes|no|defer)\b/is, /declared (calendar )?absence|portugal/i]
  for (const c of undisp) {
    const text = `${c.description} ${c.prd_span}`
    if (coveredTopics.some((t) => t.test(text))) {
      fail(`floor run: FALSE POSITIVE — undispositioned claim overlaps a registered journey: "${c.description}"`)
    }
  }
  console.error(`[rp33] floor GREEN: 3/3 registered mapped; ${String(undisp.length)} undispositioned, none overlapping the registered set`)
}
rmSync(ws, { recursive: true, force: true })

// --- Leg 2: planted omission -------------------------------------------------
console.error('[rp33] leg 2/2: planted omission (UJ-2 deleted — the founding journey must be caught)')
ws = setupCorpus()
{
  const regPath = join(ws, '.substrate', 'acceptance', 'journeys.yaml')
  const content = readFileSync(regPath, 'utf-8')
  const mutated = content.replace(/ {2}- id: UJ-2\n[\s\S]*?(?= {2}- id: UJ-3\n)/, '')
  if (mutated.includes('UJ-2') || !mutated.includes('UJ-3')) fail('planted run: UJ-2 deletion mutation failed')
  writeFileSync(regPath, mutated)
}
claims = runChecker(ws)
if (claims === undefined) fail('planted run: checker produced no claims')
{
  const undisp = claims.filter((c) => c.disposition === 'undispositioned')
  const packetCaught = undisp.some((c) => /packet/i.test(`${c.description} ${c.prd_span}`) && /\b(yes|no|defer|dossier)\b/i.test(`${c.description} ${c.prd_span}`))
  if (!packetCaught) {
    fail(
      `planted run: the deleted founding journey (Sunday Packet yes/no/defer) was NOT flagged undispositioned. Findings: ${undisp.map((c) => c.description).join(' | ')}`,
    )
  }
  console.error('[rp33] planted omission GREEN: the founding journey was caught, span-cited')
}
rmSync(ws, { recursive: true, force: true })

console.error('RP3.3 HARNESS GREEN: floor + planted omission both hold')
