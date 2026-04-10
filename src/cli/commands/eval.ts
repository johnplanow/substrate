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
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createLogger } from '../../utils/logger.js'
import { EvalEngine, PromptfooAdapter, EvalReporter } from '../../modules/eval/index.js'
import type { EvalDepth, EvalPhase, ReportFormat, PhaseData, Rubric } from '../../modules/eval/index.js'

const logger = createLogger('eval-cmd')

/** Maps eval phase names to prompt template keys in the methodology pack */
const PHASE_TO_PROMPT_KEY: Record<EvalPhase, string> = {
  analysis: 'analysis',
  planning: 'planning',
  solutioning: 'architecture',
  implementation: 'dev-story',
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

      // Load prompt template
      let promptTemplate = ''
      const taskType = PHASE_TO_PROMPT_KEY[phase]
      try {
        promptTemplate = await pack.getPrompt(taskType)
      } catch (err) {
        logger.warn(
          { phase, taskType, err: err instanceof Error ? err.message : String(err) },
          'Could not load prompt template — prompt-compliance layer will be skipped for this phase',
        )
      }

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

      phaseDataList.push({
        phase,
        output,
        promptTemplate,
        context,
      })
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

    // Enrich with deep tier data
    if (depth === 'deep') {
      for (let i = 0; i < phaseDataList.length; i++) {
        const pd = phaseDataList[i]

        // Load rubric
        pd.rubric = await loadRubric(fixturesDir, pd.phase)

        // Load golden example (when --concept is specified)
        if (concept) {
          pd.goldenExample = await loadGoldenExample(fixturesDir, concept, pd.phase)
        }

        // Wire upstream output for cross-phase coherence
        if (i > 0) {
          pd.upstreamOutput = phaseDataList[i - 1].output
          pd.upstreamPhase = phaseDataList[i - 1].phase
        }
      }
    }

    // Run eval
    const evalAdapter = new PromptfooAdapter()
    const engine = new EvalEngine(evalAdapter)
    const evalReport = await engine.evaluate(phaseDataList, depth, run.id)

    // Output report
    const reporter = new EvalReporter()
    process.stdout.write(reporter.format(evalReport, report) + '\n')

    // Save results to .substrate/evals/
    const evalsDir = join(dbRoot, '.substrate', 'evals')
    await mkdir(evalsDir, { recursive: true })
    await writeFile(
      join(evalsDir, `${run.id}.json`),
      JSON.stringify(evalReport, null, 2),
    )

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
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .action(
      async (opts: {
        depth: string
        phase?: string
        runId?: string
        concept?: string
        report: string
        projectRoot: string
      }) => {
        const depth: EvalDepth = opts.depth === 'deep' ? 'deep' : 'standard'
        const phases: EvalPhase[] = opts.phase
          ? (opts.phase.split(',') as EvalPhase[])
          : EVAL_PHASES
        const reportFmt: ReportFormat =
          opts.report === 'json'
            ? 'json'
            : opts.report === 'markdown'
              ? 'markdown'
              : 'table'

        const exitCode = await runEvalAction({
          depth,
          phases,
          runId: opts.runId,
          concept: opts.concept,
          report: reportFmt,
          projectRoot: opts.projectRoot,
        })
        process.exitCode = exitCode
      },
    )
}
