/**
 * lib.mjs — Pure helpers for the pack-upgrade A/B harness (Story 81-2).
 *
 * Provides corpus parsing, pair-outcome classification, envelope normalization,
 * and pack-override construction. All exports are synchronous and purely
 * functional — no I/O.
 *
 * Contracted with:
 *   - Story 81-3 (grader) via the envelope shape (AC4)
 *   - Story 81-4 (CLI) via the pair-record shape (AC7)
 */

import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Corpus parsing
// ---------------------------------------------------------------------------

/**
 * Parse an outcomes-corpus YAML for pack-upgrade harness consumption.
 *
 * Each corpus entry is examined for `parent_sha` and `story_file_input_path`.
 * Entries missing either required field are moved to `skipped` (corpus-error
 * mechanics — mirrors 77-1 AC8, never throws on per-entry issues).
 *
 * @param {string} yamlContent — raw YAML (outcomes-corpus.yaml format)
 * @returns {{ cases: Array<{case_id, parent_sha, story_key, story_file_input_path}>, skipped: Array<{case_id, reason}> }}
 * @throws if YAML is malformed or the top-level structure is invalid
 */
export function parseOutcomesCorpusForPackUpgrade(yamlContent) {
  let parsed
  try {
    parsed = yaml.load(yamlContent)
  } catch (err) {
    throw new Error(`parseOutcomesCorpusForPackUpgrade: YAML parse error: ${err.message ?? err}`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('parseOutcomesCorpusForPackUpgrade: corpus root must be a YAML mapping')
  }

  if (!Array.isArray(parsed.cases)) {
    throw new Error('parseOutcomesCorpusForPackUpgrade: corpus must contain a "cases" array')
  }

  const cases = []
  const skipped = []

  for (const entry of parsed.cases) {
    const caseId = entry?.id ?? entry?.story_key ?? '<unknown>'

    if (!entry?.parent_sha) {
      skipped.push({ case_id: caseId, reason: 'missing parent_sha' })
      continue
    }
    if (!entry?.story_file_input_path) {
      skipped.push({ case_id: caseId, reason: 'missing story_file_input_path' })
      continue
    }

    cases.push({
      case_id: caseId,
      parent_sha: entry.parent_sha,
      story_key: entry.story_key ?? caseId,
      story_file_input_path: entry.story_file_input_path,
      commit_sha: entry.commit_sha ?? null,
    })
  }

  return { cases, skipped }
}

// ---------------------------------------------------------------------------
// Pair-outcome classification
// ---------------------------------------------------------------------------

/**
 * Classify the overall outcome of a dispatch pair from two envelopes.
 * Returns 'pair-skipped' when either envelope is null/undefined.
 *
 * @param {object|null} envelopeA — pack-current envelope (AC4 shape)
 * @param {object|null} envelopeB — pack-candidate envelope (AC4 shape)
 * @returns {'both-completed'|'one-completed'|'neither-completed'|'pair-skipped'}
 */
export function classifyPairOutcome(envelopeA, envelopeB) {
  if (!envelopeA || !envelopeB) return 'pair-skipped'
  const aOk = envelopeA.dispatch_outcome === 'completed'
  const bOk = envelopeB.dispatch_outcome === 'completed'
  if (aOk && bOk) return 'both-completed'
  if (aOk || bOk) return 'one-completed'
  return 'neither-completed'
}

// ---------------------------------------------------------------------------
// Envelope normalization
// ---------------------------------------------------------------------------

/**
 * Shape a raw dispatcher result into the AC4 envelope.
 * Pure: constructs the envelope from its inputs without any I/O.
 *
 * @param {object|null} rawResult — from deps.dispatch(), or null on pre-dispatch error
 * @param {'current'|'candidate'} packIdentifier — which pack this side ran
 * @param {string} packPath — absolute path to the pack directory
 * @param {object} [opts={}]
 * @param {number}       [opts.costUsd=0]              — measured dispatch cost in USD
 * @param {any}          [opts.diff=null]               — unified-diff or array of file changes
 * @param {string|null}  [opts.errorDetail=null]        — error message for pre-dispatch failure
 * @param {number}       [opts.durationMs=0]            — elapsed ms (used when rawResult.durationMs absent)
 * @param {boolean}      [opts.budgetExceeded=false]    — override dispatch_outcome to 'budget-exceeded'
 * @returns {object} AC4 envelope
 */
export function normalizeDispatchEnvelope(rawResult, packIdentifier, packPath, opts = {}) {
  const {
    costUsd = 0,
    diff = null,
    errorDetail = null,
    durationMs = 0,
    budgetExceeded = false,
  } = opts

  // Determine dispatch_outcome
  let dispatch_outcome
  if (errorDetail !== null) {
    dispatch_outcome = 'error'
  } else if (budgetExceeded) {
    dispatch_outcome = 'budget-exceeded'
  } else if (!rawResult) {
    dispatch_outcome = 'error'
  } else {
    switch (rawResult.status) {
      case 'completed':
        dispatch_outcome = 'completed'
        break
      case 'escalated':
        dispatch_outcome = 'escalated'
        break
      case 'failed':
      case 'timeout':
        dispatch_outcome = 'failed'
        break
      default:
        dispatch_outcome = 'error'
        break
    }
  }

  const tokenEstimate = rawResult?.tokenEstimate ?? null
  const total_tokens = tokenEstimate
    ? { input: tokenEstimate.input ?? 0, output: tokenEstimate.output ?? 0 }
    : null

  const actualDurationMs = rawResult?.durationMs ?? durationMs

  return {
    pack: packIdentifier,
    pack_path: packPath,
    dispatch_outcome,
    diff: diff ?? rawResult?.diff ?? null,
    total_turns: rawResult?.totalTurns ?? rawResult?.total_turns ?? null,
    total_tokens,
    verdict: rawResult?.verdict ?? rawResult?.parsed?.verdict ?? null,
    recovery_history: rawResult?.recoveryHistory ?? rawResult?.recovery_history ?? [],
    escalation_reason: rawResult?.escalationReason ?? rawResult?.escalation_reason ?? null,
    duration_seconds: actualDurationMs / 1000,
    cost_usd: costUsd,
    error_detail: errorDetail,
  }
}

// ---------------------------------------------------------------------------
// Pack override
// ---------------------------------------------------------------------------

/**
 * Construct the pack-loader config object for a given pack path.
 * Used by the dispatch wrapper to pass the pack override to createPackLoader
 * without mutating packs/bmad/ in-place (see AC3 dev notes).
 *
 * @param {string} packPath — absolute path to the pack directory
 * @returns {{ packPath: string }}
 */
export function buildPackOverride(packPath) {
  return { packPath }
}
