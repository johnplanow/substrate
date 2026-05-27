#!/usr/bin/env node
/**
 * build-reconstruction-corpus.mjs — Cross-project reconstruction corpus census (Story 77-6).
 *
 * Enumerates clean reconstruction-corpus triples across one or more repos for the
 * Tier 1 phase-reconstruction eval (Story 77-9). A "clean" triple is a genuine
 * substrate dev-story auto-commit that can be re-dispatched from its parent state
 * and graded against the actual commit:
 *
 *   { repo, story_key, phase, commit_sha, parent_sha, run_id, story_file? }
 *
 * Cleanliness criteria (all must hold):
 *   1. The commit subject matches `feat(story-N-M):` (substrate's dev-story auto-commit).
 *   2. A run manifest in <repo>/.substrate/runs/ records that exact commit SHA for
 *      the story in `per_story_state[story_key].commit_sha` (the F-commitsha field),
 *      with a non-running/dispatched status. This is what distinguishes a real
 *      substrate-produced commit from a hand-built one bearing a `feat(story-)`
 *      subject — hand-built commits have no manifest recording their SHA.
 *   3. The commit's parent SHA resolves (so the phase can be re-dispatched from it).
 *
 * IMPORTANT (Story 77-6 / F-commitsha): the auto-commit SHA is stored in
 * `per_story_state[key].commit_sha` — NOT in a `stories[key].commit_sha` field
 * (that shape never existed; the first 77-6 dispatch assumed it and found 0 pairs).
 * Because F-commitsha (v0.20.118) only persists the SHA going forward, the corpus
 * is forward-thin today and grows as new auto-commits accumulate.
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
 * I/O dependencies (git log, parent resolution, story-file lookup, manifest load)
 * are injectable so the wiring is unit-testable without a real repo. Production
 * callers pass none and get the real git/FS implementations.
 *
 * @returns {{ triples: Array<object>, cleanCount: number, repo: string }}
 */
export function censusRepo(repoPath, deps = {}) {
  const {
    gitLogStdout,
    manifests,
    resolveParentFn = resolveParent,
    findStoryFileFn = findStoryFileAtParent,
  } = deps
  const runsDir = join(repoPath, '.substrate', 'runs')
  const loadedManifests = manifests ?? loadManifests(runsDir)
  const stdout = gitLogStdout ?? git(repoPath, ['log', `--pretty=%H %s%n%b%n${COMMIT_SEP}`])
  const commits = parseGitLog(stdout)

  const triples = []
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

    triples.push({
      repo: repoPath,
      story_key: storyKey,
      phase: determinePhase(correlation.storyEntry),
      commit_sha: sha,
      parent_sha: parentSha,
      run_id: correlation.runId,
      ...inputResolution,
    })
  }

  return { repo: repoPath, triples, cleanCount: triples.length }
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
  process.stdout.write(`build-reconstruction-corpus.mjs — cross-project reconstruction corpus census (Story 77-6)

Usage: node scripts/build-reconstruction-corpus.mjs --repos <p1,p2,...> [--output PATH] [--force]

  --repos   Comma-separated repo root paths (REQUIRED).
  --output  Output YAML path (default: ${DEFAULT_OUTPUT}).
  --force   Overwrite an existing curated corpus (else writes to .candidates.yaml).
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
  for (const repoPath of repoPaths) {
    const { triples, cleanCount } = censusRepo(repoPath)
    perRepo.push({ repo: repoPath, clean_pairs: cleanCount })
    allTriples.push(...triples)
    process.stdout.write(`[build-reconstruction-corpus] ${repoPath}: ${cleanCount} clean pair(s)\n`)
  }

  const corpus = {
    corpus_version: 1,
    census_date: new Date().toISOString().slice(0, 10),
    corpus_ceiling: allTriples.length, // AC5
    per_repo: perRepo,
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
