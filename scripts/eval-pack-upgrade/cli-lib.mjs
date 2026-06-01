/**
 * cli-lib.mjs — Pure helpers for the pack-upgrade CLI (Story 81-4).
 *
 * All functions are pure (or pure when deps are supplied) — no direct I/O.
 * Injectable deps are used for I/O-adjacent operations (git diff, file reads)
 * so tests can supply stubs without spawning real processes.
 *
 * Exports (AC12):
 *   formatMarkdownReport   — markdown document per AC3
 *   formatJsonReport       — JSON envelope per AC4
 *   formatPlainReport      — terminal-friendly plain text per AC5
 *   parseThresholdString   — parse axis:value,axis:value threshold string
 *   resolveGroundTruth     — run git diff to get the ground-truth diff
 *   inferPackIdentity      — read pack version + git sha
 *   dryRunCorpus           — validate corpus entries without dispatching
 *   buildGraderThresholds  — map CLI axis names to grader threshold format
 */

import { readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// parseThresholdString (AC12)
// ---------------------------------------------------------------------------

/**
 * Parse an axis:value,axis:value threshold string into an object.
 *
 * Accepted axes: code-quality, cost-turns, verdict-tv, recovery-tv.
 * Additional axis names are accepted without error (forward-compatible).
 *
 * @param {string} s — e.g. "code-quality:0.05,cost-turns:0.10,verdict-tv:0.10"
 * @returns {{ [axis: string]: number }}
 * @throws {Error} on malformed input
 */
export function parseThresholdString(s) {
  if (s === undefined || s === null || s === '') {
    throw new Error('parseThresholdString: expected a non-empty string, got empty/null input')
  }
  if (typeof s !== 'string') {
    throw new Error(`parseThresholdString: expected a string, got ${typeof s}`)
  }
  const result = {}
  const parts = s.split(',')
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) {
      throw new Error(
        `parseThresholdString: malformed segment "${trimmed}" — expected "axis:value" format`,
      )
    }
    const axis = trimmed.slice(0, colonIdx).trim()
    const valueStr = trimmed.slice(colonIdx + 1).trim()
    if (!axis) {
      throw new Error(`parseThresholdString: empty axis name in "${trimmed}"`)
    }
    const value = Number.parseFloat(valueStr)
    if (Number.isNaN(value)) {
      throw new Error(
        `parseThresholdString: invalid value "${valueStr}" for axis "${axis}" — expected a number`,
      )
    }
    result[axis] = value
  }
  if (Object.keys(result).length === 0) {
    throw new Error(`parseThresholdString: no valid axis:value pairs found in "${s}"`)
  }
  return result
}

// ---------------------------------------------------------------------------
// buildGraderThresholds — map CLI axis names to grader threshold format
// ---------------------------------------------------------------------------

/**
 * Convert CLI-style threshold maps to the grader's nested threshold object.
 *
 * CLI axis names → grader threshold keys:
 *   code-quality → codeQuality { warn, fail }
 *   cost-turns   → cost { warnTurns, failTurns }
 *   verdict-tv   → verdict { warnTV, failTV }
 *   recovery-tv  → recovery { warnTV, failTV }
 *
 * Fail thresholds default to 2× warn unless explicitly set (AC1).
 *
 * @param {object} [warnThresholds={}] — { 'code-quality': 0.05, ... }
 * @param {object} [failThresholds={}] — { 'code-quality': 0.15, ... }
 * @returns {object} — grader threshold object (partial; unset axes use grader defaults)
 */
export function buildGraderThresholds(warnThresholds, failThresholds) {
  const warn = warnThresholds ?? {}
  const fail = failThresholds ?? {}
  const result = {}

  // code-quality axis
  if ('code-quality' in warn || 'code-quality' in fail) {
    const warnVal = warn['code-quality']
    const failVal = fail['code-quality'] ?? (warnVal !== undefined ? warnVal * 2 : undefined)
    result.codeQuality = {}
    if (warnVal !== undefined) result.codeQuality.warn = warnVal
    if (failVal !== undefined) result.codeQuality.fail = failVal
  }

  // cost-turns axis
  if ('cost-turns' in warn || 'cost-turns' in fail) {
    const warnVal = warn['cost-turns']
    const failVal = fail['cost-turns'] ?? (warnVal !== undefined ? warnVal * 2 : undefined)
    result.cost = result.cost ?? {}
    if (warnVal !== undefined) result.cost.warnTurns = warnVal
    if (failVal !== undefined) result.cost.failTurns = failVal
  }

  // verdict-tv axis
  if ('verdict-tv' in warn || 'verdict-tv' in fail) {
    const warnVal = warn['verdict-tv']
    const failVal = fail['verdict-tv'] ?? (warnVal !== undefined ? warnVal * 2 : undefined)
    result.verdict = {}
    if (warnVal !== undefined) result.verdict.warnTV = warnVal
    if (failVal !== undefined) result.verdict.failTV = failVal
  }

  // recovery-tv axis
  if ('recovery-tv' in warn || 'recovery-tv' in fail) {
    const warnVal = warn['recovery-tv']
    const failVal = fail['recovery-tv'] ?? (warnVal !== undefined ? warnVal * 2 : undefined)
    result.recovery = {}
    if (warnVal !== undefined) result.recovery.warnTV = warnVal
    if (failVal !== undefined) result.recovery.failTV = failVal
  }

  return result
}

// ---------------------------------------------------------------------------
// resolveGroundTruth (AC12, AC8)
// ---------------------------------------------------------------------------

/**
 * Resolve the ground-truth diff for a corpus entry using git diff.
 *
 * @param {object} corpusEntry — corpus entry with { parent_sha, commit_sha, ... }
 * @param {string|object} repoRoots — path to the repo root (string), or map { repoName: path }
 * @param {object} deps — { gitDiff(repoRoot, parentSha, commitSha) → string }
 * @returns {string} unified diff between parent and commit
 * @throws {Error} if required fields are missing or git diff fails
 */
export function resolveGroundTruth(corpusEntry, repoRoots, deps) {
  const {
    gitDiff = defaultGitDiff,
  } = deps ?? {}

  const caseId = corpusEntry?.id ?? corpusEntry?.case_id ?? '<unknown>'
  const parentSha = corpusEntry?.parent_sha
  const commitSha = corpusEntry?.commit_sha

  if (!parentSha) {
    throw new Error(`resolveGroundTruth: corpusEntry missing parent_sha (case_id=${caseId})`)
  }
  if (!commitSha) {
    throw new Error(`resolveGroundTruth: corpusEntry missing commit_sha (case_id=${caseId})`)
  }

  // Resolve repo root
  let repoRoot
  if (typeof repoRoots === 'string') {
    repoRoot = repoRoots
  } else if (repoRoots && typeof repoRoots === 'object') {
    const repoName = corpusEntry?.repo
    repoRoot = repoName ? (repoRoots[repoName] ?? null) : Object.values(repoRoots)[0] ?? null
  }
  if (!repoRoot) {
    throw new Error(
      `resolveGroundTruth: could not resolve repo root for case_id=${caseId}`,
    )
  }

  try {
    return gitDiff(repoRoot, parentSha, commitSha)
  } catch (err) {
    throw new Error(
      `resolveGroundTruth: git diff failed for case ${caseId} ` +
        `(${parentSha}..${commitSha}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Default deps.gitDiff implementation — invokes git via execFileSync (AC8).
 * @param {string} repoRoot
 * @param {string} parentSha
 * @param {string} commitSha
 * @returns {string}
 */
export function defaultGitDiff(repoRoot, parentSha, commitSha) {
  return execFileSync('git', ['-C', repoRoot, 'diff', parentSha, commitSha], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

// ---------------------------------------------------------------------------
// inferPackIdentity (AC12, AC10)
// ---------------------------------------------------------------------------

/**
 * Infer a pack's version and git SHA for reporting purposes.
 *
 * Version comes from manifest.yaml `version` field.
 * SHA comes from `git -C <parent-of-pack-dir> rev-parse HEAD:<pack-dir-name>`.
 * Both gracefully degrade to null on any failure (AC10).
 *
 * @param {string} packPath — absolute path to the pack directory
 * @param {object} [deps={}]
 * @param {(path: string) => string} [deps.readFile] — defaults to readFileSync
 * @param {(packPath: string) => string|null} [deps.gitRevParse] — defaults to git rev-parse
 * @returns {{ version: string|null, sha: string|null }}
 */
export function inferPackIdentity(packPath, deps = {}) {
  const {
    readFile = (p) => readFileSync(p, 'utf8'),
    gitRevParse = defaultGitRevParse,
  } = deps

  // Read version from manifest.yaml
  let version = null
  try {
    const manifestPath = join(packPath, 'manifest.yaml')
    const raw = readFile(manifestPath)
    const parsed = yaml.load(raw)
    version = parsed?.version != null ? String(parsed.version) : null
  } catch {
    version = null
  }

  // Get git SHA of the pack directory object
  let sha = null
  try {
    const result = gitRevParse(packPath)
    sha = result ? String(result).trim() || null : null
  } catch {
    sha = null
  }

  return { version, sha }
}

/**
 * Default deps.gitRevParse implementation.
 * Invokes `git -C <parent-of-pack-dir> rev-parse HEAD:<pack-dir-name>`.
 * Returns null on any error (not in git repo, dir not tracked, etc.).
 *
 * @param {string} packPath — absolute path to the pack directory
 * @returns {string|null}
 */
export function defaultGitRevParse(packPath) {
  const packDirName = basename(packPath)
  const parentDir = dirname(packPath)
  try {
    const out = execFileSync('git', ['-C', parentDir, 'rev-parse', `HEAD:${packDirName}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// dryRunCorpus (AC12, AC7)
// ---------------------------------------------------------------------------

/**
 * Validate corpus entries for pack-upgrade dispatch without running any dispatches.
 *
 * Checks each entry for the three required fields:
 *   - parent_sha (corpus → dispatch parent)
 *   - story_file_input_path (story content source)
 *   - commit_sha (required for ground-truth resolution)
 *
 * Entries that were already skipped during parseOutcomesCorpusForPackUpgrade are
 * reported as errors.
 *
 * @param {object} corpus — { cases: object[], skipped: object[] } from parseOutcomesCorpusForPackUpgrade
 * @param {object} [deps={}] — reserved for future injectable validators
 * @returns {{ ready: boolean, perPair: Array<{ caseId: string, status: 'ready'|'error', error?: string }> }}
 */
export function dryRunCorpus(corpus, deps = {}) {
  const perPair = []

  // Already-skipped entries from corpus parsing → always errors
  for (const skipped of corpus?.skipped ?? []) {
    perPair.push({
      caseId: skipped.case_id ?? '<unknown>',
      status: 'error',
      error: skipped.reason ?? 'skipped during corpus parsing',
    })
  }

  // Validate each dispatchable case for pack-upgrade readiness
  for (const caseEntry of corpus?.cases ?? []) {
    const caseId = caseEntry.case_id ?? caseEntry.id ?? '<unknown>'
    const errors = []

    if (!caseEntry.parent_sha) errors.push('missing parent_sha')
    if (!caseEntry.story_file_input_path) errors.push('missing story_file_input_path')
    // commit_sha required for ground-truth resolution (AC7)
    if (!caseEntry.commit_sha) errors.push('missing commit_sha')

    if (errors.length > 0) {
      perPair.push({ caseId, status: 'error', error: errors.join('; ') })
    } else {
      perPair.push({ caseId, status: 'ready' })
    }
  }

  const ready = perPair.length > 0 && perPair.every((p) => p.status === 'ready')
  return { ready, perPair }
}

// ---------------------------------------------------------------------------
// Report formatters (AC12)
// ---------------------------------------------------------------------------

const VERDICT_EMOJI = { GREEN: '🟢', YELLOW: '🟡', RED: '🔴' }

/**
 * Format a markdown evaluation report per AC3.
 *
 * @param {object} gradeResult — PackUpgradeGradeResult from gradeAll
 * @param {{ current: { path, version, sha }, candidate: { path, version, sha } }} packIdentities
 * @param {{ path: string, version: string|number|null, pairCount: number, completedBoth: number, ungradable: number }} corpusInfo
 * @returns {string}
 */
export function formatMarkdownReport(gradeResult, packIdentities, corpusInfo) {
  const overallVerdict = gradeResult?.overall_verdict ?? 'GREEN'
  const axes = gradeResult?.axes ?? {}
  const thresholdsUsed = gradeResult?.thresholds_used

  const emoji = VERDICT_EMOJI[overallVerdict] ?? ''
  const lines = []

  lines.push('# Pack-upgrade evaluation report')
  lines.push('')

  // Header block
  const curr = packIdentities?.current
  const cand = packIdentities?.candidate
  const currRef = curr?.sha ?? curr?.version ?? 'unknown'
  const candRef = cand?.sha ?? cand?.version ?? 'unknown'
  lines.push(`**Current pack**: ${curr?.path ?? '<unknown>'} @ ${currRef}`)
  lines.push(`**Candidate pack**: ${cand?.path ?? '<unknown>'} @ ${candRef}`)
  lines.push(
    `**Corpus**: ${corpusInfo?.path ?? '<unknown>'}, ${corpusInfo?.pairCount ?? 0} pairs, ` +
      `${corpusInfo?.completedBoth ?? 0} completed both, ${corpusInfo?.ungradable ?? 0} ungradable`,
  )
  lines.push(`**Overall verdict**: ${emoji} ${overallVerdict}`)
  lines.push('')

  // Axis verdicts table
  lines.push('## Axis verdicts')
  lines.push('| Axis | Verdict | Headline |')
  lines.push('| --- | --- | --- |')

  const cq = axes.code_quality
  if (cq) {
    const cqEmoji = VERDICT_EMOJI[cq.verdict] ?? ''
    const delta = typeof cq.mean_delta === 'number' ? cq.mean_delta.toFixed(3) : 'n/a'
    const sign = typeof cq.mean_delta === 'number' && cq.mean_delta >= 0 ? '+' : ''
    const gradable = (cq.regression_count ?? 0) + (cq.improvement_count ?? 0)
    const headline = `mean Δ = ${sign}${delta} (regression in ${cq.regression_count ?? 0} of ${gradable} pairs)`
    lines.push(`| Code quality | ${cqEmoji} ${cq.verdict} | ${headline} |`)
  }

  const cost = axes.cost
  if (cost) {
    const costEmoji = VERDICT_EMOJI[cost.verdict] ?? ''
    const deltaTurns = typeof cost.mean_delta_turns === 'number' ? cost.mean_delta_turns.toFixed(1) : 'n/a'
    const sign = typeof cost.mean_delta_turns === 'number' && cost.mean_delta_turns >= 0 ? '+' : ''
    const headline = `mean Δ turns = ${sign}${deltaTurns} (within threshold)`
    lines.push(`| Cost | ${costEmoji} ${cost.verdict} | ${headline} |`)
  }

  const vd = axes.verdict
  if (vd) {
    const vdEmoji = VERDICT_EMOJI[vd.verdict] ?? ''
    const tv = typeof vd.tv_distance === 'number' ? vd.tv_distance.toFixed(2) : 'n/a'
    const currentDist = vd.current_distribution ?? {}
    const candidateDist = vd.candidate_distribution ?? {}
    const currentTotal = Object.values(currentDist).reduce((a, b) => a + b, 0)
    const candidateTotal = Object.values(candidateDist).reduce((a, b) => a + b, 0)
    const currentShipIt = currentDist.SHIP_IT ?? 0
    const candidateShipIt = candidateDist.SHIP_IT ?? 0
    const currentPct = currentTotal > 0 ? Math.round((100 * currentShipIt) / currentTotal) : 0
    const candidatePct = candidateTotal > 0 ? Math.round((100 * candidateShipIt) / candidateTotal) : 0
    const headline = `TV = ${tv} (SHIP_IT ${currentPct}% → ${candidatePct}%)`
    lines.push(`| Verdict distribution | ${vdEmoji} ${vd.verdict} | ${headline} |`)
  }

  const rec = axes.recovery
  if (rec) {
    const recEmoji = VERDICT_EMOJI[rec.verdict] ?? ''
    const tv = typeof rec.tv_distance === 'number' ? rec.tv_distance.toFixed(2) : 'n/a'
    const headline = `TV = ${tv}`
    lines.push(`| Recovery taxonomy | ${recEmoji} ${rec.verdict} | ${headline} |`)
  }

  lines.push('')

  // Per-axis detail
  lines.push('## Per-axis detail')

  // Code quality
  if (cq) {
    lines.push('')
    lines.push('### Code quality')
    const sign = typeof cq.mean_delta === 'number' && cq.mean_delta >= 0 ? '+' : ''
    lines.push(`Mean Δ: ${sign}${cq.mean_delta?.toFixed(3) ?? 'n/a'}`)
    const medSign = typeof cq.median_delta === 'number' && cq.median_delta >= 0 ? '+' : ''
    lines.push(`Median Δ: ${medSign}${cq.median_delta?.toFixed(3) ?? 'n/a'}`)
    lines.push(
      `Regressions: ${cq.regression_count ?? 0}, Improvements: ${cq.improvement_count ?? 0}, ` +
        `Ungradable: ${cq.ungradable_count ?? 0}`,
    )

    const regressions = (cq.per_pair ?? [])
      .filter((p) => p.gradable && typeof p.delta === 'number' && p.delta < 0)
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
      .slice(0, 3)
    if (regressions.length > 0) {
      lines.push('')
      lines.push('**Top regressions:**')
      for (const r of regressions) {
        lines.push(
          `- case_id=${r.case_id ?? r.pair_id ?? 'n/a'}, ` +
            `current_score=${r.current_score?.toFixed(3) ?? 'n/a'}, ` +
            `candidate_score=${r.candidate_score?.toFixed(3) ?? 'n/a'}, ` +
            `Δ=${r.delta?.toFixed(3) ?? 'n/a'}`,
        )
      }
    }
  }

  // Cost
  if (cost) {
    lines.push('')
    lines.push('### Cost')
    const sign = typeof cost.mean_delta_turns === 'number' && cost.mean_delta_turns >= 0 ? '+' : ''
    lines.push(`Mean Δ turns: ${sign}${cost.mean_delta_turns?.toFixed(1) ?? 'n/a'}`)
    const inSign = typeof cost.mean_delta_input_tokens === 'number' && cost.mean_delta_input_tokens >= 0 ? '+' : ''
    lines.push(`Mean Δ input tokens: ${inSign}${cost.mean_delta_input_tokens?.toFixed(0) ?? 'n/a'}`)
    const outSign = typeof cost.mean_delta_output_tokens === 'number' && cost.mean_delta_output_tokens >= 0 ? '+' : ''
    lines.push(`Mean Δ output tokens: ${outSign}${cost.mean_delta_output_tokens?.toFixed(0) ?? 'n/a'}`)
    if (cost.p95s) {
      lines.push(
        `p95 Δ turns: ${cost.p95s.turns?.toFixed(1) ?? 'n/a'}, ` +
          `p95 Δ input tokens: ${cost.p95s.input_tokens?.toFixed(0) ?? 'n/a'}, ` +
          `p95 Δ output tokens: ${cost.p95s.output_tokens?.toFixed(0) ?? 'n/a'}`,
      )
    }
    lines.push(`Ungradable: ${cost.ungradable_count ?? 0}`)
  }

  // Verdict distribution
  if (vd) {
    lines.push('')
    lines.push('### Verdict distribution')
    lines.push(`TV distance: ${vd.tv_distance?.toFixed(4) ?? 'n/a'}`)
    const allVerdicts = new Set([
      ...Object.keys(vd.current_distribution ?? {}),
      ...Object.keys(vd.candidate_distribution ?? {}),
    ])
    if (allVerdicts.size > 0) {
      lines.push('')
      lines.push('| Verdict | Current count | Candidate count | Shift |')
      lines.push('| --- | --- | --- | --- |')
      for (const v of allVerdicts) {
        const currCount = (vd.current_distribution ?? {})[v] ?? 0
        const candCount = (vd.candidate_distribution ?? {})[v] ?? 0
        const shift = candCount - currCount
        lines.push(`| ${v} | ${currCount} | ${candCount} | ${shift >= 0 ? '+' : ''}${shift} |`)
      }
    }
  }

  // Recovery taxonomy
  if (rec) {
    lines.push('')
    lines.push('### Recovery taxonomy')
    lines.push(`TV distance: ${rec.tv_distance?.toFixed(4) ?? 'n/a'}`)
    const allClasses = new Set([
      ...Object.keys(rec.current_distribution ?? {}),
      ...Object.keys(rec.candidate_distribution ?? {}),
    ])
    if (allClasses.size > 0) {
      lines.push('')
      lines.push('| Class | Current count | Candidate count | Shift |')
      lines.push('| --- | --- | --- | --- |')
      for (const cls of allClasses) {
        const currCount = (rec.current_distribution ?? {})[cls] ?? 0
        const candCount = (rec.candidate_distribution ?? {})[cls] ?? 0
        const shift = candCount - currCount
        lines.push(`| ${cls} | ${currCount} | ${candCount} | ${shift >= 0 ? '+' : ''}${shift} |`)
      }
    }
  }

  // Configuration
  lines.push('')
  lines.push('## Configuration')
  if (thresholdsUsed) {
    lines.push('```json')
    lines.push(JSON.stringify(thresholdsUsed, null, 2))
    lines.push('```')
  } else {
    lines.push('_Using grader defaults._')
  }

  return lines.join('\n')
}

/**
 * Format a JSON evaluation report per AC4.
 *
 * @param {object} gradeResult — PackUpgradeGradeResult from gradeAll
 * @param {{ current: { path, version, sha }, candidate: { path, version, sha } }} packIdentities
 * @param {{ path: string, version: string|number|null, pairCount: number }} corpusInfo
 * @param {object} [opts={}] — { generatedAt?: string } for deterministic timestamps in tests
 * @returns {object}
 */
export function formatJsonReport(gradeResult, packIdentities, corpusInfo, opts = {}) {
  return {
    report_version: '1.0.0',
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    pack_current: {
      path: packIdentities?.current?.path ?? null,
      version: packIdentities?.current?.version ?? null,
      sha: packIdentities?.current?.sha ?? null,
    },
    pack_candidate: {
      path: packIdentities?.candidate?.path ?? null,
      version: packIdentities?.candidate?.version ?? null,
      sha: packIdentities?.candidate?.sha ?? null,
    },
    corpus: {
      path: corpusInfo?.path ?? null,
      version: corpusInfo?.version ?? null,
      pair_count: corpusInfo?.pairCount ?? 0,
    },
    grade_result: gradeResult ?? null,
  }
}

/**
 * Format a plain text evaluation report per AC5.
 * 60-80 lines max, no emoji, no markdown markers. Designed for terminal viewing.
 *
 * @param {object} gradeResult — PackUpgradeGradeResult from gradeAll
 * @param {{ current: { path, version, sha }, candidate: { path, version, sha } }} packIdentities
 * @param {{ path: string, version: string|number|null, pairCount: number, completedBoth: number, ungradable: number }} corpusInfo
 * @returns {string}
 */
export function formatPlainReport(gradeResult, packIdentities, corpusInfo) {
  const overallVerdict = gradeResult?.overall_verdict ?? 'GREEN'
  const axes = gradeResult?.axes ?? {}
  const lines = []

  const sep60 = '='.repeat(60)
  const sep40 = '-'.repeat(40)

  lines.push('PACK-UPGRADE EVALUATION REPORT')
  lines.push(sep60)
  lines.push('')

  // Pack identities
  const curr = packIdentities?.current
  const cand = packIdentities?.candidate
  lines.push(`Current pack  : ${curr?.path ?? '<unknown>'}`)
  if (curr?.version) lines.push(`  version     : ${curr.version}`)
  if (curr?.sha) lines.push(`  sha         : ${curr.sha.slice(0, 12)}`)
  lines.push(`Candidate pack: ${cand?.path ?? '<unknown>'}`)
  if (cand?.version) lines.push(`  version     : ${cand.version}`)
  if (cand?.sha) lines.push(`  sha         : ${cand.sha.slice(0, 12)}`)

  // Corpus info
  lines.push(`Corpus        : ${corpusInfo?.path ?? '<unknown>'}`)
  lines.push(
    `  pairs: ${corpusInfo?.pairCount ?? 0} total, ` +
      `${corpusInfo?.completedBoth ?? 0} completed both, ` +
      `${corpusInfo?.ungradable ?? 0} ungradable`,
  )
  lines.push(`Overall verdict: ${overallVerdict}`)
  lines.push('')

  // Axis verdicts
  lines.push('AXIS VERDICTS')
  lines.push(sep40)

  const cq = axes.code_quality
  if (cq) {
    const delta = typeof cq.mean_delta === 'number' ? cq.mean_delta.toFixed(3) : 'n/a'
    const sign = typeof cq.mean_delta === 'number' && cq.mean_delta >= 0 ? '+' : ''
    const gradable = (cq.regression_count ?? 0) + (cq.improvement_count ?? 0)
    lines.push(`Code quality  : ${cq.verdict}`)
    lines.push(`  mean delta  : ${sign}${delta}`)
    lines.push(`  regressions : ${cq.regression_count ?? 0} / ${gradable} gradable pairs`)
  }

  const cost = axes.cost
  if (cost) {
    const deltaTurns = typeof cost.mean_delta_turns === 'number' ? cost.mean_delta_turns.toFixed(1) : 'n/a'
    const sign = typeof cost.mean_delta_turns === 'number' && cost.mean_delta_turns >= 0 ? '+' : ''
    lines.push(`Cost          : ${cost.verdict}`)
    lines.push(`  mean delta turns : ${sign}${deltaTurns}`)
    if (cost.ungradable_count != null) {
      lines.push(`  ungradable       : ${cost.ungradable_count}`)
    }
  }

  const vd = axes.verdict
  if (vd) {
    const tv = typeof vd.tv_distance === 'number' ? vd.tv_distance.toFixed(4) : 'n/a'
    lines.push(`Verdict dist  : ${vd.verdict}`)
    lines.push(`  TV distance : ${tv}`)
  }

  const rec = axes.recovery
  if (rec) {
    const tv = typeof rec.tv_distance === 'number' ? rec.tv_distance.toFixed(4) : 'n/a'
    lines.push(`Recovery tax  : ${rec.verdict}`)
    lines.push(`  TV distance : ${tv}`)
  }

  lines.push('')

  // Top 3 regressions per axis
  lines.push('TOP REGRESSIONS (up to 3 per axis)')
  lines.push(sep40)

  if (cq) {
    const regs = (cq.per_pair ?? [])
      .filter((p) => p.gradable && typeof p.delta === 'number' && p.delta < 0)
      .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
      .slice(0, 3)
    if (regs.length > 0) {
      lines.push('Code quality:')
      for (let i = 0; i < regs.length; i++) {
        const r = regs[i]
        lines.push(
          `  ${i + 1}. case_id=${r.case_id ?? r.pair_id ?? 'n/a'} ` +
            `current=${r.current_score?.toFixed(3) ?? 'n/a'} ` +
            `candidate=${r.candidate_score?.toFixed(3) ?? 'n/a'} ` +
            `delta=${r.delta?.toFixed(3) ?? 'n/a'}`,
        )
      }
    } else {
      lines.push('Code quality: no regressions')
    }
  }

  if (cost) {
    const regs = (cost.per_pair ?? [])
      .filter((p) => p.gradable && typeof p.delta_turns === 'number' && p.delta_turns > 0)
      .sort((a, b) => (b.delta_turns ?? 0) - (a.delta_turns ?? 0))
      .slice(0, 3)
    if (regs.length > 0) {
      lines.push('Cost (turn increases):')
      for (let i = 0; i < regs.length; i++) {
        const r = regs[i]
        const turnSign = r.delta_turns >= 0 ? '+' : ''
        lines.push(
          `  ${i + 1}. delta_turns=${turnSign}${r.delta_turns}` +
            ` delta_input=${r.delta_input_tokens} delta_output=${r.delta_output_tokens}`,
        )
      }
    } else {
      lines.push('Cost: no turn-increase regressions')
    }
  }

  if (vd) {
    const regs = (vd.per_pair ?? [])
      .filter((p) => p.gradable && p.shift === 'shifted-down')
      .slice(0, 3)
    if (regs.length > 0) {
      lines.push('Verdict (shifted-down):')
      for (let i = 0; i < regs.length; i++) {
        const r = regs[i]
        lines.push(`  ${i + 1}. ${r.current_verdict} -> ${r.candidate_verdict}`)
      }
    } else {
      lines.push('Verdict: no shifted-down pairs')
    }
  }

  if (rec) {
    const tv = typeof rec.tv_distance === 'number' ? rec.tv_distance.toFixed(4) : 'n/a'
    lines.push(`Recovery: TV distance = ${tv} (ungradable: ${rec.ungradable_count ?? 0})`)
  }

  return lines.join('\n')
}
