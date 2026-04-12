/**
 * `substrate eval` command
 *
 * Evaluates pipeline output quality using LLM-as-judge assertions.
 *
 * Usage:
 *   substrate eval                              Evaluate latest run (standard)
 *   substrate eval --depth deep                 Deep evaluation with rubrics
 *   substrate eval --phase analysis,planning    Limit to specific phases
 *   substrate eval --run-id <id>                Evaluate specific run
 *   substrate eval --report json                JSON output
 */

import type { Command } from 'commander'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'path'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import yaml from 'js-yaml'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  getLatestRun,
  getPipelineRunById,
  getDecisionsByPhaseForRun,
} from '../../persistence/queries/decisions.js'
import { getRawOutputsByPhaseForRun } from '../../persistence/queries/phase-outputs.js'
import { writeEvalResult, getLatestEvalForRun } from '../../persistence/queries/eval-results.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createLogger } from '../../utils/logger.js'
import { EvalEngine, PromptfooAdapter, EvalReporter, EvalComparer } from '../../modules/eval/index.js'
import type { EvalDepth, EvalPhase, ReportFormat, PhaseData, Rubric, EvalMetadata, ThresholdConfig, EvalReport } from '../../modules/eval/index.js'
import { loadStorySpecsForRun } from '../../modules/eval/story-spec-loader.js'

const logger = createLogger('eval-cmd')

/** Maps eval phase names to prompt template keys in the methodology pack */
const PHASE_TO_PROMPT_KEY: Record<EvalPhase, string> = {
  analysis: 'analysis',
  planning: 'planning',
  solutioning: 'architecture',
  implementation: 'dev-story',
}

/**
 * Load the prompt template for a phase, throwing a clear diagnostic error
 * if the pack cannot resolve it (G7 — make degraded runs loud).
 *
 * The pre-G7 code path caught the error, logged a warning, and continued
 * with an empty template. PromptComplianceLayer would then run against
 * nothing and produce a meaningless score, polluting the aggregate phase
 * score with no visible marker that something was wrong.
 *
 * Now we refuse to proceed. The outer try/catch in runEvalAction surfaces
 * the thrown message on stderr and returns exit 1, so the user sees the
 * failure immediately and knows which pack file to fix (or which phase to
 * exclude via --phase).
 *
 * @param pack - Anything with a getPrompt(taskType) method; keeps this
 *               helper trivially mockable in unit tests.
 * @param phase - eval phase name; mapped to a pack task type via
 *                PHASE_TO_PROMPT_KEY.
 * @throws Error with a message naming the phase, the task type key, and
 *         the underlying pack error, so the user can act on it without
 *         re-running.
 */
export async function loadPromptTemplateStrict(
  pack: { getPrompt(taskType: string): Promise<string> },
  phase: EvalPhase,
): Promise<string> {
  const taskType = PHASE_TO_PROMPT_KEY[phase]
  try {
    return await pack.getPrompt(taskType)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Prompt template for phase '${phase}' (pack task type '${taskType}') ` +
        `could not be loaded: ${cause}. ` +
        `Eval cannot proceed without a prompt template — prompt-compliance ` +
        `would otherwise score against an empty string and silently pollute ` +
        `the phase score. Fix: ensure the methodology pack defines a prompt ` +
        `for '${taskType}', or re-run with --phase to exclude '${phase}'.`,
    )
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const EVAL_PHASES: EvalPhase[] = ['analysis', 'planning', 'solutioning', 'implementation']

export interface EvalCommandOptions {
  depth: EvalDepth
  phases: EvalPhase[]
  runId?: string
  concept?: string
  report: ReportFormat
  projectRoot: string
  /** When true, persist results to promptfoo's cache for `npx promptfoo view`. */
  promptfooUi?: boolean
}

/**
 * Resolve the fixtures directory. In dev (src/), fixtures live in
 * src/modules/eval/fixtures. In a built package (dist/), they should
 * live at dist/modules/eval/fixtures (see postbuild script).
 */
function resolveFixturesDir(): string {
  // Try compiled dist path first (most common at runtime)
  const distPath = join(__dirname, '..', '..', 'modules', 'eval', 'fixtures')
  if (existsSync(distPath)) return distPath

  // Fall back to source path (for running under tsx/vitest/dev mode)
  const srcPath = join(__dirname, '..', '..', '..', 'modules', 'eval', 'fixtures')
  if (existsSync(srcPath)) return srcPath

  // Last resort: fixtures not found — caller will gracefully degrade
  return distPath
}

/**
 * Extract the short git SHA from HEAD. Returns undefined in environments
 * without git (e.g., some CI containers or installed packages).
 */
export function getGitSha(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return undefined
  }
}

/**
 * Hash the content of each rubric YAML file used during evaluation.
 * Keyed by phase name. Only includes phases that have rubric files.
 */
export async function hashRubricFiles(
  fixturesDir: string,
  phases: EvalPhase[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const phase of phases) {
    try {
      const content = await readFile(join(fixturesDir, 'rubrics', `${phase}.yaml`), 'utf-8')
      hashes[phase] = createHash('sha256').update(content).digest('hex')
    } catch {
      // Rubric file doesn't exist for this phase — skip
    }
  }
  return hashes
}

/**
 * Collect versioning metadata for the eval report (V1b-1).
 * Metadata enables meaningful comparison between eval runs by recording
 * the conditions that produced the scores.
 */
export async function collectEvalMetadata(
  fixturesDir: string,
  phases: EvalPhase[],
): Promise<EvalMetadata> {
  const [gitSha, rubricHashes] = await Promise.all([
    Promise.resolve(getGitSha()),
    hashRubricFiles(fixturesDir, phases),
  ])

  return {
    schemaVersion: '1b',
    gitSha,
    rubricHashes: Object.keys(rubricHashes).length > 0 ? rubricHashes : undefined,
  }
}

/**
 * Load per-phase threshold config from fixtures/thresholds.yaml (V1b-3).
 * Returns undefined if the file does not exist — caller falls back to
 * DEFAULT_PASS_THRESHOLD for all phases.
 */
export async function loadThresholds(fixturesDir: string): Promise<ThresholdConfig | undefined> {
  try {
    const content = await readFile(join(fixturesDir, 'thresholds.yaml'), 'utf-8')
    return yaml.load(content) as ThresholdConfig
  } catch {
    return undefined
  }
}

async function loadRubric(fixturesDir: string, phase: string): Promise<Rubric | undefined> {
  try {
    const content = await readFile(join(fixturesDir, 'rubrics', `${phase}.yaml`), 'utf-8')
    return yaml.load(content) as Rubric
  } catch {
    return undefined
  }
}

async function loadGoldenExample(fixturesDir: string, concept: string, phase: string): Promise<string | undefined> {
  try {
    return await readFile(join(fixturesDir, 'golden', concept, `${phase}.yaml`), 'utf-8')
  } catch {
    return undefined
  }
}

export async function runEvalAction(options: EvalCommandOptions): Promise<number> {
  const { depth, phases, runId, concept, report, projectRoot } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    process.stderr.write('Error: No pipeline database found. Run a pipeline first.\n')
    return 1
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
  try {
    await initSchema(adapter)

    // Resolve run
    const run = runId
      ? await getPipelineRunById(adapter, runId)
      : await getLatestRun(adapter)

    if (!run) {
      process.stderr.write('Error: No pipeline run found.\n')
      return 1
    }

    // Load methodology pack
    const packLoader = createPackLoader()
    const packs = await packLoader.discover(dbRoot)
    if (packs.length === 0) {
      process.stderr.write('Error: No methodology pack found in packs/.\n')
      return 1
    }
    const pack = await packLoader.load(packs[0].path)

    // Build phase data from decisions
    const phaseDataList: PhaseData[] = []
    const phasesUsingRaw: EvalPhase[] = []
    const phasesUsingFallback: EvalPhase[] = []
    for (const phase of phases) {
      const decisions = await getDecisionsByPhaseForRun(adapter, run.id, phase)
      if (decisions.length === 0) continue

      // Prefer raw LLM output captured at dispatch time (deferred-work G2).
      // Falls back to the legacy key:value synthesis for runs predating
      // phase_outputs capture — see docs/eval-system.md for the rationale.
      // Separator uses an HTML comment (not `---`, which collides with LLM-
      // produced markdown horizontal rules and YAML front-matter delimiters).
      const rawOutputs = await getRawOutputsByPhaseForRun(adapter, run.id, phase)
      let output: string
      if (rawOutputs.length > 0) {
        output = rawOutputs.map((r) => r.raw_output).join('\n\n<!-- step-boundary -->\n\n')
        phasesUsingRaw.push(phase)
      } else {
        output = decisions.map((d) => `${d.key}: ${d.value}`).join('\n')
        phasesUsingFallback.push(phase)
      }

      // Load prompt template — hard failure on missing template (G7).
      // See loadPromptTemplateStrict for the rationale: running the
      // prompt-compliance layer against an empty template produces a
      // meaningless score and silently pollutes the phase aggregate.
      // The thrown error bubbles to the outer try/catch, which surfaces
      // it on stderr and returns exit 1.
      const promptTemplate = await loadPromptTemplateStrict(pack, phase)

      // Build context from upstream decisions
      const context: Record<string, string> = {}
      const phaseIdx = EVAL_PHASES.indexOf(phase)
      if (phaseIdx > 0) {
        const upstreamPhase = EVAL_PHASES[phaseIdx - 1]
        const upstreamDecisions = await getDecisionsByPhaseForRun(
          adapter,
          run.id,
          upstreamPhase,
        )
        for (const d of upstreamDecisions) {
          context[d.key] = d.value
        }
      }

      const phaseData: PhaseData = {
        phase,
        output,
        promptTemplate,
        context,
      }

      // For the implementation phase, load story specs (files + acceptance
      // criteria) from on-disk story files for every story that ran in this
      // run. ImplVerifier uses these for deterministic checks (file
      // existence, compile, AC rubric). Empty result simply skips the layer.
      // Closes deferred-work G4 — see _bmad-output/implementation-artifacts/deferred-work.md.
      if (phase === 'implementation') {
        try {
          const storySpec = await loadStorySpecsForRun(adapter, run.id, dbRoot)
          if (storySpec.files.length > 0 || storySpec.acceptanceCriteria.length > 0) {
            phaseData.storySpec = storySpec
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Failed to load story specs for implementation phase — impl-verifier layer will be skipped',
          )
        }
      }

      phaseDataList.push(phaseData)
    }

    if (phaseDataList.length === 0) {
      process.stderr.write('Error: No phase data found for evaluation.\n')
      return 1
    }

    // Warn on mixed coverage — a run with some phases captured (raw) and others
    // falling back to decision synthesis means the judge is comparing
    // structurally different artifacts across phases. Cross-phase scores
    // should be interpreted with care.
    if (phasesUsingRaw.length > 0 && phasesUsingFallback.length > 0) {
      logger.warn(
        {
          rawPhases: phasesUsingRaw,
          fallbackPhases: phasesUsingFallback,
        },
        'Mixed raw/fallback coverage — this run has captured raw output for some phases but not others; cross-phase scores may compare structurally different artifacts',
      )
    }

    // Resolve fixtures directory (co-located with the eval module)
    const fixturesDir = resolveFixturesDir()

    if (depth === 'deep' && !existsSync(fixturesDir)) {
      process.stderr.write(
        `Warning: Deep tier fixtures not found at ${fixturesDir}. Running without golden examples or rubrics.\n`,
      )
    }

    // Wire upstream output for cross-phase coherence (V1b-4: both tiers)
    for (let i = 1; i < phaseDataList.length; i++) {
      phaseDataList[i].upstreamOutput = phaseDataList[i - 1].output
      phaseDataList[i].upstreamPhase = phaseDataList[i - 1].phase
    }

    // Enrich with deep tier data
    if (depth === 'deep') {
      for (const pd of phaseDataList) {
        // Load rubric
        pd.rubric = await loadRubric(fixturesDir, pd.phase)

        // Load golden example (when --concept is specified)
        if (concept) {
          pd.goldenExample = await loadGoldenExample(fixturesDir, concept, pd.phase)
        }
      }
    }

    // Load per-phase thresholds (V1b-3) — falls back to DEFAULT_PASS_THRESHOLD
    const thresholds = await loadThresholds(fixturesDir)

    // Run eval
    const evalAdapter = new PromptfooAdapter({
      persistToUi: options.promptfooUi ?? false,
    })
    const engine = new EvalEngine(evalAdapter)
    const evalReport = await engine.evaluate(phaseDataList, depth, run.id, thresholds)

    // Attach versioning metadata (V1b-1) so eval runs can be compared
    // meaningfully — different git SHAs, rubric hashes, or judge models
    // mean scores are not directly comparable.
    evalReport.metadata = await collectEvalMetadata(fixturesDir, phases)

    // Output report
    const reporter = new EvalReporter()
    process.stdout.write(reporter.format(evalReport, report, { thresholds }) + '\n')

    // Save results to .substrate/evals/ (JSON file — backward compat)
    const evalsDir = join(dbRoot, '.substrate', 'evals')
    await mkdir(evalsDir, { recursive: true })
    await writeFile(
      join(evalsDir, `${run.id}.json`),
      JSON.stringify(evalReport, null, 2),
    )

    // Persist to eval_results table (V1b-2) — alongside JSON for queryable history
    try {
      await writeEvalResult(adapter, {
        run_id: run.id,
        eval_id: crypto.randomUUID(),
        depth,
        timestamp: evalReport.timestamp,
        overall_score: evalReport.overallScore,
        pass: evalReport.pass,
        phases_json: JSON.stringify(evalReport.phases),
        metadata_json: evalReport.metadata ? JSON.stringify(evalReport.metadata) : null,
      })
    } catch (err) {
      // DB persistence is best-effort — JSON file is the primary record.
      // Don't fail the eval because the DB write failed.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to persist eval result to database — JSON file was written successfully',
      )
    }

    return evalReport.pass ? 0 : 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${msg}\n`)
    logger.error({ err }, 'eval action failed')
    return 1
  } finally {
    try {
      await adapter.close()
    } catch { /* ignore */ }
  }
}

/**
 * Load an EvalReport for a run — tries DB first, falls back to JSON file (V1b-5).
 */
async function loadReportForRun(
  adapter: { query: (sql: string, params: unknown[]) => Promise<unknown[]>; close: () => Promise<void> },
  runId: string,
  evalsDir: string,
): Promise<EvalReport | undefined> {
  // Try DB first
  const dbRow = await getLatestEvalForRun(adapter as Parameters<typeof getLatestEvalForRun>[0], runId)
  if (dbRow) {
    return {
      runId: dbRow.run_id,
      depth: dbRow.depth as EvalReport['depth'],
      timestamp: dbRow.timestamp,
      phases: JSON.parse(dbRow.phases_json),
      overallScore: dbRow.overall_score,
      pass: dbRow.pass as boolean,
      metadata: dbRow.metadata_json ? JSON.parse(dbRow.metadata_json) : undefined,
    }
  }

  // Fall back to JSON file
  try {
    const content = await readFile(join(evalsDir, `${runId}.json`), 'utf-8')
    return JSON.parse(content) as EvalReport
  } catch {
    return undefined
  }
}

export interface CompareCommandOptions {
  runs: string
  report: ReportFormat
  projectRoot: string
}

export async function runCompareAction(options: CompareCommandOptions): Promise<number> {
  const { runs, report, projectRoot } = options

  const parts = runs.split(',')
  if (parts.length !== 2) {
    process.stderr.write('Error: --compare requires exactly two comma-separated run IDs.\n')
    return 1
  }
  const [runIdA, runIdB] = parts

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    process.stderr.write('Error: No pipeline database found. Run a pipeline first.\n')
    return 1
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
  try {
    await initSchema(adapter)
    const evalsDir = join(dbRoot, '.substrate', 'evals')

    const [reportA, reportB] = await Promise.all([
      loadReportForRun(adapter, runIdA, evalsDir),
      loadReportForRun(adapter, runIdB, evalsDir),
    ])

    if (!reportA && !reportB) {
      process.stderr.write(`Error: No eval results found for either run (${runIdA}, ${runIdB}).\n`)
      return 1
    }
    if (!reportA) {
      process.stderr.write(`Error: No eval results found for run ${runIdA}.\n`)
      return 1
    }
    if (!reportB) {
      process.stderr.write(`Error: No eval results found for run ${runIdB}.\n`)
      return 1
    }

    // Load thresholds for regression delta
    const fixturesDir = resolveFixturesDir()
    const thresholds = await loadThresholds(fixturesDir)

    const comparer = new EvalComparer()
    const compareReport = comparer.compare(reportA, reportB, thresholds)

    const reporter = new EvalReporter()
    process.stdout.write(reporter.formatComparison(compareReport, report) + '\n')

    return compareReport.hasRegression ? 1 : 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${msg}\n`)
    logger.error({ err }, 'eval compare action failed')
    return 1
  } finally {
    try {
      await adapter.close()
    } catch { /* ignore */ }
  }
}

export function registerEvalCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('eval')
    .description('Evaluate pipeline output quality using LLM-as-judge')
    .option('--depth <depth>', 'Eval depth: standard or deep', 'standard')
    .option('--phase <phases>', 'Comma-separated phases to evaluate')
    .option('--run-id <id>', 'Pipeline run ID (defaults to latest)')
    .option('--concept <name>', 'Canonical test concept for golden example comparison')
    .option('--report <format>', 'Output format: table, json, or markdown', 'table')
    .option('--compare <runs>', 'Compare two runs: --compare <runA>,<runB>')
    .option('--promptfoo-ui', 'Persist results to promptfoo cache for `npx promptfoo view`')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .action(
      async (opts: {
        depth: string
        phase?: string
        runId?: string
        concept?: string
        report: string
        compare?: string
        promptfooUi?: boolean
        projectRoot: string
      }) => {
        const reportFmt: ReportFormat =
          opts.report === 'json'
            ? 'json'
            : opts.report === 'markdown'
              ? 'markdown'
              : 'table'

        // --compare is a separate code path — reads existing reports, no new eval
        if (opts.compare) {
          const exitCode = await runCompareAction({
            runs: opts.compare,
            report: reportFmt,
            projectRoot: opts.projectRoot,
          })
          process.exitCode = exitCode
          return
        }

        const depth: EvalDepth = opts.depth === 'deep' ? 'deep' : 'standard'
        const phases: EvalPhase[] = opts.phase
          ? (opts.phase.split(',') as EvalPhase[])
          : EVAL_PHASES

        const exitCode = await runEvalAction({
          depth,
          phases,
          runId: opts.runId,
          concept: opts.concept,
          report: reportFmt,
          projectRoot: opts.projectRoot,
          promptfooUi: opts.promptfooUi,
        })
        process.exitCode = exitCode
      },
    )
}
