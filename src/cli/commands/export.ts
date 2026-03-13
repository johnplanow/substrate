/**
 * `substrate export` command
 *
 * Exports decision store contents as human-readable markdown files so
 * planning artifacts can be shared with colleagues without database access.
 *
 * Usage:
 *   substrate export                              Export latest run to default dir
 *   substrate export --run-id <id>               Export specific run
 *   substrate export --output-dir ./artifacts    Write to custom directory
 *   substrate export --output-format json        Emit JSON result to stdout
 *
 * Output files (written to --output-dir, default _bmad-output/planning-artifacts/):
 *   product-brief.md     — analysis phase product brief
 *   prd.md               — planning phase PRD
 *   architecture.md      — solutioning phase architecture decisions
 *   epics.md             — solutioning phase epics and stories
 *   readiness-report.md  — solutioning phase readiness findings
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import type { Command } from 'commander'
import { join, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  getLatestRun,
  getPipelineRunById,
  getDecisionsByPhaseForRun,
  getDecisionsByCategory,
  listRequirements,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import {
  renderProductBrief,
  renderPrd,
  renderArchitecture,
  renderEpics,
  renderReadinessReport,
  renderOperationalFindings,
  renderExperiments,
} from '../../modules/export/renderers.js'
import { OPERATIONAL_FINDING, EXPERIMENT_RESULT } from '../../persistence/schemas/operational.js'

const logger = createLogger('export-cmd')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputFormat = 'human' | 'json'

export interface ExportOptions {
  /** Pipeline run ID to export; defaults to latest run */
  runId?: string
  /** Directory to write exported files to */
  outputDir: string
  /** Project root directory */
  projectRoot: string
  /** Output format for the command result */
  outputFormat: OutputFormat
}

export interface ExportResult {
  /** Paths of all files written */
  files_written: string[]
  /** The pipeline run that was exported */
  run_id: string
  /** Which phases had data and were exported */
  phases_exported: string[]
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Execute the export action.
 * Returns an exit code (0 = success, 1 = error).
 */
export async function runExportAction(options: ExportOptions): Promise<number> {
  const { runId, outputDir, projectRoot, outputFormat } = options

  let adapter: import('../../persistence/adapter.js').DatabaseAdapter | undefined

  try {
    // Resolve the database path (inside try/catch so errors are handled uniformly)
    const dbRoot = await resolveMainRepoRoot(projectRoot)
    const dbPath = join(dbRoot, '.substrate', 'substrate.db')
    const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')

    if (!existsSync(dbPath) && !existsSync(doltDir)) {
      const errorMsg = `Decision store not initialized. Run 'substrate init' first.`
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify({ error: errorMsg }) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
    await initSchema(adapter)

    // Find the pipeline run to export
    let run: PipelineRun | undefined
    if (runId !== undefined && runId !== '') {
      run = await getPipelineRunById(adapter, runId)
    } else {
      run = await getLatestRun(adapter)
    }

    if (run === undefined) {
      const errorMsg =
        runId !== undefined
          ? `Pipeline run '${runId}' not found.`
          : 'No pipeline runs found. Run `substrate run` first.'
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify({ error: errorMsg }) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const activeRunId = run.id

    // Ensure output directory exists — support both absolute and relative --output-dir
    const resolvedOutputDir = isAbsolute(outputDir)
      ? outputDir
      : join(projectRoot, outputDir)
    if (!existsSync(resolvedOutputDir)) {
      mkdirSync(resolvedOutputDir, { recursive: true })
    }

    const filesWritten: string[] = []
    const phasesExported: string[] = []

    // -------------------------------------------------------------------------
    // Export product-brief.md (AC2)
    // -------------------------------------------------------------------------
    const analysisDecisions = await getDecisionsByPhaseForRun(adapter, activeRunId, 'analysis')
    if (analysisDecisions.length > 0) {
      const content = renderProductBrief(analysisDecisions)
      if (content !== '') {
        const filePath = join(resolvedOutputDir, 'product-brief.md')
        writeFileSync(filePath, content, 'utf-8')
        filesWritten.push(filePath)
        phasesExported.push('analysis')
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }
    }

    // -------------------------------------------------------------------------
    // Export prd.md (AC3)
    // -------------------------------------------------------------------------
    const planningDecisions = await getDecisionsByPhaseForRun(adapter, activeRunId, 'planning')
    if (planningDecisions.length > 0) {
      // Also fetch requirements from the requirements table for this run
      const requirements = (await listRequirements(adapter)).filter(
        (r) => r.pipeline_run_id === activeRunId,
      )
      const content = renderPrd(planningDecisions, requirements)
      if (content !== '') {
        const filePath = join(resolvedOutputDir, 'prd.md')
        writeFileSync(filePath, content, 'utf-8')
        filesWritten.push(filePath)
        if (!phasesExported.includes('planning')) {
          phasesExported.push('planning')
        }
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }
    }

    // -------------------------------------------------------------------------
    // Export architecture.md (AC4)
    // -------------------------------------------------------------------------
    const solutioningDecisions = await getDecisionsByPhaseForRun(adapter, activeRunId, 'solutioning')
    if (solutioningDecisions.length > 0) {
      const archContent = renderArchitecture(solutioningDecisions)
      if (archContent !== '') {
        const filePath = join(resolvedOutputDir, 'architecture.md')
        writeFileSync(filePath, archContent, 'utf-8')
        filesWritten.push(filePath)
        if (!phasesExported.includes('solutioning')) {
          phasesExported.push('solutioning')
        }
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }

      // -----------------------------------------------------------------------
      // Export epics.md (AC5)
      // -----------------------------------------------------------------------
      const epicsContent = renderEpics(solutioningDecisions)
      if (epicsContent !== '') {
        const filePath = join(resolvedOutputDir, 'epics.md')
        writeFileSync(filePath, epicsContent, 'utf-8')
        filesWritten.push(filePath)
        if (!phasesExported.includes('solutioning')) {
          phasesExported.push('solutioning')
        }
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }

      // -----------------------------------------------------------------------
      // Export readiness-report.md (AC6)
      // -----------------------------------------------------------------------
      const readinessContent = renderReadinessReport(solutioningDecisions)
      if (readinessContent !== '') {
        const filePath = join(resolvedOutputDir, 'readiness-report.md')
        writeFileSync(filePath, readinessContent, 'utf-8')
        filesWritten.push(filePath)
        if (!phasesExported.includes('solutioning')) {
          phasesExported.push('solutioning')
        }
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }
    }

    // -------------------------------------------------------------------------
    // Export operational-findings.md (Story 21-1 AC5)
    // -------------------------------------------------------------------------
    const operationalDecisions = await getDecisionsByCategory(adapter, OPERATIONAL_FINDING)
    if (operationalDecisions.length > 0) {
      const operationalContent = renderOperationalFindings(operationalDecisions)
      if (operationalContent !== '') {
        const filePath = join(resolvedOutputDir, 'operational-findings.md')
        writeFileSync(filePath, operationalContent, 'utf-8')
        filesWritten.push(filePath)
        if (!phasesExported.includes('operational')) {
          phasesExported.push('operational')
        }
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }
    }

    // -------------------------------------------------------------------------
    // Export experiments.md (Story 21-1 AC5)
    // -------------------------------------------------------------------------
    const experimentDecisions = await getDecisionsByCategory(adapter, EXPERIMENT_RESULT)
    if (experimentDecisions.length > 0) {
      const experimentsContent = renderExperiments(experimentDecisions)
      if (experimentsContent !== '') {
        const filePath = join(resolvedOutputDir, 'experiments.md')
        writeFileSync(filePath, experimentsContent, 'utf-8')
        filesWritten.push(filePath)
        if (!phasesExported.includes('operational')) {
          phasesExported.push('operational')
        }
        if (outputFormat === 'human') {
          process.stdout.write(`  Written: ${filePath}\n`)
        }
      }
    }

    // Report results (AC7: --output-format json emits JSON to stdout)
    if (outputFormat === 'json') {
      const result: ExportResult = {
        files_written: filesWritten,
        run_id: activeRunId,
        phases_exported: phasesExported,
      }
      process.stdout.write(JSON.stringify(result) + '\n')
    } else {
      if (filesWritten.length === 0) {
        process.stdout.write(
          `No data found for run ${activeRunId}. The pipeline may not have completed any phases.\n`,
        )
      } else {
        process.stdout.write(
          `\nExported ${filesWritten.length} file(s) from run ${activeRunId}.\n`,
        )
      }

      const skippedPhases: string[] = []
      if (!phasesExported.includes('analysis')) skippedPhases.push('analysis')
      if (!phasesExported.includes('planning')) skippedPhases.push('planning')
      if (!phasesExported.includes('solutioning')) skippedPhases.push('solutioning')

      if (skippedPhases.length > 0) {
        process.stdout.write(
          `Phases with no data (skipped): ${skippedPhases.join(', ')}\n`,
        )
      }
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ error: msg }) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'export action failed')
    return 1
  } finally {
    if (adapter !== undefined) {
      try {
        await adapter.close()
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// registerExportCommand
// ---------------------------------------------------------------------------

export function registerExportCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('export')
    .description('Export decision store contents as human-readable markdown files')
    .option('--run-id <id>', 'Pipeline run ID to export (defaults to latest run)')
    .option(
      '--output-dir <path>',
      'Directory to write exported files to',
      '_bmad-output/planning-artifacts/',
    )
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(
      async (opts: {
        runId?: string
        outputDir: string
        projectRoot: string
        outputFormat: string
      }) => {
        if (opts.outputFormat !== 'json' && opts.outputFormat !== 'human') {
          process.stderr.write(
            `Warning: unknown --output-format '${opts.outputFormat}', defaulting to 'human'\n`,
          )
        }
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runExportAction({
          runId: opts.runId,
          outputDir: opts.outputDir,
          projectRoot: opts.projectRoot,
          outputFormat,
        })
        process.exitCode = exitCode
      },
    )
}
