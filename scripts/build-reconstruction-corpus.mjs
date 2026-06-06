#!/usr/bin/env node
/**
 * build-reconstruction-corpus.mjs — Cross-project reconstruction corpus census (Story 77-6).
 *
 * Enumerates clean reconstruction-corpus triples across one or more repos for the
 * Tier 1 phase-reconstruction eval (Story 77-9). A "clean" triple is a genuine
 * substrate dev-story auto-commit that can be re-dispatched from its parent state
 * and graded against the actual commit:
 *
 *   { id, source, repo, story_key, phase, commit_sha, parent_sha, run_id,
 *     story_file_input_path, expect, story_file?, input_path? }
 *
 * Cleanliness criteria (all must hold):
 *   1. The commit subject matches `feat(story-N-M):` (substrate's dev-story auto-commit).
 *   2. A run manifest in <repo>/.substrate/runs/ records that exact commit SHA for
 *      the story in `per_story_state[story_key].commit_sha` (the F-commitsha field),
 *      with a non-running/dispatched status. This is what distinguishes a real
 *      substrate-produced commit from a hand-built one bearing a `feat(story-)`
 *      subject — hand-built commits have no manifest recording their SHA.
 *   3. The commit's parent SHA resolves (so the phase can be re-dispatched from it).
 *   4. A story_file_input_path can be resolved (manifest sidecar > git > current checkout).
 *      Triples with no recoverable story input are excluded as corpus-errors (AC5/Story 81-8).
 *
 * IMPORTANT (Story 77-6 / F-commitsha): the auto-commit SHA is stored in
 * `per_story_state[key].commit_sha` — NOT in a `stories[key].commit_sha` field
 * (that shape never existed; the first 77-6 dispatch assumed it and found 0 pairs).
 * Because F-commitsha (v0.20.118) only persists the SHA going forward, the corpus
 * is forward-thin today and grows as new auto-commits accumulate.
 *
 * Shared corpus schema (Story 81-8, AC2): the output carries the superset of fields
 * needed by BOTH the reconstruction harness (scripts/eval-reconstruction/harness.mjs)
 * AND the pack-upgrade harness (scripts/eval-pack-upgrade/harness.mjs):
 *   - id, source, run_id, story_key, commit_sha, parent_sha, expect  (common)
 *   - story_file_input_path  (pack-upgrade reads this — absolute path)
 *   - input_path             (reconstruction reads this — manifest sidecar, absolute)
 *   - story_file             (reconstruction reads this — git-recovered, checkout-relative)
 *   - story_file_source      (provenance: 'manifest' | 'git' | 'checkout')
 *
 * Usage:
 *   node scripts/build-reconstruction-corpus.mjs \
 *     --repos /path/to/repo1,/path/to/repo2 \
 *     [--output _bmad-output/eval-results/corpus/reconstruction-corpus.yaml] \
 *     [--force]
 *
 *   --repos   Comma-separated repo root paths (REQUIRED — pollution guard).
 *   --output  Output YAML path (default: the canonical reconstruction-corpus.yaml).
 *   --force   Overwrite an existing curated corpus. Without it, when the output
 *             already exists the census writes to a sibling `.candidates.yaml` so a
 *             curated corpus is never clobbered by an automated sweep.
 *
 * Re-runnability: re-run after a batch of substrate-on-substrate dispatches to
 * harvest new pairs. Without --force the census writes to a .candidates.yaml sibling
 * so a curated corpus is never clobbered by an automated sweep.
 *
 * Exits non-zero when --repos is absent or a configured repo root is not a git repo.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const DEFAULT_OUTPUT = join(repoRoot, '_bmad-output', 'eval-results', 'corpus', 'reconstruction-corpus.yaml')

// Manifest statuses that mean the run is still in flight — never corpus sources.
export const EXCLUDED_STATUS = new Set(['running', 'dispatched'])

// substrate dev-story auto-commit subject: `feat(story-N-M):` (story key may carry
// a letter suffix, e.g. 41-6b). The producing phase for such a commit is dev-story.
const AUTO_COMMIT_RE = /^feat\(story-(\d+-\d+[a-z]?)\):/

const COMMIT_SEP = '---END-COMMIT-77-6---'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** True when a commit subject is a substrate dev-story auto-commit. */
export function isAutoCommitSubject(subject) {
  return AUTO_COMMIT_RE.test(subject ?? '')
}

/**
 * Derive a human-readable source label from a repo path.
 * 'substrate' → 'substrate-self' (the self-hosting canonical label).
 * Other repos → basename (e.g. 'ynab', 'strata').
 *
 * @param {string} repoPath — absolute repo root path
 * @returns {string}
 */
export function deriveSource(repoPath) {
  const parts = repoPath.replace(/\\/g, '/').split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? 'unknown'
  return base === 'substrate' ? 'substrate-self' : base
}

/**
 * Resolve the absolute story_file_input_path for a corpus triple (Story 81-8, AC5).
 *
 * Priority order:
 *   1. Manifest sidecar (inputResolution.input_path) — absolute, existence already
 *      verified by resolvePhaseInput. Durable; works even when the repo does not
 *      git-track story artifacts.
 *   2. Git-recovered file (inputResolution.story_file) — repo-relative path found at
 *      parentSha via git ls-tree. Resolve to absolute and confirm it exists on disk.
 *   3. Current-checkout fallback — the story file may have been added IN the commit
 *      (not pre-existing at parentSha), e.g. `_bmad-output/implementation-artifacts/
 *      <storyKey>-*.md`. Scan candidate dirs in the current working tree.
 *
 * Returns null when no story input can be resolved; the caller should exclude the
 * triple as a corpus-error (AC5: "pair with NO recoverable story input is excluded").
 *
 * @param {object} inputResolution — return value of resolvePhaseInput
 * @param {string} repoPath — absolute repo root
 * @param {string} storyKey — e.g. '78-1'
 * @returns {{ path: string, source: string } | null}
 */
export function resolveStoryFileInputPath(inputResolution, repoPath, storyKey) {
  // Priority 1: manifest sidecar (absolute path, existence already confirmed).
  if (typeof inputResolution.input_path === 'string' && inputResolution.input_path.length > 0) {
    return { path: inputResolution.input_path, source: 'manifest' }
  }

  // Priority 2: git-recovered file — absolute-ify and verify on disk.
  if (typeof inputResolution.story_file === 'string' && inputResolution.story_file.length > 0) {
    const abs = join(repoPath, inputResolution.story_file)
    if (existsSync(abs)) return { path: abs, source: 'git' }
  }

  // Priority 3: current-checkout fallback — story file added in the commit itself,
  // so not present at parentSha but accessible in the live working tree.
  const candidateDirs = [
    join(repoPath, '_bmad-output', 'implementation-artifacts'),
    join(repoPath, '_bmad-output', 'stories'),
    join(repoPath, 'docs', 'stories'),
    join(repoPath, 'docs', 'planning'),
  ]
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir)
      const match = files.find(
        (f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md') && !f.includes('.stale-'),
      )
      if (match) return { path: join(dir, match), source: 'checkout' }
    } catch {
      // directory unreadable — try next
    }
  }

  return null
}

/** Extract the story key (e.g. '10-2') from a `feat(story-10-2): …` subject, else null. */
export function extractStoryKey(subject) {
  const m = AUTO_COMMIT_RE.exec(subject ?? '')
  return m ? m[1] : null
}

/**
 * Load and parse all `<runsDir>/*.json` run manifests.
 * @param {string} runsDir absolute path to a repo's .substrate/runs/
 * @returns {Array<{runId: string, raw: object}>}
 */
export function loadManifests(runsDir) {
  if (!existsSync(runsDir)) return []
  const manifests = []
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(runsDir, file), 'utf8'))
      manifests.push({ runId: file.replace(/\.json$/, ''), raw })
    } catch {
      // Skip unreadable/partial manifests — never abort the census.
    }
  }
  return manifests
}

/**
 * Find the manifest that records `commitSha` as story `storyKey`'s auto-commit
 * via `per_story_state[storyKey].commit_sha` (F-commitsha), with a settled status.
 * @returns {{runId: string, manifest: object, storyEntry: object} | null}
 */
export function findCorrelatingManifest(manifests, storyKey, commitSha) {
  for (const { runId, raw } of manifests) {
    const perStory = raw?.per_story_state
    if (!perStory || typeof perStory !== 'object') continue
    const entry = perStory[storyKey]
    if (!entry || typeof entry !== 'object') continue
    if (entry.commit_sha !== commitSha) continue
    if (EXCLUDED_STATUS.has(entry.status ?? '')) continue
    return { runId, manifest: raw, storyEntry: entry }
  }
  return null
}

/**
 * Determine the producing phase for a story's auto-commit. substrate auto-commits
 * dev-story output, so dev-story is the default; honor an explicit recorded phase.
 */
export function determinePhase(storyEntry) {
  const phase = storyEntry?.phase
  if (typeof phase === 'string' && phase.length > 0) {
    // Manifest phases are uppercase lifecycle states (IN_DEV, COMPLETE…); the
    // reconstruction phase vocabulary is the dispatch task type.
    return 'dev-story'
  }
  return 'dev-story'
}

/**
 * Parse `git log` output (subject%n body, commit-separated) into commit records.
 * @returns {Array<{sha: string, subject: string}>}
 */
export function parseGitLog(stdout) {
  const records = []
  for (const block of stdout.split(COMMIT_SEP)) {
    const trimmed = block.trim()
    if (trimmed.length === 0) continue
    const nl = trimmed.indexOf('\n')
    const firstLine = nl === -1 ? trimmed : trimmed.slice(0, nl)
    const spaceIdx = firstLine.indexOf(' ')
    if (spaceIdx === -1) continue
    const sha = firstLine.slice(0, spaceIdx)
    const subject = firstLine.slice(spaceIdx + 1)
    records.push({ sha, subject })
  }
  return records
}

/**
 * Resolve the phase input for a triple (obs_2026-05-26_027). Prefers the durable
 * sidecar the orchestrator captured in the manifest (`story_file_input_path`,
 * relative to the runs dir) over recovering the story file from git at the
 * parent SHA. The sidecar works for consumer repos that don't git-track story
 * artifacts; git recovery is the fallback for pre-fix runs.
 *
 * @returns input fields to merge onto the triple:
 *   - manifest: { story_file?, story_file_source:'manifest', input_path, story_file_sha256? }
 *   - git:      { story_file, story_file_source:'git' }
 *   - none:     {} (no recoverable input — triple is recorded but not reconstructable)
 */
export function resolvePhaseInput(storyEntry, runsDir, repoPath, parentSha, storyKey, findStoryFileFn = findStoryFileAtParent) {
  const relInput = storyEntry?.story_file_input_path
  if (typeof relInput === 'string' && relInput.length > 0) {
    const abs = join(runsDir, relInput)
    if (existsSync(abs)) {
      return {
        ...(typeof storyEntry.story_file === 'string' ? { story_file: storyEntry.story_file } : {}),
        story_file_source: 'manifest',
        input_path: abs,
        ...(typeof storyEntry.story_file_sha256 === 'string'
          ? { story_file_sha256: storyEntry.story_file_sha256 }
          : {}),
      }
    }
  }
  const gitFile = findStoryFileFn(repoPath, parentSha, storyKey)
  return gitFile !== null ? { story_file: gitFile, story_file_source: 'git' } : {}
}

// ---------------------------------------------------------------------------
// Git access (I/O — not unit-tested directly)
// ---------------------------------------------------------------------------

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

function isGitRepo(repoPath) {
  try {
    git(repoPath, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

function resolveParent(repoPath, sha) {
  try {
    return git(repoPath, ['rev-parse', `${sha}^`]).trim()
  } catch {
    return null
  }
}

/** Find the story-file artifact for `storyKey` at `parentSha`, if one exists there. */
function findStoryFileAtParent(repoPath, parentSha, storyKey) {
  const candidates = [
    `_bmad-output/implementation-artifacts`,
    `_bmad-output/stories`,
    `docs/stories`,
  ]
  for (const dir of candidates) {
    try {
      const listing = git(repoPath, ['ls-tree', '--name-only', parentSha, `${dir}/`])
      const match = listing
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.includes(`${storyKey}-`) && l.endsWith('.md') && !l.includes('.stale-'))
      if (match) return match
    } catch {
      // dir absent at parentSha — try next
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

/**
 * Enumerate clean reconstruction triples for a single repo.
 *
 * I/O dependencies (git log, parent resolution, story-file lookup, manifest load,
 * story_file_input_path resolution) are injectable so the wiring is unit-testable
 * without a real repo. Production callers pass none and get the real git/FS
 * implementations.
 *
 * Shared schema (Story 81-8, AC2): each emitted triple carries both the
 * reconstruction-harness fields (repo, phase, input_path, story_file) AND the
 * pack-upgrade-harness fields (id, source, story_file_input_path, expect).
 * Triples with no resolvable story_file_input_path are excluded as corpus-errors.
 *
 * @param {string} repoPath
 * @param {object} [deps={}]
 * @param {string} [deps.gitLogStdout] — inject for tests
 * @param {Array}  [deps.manifests] — inject for tests
 * @param {Function} [deps.resolveParentFn] — inject for tests
 * @param {Function} [deps.findStoryFileFn] — inject for tests
 * @param {Function} [deps.resolveStoryFileInputPathFn] — inject for tests
 * @returns {{ triples: Array<object>, cleanCount: number, excludedCount: number, repo: string }}
 */
export function censusRepo(repoPath, deps = {}) {
  const {
    gitLogStdout,
    manifests,
    resolveParentFn = resolveParent,
    findStoryFileFn = findStoryFileAtParent,
    resolveStoryFileInputPathFn = resolveStoryFileInputPath,
  } = deps
  const runsDir = join(repoPath, '.substrate', 'runs')
  const loadedManifests = manifests ?? loadManifests(runsDir)
  const stdout = gitLogStdout ?? git(repoPath, ['log', `--pretty=%H %s%n%b%n${COMMIT_SEP}`])
  const commits = parseGitLog(stdout)

  const triples = []
  let excludedCount = 0
  for (const { sha, subject } of commits) {
    if (!isAutoCommitSubject(subject)) continue
    const storyKey = extractStoryKey(subject)
    if (storyKey === null) continue

    const correlation = findCorrelatingManifest(loadedManifests, storyKey, sha)
    if (correlation === null) continue // hand-built / unrecorded — not a clean pair

    const parentSha = resolveParentFn(repoPath, sha)
    if (parentSha === null) continue

    // obs_2026-05-26_027: prefer the durable phase-input the orchestrator
    // captured in the manifest (`story_file_input_path`, relative to runsDir)
    // over recovering the story file from git at the parent SHA. The manifest
    // copy works even when the consumer repo does not git-track story artifacts
    // (the strata-5-2 gap); git recovery is the fallback for older runs.
    const inputResolution = resolvePhaseInput(
      correlation.storyEntry,
      runsDir,
      repoPath,
      parentSha,
      storyKey,
      findStoryFileFn,
    )

    // Story 81-8 AC5: resolve story_file_input_path (the unified path both harnesses
    // read). Priority: manifest sidecar > git-recovered file > current-checkout fallback.
    // Exclude triples with no recoverable story input (corpus-error, not silently passed).
    const resolved = resolveStoryFileInputPathFn(inputResolution, repoPath, storyKey)
    if (resolved === null) {
      excludedCount++
      continue // no story input — corpus-error, excluded
    }

    // Story 81-8 AC2: emit the shared schema superset (id, source, story_file_input_path,
    // expect) alongside the existing reconstruction-harness fields.
    const id = `${storyKey}-${sha.slice(0, 8)}`
    const source = deriveSource(repoPath)

    triples.push({
      id,
      source,
      repo: repoPath,
      story_key: storyKey,
      phase: determinePhase(correlation.storyEntry),
      commit_sha: sha,
      parent_sha: parentSha,
      run_id: correlation.runId,
      story_file_input_path: resolved.path,
      expect: { result_class: 'complete' },
      // Additive: keep reconstruction-harness fields (input_path, story_file, story_file_source).
      ...inputResolution,
      // Override story_file_source when we used the checkout fallback (Priority 3).
      ...(resolved.source === 'checkout' ? { story_file_source: 'checkout' } : {}),
      // For the checkout fallback, also set input_path so the reconstruction harness
      // can read the story file (its defaultReadStoryFile reads input_path for absolute paths).
      ...(resolved.source === 'checkout' && !inputResolution.input_path
        ? { input_path: resolved.path }
        : {}),
    })
  }

  return { repo: repoPath, triples, cleanCount: triples.length, excludedCount }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { repos: null, output: null, force: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repos') args.repos = argv[++i]
    else if (a === '--output') args.output = argv[++i]
    else if (a === '--force') args.force = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  process.stdout.write(`build-reconstruction-corpus.mjs — cross-project reconstruction corpus census (Story 77-6/81-8)

Usage: node scripts/build-reconstruction-corpus.mjs --repos <p1,p2,...> [--output PATH] [--force]

  --repos   Comma-separated repo root paths (REQUIRED — pollution guard).
  --output  Output YAML path (default: ${DEFAULT_OUTPUT}).
  --force   Overwrite an existing curated corpus (else writes to a .candidates.yaml sibling
            so a curated corpus is never clobbered by an automated sweep).

Re-runnability (Story 81-8, AC7):
  Re-run after a batch of substrate-on-substrate dispatches to harvest new pairs.
  The corpus grows organically as post-v0.20.118 auto-commits accumulate.
  Without --force the census writes to a .candidates.yaml sibling — inspect the
  diff and promote to the canonical file manually, or use --force to auto-promote.

Structural ceiling (as of 2026-06-06):
  ~2 clean pairs in substrate-self (only auto-commits with F-commitsha field qualify;
  Path-A-reconciled commits have no manifest recording and are excluded).
  Consumer repos (ynab, strata) are at 0 — manifests were excluded or not yet produced.
  The corpus grows as new substrate dispatches accumulate post-v0.20.118.

Shared schema (Story 81-8, AC2):
  Emits the field superset consumed by BOTH the reconstruction harness
  (scripts/eval-reconstruction/harness.mjs) AND the pack-upgrade harness
  (scripts/eval-pack-upgrade/harness.mjs). Pairs with no resolvable story
  story_file_input_path are excluded as corpus-errors (not silently passed).
`)
}

function main() {
  const args = parseArgs(process.argv)

  // Pollution guard (AC4): never census an implicit/default repo set.
  if (!args.repos || args.repos.trim().length === 0) {
    process.stderr.write('[build-reconstruction-corpus] ERROR: --repos is required (comma-separated repo roots)\n')
    process.exit(1)
  }

  const repoPaths = args.repos.split(',').map((r) => resolve(r.trim())).filter(Boolean)
  for (const repoPath of repoPaths) {
    if (!existsSync(repoPath) || !isGitRepo(repoPath)) {
      process.stderr.write(`[build-reconstruction-corpus] ERROR: not a git repo: ${repoPath}\n`)
      process.exit(1)
    }
  }

  const perRepo = []
  const allTriples = []
  let totalExcluded = 0
  for (const repoPath of repoPaths) {
    const { triples, cleanCount, excludedCount } = censusRepo(repoPath)
    perRepo.push({ repo: repoPath, clean_pairs: cleanCount })
    allTriples.push(...triples)
    totalExcluded += excludedCount ?? 0
    process.stdout.write(
      `[build-reconstruction-corpus] ${repoPath}: ${cleanCount} clean pair(s)` +
        (excludedCount > 0 ? ` (${excludedCount} excluded — no story input)` : '') +
        '\n',
    )
  }

  // Story 81-8 AC6: provenance + ceiling documentation in the corpus header.
  // The structural ceiling note documents WHY the corpus is thin: F-commitsha
  // (v0.20.118) is forward-only, Path-A-reconciled commits have no manifest
  // recording, and some consumer repos cleaned their manifests.
  const corpus = {
    corpus_version: 2, // bumped from v1 for the AC2 schema extension (id, source, story_file_input_path, expect)
    census_date: new Date().toISOString().slice(0, 10),
    corpus_ceiling: allTriples.length,
    source_repos: repoPaths,
    per_repo: perRepo,
    provenance: {
      f_commitsha_field: 'per_story_state[key].commit_sha (F-commitsha, v0.20.118+)',
      structural_ceiling_note:
        'F-commitsha is forward-only: only substrate auto-commits dispatched after v0.20.118' +
        ' carry this field. Path-A-reconciled commits (hand-built) are excluded — they have no' +
        ' manifest recording their SHA. Re-run after a batch of substrate dispatches to harvest' +
        ' new pairs.',
      strata_note:
        'strata has commits but manifests were excluded/cleaned — 0 reconstructable pairs.',
      excluded_count: totalExcluded,
      excluded_note:
        totalExcluded > 0
          ? `${totalExcluded} otherwise-clean pair(s) excluded because no story_file_input_path` +
            ' could be resolved (AC5). These pairs have no manifest sidecar and no story file' +
            ' in the current checkout.'
          : 'No pairs excluded for missing story input.',
    },
    cases: allTriples,
  }

  // AC4: curated-corpus protection — never clobber an existing curated file
  // unless --force; otherwise emit candidates for human review.
  let outputPath = args.output ? resolve(args.output) : DEFAULT_OUTPUT
  if (!args.force && existsSync(outputPath)) {
    outputPath = outputPath.replace(/\.ya?ml$/, '.candidates.yaml')
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, yaml.dump(corpus, { lineWidth: 100 }))

  process.stdout.write(`[build-reconstruction-corpus] Corpus ceiling: ${allTriples.length} clean pairs across ${repoPaths.length} repo(s)\n`)
  process.stdout.write(`[build-reconstruction-corpus] Written to: ${outputPath}\n`)
}

// Only run main() when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
