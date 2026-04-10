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
import { join } from 'path'
import { existsSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  getLatestRun,
  getPipelineRunById,
  getDecisionsByPhaseForRun,
} from '../../persistence/queries/decisions.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createLogger } from '../../utils/logger.js'
import { EvalEngine, PromptfooAdapter, EvalReporter } from '../../modules/eval/index.js'
import type { EvalDepth, EvalPhase, ReportFormat, PhaseData } from '../../modules/eval/index.js'

const logger = createLogger('eval-cmd')

const EVAL_PHASES: EvalPhase[] = ['analysis', 'planning', 'solutioning', 'implementation']

export interface EvalCommandOptions {
  depth: EvalDepth
  phases: EvalPhase[]
  runId?: string
  report: ReportFormat
  projectRoot: string
}

export async function runEvalAction(options: EvalCommandOptions): Promise<number> {
  const { depth, phases, runId, report, projectRoot } = options

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
    for (const phase of phases) {
      const decisions = await getDecisionsByPhaseForRun(adapter, run.id, phase)
      if (decisions.length === 0) continue

      // Reconstruct output from decisions
      const output = decisions.map((d) => `${d.key}: ${d.value}`).join('\n')

      // Load prompt template
      let promptTemplate = ''
      try {
        const taskType = phase === 'implementation' ? 'dev-story' : phase
        promptTemplate = await pack.getPrompt(taskType)
      } catch {
        logger.debug({ phase }, 'No prompt template found for phase')
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
    .option('--report <format>', 'Output format: table, json, or markdown', 'table')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .action(
      async (opts: {
        depth: string
        phase?: string
        runId?: string
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
          report: reportFmt,
          projectRoot: opts.projectRoot,
        })
        process.exitCode = exitCode
      },
    )
}
