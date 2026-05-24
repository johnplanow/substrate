/**
 * OutcomeGraderCheck — VerificationCheck implementation for outcome-replay grading (Story 77-1).
 *
 * Implements the VerificationCheck interface from packages/sdlc/src/verification/types.ts.
 * Promotable to a production gate: the same class works as an every-ship gate
 * (filtered by context.runId) and as a full corpus sweep (no runId).
 *
 * Design principles (77-1 AC1):
 *   - `name = 'outcome-grader'`, `tier = 'A'`
 *   - `run(context)` returns Promise<VerificationResult>
 *   - Constructor accepts optional injected adapter for testing
 *   - Corpus path convention: `_bmad-output/eval-results/corpus/outcomes-corpus.yaml`
 *
 * Return semantics:
 *   - 'pass'  — rubric is GREEN or YELLOW (pass-rate ≥ 0.85)
 *   - 'fail'  — rubric is RED (pass-rate < 0.85)
 *   - 'warn'  — all cases were corpus-errors; no gradable data
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VALID_RESULT_CLASSES,
  parseOutcomesCorpus,
  assertOutcomeCase,
  computeRubric,
  readManifest,
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')

// Default corpus path convention (AC2)
const DEFAULT_CORPUS_PATH = join(
  repoRoot,
  '_bmad-output',
  'eval-results',
  'corpus',
  'outcomes-corpus.yaml',
)

// ---------------------------------------------------------------------------
// OutcomeGraderCheck
// ---------------------------------------------------------------------------

/**
 * VerificationCheck that replays persisted run outcomes against the curated corpus.
 *
 * Implements VerificationCheck interface (duck-typed from packages/sdlc/src/verification/types.ts):
 *   name: string
 *   tier: 'A' | 'B'
 *   run(context: VerificationContext): Promise<VerificationResult>
 *
 * @param {object} [options] - Optional configuration
 * @param {string} [options.corpusPath] - Path to corpus YAML (default: convention path)
 * @param {object} [options.adapter] - Injected database adapter (for testing)
 * @param {string} [options.projectRoot] - Project root for manifest lookup
 * @param {number} [options.threshold] - GREEN rubric threshold (default: 0.95)
 */
export class OutcomeGraderCheck {
  name = 'outcome-grader'
  tier = 'A'

  #corpusPath
  #injectedAdapter
  #projectRoot
  #threshold

  constructor(options = {}) {
    this.#corpusPath = options.corpusPath ?? DEFAULT_CORPUS_PATH
    this.#injectedAdapter = options.adapter ?? null
    this.#projectRoot = options.projectRoot ?? repoRoot
    this.#threshold = options.threshold ?? 0.95
  }

  /**
   * Execute the outcome-grader check.
   *
   * @param {import('../../packages/sdlc/src/verification/types.js').VerificationContext} context
   * @returns {Promise<import('../../packages/sdlc/src/verification/types.js').VerificationResult>}
   */
  async run(context) {
    const startTime = Date.now()

    // Load corpus
    if (!existsSync(this.#corpusPath)) {
      return {
        status: 'warn',
        details: `outcome-grader: corpus not found at ${this.#corpusPath}`,
        duration_ms: Date.now() - startTime,
      }
    }

    let corpusData
    try {
      const raw = readFileSync(this.#corpusPath, 'utf8')
      corpusData = parseOutcomesCorpus(raw)
    } catch (err) {
      return {
        status: 'warn',
        details: `outcome-grader: corpus parse error — ${err.message}`,
        duration_ms: Date.now() - startTime,
      }
    }

    // Get or create adapter
    let adapter = this.#injectedAdapter
    if (!adapter) {
      try {
        const { createDatabaseAdapter } = await import(
          '../../packages/core/dist/persistence/adapter.js'
        )
        const { DoltClient } = await import(
          '../../packages/core/dist/persistence/dolt-client.js'
        )
        const { initSchema } = await import(
          '../../packages/core/dist/persistence/schema.js'
        )
        adapter = createDatabaseAdapter(
          { backend: 'dolt', basePath: this.#projectRoot },
          (rp) => new DoltClient({ repoPath: rp }),
        )
        await initSchema(adapter)
      } catch (err) {
        return {
          status: 'warn',
          details: `outcome-grader: Dolt unavailable — ${err.message}`,
          duration_ms: Date.now() - startTime,
        }
      }
    }

    const { getStoryMetricsForRun } = await this.#loadMetricsQuery()
    if (!getStoryMetricsForRun) {
      return {
        status: 'warn',
        details: 'outcome-grader: failed to load getStoryMetricsForRun',
        duration_ms: Date.now() - startTime,
      }
    }

    // Filter corpus entries by runId if provided (production gate mode)
    const cases = context?.runId
      ? corpusData.cases.filter((c) => c.run_id === context.runId)
      : corpusData.cases

    // Grade each case
    let passed = 0
    let failed = 0
    let corpusErrors = 0
    const perCase = []

    for (const entry of cases) {
      const { id, run_id: runId, story_key: storyKey, expect } = entry

      // Corpus-error: missing required fields
      if (!runId) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: 'missing run_id field',
        })
        continue
      }
      if (!storyKey) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: 'missing story_key field',
        })
        continue
      }
      if (!expect?.result_class) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: 'missing expect.result_class field',
        })
        continue
      }
      if (!VALID_RESULT_CLASSES.has(expect.result_class)) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: `unknown result_class: "${expect.result_class}"`,
        })
        continue
      }

      // Pollution guard (AC8): never enumerate .substrate/runs/
      // Only check the manifest for the explicitly-listed run_id
      const manifest = readManifest(this.#projectRoot, runId)
      if (!manifest) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: `unresolvable run_id: ${runId}`,
        })
        continue
      }
      const runStatus = manifest.run_status ?? manifest.status
      if (runStatus === 'running' || runStatus === 'dispatched') {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: `run_id ${runId} has status "${runStatus}" — must reference completed runs`,
        })
        continue
      }

      // Query story metrics
      let rows
      try {
        rows = await getStoryMetricsForRun(adapter, runId)
      } catch (err) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: `query error: ${err.message ?? err}`,
        })
        continue
      }

      const storyRow = rows.find((r) => r.story_key === storyKey)
      if (!storyRow) {
        corpusErrors++
        perCase.push({
          id,
          runId,
          storyKey,
          status: 'corpus-error',
          reason: `story_key ${storyKey} not found in story_metrics for run ${runId}`,
        })
        continue
      }

      // Assert outcome
      const result = assertOutcomeCase(entry, storyRow)
      if (result.status === 'pass') {
        passed++
      } else {
        failed++
      }
      perCase.push({
        id,
        runId,
        storyKey,
        ...result,
      })
    }

    const totalGraded = passed + failed

    // Warn if all cases were corpus-errors (no gradable data)
    if (totalGraded === 0) {
      return {
        status: 'warn',
        details: `outcome-grader: no gradable cases — ${corpusErrors} corpus-error(s)`,
        duration_ms: Date.now() - startTime,
      }
    }

    const passRate = passed / totalGraded
    const rubric = computeRubric(passed, totalGraded, this.#threshold)

    const details =
      `outcome-grader: ${rubric} — pass_rate=${(passRate * 100).toFixed(1)}% ` +
      `(${passed}/${totalGraded}) corpus_errors=${corpusErrors} threshold=${(this.#threshold * 100).toFixed(0)}%`

    return {
      status: rubric === 'RED' ? 'fail' : 'pass',
      details,
      duration_ms: Date.now() - startTime,
    }
  }

  async #loadMetricsQuery() {
    try {
      const { getStoryMetricsForRun } = await import(
        '../../packages/core/dist/persistence/queries/metrics.js'
      )
      return { getStoryMetricsForRun }
    } catch {
      return { getStoryMetricsForRun: null }
    }
  }
}
