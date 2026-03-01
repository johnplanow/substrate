/**
 * `substrate auto` command group
 *
 * Provides the autonomous implementation pipeline CLI interface:
 *   substrate auto init [--pack bmad] [--project-root .]
 *   substrate auto run [--pack bmad] [--from <phase>] [--concept <text>] [--concept-file <path>]
 *                      [--stories 10-1,10-2] [--concurrency 3] [--output-format json]
 *   substrate auto resume [--run-id <id>] [--output-format json]
 *   substrate auto status [--output-format json] [--run-id <id>]
 *   substrate auto amend [--concept <text>] [--concept-file <path>] [--run-id <id>]
 *                        [--stop-after <phase>] [--from <phase>]
 *
 * Architecture (ADR-001: Modular Monolith):
 *   CLI is a thin wiring layer — all business logic lives in modules.
 *
 * Database (ADR-003: SQLite WAL):
 *   Uses DatabaseWrapper from src/persistence/database.ts for all DB access.
 */

import type { Command } from 'commander'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'path'
import { mkdirSync, existsSync, cpSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { createRequire } from 'node:module'
import { createEventEmitter } from '../../modules/implementation-orchestrator/event-emitter.js'
import { createProgressRenderer } from '../../modules/implementation-orchestrator/progress-renderer.js'
import type { PipelinePhase } from '../../modules/implementation-orchestrator/event-types.js'
import { runHelpAgent } from './help-agent.js'
import { createTuiApp, isTuiCapable, printNonTtyWarning } from '../../tui/index.js'

// ---------------------------------------------------------------------------
// Package root resolution (ESM-compatible)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Find the package root by walking up until we find package.json.
 * Works regardless of build output structure (tsdown bundles into
 * dist/cli/index.js, not dist/cli/commands/auto.js).
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return startDir
}

// Static export for tests (3 levels is correct from src/cli/commands/)
export const PACKAGE_ROOT = join(__dirname, '..', '..', '..')

/**
 * Resolve the absolute path to the bmad-method package's src/ directory.
 * Uses createRequire so it works in ESM without import.meta.resolve polyfills.
 * Returns null if bmad-method is not installed.
 */
export function resolveBmadMethodSrcPath(fromDir: string = __dirname): string | null {
  try {
    const require = createRequire(join(fromDir, 'synthetic.js'))
    const pkgJsonPath = require.resolve('bmad-method/package.json')
    return join(dirname(pkgJsonPath), 'src')
  } catch {
    return null
  }
}

/**
 * Read the version field from bmad-method's package.json.
 * Returns 'unknown' if not resolvable.
 */
export function resolveBmadMethodVersion(fromDir: string = __dirname): string {
  try {
    const require = createRequire(join(fromDir, 'synthetic.js'))
    const pkgJsonPath = require.resolve('bmad-method/package.json')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(pkgJsonPath) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventBus } from '../../core/event-bus.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator, discoverPendingStoryKeys } from '../../modules/implementation-orchestrator/index.js'
import { createPhaseOrchestrator } from '../../modules/phase-orchestrator/index.js'
import { runAnalysisPhase } from '../../modules/phase-orchestrator/phases/analysis.js'
import { runPlanningPhase } from '../../modules/phase-orchestrator/phases/planning.js'
import { runSolutioningPhase } from '../../modules/phase-orchestrator/phases/solutioning.js'
import {
  createPipelineRun,
  createDecision,
  getLatestRun,
  getPipelineRunById,
  getDecisionsByPhaseForRun,
  addTokenUsage,
  getTokenUsageSummary,
  updatePipelineRun,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun, TokenUsageSummary } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import {
  VALID_PHASES,
  createStopAfterGate,
  validateStopAfterFromConflict,
  formatPhaseCompletionSummary,
} from '../../modules/stop-after/index.js'
import type { PhaseName } from '../../modules/stop-after/index.js'
import {
  createAmendmentRun,
  getLatestCompletedRun,
  getActiveDecisions,
  supersedeDecision,
} from '../../persistence/queries/amendments.js'
import { createAmendmentContextHandler } from '../../modules/amendment-handlers/index.js'
import type { AmendmentContextHandler } from '../../modules/amendment-handlers/index.js'
import {
  generateDeltaDocument,
  formatDeltaDocument,
} from '../../modules/delta-document/index.js'

const logger = createLogger('auto-cmd')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BMAD baseline token total for full pipeline comparison (analysis+planning+solutioning+implementation) */
const BMAD_BASELINE_TOKENS_FULL = 56_800

/** BMAD baseline token total for create+dev+review comparison */
const BMAD_BASELINE_TOKENS = 23_800

/** Story key pattern: <epic>-<story> e.g. "10-1" */
const STORY_KEY_PATTERN = /^\d+-\d+$/

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

type OutputFormat = 'human' | 'json'

/**
 * Format output according to the requested format.
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat,
  success = true,
  errorMessage?: string,
): string {
  if (format === 'json') {
    if (!success) {
      return JSON.stringify({ success: false, error: errorMessage ?? 'Unknown error' })
    }
    return JSON.stringify({ success: true, data })
  }
  // Human format: return data as-is if string, otherwise pretty-print
  if (typeof data === 'string') return data
  return JSON.stringify(data, null, 2)
}

/**
 * Build a human-readable token telemetry display from summary rows.
 */
export function formatTokenTelemetry(summary: TokenUsageSummary[], baselineTokens = BMAD_BASELINE_TOKENS): string {
  if (summary.length === 0) {
    return 'No token usage recorded.'
  }

  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0

  const lines: string[] = ['Pipeline Token Usage:']
  for (const row of summary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
    const cost = `$${row.total_cost_usd.toFixed(4)}`
    lines.push(
      `  ${row.phase} (${row.agent}): ${row.total_input_tokens.toLocaleString()} input / ${row.total_output_tokens.toLocaleString()} output (${cost})`,
    )
  }
  lines.push('  ' + '─'.repeat(55))

  const costDisplay = `$${totalCost.toFixed(4)}`
  lines.push(
    `  Total:  ${totalInput.toLocaleString()} input / ${totalOutput.toLocaleString()} output (${costDisplay})`,
  )

  const totalTokens = totalInput + totalOutput
  const savingsPct =
    baselineTokens > 0
      ? Math.round(((baselineTokens - totalTokens) / baselineTokens) * 100)
      : 0
  const savingsLabel =
    savingsPct >= 0
      ? `Savings: ${savingsPct}%`
      : `Overhead: +${Math.abs(savingsPct)}%`
  lines.push(
    `  BMAD Baseline: ${baselineTokens.toLocaleString()} tokens → ${savingsLabel}`,
  )

  return lines.join('\n')
}

/**
 * Validate a story key has the expected format: <epic>-<story> (e.g., "10-1").
 */
export function validateStoryKey(key: string): boolean {
  return STORY_KEY_PATTERN.test(key)
}

// ---------------------------------------------------------------------------
// Phase-level status formatting
// ---------------------------------------------------------------------------

interface PhaseStatusInfo {
  status: 'complete' | 'running' | 'pending'
  started_at?: string
  completed_at?: string
  token_usage?: { input: number; output: number }
}

interface PipelineStatusOutput {
  run_id: string
  current_phase: string | null
  phases: Record<string, PhaseStatusInfo>
  total_tokens: { input: number; output: number; cost_usd: number }
  decisions_count: number
  stories_count: number
  /** ISO-8601 timestamp of the most recent pipeline activity (Story 16-7 AC4) */
  last_activity: string
  /** Seconds since last pipeline activity (Story 16-7 AC4) */
  staleness_seconds: number
}

/**
 * Build the AC5 JSON status schema for a pipeline run.
 */
export function buildPipelineStatusOutput(
  run: PipelineRun,
  tokenSummary: TokenUsageSummary[],
  decisionsCount: number,
  storiesCount: number,
): PipelineStatusOutput {
  const phases: Record<string, PhaseStatusInfo> = {}

  // Build per-phase token usage map
  const phaseTokenMap: Record<string, { input: number; output: number }> = {}
  for (const row of tokenSummary) {
    if (!phaseTokenMap[row.phase]) {
      phaseTokenMap[row.phase] = { input: 0, output: 0 }
    }
    phaseTokenMap[row.phase].input += row.total_input_tokens
    phaseTokenMap[row.phase].output += row.total_output_tokens
  }

  // Parse phase history from config_json
  let phaseHistory: Array<{ phase: string; startedAt?: string; completedAt?: string }> = []
  try {
    if (run.config_json) {
      const config = JSON.parse(run.config_json) as {
        phaseHistory?: Array<{ phase: string; startedAt?: string; completedAt?: string }>
      }
      phaseHistory = config.phaseHistory ?? []
    }
  } catch {
    // ignore
  }

  const currentPhase = run.current_phase ?? null

  // Build status for each built-in phase
  for (const phaseName of VALID_PHASES) {
    const historyEntry = phaseHistory.find((h) => h.phase === phaseName)
    const tokenUsage = phaseTokenMap[phaseName] ?? { input: 0, output: 0 }

    if (historyEntry?.completedAt) {
      phases[phaseName] = {
        status: 'complete',
        completed_at: historyEntry.completedAt,
        token_usage: tokenUsage,
      }
      if (historyEntry.startedAt) {
        phases[phaseName].started_at = historyEntry.startedAt
      }
    } else if (phaseName === currentPhase || historyEntry?.startedAt) {
      phases[phaseName] = {
        status: 'running',
        started_at: historyEntry?.startedAt,
        token_usage: tokenUsage,
      }
    } else {
      phases[phaseName] = {
        status: 'pending',
      }
    }
  }

  // Compute totals
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  for (const row of tokenSummary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
  }

  return {
    run_id: run.id,
    current_phase: currentPhase,
    phases,
    total_tokens: {
      input: totalInput,
      output: totalOutput,
      cost_usd: totalCost,
    },
    decisions_count: decisionsCount,
    stories_count: storiesCount,
    last_activity: run.updated_at,
    staleness_seconds: Math.round((Date.now() - new Date(run.updated_at).getTime()) / 1000),
  }
}

/**
 * Format a pipeline status summary in human-readable format.
 */
export function formatPipelineStatusHuman(status: PipelineStatusOutput): string {
  const lines: string[] = []
  lines.push(`Pipeline Run: ${status.run_id}`)
  lines.push(`  Current Phase: ${status.current_phase ?? 'N/A'}`)
  lines.push('')
  lines.push('  Phase Status:')

  const statusIcons: Record<string, string> = {
    complete: '[DONE]',
    running: '[RUN] ',
    pending: '[    ]',
  }

  for (const [phaseName, phaseInfo] of Object.entries(status.phases)) {
    const icon = statusIcons[phaseInfo.status] ?? '[?]'
    let line = `    ${icon} ${phaseName}`
    if (phaseInfo.status === 'complete' && phaseInfo.completed_at) {
      line += ` (completed: ${phaseInfo.completed_at})`
    }
    if (phaseInfo.token_usage && (phaseInfo.token_usage.input > 0 || phaseInfo.token_usage.output > 0)) {
      line += ` — tokens: ${phaseInfo.token_usage.input.toLocaleString()} in / ${phaseInfo.token_usage.output.toLocaleString()} out`
    }
    lines.push(line)
  }

  lines.push('')
  lines.push(`  Total Tokens: ${(status.total_tokens.input + status.total_tokens.output).toLocaleString()} (in: ${status.total_tokens.input.toLocaleString()}, out: ${status.total_tokens.output.toLocaleString()})`)
  lines.push(`  Total Cost: $${status.total_tokens.cost_usd.toFixed(4)}`)
  lines.push(`  Decisions: ${status.decisions_count}`)
  lines.push(`  Stories: ${status.stories_count}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Pipeline summary
// ---------------------------------------------------------------------------

/**
 * Format a complete pipeline run summary.
 */
export function formatPipelineSummary(
  run: PipelineRun,
  tokenSummary: TokenUsageSummary[],
  decisionsCount: number,
  storiesCount: number,
  durationMs: number,
  format: OutputFormat,
): string {
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  for (const row of tokenSummary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
  }

  const totalTokens = totalInput + totalOutput
  const savingsPct =
    BMAD_BASELINE_TOKENS_FULL > 0
      ? Math.round(((BMAD_BASELINE_TOKENS_FULL - totalTokens) / BMAD_BASELINE_TOKENS_FULL) * 100)
      : 0

  const durationSec = Math.round(durationMs / 1000)

  if (format === 'json') {
    return JSON.stringify({
      run_id: run.id,
      status: run.status,
      duration_ms: durationMs,
      phases_completed: VALID_PHASES.length,
      decisions_count: decisionsCount,
      stories_count: storiesCount,
      token_usage: {
        input: totalInput,
        output: totalOutput,
        total: totalTokens,
        cost_usd: totalCost,
        bmad_baseline: BMAD_BASELINE_TOKENS_FULL,
        savings_pct: savingsPct,
      },
    })
  }

  const lines: string[] = [
    '┌─────────────────────────────────────────────────────┐',
    '│              Pipeline Run Summary                    │',
    '└─────────────────────────────────────────────────────┘',
    `  Run ID:          ${run.id}`,
    `  Status:          ${run.status}`,
    `  Duration:        ${durationSec}s`,
    `  Phases Complete: ${VALID_PHASES.length}`,
    `  Decisions:       ${decisionsCount}`,
    `  Stories:         ${storiesCount}`,
    '',
    `  Token Usage:     ${totalTokens.toLocaleString()} total`,
    `    Input:         ${totalInput.toLocaleString()}`,
    `    Output:        ${totalOutput.toLocaleString()}`,
    `    Cost:          $${totalCost.toFixed(4)}`,
    '',
    `  BMAD Baseline:   ${BMAD_BASELINE_TOKENS_FULL.toLocaleString()} tokens`,
    `  Token Savings:   ${savingsPct >= 0 ? savingsPct + '%' : 'N/A (overhead)'}`,
  ]

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// BMAD framework scaffolding
// ---------------------------------------------------------------------------

/**
 * Subdirectories of bmad-method/src/ that constitute the framework.
 * tea/ is an optional add-on that may or may not be present in the package.
 */
const BMAD_FRAMEWORK_DIRS = ['core', 'bmm', 'tea'] as const

/**
 * Scaffold the BMAD framework from the bmad-method npm dependency into
 * <projectRoot>/_bmad/.
 *
 * Behaviour:
 * - If _bmad/ already exists and --force is NOT set → skip silently.
 * - If _bmad/ already exists and --force IS set → warn and replace.
 * - Copies each of BMAD_FRAMEWORK_DIRS from bmad-method/src/ that exist.
 * - Generates a minimal _config/config.yaml stub if it doesn't already exist.
 * - Logs "Scaffolding BMAD framework from bmad-method@<version>".
 */
export async function scaffoldBmadFramework(
  projectRoot: string,
  force: boolean,
  outputFormat: OutputFormat,
): Promise<void> {
  const bmadDest = join(projectRoot, '_bmad')
  const bmadExists = existsSync(bmadDest)

  if (bmadExists && !force) {
    // Existing _bmad/ — respect it, do not overwrite
    return
  }

  const bmadSrc = resolveBmadMethodSrcPath()
  if (!bmadSrc) {
    // bmad-method not installed — log a warning but don't fail init
    if (outputFormat !== 'json') {
      process.stderr.write(
        'Warning: bmad-method is not installed. BMAD framework not scaffolded. Run: npm install bmad-method\n',
      )
    }
    return
  }

  const version = resolveBmadMethodVersion()

  if (force && bmadExists) {
    process.stderr.write(
      `Warning: Replacing existing _bmad/ framework with bmad-method@${version}\n`,
    )
  }

  process.stdout.write(`Scaffolding BMAD framework from bmad-method@${version}\n`)
  logger.info({ version, dest: bmadDest }, 'Scaffolding BMAD framework')

  // Copy each framework directory that exists in bmad-method/src/
  for (const dir of BMAD_FRAMEWORK_DIRS) {
    const srcDir = join(bmadSrc, dir)
    if (existsSync(srcDir)) {
      const destDir = join(bmadDest, dir)
      mkdirSync(destDir, { recursive: true })
      cpSync(srcDir, destDir, { recursive: true })
      logger.info({ dir, dest: destDir }, 'Scaffolded BMAD framework directory')
    }
  }

  // Generate minimal _config/config.yaml stub if not already present
  const configDir = join(bmadDest, '_config')
  const configFile = join(configDir, 'config.yaml')
  if (!existsSync(configFile)) {
    mkdirSync(configDir, { recursive: true })
    const configStub = [
      '# BMAD framework configuration',
      `# Scaffolded from bmad-method@${version} by substrate auto init`,
      '# This file is project-specific — customize as needed.',
      'user_name: Human',
      'communication_language: English',
      'document_output_language: English',
    ].join('\n') + '\n'
    await writeFile(configFile, configStub, 'utf8')
    logger.info({ configFile }, 'Generated _bmad/_config/config.yaml stub')
  }
}

// ---------------------------------------------------------------------------
// CLAUDE.md scaffold
// ---------------------------------------------------------------------------

export const CLAUDE_MD_START_MARKER = '<!-- substrate:start -->'
export const CLAUDE_MD_END_MARKER = '<!-- substrate:end -->'

/**
 * Inject or update the substrate pipeline section in CLAUDE.md.
 *
 * Behaviour:
 * - Reads the static section template from src/cli/templates/claude-md-substrate-section.md.
 * - If CLAUDE.md does not exist, creates it with the substrate section.
 * - If CLAUDE.md exists and already contains the substrate markers, replaces
 *   the section (idempotent update) without touching any other content.
 * - If CLAUDE.md exists but has no substrate markers, appends the section.
 *
 * This function is only called from `substrate auto init` — never from `auto run`.
 */
export async function scaffoldClaudeMd(projectRoot: string): Promise<void> {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md')
  const pkgRoot = findPackageRoot(__dirname)
  const templateName = 'claude-md-substrate-section.md'
  // Check dist first (npm package / bundled build), then src (development)
  let templatePath = join(pkgRoot, 'dist', 'cli', 'templates', templateName)
  if (!existsSync(templatePath)) {
    templatePath = join(pkgRoot, 'src', 'cli', 'templates', templateName)
  }

  // Load the section template
  let sectionContent: string
  try {
    sectionContent = await readFile(templatePath, 'utf8')
  } catch {
    // Template not found — nothing to inject
    logger.warn({ templatePath }, 'CLAUDE.md substrate section template not found; skipping')
    return
  }

  // Normalise: ensure section ends with a newline
  if (!sectionContent.endsWith('\n')) {
    sectionContent += '\n'
  }

  let existingContent = ''
  let claudeMdExists = false

  try {
    existingContent = await readFile(claudeMdPath, 'utf8')
    claudeMdExists = true
  } catch {
    // File does not exist — will create it
  }

  let newContent: string

  if (!claudeMdExists) {
    // Fresh CLAUDE.md
    newContent = sectionContent
  } else if (existingContent.includes(CLAUDE_MD_START_MARKER)) {
    // Replace existing substrate section (idempotent)
    newContent = existingContent.replace(
      new RegExp(
        `${CLAUDE_MD_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CLAUDE_MD_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
      sectionContent.trimEnd(),
    )
  } else {
    // Append to existing CLAUDE.md
    const separator = existingContent.endsWith('\n') ? '\n' : '\n\n'
    newContent = existingContent + separator + sectionContent
  }

  await writeFile(claudeMdPath, newContent, 'utf8')
  logger.info({ claudeMdPath }, 'Wrote substrate section to CLAUDE.md')
}

// ---------------------------------------------------------------------------
// auto init action
// ---------------------------------------------------------------------------

export interface AutoInitOptions {
  pack: string
  projectRoot: string
  outputFormat: OutputFormat
  force?: boolean
}

export async function runAutoInit(options: AutoInitOptions): Promise<number> {
  const { pack: packName, projectRoot, outputFormat, force = false } = options

  const packPath = join(projectRoot, 'packs', packName)
  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbDir = join(dbRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')

  try {
    // Step -1: Scaffold BMAD framework from bmad-method dependency (runs before pack scaffolding)
    await scaffoldBmadFramework(projectRoot, force, outputFormat)

    // Step 0: Scaffold pack if not present locally (or --force flag used)
    const localManifest = join(packPath, 'manifest.yaml')
    let scaffolded = false
    if (!existsSync(localManifest) || force) {
      const packageRoot = findPackageRoot(__dirname)
      const bundledPackPath = join(packageRoot, 'packs', packName)
      if (!existsSync(join(bundledPackPath, 'manifest.yaml'))) {
        // Bundled pack missing — bad install
        const errorMsg = `Pack '${packName}' not found locally or in bundled packs. Try reinstalling Substrate.`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
      if (force && existsSync(localManifest)) {
        logger.info({ pack: packName }, 'Replacing existing pack with bundled version')
        process.stderr.write(`Warning: Replacing existing pack '${packName}' with bundled version\n`)
      }
      mkdirSync(dirname(packPath), { recursive: true })
      cpSync(bundledPackPath, packPath, { recursive: true })
      logger.info({ pack: packName, dest: packPath }, 'Scaffolded methodology pack')
      process.stdout.write(`Scaffolding methodology pack '${packName}' into packs/${packName}/\n`)
      scaffolded = true
    }

    // Step 1: Validate the pack
    const packLoader = createPackLoader()
    try {
      await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Check that packs/${packName}/manifest.yaml exists or try reinstalling Substrate.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Step 2: Initialize database and run migrations
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const dbWrapper = new DatabaseWrapper(dbPath)
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    dbWrapper.close()

    // Step 2b: Scaffold CLAUDE.md with substrate pipeline section
    await scaffoldClaudeMd(projectRoot)

    // Step 3: Output success
    const successMsg = `Pack '${packName}' and database initialized successfully at ${dbPath}`
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput({ pack: packName, dbPath, scaffolded }, 'json', true) + '\n',
      )
    } else {
      process.stdout.write(`${successMsg}\n`)
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto init failed')
    return 1
  }
}

// ---------------------------------------------------------------------------
// auto run action
// ---------------------------------------------------------------------------

/**
 * Map internal orchestrator phase names to pipeline event protocol phase names.
 * Returns null for internal phases that don't correspond to an event phase
 * (e.g., IN_MINOR_FIX / IN_MAJOR_FIX map to 'fix').
 */
function mapInternalPhaseToEventPhase(internalPhase: string): PipelinePhase | null {
  switch (internalPhase) {
    case 'IN_STORY_CREATION':
      return 'create-story'
    case 'IN_DEV':
      return 'dev-story'
    case 'IN_REVIEW':
      return 'code-review'
    case 'IN_MINOR_FIX':
    case 'IN_MAJOR_FIX':
      return 'fix'
    default:
      return null
  }
}

export interface AutoRunOptions {
  pack: string
  from?: PhaseName
  stopAfter?: PhaseName
  concept?: string
  conceptFile?: string
  stories?: string
  concurrency: number
  outputFormat: OutputFormat
  projectRoot: string
  /** When true, emit structured NDJSON events on stdout (AC1) */
  events?: boolean
  /** When true, preserve full pino stderr output for debugging (AC5) */
  verbose?: boolean
  /** When true, activate the full-screen TUI dashboard (Story 15-5) */
  tui?: boolean
}

export async function runAutoRun(options: AutoRunOptions): Promise<number> {
  const {
    pack: packName,
    from: startPhase,
    stopAfter,
    concept: conceptArg,
    conceptFile,
    stories: storiesArg,
    concurrency,
    outputFormat,
    projectRoot,
    events: eventsFlag,
    verbose: verboseFlag,
    tui: tuiFlag,
  } = options

  // Validate --from phase
  if (startPhase !== undefined && !VALID_PHASES.includes(startPhase)) {
    const errorMsg = `Invalid phase '${startPhase}'. Valid phases: ${VALID_PHASES.join(', ')}`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  // Validate --stop-after phase (before any DB writes)
  if (stopAfter !== undefined && !VALID_PHASES.includes(stopAfter)) {
    const errorMsg = `Invalid phase: "${stopAfter}". Valid phases: ${VALID_PHASES.join(', ')}`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  // Validate --stop-after / --from conflict (before any DB writes)
  if (stopAfter !== undefined && startPhase !== undefined) {
    const conflictResult = validateStopAfterFromConflict(stopAfter, startPhase)
    if (!conflictResult.valid) {
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, conflictResult.error) + '\n')
      } else {
        process.stderr.write(`Error: ${conflictResult.error ?? 'Invalid --stop-after / --from combination'}\n`)
      }
      return 1
    }
  }

  // Resolve concept text when starting from analysis
  let concept: string | undefined
  if (startPhase === 'analysis' || startPhase === undefined) {
    if (conceptFile !== undefined && conceptFile !== '') {
      try {
        concept = await readFile(conceptFile, 'utf-8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const errorMsg = `Failed to read concept file '${conceptFile}': ${msg}`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
    } else if (conceptArg !== undefined && conceptArg !== '') {
      concept = conceptArg
    } else if (startPhase === 'analysis') {
      // Analysis requires concept
      const errorMsg = '--concept or --concept-file required when starting from analysis phase'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }
  }

  const packPath = join(projectRoot, 'packs', packName)
  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbDir = join(dbRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')

  // If --from is provided, we're running the full phase pipeline
  if (startPhase !== undefined) {
    return runFullPipeline({
      packName,
      packPath,
      dbDir,
      dbPath,
      startPhase,
      stopAfter,
      concept,
      concurrency,
      outputFormat,
      projectRoot,
    })
  }

  // Legacy behavior: run implementation-only (existing auto run without --from)
  // Parse story keys
  let storyKeys: string[] = []
  if (storiesArg !== undefined && storiesArg !== '') {
    storyKeys = storiesArg
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)

    // Validate story key format
    for (const key of storyKeys) {
      if (!validateStoryKey(key)) {
        const errorMsg = `Story key '${key}' is not a valid format. Expected: <epic>-<story> (e.g., 10-1)`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
    }
  }

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  // Open database
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    try {
      dbWrapper.open()
      runMigrations(dbWrapper.db)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const db = dbWrapper.db

    // Load methodology pack
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Discover story keys from DB if not provided
    if (storyKeys.length === 0) {
      // Query requirements table for active stories
      const activeReqs = db
        .prepare(`SELECT description FROM requirements WHERE status = 'active' AND type = 'story'`)
        .all() as Array<{ description: string }>

      for (const req of activeReqs) {
        const match = STORY_KEY_PATTERN.exec(req.description.trim())
        if (match !== null) {
          storyKeys.push(match[0])
        }
      }

      // AC8: filter out stories already completed in previous pipeline runs
      if (storyKeys.length > 0) {
        const completedStoryKeys = new Set<string>()
        try {
          const completedRuns = db
            .prepare(
              `SELECT token_usage_json FROM pipeline_runs WHERE status = 'completed' AND token_usage_json IS NOT NULL`,
            )
            .all() as Array<{ token_usage_json: string }>

          for (const row of completedRuns) {
            try {
              const state = JSON.parse(row.token_usage_json) as {
                stories?: Record<string, { phase: string }>
              }
              if (state.stories !== undefined) {
                for (const [key, s] of Object.entries(state.stories)) {
                  if (s.phase === 'COMPLETE') {
                    completedStoryKeys.add(key)
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        } catch {
          // ignore query errors — proceed with all discovered stories
        }

        storyKeys = storyKeys.filter((k) => !completedStoryKeys.has(k))
      }

      // Fallback: discover from epics.md if requirements table is empty
      if (storyKeys.length === 0) {
        storyKeys = discoverPendingStoryKeys(projectRoot)
        if (storyKeys.length > 0) {
          process.stdout.write(
            `Discovered ${storyKeys.length} pending stories from epics.md: ${storyKeys.join(', ')}\n`,
          )
        }
      }

      if (storyKeys.length === 0) {
        if (outputFormat === 'human') {
          process.stdout.write('No pending stories found in decision store.\n')
        } else {
          process.stdout.write(
            formatOutput({ storyKeys: [], message: 'No pending stories found.' }, 'json', true) +
              '\n',
          )
        }
        return 0
      }
    }

    // Create pipeline run record
    const pipelineRun = createPipelineRun(db, {
      methodology: pack.manifest.name,
      start_phase: 'implementation',
      config_json: JSON.stringify({ storyKeys, concurrency }),
    })

    // Create dependencies
    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry,
    })

    // AC5: Subscribe to phase-complete events to record token usage
    eventBus.on('orchestrator:story-phase-complete', (payload) => {
      try {
        const result = payload.result as {
          tokenUsage?: { input: number; output: number }
        }
        if (result?.tokenUsage !== undefined) {
          const { input, output } = result.tokenUsage
          // Estimate cost: $3/1M input + $15/1M output (Claude pricing)
          const costUsd = (input * 3 + output * 15) / 1_000_000
          addTokenUsage(db, pipelineRun.id, {
            phase: payload.phase,
            agent: 'claude-code',
            input_tokens: input,
            output_tokens: output,
            cost_usd: costUsd,
          })
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to record token usage for phase')
      }

      if (outputFormat === 'human') {
        process.stdout.write(
          `  [${payload.phase}] ${payload.storyKey} — phase complete\n`,
        )
      }
    })

    // Subscribe to progress events
    if (outputFormat === 'human') {
      eventBus.on('orchestrator:story-complete', (payload) => {
        process.stdout.write(
          `  [COMPLETE] ${payload.storyKey} (${payload.reviewCycles} review cycle(s))\n`,
        )
      })
      eventBus.on('orchestrator:story-escalated', (payload) => {
        process.stdout.write(
          `  [ESCALATED] ${payload.storyKey}: ${payload.lastVerdict}\n`,
        )
      })
    }

    // AC6 (Story 15-5): Non-TTY rejection for --tui flag
    if (tuiFlag === true && !isTuiCapable()) {
      printNonTtyWarning()
      // Fall through to default output (tuiApp remains undefined)
    }

    // AC5 (Story 15-2): Suppress pino stderr by default unless --verbose is set.
    // This prevents raw JSON log lines from appearing in default terminal output.
    if (verboseFlag !== true && eventsFlag !== true) {
      // Override LOG_LEVEL to 'silent' so pino writes nothing to stderr.
      // We only do this when NOT in --events mode (events mode is programmatic).
      process.env.LOG_LEVEL = 'silent'
    }

    // AC1-AC6 (Story 15-5): Wire TUI dashboard when --tui flag is active and stdout is a TTY.
    let tuiApp: ReturnType<typeof createTuiApp> | undefined
    if (tuiFlag === true && isTuiCapable() && eventsFlag !== true && outputFormat === 'human') {
      tuiApp = createTuiApp(process.stdout, process.stdin)

      // Emit pipeline:start to TUI
      tuiApp.handleEvent({
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: pipelineRun.id,
        stories: storyKeys,
        concurrency,
      })

      // Wire story phase events to the TUI
      eventBus.on('orchestrator:story-phase-complete', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null && tuiApp !== undefined) {
          const result = payload.result as { story_file?: string; verdict?: string }
          tuiApp.handleEvent({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'complete',
            ...(phase === 'code-review' && result?.verdict !== undefined
              ? { verdict: result.verdict }
              : {}),
            ...(phase === 'create-story' && result?.story_file !== undefined
              ? { file: result.story_file }
              : {}),
          })
        }
      })

      // Wire story:done events
      eventBus.on('orchestrator:story-complete', (payload) => {
        tuiApp?.handleEvent({
          type: 'story:done',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          result: 'success',
          review_cycles: payload.reviewCycles,
        })
      })

      // Wire story:escalation events
      eventBus.on('orchestrator:story-escalated', (payload) => {
        const rawIssues = Array.isArray(payload.issues) ? payload.issues : []
        const issues = rawIssues.map((issue) => {
          const iss = issue as { severity?: string; file?: string; description?: string; desc?: string }
          return {
            severity: (iss.severity ?? 'unknown') as 'blocker' | 'major' | 'minor' | 'unknown',
            file: iss.file ?? '',
            desc: iss.desc ?? iss.description ?? '',
          }
        })
        tuiApp?.handleEvent({
          type: 'story:escalation',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          reason: payload.lastVerdict ?? 'escalated',
          cycles: payload.reviewCycles ?? 0,
          issues,
        })
      })
    }

    // AC1-AC4 (Story 15-2): Wire progress renderer when default human output is active
    // (i.e., not --events and not --output-format json and not --tui).
    let progressRenderer: ReturnType<typeof createProgressRenderer> | undefined
    if (eventsFlag !== true && outputFormat === 'human' && tuiApp === undefined) {
      progressRenderer = createProgressRenderer(process.stdout)

      // Emit pipeline:start to renderer
      progressRenderer.render({
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: pipelineRun.id,
        stories: storyKeys,
        concurrency,
      })

      // Wire story phase start events to the renderer (in_progress status)
      eventBus.on('orchestrator:story-phase-start', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null && progressRenderer !== undefined) {
          progressRenderer.render({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'in_progress',
          })
        }
      })

      // Wire story phase events to the renderer
      eventBus.on('orchestrator:story-phase-complete', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null && progressRenderer !== undefined) {
          const result = payload.result as { story_file?: string; verdict?: string }
          progressRenderer.render({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'complete',
            ...(phase === 'code-review' && result?.verdict !== undefined
              ? { verdict: result.verdict }
              : {}),
            ...(phase === 'create-story' && result?.story_file !== undefined
              ? { file: result.story_file }
              : {}),
          })
        }
      })

      // Wire story:done events
      eventBus.on('orchestrator:story-complete', (payload) => {
        progressRenderer?.render({
          type: 'story:done',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          result: 'success',
          review_cycles: payload.reviewCycles,
        })
      })

      // Wire story:escalation events
      eventBus.on('orchestrator:story-escalated', (payload) => {
        const rawIssues = Array.isArray(payload.issues) ? payload.issues : []
        const issues = rawIssues.map((issue) => {
          const iss = issue as { severity?: string; file?: string; description?: string; desc?: string }
          return {
            severity: (iss.severity ?? 'unknown') as 'blocker' | 'major' | 'minor' | 'unknown',
            file: iss.file ?? '',
            desc: iss.desc ?? iss.description ?? '',
          }
        })
        progressRenderer?.render({
          type: 'story:escalation',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          reason: payload.lastVerdict ?? 'escalated',
          cycles: payload.reviewCycles ?? 0,
          issues,
        })
      })

      // Wire story:warn events for non-fatal warnings
      eventBus.on('orchestrator:story-warn', (payload) => {
        progressRenderer?.render({
          type: 'story:warn',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          msg: payload.msg,
        })
      })
    }

    // AC1: Wire NDJSON event emitter when --events flag is active
    let ndjsonEmitter: ReturnType<typeof createEventEmitter> | undefined
    if (eventsFlag === true) {
      ndjsonEmitter = createEventEmitter(process.stdout)

      // AC2: pipeline:start — first event
      ndjsonEmitter.emit({
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: pipelineRun.id,
        stories: storyKeys,
        concurrency,
      })

      // AC3: story:phase events for each pipeline phase (in_progress on start)
      eventBus.on('orchestrator:story-phase-start', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null) {
          ndjsonEmitter!.emit({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'in_progress',
          })
        }
      })

      // AC3: story:phase events for each pipeline phase (complete on finish)
      eventBus.on('orchestrator:story-phase-complete', (payload) => {
        // Map internal phase names to event protocol phase names
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null) {
          const result = payload.result as {
            story_file?: string
            verdict?: string
          }
          ndjsonEmitter!.emit({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'complete',
            ...(phase === 'code-review' && result?.verdict !== undefined
              ? { verdict: result.verdict }
              : {}),
            ...(phase === 'create-story' && result?.story_file !== undefined
              ? { file: result.story_file }
              : {}),
          })
        }
      })

      // AC4: story:done events on story completion
      eventBus.on('orchestrator:story-complete', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:done',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          result: 'success',
          review_cycles: payload.reviewCycles,
        })
      })

      // AC5: story:escalation events on escalation
      eventBus.on('orchestrator:story-escalated', (payload) => {
        const rawIssues = Array.isArray(payload.issues) ? payload.issues : []
        const issues = rawIssues.map((issue) => {
          const iss = issue as { severity?: string; file?: string; description?: string; desc?: string }
          return {
            severity: (iss.severity ?? 'unknown') as 'blocker' | 'major' | 'minor' | 'unknown',
            file: iss.file ?? '',
            desc: iss.desc ?? iss.description ?? '',
          }
        })
        ndjsonEmitter!.emit({
          type: 'story:escalation',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          reason: payload.lastVerdict ?? 'escalated',
          cycles: payload.reviewCycles ?? 0,
          issues,
        })
      })

      // AC6: story:warn events for non-fatal warnings
      eventBus.on('orchestrator:story-warn', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:warn',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          msg: payload.msg,
        })
      })

      // Heartbeat events (Story 16-7 AC1)
      eventBus.on('orchestrator:heartbeat', (payload) => {
        ndjsonEmitter!.emit({
          type: 'pipeline:heartbeat',
          ts: new Date().toISOString(),
          run_id: payload.runId,
          active_dispatches: payload.activeDispatches,
          completed_dispatches: payload.completedDispatches,
          queued_dispatches: payload.queuedDispatches,
        })
      })

      // Stall detection events (Story 16-7 AC2)
      eventBus.on('orchestrator:stall', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:stall',
          ts: new Date().toISOString(),
          run_id: payload.runId,
          story_key: payload.storyKey,
          phase: payload.phase,
          elapsed_ms: payload.elapsedMs,
        })
      })
    }

    // Create orchestrator
    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config: {
        maxConcurrency: concurrency,
        maxReviewCycles: 2,
        pipelineRunId: pipelineRun.id,
      },
      projectRoot,
    })

    // Display startup header (only in legacy human mode without progress renderer or NDJSON emitter)
    if (outputFormat === 'human' && progressRenderer === undefined && ndjsonEmitter === undefined) {
      process.stdout.write(
        `Starting pipeline: ${storyKeys.length} story/stories, concurrency=${concurrency}\n`,
      )
      process.stdout.write(`Pipeline run ID: ${pipelineRun.id}\n`)
      process.stdout.write(`Stories: ${storyKeys.join(', ')}\n`)
    }

    // Run the orchestrator
    const status = await orchestrator.run(storyKeys)

    // Compute succeeded/failed/escalated for both progress renderer and ndjson emitter
    const succeededKeys: string[] = []
    const failedKeys: string[] = []
    const escalatedKeys: string[] = []
    for (const [key, s] of Object.entries(status.stories)) {
      if (s.phase === 'COMPLETE') succeededKeys.push(key)
      else if (s.phase === 'ESCALATED') {
        if (s.error !== undefined) failedKeys.push(key)
        else escalatedKeys.push(key)
      } else {
        failedKeys.push(key)
      }
    }

    // pipeline:complete — emit to progress renderer (AC2 of Story 15-2)
    if (progressRenderer !== undefined) {
      progressRenderer.render({
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: succeededKeys,
        failed: failedKeys,
        escalated: escalatedKeys,
      })
    }

    // pipeline:complete — emit to TUI app (Story 15-5)
    if (tuiApp !== undefined) {
      tuiApp.handleEvent({
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: succeededKeys,
        failed: failedKeys,
        escalated: escalatedKeys,
      })
    }

    // AC2: pipeline:complete — last event (emitted after all stories settle)
    if (ndjsonEmitter !== undefined) {
      ndjsonEmitter.emit({
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: succeededKeys,
        failed: failedKeys,
        escalated: escalatedKeys,
      })
    }

    // Record final token usage for the run
    const tokenSummary = getTokenUsageSummary(db, pipelineRun.id)

    // Keep the process alive so the user can interact with the TUI (Story 15-5)
    // Wait for TUI to exit BEFORE writing any plain-text summary to stdout, so
    // that the alternate-screen buffer is restored before the summary appears.
    if (tuiApp !== undefined) {
      await tuiApp.waitForExit()
    }

    // Output results (after TUI has exited and restored the normal screen)
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput(
          {
            pipelineRunId: pipelineRun.id,
            status,
            tokenSummary,
          },
          'json',
          true,
        ) + '\n',
      )
    } else if (tuiApp === undefined && ndjsonEmitter === undefined) {
      // Only write plain-text summary when TUI and NDJSON emitter are not active;
      // TUI displays pipeline status via its event-driven panels, and NDJSON
      // emitter already emits pipeline:complete with structured data.
      process.stdout.write('\n')
      // Count story outcomes
      let completed = 0
      let escalated = 0
      for (const s of Object.values(status.stories)) {
        if (s.phase === 'COMPLETE') completed++
        else if (s.phase === 'ESCALATED') escalated++
      }
      process.stdout.write(
        `Pipeline complete: ${completed}/${storyKeys.length} stories completed, ${escalated} escalated\n`,
      )
      process.stdout.write('\n')
      process.stdout.write(formatTokenTelemetry(tokenSummary) + '\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto run failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Full multi-phase pipeline execution
// ---------------------------------------------------------------------------

interface FullPipelineOptions {
  packName: string
  packPath: string
  dbDir: string
  dbPath: string
  startPhase: PhaseName
  stopAfter?: PhaseName
  concept?: string
  concurrency: number
  outputFormat: OutputFormat
  projectRoot: string
}

async function runFullPipeline(options: FullPipelineOptions): Promise<number> {
  const { packName, packPath, dbDir, dbPath, startPhase, stopAfter, concept, concurrency, outputFormat, projectRoot } =
    options

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    try {
      dbWrapper.open()
      runMigrations(dbWrapper.db)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const db = dbWrapper.db

    // Load methodology pack
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Create shared dependencies
    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()

    const dispatcher = createDispatcher({ eventBus, adapterRegistry })

    const phaseDeps = { db, pack, contextCompiler, dispatcher }

    // Create PhaseOrchestrator
    const phaseOrchestrator = createPhaseOrchestrator({ db, pack })

    // Start the run
    const startedAt = Date.now()
    const runId = await phaseOrchestrator.startRun(concept ?? '', startPhase)

    if (outputFormat === 'human') {
      process.stdout.write(`Starting full pipeline from phase: ${startPhase}\n`)
      process.stdout.write(`Pipeline run ID: ${runId}\n`)
    }

    // Execute phases in order starting from startPhase
    const phaseOrder: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']
    const startIdx = phaseOrder.indexOf(startPhase)

    for (let i = startIdx; i < phaseOrder.length; i++) {
      const currentPhase = phaseOrder[i]

      if (outputFormat === 'human') {
        process.stdout.write(`\n[${currentPhase.toUpperCase()}] Starting...\n`)
      }

      // Execute the phase
      if (currentPhase === 'analysis') {
        const result = await runAnalysisPhase(phaseDeps, { runId, concept: concept ?? '' })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'analysis',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Analysis phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[ANALYSIS] Complete — product brief created (artifact: ${result.artifact_id ?? 'n/a'})\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'planning') {
        const result = await runPlanningPhase(phaseDeps, { runId })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'planning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Planning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[PLANNING] Complete — ${result.requirements_count ?? 0} requirements, ${result.user_stories_count ?? 0} user stories\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'solutioning') {
        const result = await runSolutioningPhase(phaseDeps, { runId })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'solutioning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Solutioning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[SOLUTIONING] Complete — ${result.architecture_decisions ?? 0} architecture decisions, ${result.epics ?? 0} epics, ${result.stories ?? 0} stories\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'implementation') {
        // Run implementation orchestrator
        const orchestrator = createImplementationOrchestrator({
          db,
          pack,
          contextCompiler,
          dispatcher,
          eventBus,
          config: {
            maxConcurrency: concurrency,
            maxReviewCycles: 2,
            pipelineRunId: runId,
          },
          projectRoot,
        })

        // Subscribe to events for progress reporting
        eventBus.on('orchestrator:story-phase-complete', (payload) => {
          try {
            const result = payload.result as {
              tokenUsage?: { input: number; output: number }
            }
            if (result?.tokenUsage !== undefined) {
              const { input, output } = result.tokenUsage
              const costUsd = (input * 3 + output * 15) / 1_000_000
              addTokenUsage(db, runId, {
                phase: payload.phase,
                agent: 'claude-code',
                input_tokens: input,
                output_tokens: output,
                cost_usd: costUsd,
              })
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to record token usage for phase')
          }

          if (outputFormat === 'human') {
            process.stdout.write(`  [${payload.phase}] ${payload.storyKey} — phase complete\n`)
          }
        })

        if (outputFormat === 'human') {
          eventBus.on('orchestrator:story-complete', (payload) => {
            process.stdout.write(
              `  [COMPLETE] ${payload.storyKey} (${payload.reviewCycles} review cycle(s))\n`,
            )
          })
          eventBus.on('orchestrator:story-escalated', (payload) => {
            process.stdout.write(`  [ESCALATED] ${payload.storyKey}: ${payload.lastVerdict}\n`)
          })
        }

        // Discover story keys from DB
        const storyDecisions = db
          .prepare(
            `SELECT description FROM requirements WHERE status = 'active' AND source = 'solutioning-phase'`,
          )
          .all() as Array<{ description: string }>

        const storyKeys: string[] = []
        for (const req of storyDecisions) {
          // Keys embedded in solutioning decisions
          const keyMatch = /^(\d+-\d+):/.exec(req.description)
          if (keyMatch) {
            storyKeys.push(keyMatch[1])
          }
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[IMPLEMENTATION] Starting ${storyKeys.length} stories with concurrency=${concurrency}\n`,
          )
        }

        await orchestrator.run(storyKeys)

        if (outputFormat === 'human') {
          process.stdout.write('[IMPLEMENTATION] Complete\n')
        }
      }

      // Evaluate stop-after gate after each phase completes (AC8: between phases, not mid-phase)
      if (stopAfter !== undefined && currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          // Count decisions for summary
          const decisionsCount =
            (db
              .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
              .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

          // Update run status to 'stopped' atomically before emitting summary (AC4)
          updatePipelineRun(db, runId, { status: 'stopped' })

          // Emit phase completion summary (AC5)
          const phaseStartedAt = new Date(startedAt).toISOString()
          const phaseCompletedAt = new Date().toISOString()
          const summary = formatPhaseCompletionSummary({
            phaseName: stopAfter,
            startedAt: phaseStartedAt,
            completedAt: phaseCompletedAt,
            decisionsCount,
            // artifact paths not available at integration level; summary uses phase metadata only
            artifactPaths: [],
            runId,
          })
          process.stdout.write(summary + '\n')
          return 0
        }
      }

      // Advance to next phase (if not the last phase)
      if (i < phaseOrder.length - 1) {
        const advanceResult = await phaseOrchestrator.advancePhase(runId)
        if (!advanceResult.advanced) {
          const gateErrors = advanceResult.gateFailures?.map((f) => f.error).join('; ') ?? 'unknown gate failure'
          const errorMsg = `Phase gate check failed after ${currentPhase}: ${gateErrors}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
      }
    }

    // Get final token summary
    const tokenSummary = getTokenUsageSummary(db, runId)
    const durationMs = Date.now() - startedAt

    // Count decisions and stories
    const decisionsCount = (db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
      .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

    const storiesCount = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
      )
      .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

    // Get pipeline run for summary
    const finalRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as
      | PipelineRun
      | undefined

    if (outputFormat === 'json') {
      const statusOutput = buildPipelineStatusOutput(
        finalRun ?? ({ id: runId } as PipelineRun),
        tokenSummary,
        decisionsCount,
        storiesCount,
      )
      process.stdout.write(formatOutput(statusOutput, 'json', true) + '\n')
    } else {
      process.stdout.write('\n')
      process.stdout.write(
        formatPipelineSummary(
          finalRun ?? ({ id: runId } as PipelineRun),
          tokenSummary,
          decisionsCount,
          storiesCount,
          durationMs,
          'human',
        ) + '\n',
      )
      process.stdout.write('\n')
      process.stdout.write(formatTokenTelemetry(tokenSummary, BMAD_BASELINE_TOKENS_FULL) + '\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'full pipeline run failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// auto resume action
// ---------------------------------------------------------------------------

export interface AutoResumeOptions {
  runId?: string
  stopAfter?: PhaseName
  outputFormat: OutputFormat
  projectRoot: string
  concurrency: number
  pack: string
}

export async function runAutoResume(options: AutoResumeOptions): Promise<number> {
  const { runId: specifiedRunId, stopAfter, outputFormat, projectRoot, concurrency, pack: packName } = options

  // Validate --stop-after phase (before any DB writes) (AC7)
  if (stopAfter !== undefined && !VALID_PHASES.includes(stopAfter)) {
    const errorMsg = `Invalid phase: "${stopAfter}". Valid phases: ${VALID_PHASES.join(', ')}`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const packPath = join(projectRoot, 'packs', packName)
  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    const db = dbWrapper.db

    // Load methodology pack
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Load pipeline run
    let run: PipelineRun | undefined
    if (specifiedRunId !== undefined && specifiedRunId !== '') {
      run = db
        .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
        .get(specifiedRunId) as PipelineRun | undefined
    } else {
      run = getLatestRun(db)
    }

    if (run === undefined) {
      const errorMsg =
        specifiedRunId !== undefined
          ? `Pipeline run '${specifiedRunId}' not found.`
          : 'No pipeline runs found. Run `substrate auto run --from analysis` first.'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const runId = run.id

    if (outputFormat === 'human') {
      process.stdout.write(`Resuming pipeline run: ${runId}\n`)
    }

    // Create PhaseOrchestrator and determine resume point
    const phaseOrchestrator = createPhaseOrchestrator({ db, pack })
    const runStatus = await phaseOrchestrator.resumeRun(runId)

    const resumePhase = runStatus.currentPhase as PhaseName | null

    if (resumePhase === null || runStatus.status === 'completed') {
      if (outputFormat === 'human') {
        process.stdout.write('Pipeline run is already completed.\n')
      } else {
        process.stdout.write(formatOutput({ runId, status: 'completed' }, 'json', true) + '\n')
      }
      return 0
    }

    if (outputFormat === 'human') {
      process.stdout.write(`Resuming from phase: ${resumePhase}\n`)
    }

    // Get concept from config_json
    let concept = ''
    try {
      const config = JSON.parse(run.config_json ?? '{}') as { concept?: string }
      concept = config.concept ?? ''
    } catch {
      // ignore
    }

    // Determine db directory from db path
    const dbDir = dbPath.replace('/substrate.db', '')

    // Execute remaining phases
    return runFullPipelineFromPhase({
      packName,
      packPath,
      dbDir,
      dbPath,
      startPhase: resumePhase,
      stopAfter,
      concept,
      concurrency,
      outputFormat,
      existingRunId: runId,
      projectRoot,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto resume failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Full pipeline execution from a specific phase with an existing run ID
// ---------------------------------------------------------------------------

interface FullPipelineFromPhaseOptions {
  packName: string
  packPath: string
  dbDir: string
  dbPath: string
  startPhase: PhaseName
  stopAfter?: PhaseName
  concept: string
  concurrency: number
  outputFormat: OutputFormat
  existingRunId?: string
  projectRoot: string
}

async function runFullPipelineFromPhase(options: FullPipelineFromPhaseOptions): Promise<number> {
  const {
    packName,
    packPath,
    dbDir,
    dbPath,
    startPhase,
    stopAfter,
    concept,
    concurrency,
    outputFormat,
    existingRunId,
    projectRoot,
  } = options

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const db = dbWrapper.db

    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()
    const dispatcher = createDispatcher({ eventBus, adapterRegistry })
    const phaseDeps = { db, pack, contextCompiler, dispatcher }

    const phaseOrchestrator = createPhaseOrchestrator({ db, pack })

    const startedAt = Date.now()
    let runId: string

    if (existingRunId !== undefined) {
      runId = existingRunId
    } else {
      runId = await phaseOrchestrator.startRun(concept, startPhase)
    }

    const phaseOrder: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']
    const startIdx = phaseOrder.indexOf(startPhase)

    for (let i = startIdx; i < phaseOrder.length; i++) {
      const currentPhase = phaseOrder[i]

      if (outputFormat === 'human') {
        process.stdout.write(`\n[${currentPhase.toUpperCase()}] Starting...\n`)
      }

      if (currentPhase === 'analysis') {
        const result = await runAnalysisPhase(phaseDeps, { runId, concept })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'analysis',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Analysis phase failed: ${result.error ?? 'unknown error'}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
        if (outputFormat === 'human') {
          process.stdout.write(`[ANALYSIS] Complete\n`)
        }
      } else if (currentPhase === 'planning') {
        const result = await runPlanningPhase(phaseDeps, { runId })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'planning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Planning phase failed: ${result.error ?? 'unknown error'}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
        if (outputFormat === 'human') {
          process.stdout.write(`[PLANNING] Complete\n`)
        }
      } else if (currentPhase === 'solutioning') {
        const result = await runSolutioningPhase(phaseDeps, { runId })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'solutioning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Solutioning phase failed: ${result.error ?? 'unknown error'}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
        if (outputFormat === 'human') {
          process.stdout.write(`[SOLUTIONING] Complete\n`)
        }
      } else if (currentPhase === 'implementation') {
        const orchestrator = createImplementationOrchestrator({
          db,
          pack,
          contextCompiler,
          dispatcher,
          eventBus,
          config: {
            maxConcurrency: concurrency,
            maxReviewCycles: 2,
            pipelineRunId: runId,
          },
          projectRoot,
        })

        eventBus.on('orchestrator:story-phase-complete', (payload) => {
          try {
            const result = payload.result as { tokenUsage?: { input: number; output: number } }
            if (result?.tokenUsage !== undefined) {
              const { input, output } = result.tokenUsage
              const costUsd = (input * 3 + output * 15) / 1_000_000
              addTokenUsage(db, runId, {
                phase: payload.phase,
                agent: 'claude-code',
                input_tokens: input,
                output_tokens: output,
                cost_usd: costUsd,
              })
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to record token usage')
          }
        })

        const storyDecisions = db
          .prepare(
            `SELECT description FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
          )
          .all(runId) as Array<{ description: string }>

        const storyKeys: string[] = []
        for (const req of storyDecisions) {
          const keyMatch = /^(\d+-\d+):/.exec(req.description)
          if (keyMatch) {
            storyKeys.push(keyMatch[1])
          }
        }

        await orchestrator.run(storyKeys)

        if (outputFormat === 'human') {
          process.stdout.write('[IMPLEMENTATION] Complete\n')
        }
      }

      // Evaluate stop-after gate after each phase completes (AC8: between phases, not mid-phase)
      if (stopAfter !== undefined && currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          // Count decisions for summary
          const decisionsCount =
            (db
              .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
              .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

          // Update run status to 'stopped' atomically before emitting summary (AC4)
          updatePipelineRun(db, runId, { status: 'stopped' })

          // Emit phase completion summary (AC5)
          const phaseStartedAt = new Date(startedAt).toISOString()
          const phaseCompletedAt = new Date().toISOString()
          const summary = formatPhaseCompletionSummary({
            phaseName: stopAfter,
            startedAt: phaseStartedAt,
            completedAt: phaseCompletedAt,
            decisionsCount,
            // artifact paths not available at integration level; summary uses phase metadata only
            artifactPaths: [],
            runId,
          })
          process.stdout.write(summary + '\n')
          return 0
        }
      }

      // Advance phase (except after implementation)
      if (i < phaseOrder.length - 1) {
        const advanceResult = await phaseOrchestrator.advancePhase(runId)
        if (!advanceResult.advanced) {
          const gateErrors =
            advanceResult.gateFailures?.map((f) => f.error).join('; ') ?? 'unknown gate failure'
          const errorMsg = `Phase gate check failed after ${currentPhase}: ${gateErrors}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
      }
    }

    // Final summary
    const tokenSummary = getTokenUsageSummary(db, runId)
    const durationMs = Date.now() - startedAt

    const decisionsCount =
      (
        db
          .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
          .get(runId) as { cnt: number } | undefined
      )?.cnt ?? 0

    const storiesCount =
      (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
          )
          .get(runId) as { cnt: number } | undefined
      )?.cnt ?? 0

    const finalRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as
      | PipelineRun
      | undefined

    if (outputFormat === 'json') {
      const statusOutput = buildPipelineStatusOutput(
        finalRun ?? ({ id: runId } as PipelineRun),
        tokenSummary,
        decisionsCount,
        storiesCount,
      )
      process.stdout.write(formatOutput(statusOutput, 'json', true) + '\n')
    } else {
      process.stdout.write('\n')
      process.stdout.write(
        formatPipelineSummary(
          finalRun ?? ({ id: runId } as PipelineRun),
          tokenSummary,
          decisionsCount,
          storiesCount,
          durationMs,
          'human',
        ) + '\n',
      )
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'pipeline from phase failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// auto status action
// ---------------------------------------------------------------------------

export interface AutoStatusOptions {
  outputFormat: OutputFormat
  runId?: string
  projectRoot: string
}

export async function runAutoStatus(options: AutoStatusOptions): Promise<number> {
  const { outputFormat, runId, projectRoot } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    const db = dbWrapper.db

    // Query pipeline run
    let run: PipelineRun | undefined
    if (runId !== undefined && runId !== '') {
      run = db
        .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
        .get(runId) as PipelineRun | undefined
    } else {
      run = getLatestRun(db)
    }

    if (run === undefined) {
      const errorMsg =
        runId !== undefined
          ? `Pipeline run '${runId}' not found.`
          : 'No pipeline runs found. Run `substrate auto run` first.'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Get token usage summary
    const tokenSummary = getTokenUsageSummary(db, run.id)

    // Count decisions and stories
    const decisionsCount =
      (
        db
          .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
          .get(run.id) as { cnt: number } | undefined
      )?.cnt ?? 0

    const storiesCount =
      (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
          )
          .get(run.id) as { cnt: number } | undefined
      )?.cnt ?? 0

    if (outputFormat === 'json') {
      // AC5: output the exact schema defined in the story
      const statusOutput = buildPipelineStatusOutput(run, tokenSummary, decisionsCount, storiesCount)
      process.stdout.write(
        formatOutput(statusOutput, 'json', true) + '\n',
      )
    } else {
      // Check if this is a phase-level run (has phaseHistory) or legacy implementation-only run
      let hasPhaseHistory = false
      try {
        const config = JSON.parse(run.config_json ?? '{}') as { phaseHistory?: unknown[] }
        hasPhaseHistory = Array.isArray(config.phaseHistory) && config.phaseHistory.length > 0
      } catch {
        // ignore
      }

      if (hasPhaseHistory) {
        // Phase-level status display
        const statusOutput = buildPipelineStatusOutput(run, tokenSummary, decisionsCount, storiesCount)
        process.stdout.write(formatPipelineStatusHuman(statusOutput) + '\n')
      } else {
        // Legacy human-readable status (implementation-only)
        process.stdout.write(`Pipeline Run: ${run.id}\n`)
        process.stdout.write(`  Status:       ${run.status}\n`)
        process.stdout.write(`  Methodology:  ${run.methodology}\n`)
        process.stdout.write(`  Phase:        ${run.current_phase ?? 'N/A'}\n`)
        process.stdout.write(`  Created:      ${run.created_at}\n`)
        process.stdout.write(`  Updated:      ${run.updated_at}\n`)

        // Story breakdown if available
        let storyState: unknown = null
        try {
          if (run.token_usage_json !== null && run.token_usage_json !== undefined) {
            storyState = JSON.parse(run.token_usage_json)
          } else if (run.config_json !== null && run.config_json !== undefined) {
            storyState = JSON.parse(run.config_json)
          }
        } catch {
          // Ignore parse errors
        }

        if (
          storyState !== null &&
          typeof storyState === 'object' &&
          'stories' in (storyState as Record<string, unknown>)
        ) {
          const stories = (
            storyState as { stories: Record<string, { phase: string; reviewCycles: number }> }
          ).stories
          const storyEntries = Object.entries(stories)
          if (storyEntries.length > 0) {
            process.stdout.write('\nPer-Story Breakdown:\n')
            let completed = 0
            let pending = 0
            let escalated = 0
            for (const [key, s] of storyEntries) {
              process.stdout.write(`  ${key}: ${s.phase} (review cycles: ${s.reviewCycles})\n`)
              if (s.phase === 'COMPLETE') completed++
              else if (s.phase === 'ESCALATED') escalated++
              else pending++
            }
            process.stdout.write(
              `\nSummary: ${completed} completed, ${pending} pending, ${escalated} escalated\n`,
            )
          }
        }
      }

      process.stdout.write('\n')
      process.stdout.write(formatTokenTelemetry(tokenSummary) + '\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto status failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// auto health action (Story 16-7 AC3)
// ---------------------------------------------------------------------------

export interface AutoHealthOptions {
  outputFormat: OutputFormat
  runId?: string
  projectRoot: string
}

type HealthVerdict = 'HEALTHY' | 'STALLED' | 'NO_PIPELINE_RUNNING'

interface ProcessInfo {
  orchestrator_pid: number | null
  child_pids: number[]
  zombies: number[]
}

interface PipelineHealthOutput {
  verdict: HealthVerdict
  run_id: string | null
  status: string | null
  current_phase: string | null
  staleness_seconds: number
  last_activity: string
  process: ProcessInfo
  stories: {
    active: number
    completed: number
    escalated: number
    details: Record<string, { phase: string; review_cycles: number }>
  }
}

function inspectProcessTree(): ProcessInfo {
  const result: ProcessInfo = { orchestrator_pid: null, child_pids: [], zombies: [] }
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const psOutput = execFileSync('ps', ['-eo', 'pid,ppid,stat,command'], { encoding: 'utf-8', timeout: 5000 })
    const lines = psOutput.split('\n')

    // Find substrate auto run process
    for (const line of lines) {
      if (line.includes('substrate auto run') && !line.includes('grep')) {
        const match = line.trim().match(/^(\d+)/)
        if (match) {
          result.orchestrator_pid = parseInt(match[1], 10)
          break
        }
      }
    }

    // Find children and zombies
    if (result.orchestrator_pid !== null) {
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 3) {
          const pid = parseInt(parts[0], 10)
          const ppid = parseInt(parts[1], 10)
          const stat = parts[2]
          if (ppid === result.orchestrator_pid && pid !== result.orchestrator_pid) {
            result.child_pids.push(pid)
            if (stat.includes('Z')) {
              result.zombies.push(pid)
            }
          }
        }
      }
    }
  } catch {
    // Process inspection failed — return empty result
  }
  return result
}

export async function runAutoHealth(options: AutoHealthOptions): Promise<number> {
  const { outputFormat, runId, projectRoot } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    const output: PipelineHealthOutput = {
      verdict: 'NO_PIPELINE_RUNNING',
      run_id: null,
      status: null,
      current_phase: null,
      staleness_seconds: 0,
      last_activity: '',
      process: { orchestrator_pid: null, child_pids: [], zombies: [] },
      stories: { active: 0, completed: 0, escalated: 0, details: {} },
    }
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(output, 'json', true) + '\n')
    } else {
      process.stdout.write('NO_PIPELINE_RUNNING — no substrate database found\n')
    }
    return 0
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    const db = dbWrapper.db

    let run: PipelineRun | undefined
    if (runId !== undefined) {
      run = getPipelineRunById(db, runId)
    } else {
      run = getLatestRun(db)
    }

    if (run === undefined) {
      const output: PipelineHealthOutput = {
        verdict: 'NO_PIPELINE_RUNNING',
        run_id: null,
        status: null,
        current_phase: null,
        staleness_seconds: 0,
        last_activity: '',
        process: { orchestrator_pid: null, child_pids: [], zombies: [] },
        stories: { active: 0, completed: 0, escalated: 0, details: {} },
      }
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(output, 'json', true) + '\n')
      } else {
        process.stdout.write('NO_PIPELINE_RUNNING — no pipeline runs found\n')
      }
      return 0
    }

    // Compute staleness
    const updatedAt = new Date(run.updated_at)
    const stalenessSeconds = Math.round((Date.now() - updatedAt.getTime()) / 1000)

    // Parse story state from token_usage_json
    let storyDetails: Record<string, { phase: string; review_cycles: number }> = {}
    let active = 0
    let completed = 0
    let escalated = 0

    try {
      if (run.token_usage_json) {
        const state = JSON.parse(run.token_usage_json) as {
          stories?: Record<string, { phase: string; reviewCycles: number }>
        }
        if (state.stories) {
          for (const [key, s] of Object.entries(state.stories)) {
            storyDetails[key] = { phase: s.phase, review_cycles: s.reviewCycles }
            if (s.phase === 'COMPLETE') completed++
            else if (s.phase === 'ESCALATED') escalated++
            else if (s.phase !== 'PENDING') active++
          }
        }
      }
    } catch {
      // ignore parse errors
    }

    // Inspect process tree
    const processInfo = inspectProcessTree()

    // Derive verdict
    let verdict: HealthVerdict = 'NO_PIPELINE_RUNNING'
    if (run.status === 'running') {
      if (processInfo.zombies.length > 0) {
        verdict = 'STALLED'
      } else if (stalenessSeconds > 600) {
        verdict = 'STALLED'
      } else if (processInfo.orchestrator_pid !== null && processInfo.child_pids.length === 0 && active > 0) {
        verdict = 'STALLED'
      } else {
        verdict = 'HEALTHY'
      }
    } else if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
      verdict = 'NO_PIPELINE_RUNNING'
    }

    const output: PipelineHealthOutput = {
      verdict,
      run_id: run.id,
      status: run.status,
      current_phase: run.current_phase,
      staleness_seconds: stalenessSeconds,
      last_activity: run.updated_at,
      process: processInfo,
      stories: { active, completed, escalated, details: storyDetails },
    }

    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(output, 'json', true) + '\n')
    } else {
      // Human-readable output
      const verdictLabel = verdict === 'HEALTHY' ? 'HEALTHY'
        : verdict === 'STALLED' ? 'STALLED'
        : 'NO PIPELINE RUNNING'
      process.stdout.write(`\nPipeline Health: ${verdictLabel}\n`)
      process.stdout.write(`  Run:          ${run.id}\n`)
      process.stdout.write(`  Status:       ${run.status}\n`)
      process.stdout.write(`  Phase:        ${run.current_phase ?? 'N/A'}\n`)
      process.stdout.write(`  Last Active:  ${run.updated_at} (${stalenessSeconds}s ago)\n`)

      if (processInfo.orchestrator_pid !== null) {
        process.stdout.write(`  Orchestrator: PID ${processInfo.orchestrator_pid}\n`)
        process.stdout.write(`  Children:     ${processInfo.child_pids.length} active`)
        if (processInfo.zombies.length > 0) {
          process.stdout.write(` (${processInfo.zombies.length} ZOMBIE)`)
        }
        process.stdout.write('\n')
      } else {
        process.stdout.write('  Orchestrator: not running\n')
      }

      if (Object.keys(storyDetails).length > 0) {
        process.stdout.write('\n  Stories:\n')
        for (const [key, s] of Object.entries(storyDetails)) {
          process.stdout.write(`    ${key}: ${s.phase} (${s.review_cycles} review cycles)\n`)
        }
        process.stdout.write(`\n  Summary: ${active} active, ${completed} completed, ${escalated} escalated\n`)
      }
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto health failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// auto status enhancement (Story 16-7 AC4)
// ---------------------------------------------------------------------------

// Note: `last_activity` and `staleness_seconds` are added to PipelineStatusOutput
// in the buildPipelineStatusOutput function below.

// ---------------------------------------------------------------------------
// Amendment supersession detection
// ---------------------------------------------------------------------------

/**
 * Detect and apply supersessions after a phase completes in an amendment run.
 *
 * Compares new decisions from the amendment run for the given phase against
 * parent run decisions by (phase, category, key) tuple. For each match,
 * calls supersedeDecision() and handler.logSupersession().
 *
 * Errors in individual supersession calls are logged as warnings but do not
 * fail the phase (AC7: atomic with phase completion, non-blocking on error).
 */
export function runPostPhaseSupersessionDetection(
  db: BetterSqlite3Database,
  amendmentRunId: string,
  currentPhase: string,
  handler: AmendmentContextHandler,
): void {
  const newDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId, phase: currentPhase })
  const parentDecisions = handler.getParentDecisions()

  for (const newDec of newDecisions) {
    const parentMatch = parentDecisions.find(
      (p) => p.phase === newDec.phase && p.category === newDec.category && p.key === newDec.key
    )
    if (parentMatch) {
      try {
        supersedeDecision(db, parentMatch.id, newDec.id)
        handler.logSupersession({
          originalDecisionId: parentMatch.id,
          supersedingDecisionId: newDec.id,
          phase: currentPhase,
          key: newDec.key,
          reason: `Amendment replaced ${parentMatch.category}/${parentMatch.key}`,
          loggedAt: new Date().toISOString(),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err, originalId: parentMatch.id, supersedingId: newDec.id }, `Supersession failed: ${msg}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// auto amend action
// ---------------------------------------------------------------------------

export interface AutoAmendOptions {
  concept?: string
  conceptFile?: string
  runId?: string
  stopAfter?: PhaseName
  from?: PhaseName
  projectRoot: string
  pack: string
}

export async function runAmendCommand(options: AutoAmendOptions): Promise<number> {
  const { concept: conceptArg, conceptFile, runId: specifiedRunId, stopAfter, from: startPhase, projectRoot, pack: packName } = options

  // AC2: --concept or --concept-file is required (before any DB reads/writes)
  let concept: string
  if (conceptFile !== undefined && conceptFile !== '') {
    try {
      concept = await readFile(conceptFile, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: Failed to read concept file '${conceptFile}': ${msg}\n`)
      return 1
    }
  } else if (conceptArg !== undefined && conceptArg !== '') {
    concept = conceptArg
  } else {
    process.stderr.write('Either --concept or --concept-file is required for amendment runs\n')
    return 1
  }

  // AC3: Validate --stop-after / --from conflict (before any DB writes)
  if (stopAfter !== undefined && startPhase !== undefined) {
    const conflictResult = validateStopAfterFromConflict(stopAfter, startPhase)
    if (!conflictResult.valid) {
      process.stderr.write(`Error: ${conflictResult.error ?? 'Invalid --stop-after / --from combination'}\n`)
      return 1
    }
  }

  // Validate --from phase
  if (startPhase !== undefined && !VALID_PHASES.includes(startPhase)) {
    process.stderr.write(`Error: Invalid phase '${startPhase}'. Valid phases: ${VALID_PHASES.join(', ')}\n`)
    return 1
  }

  // Validate --stop-after phase
  if (stopAfter !== undefined && !VALID_PHASES.includes(stopAfter)) {
    process.stderr.write(`Error: Invalid phase: "${stopAfter}". Valid phases: ${VALID_PHASES.join(', ')}\n`)
    return 1
  }

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbDir = join(dbRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')
  const packPath = join(projectRoot, 'packs', packName)

  if (!existsSync(dbPath)) {
    process.stderr.write(`Error: Decision store not initialized. Run 'substrate auto init' first.\n`)
    return 1
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const db = dbWrapper.db

    // AC4: Resolve parentRunId: use --run-id or getLatestCompletedRun()
    let parentRunId: string
    if (specifiedRunId !== undefined && specifiedRunId !== '') {
      parentRunId = specifiedRunId
    } else {
      const latestCompleted = getLatestCompletedRun(db)
      if (latestCompleted === undefined) {
        process.stderr.write("No completed pipeline run found. Run 'substrate auto run' first.\n")
        return 1
      }
      parentRunId = latestCompleted.id
    }

    // AC5: createAmendmentRun() creates DB record
    const amendmentRunId = randomUUID()
    let methodology = packName
    try {
      const packLoader = createPackLoader()
      const pack = await packLoader.load(packPath)
      methodology = pack.manifest.name
    } catch {
      // Use packName as fallback
    }

    try {
      createAmendmentRun(db, {
        id: amendmentRunId,
        parentRunId,
        methodology,
        configJson: JSON.stringify({ concept, startPhase, stopAfter }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
      return 1
    }

    // AC6: createAmendmentContextHandler() before the phase loop
    const handler = createAmendmentContextHandler(db, parentRunId, { framingConcept: concept })

    // Load methodology pack and assemble PhaseDeps (matching runFullPipeline pattern)
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}\n`)
      return 1
    }

    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()
    const dispatcher = createDispatcher({ eventBus, adapterRegistry })
    const phaseDeps = { db, pack, contextCompiler, dispatcher }

    // Determine phases to run
    const phaseOrder: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']
    const startIdx = startPhase !== undefined ? phaseOrder.indexOf(startPhase) : 0

    // Copy parent decisions for skipped phases so downstream phases can query them
    if (startIdx > 0) {
      const phasesToCopy = phaseOrder.slice(0, startIdx)
      for (const phase of phasesToCopy) {
        const parentDecisions = getDecisionsByPhaseForRun(db, parentRunId, phase)
        for (const d of parentDecisions) {
          createDecision(db, {
            pipeline_run_id: amendmentRunId,
            phase: d.phase,
            category: d.category,
            key: d.key,
            value: d.value,
            rationale: d.rationale ?? undefined,
          })
        }
        if (parentDecisions.length > 0) {
          process.stdout.write(`[AMENDMENT] Copied ${parentDecisions.length} ${phase} decisions from parent run\n`)
        }
      }
    }

    const startedAt = Date.now()

    // AC9: Phase loop with context injection and actual phase execution
    let stopped = false
    for (let i = startIdx; i < phaseOrder.length; i++) {
      const currentPhase = phaseOrder[i]

      // AC6 + AC9: Load context for this phase and inject it
      const amendmentContext = handler.loadContextForPhase(currentPhase)
      logger.info({ phase: currentPhase, amendmentContextLen: amendmentContext.length }, 'Amendment context loaded for phase')

      process.stdout.write(`\n[AMENDMENT:${currentPhase.toUpperCase()}] Starting (with amendment context)...\n`)

      // Execute actual phase runners with amendment context (AC4)
      if (currentPhase === 'analysis') {
        const result = await runAnalysisPhase(phaseDeps, { runId: amendmentRunId, concept, amendmentContext })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, amendmentRunId, {
            phase: 'analysis',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, amendmentRunId, { status: 'failed' })
          process.stderr.write(`Error: Analysis phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}\n`)
          return 1
        }
        // AC1 (Story 12-12): Post-phase supersession detection
        runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
        process.stdout.write(`[AMENDMENT:ANALYSIS] Complete\n`)
      } else if (currentPhase === 'planning') {
        const result = await runPlanningPhase(phaseDeps, { runId: amendmentRunId, amendmentContext })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, amendmentRunId, {
            phase: 'planning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, amendmentRunId, { status: 'failed' })
          process.stderr.write(`Error: Planning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}\n`)
          return 1
        }
        // AC1 (Story 12-12): Post-phase supersession detection
        runPostPhaseSupersessionDetection(db, amendmentRunId, 'planning', handler)
        process.stdout.write(`[AMENDMENT:PLANNING] Complete\n`)
      } else if (currentPhase === 'solutioning') {
        const result = await runSolutioningPhase(phaseDeps, { runId: amendmentRunId, amendmentContext })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, amendmentRunId, {
            phase: 'solutioning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, amendmentRunId, { status: 'failed' })
          process.stderr.write(`Error: Solutioning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}\n`)
          return 1
        }
        // AC1 (Story 12-12): Post-phase supersession detection
        runPostPhaseSupersessionDetection(db, amendmentRunId, 'solutioning', handler)
        process.stdout.write(`[AMENDMENT:SOLUTIONING] Complete\n`)
      } else if (currentPhase === 'implementation') {
        // Implementation phase: context injection only (implementation is story-based, not re-run on amend)
        process.stdout.write(`[AMENDMENT:IMPLEMENTATION] Context injected (${amendmentContext.length} chars)\n`)
      }

      // AC7: Stop-after gate reused from Story 12-2
      if (stopAfter !== undefined && currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          const decisionsCount =
            (db
              .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
              .get(amendmentRunId) as { cnt: number } | undefined)?.cnt ?? 0

          updatePipelineRun(db, amendmentRunId, { status: 'stopped' })

          const phaseStartedAt = new Date(startedAt).toISOString()
          const phaseCompletedAt = new Date().toISOString()
          const summary = formatPhaseCompletionSummary({
            phaseName: stopAfter,
            startedAt: phaseStartedAt,
            completedAt: phaseCompletedAt,
            decisionsCount,
            artifactPaths: [],
            runId: amendmentRunId,
          })
          process.stdout.write(summary + '\n')
          stopped = true
          break
        }
      }
    }

    // AC8: generateDeltaDocument() on completion
    if (!stopped) {
      updatePipelineRun(db, amendmentRunId, { status: 'completed' })
    }

    // Query amendment decisions and superseded decisions from DB
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })
    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()

    // Build superseded decisions list from supersession log
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))

    try {
      const deltaDoc = await generateDeltaDocument({
        amendmentRunId,
        parentRunId,
        parentDecisions,
        amendmentDecisions,
        supersededDecisions,
        framingConcept: concept,
      })

      const deltaDocPath = join(projectRoot, `amendment-delta-${amendmentRunId}.md`)
      await writeFile(deltaDocPath, formatDeltaDocument(deltaDoc), 'utf-8')
      process.stdout.write(`Delta document written to: ${deltaDocPath}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Warning: Delta document generation failed: ${msg}\n`)
      // AC8: degrade gracefully — exit 0
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${msg}\n`)
    logger.error({ err }, 'auto amend failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// registerAutoCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate auto` command group with the CLI program.
 *
 * Registers subcommands: init, run, resume, status.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (unused currently, reserved)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerAutoCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  const auto = program
    .command('auto')
    .description('Autonomous implementation pipeline')

  // ----------- auto init -----------
  auto
    .command('init')
    .description('Initialize a methodology pack and decision store for autonomous pipeline')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option('--force', 'Overwrite existing local pack with bundled version')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (opts: { pack: string; projectRoot: string; outputFormat: string; force?: boolean }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runAutoInit({
        pack: opts.pack,
        projectRoot: opts.projectRoot,
        outputFormat,
        force: opts.force ?? false,
      })
      process.exitCode = exitCode
    })

  // ----------- auto run -----------
  auto
    .command('run')
    .description('Run the autonomous pipeline (use --from to start from a specific phase)')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option(
      '--from <phase>',
      'Start from this phase: analysis, planning, solutioning, implementation',
    )
    .option('--stop-after <phase>', 'Stop pipeline after this phase completes')
    .option('--concept <text>', 'Inline concept text (required when --from analysis)')
    .option('--concept-file <path>', 'Path to a file containing the concept text')
    .option('--stories <keys>', 'Comma-separated story keys (e.g., 10-1,10-2)')
    .option('--concurrency <n>', 'Maximum parallel conflict groups', (v) => parseInt(v, 10), 3)
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--events', 'Emit structured NDJSON events on stdout for programmatic consumption')
    .option('--verbose', 'Show detailed pino log output')
    .option('--help-agent', 'Print a machine-optimized prompt fragment for AI agents and exit')
    .option('--tui', 'Show TUI dashboard')
    .action(
      async (opts: {
        pack: string
        from?: string
        stopAfter?: string
        concept?: string
        conceptFile?: string
        stories?: string
        concurrency: number
        projectRoot: string
        outputFormat: string
        events?: boolean
        verbose?: boolean
        helpAgent?: boolean
        tui?: boolean
      }) => {
        // --help-agent: print agent instructions and exit without running the pipeline
        if (opts.helpAgent) {
          process.exitCode = await runHelpAgent()
          return
        }

        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'

        // Validate --from phase
        let fromPhase: PhaseName | undefined
        if (opts.from !== undefined) {
          if (!VALID_PHASES.includes(opts.from as PhaseName)) {
            const errorMsg = `Invalid phase '${opts.from}'. Valid phases: ${VALID_PHASES.join(', ')}`
            if (outputFormat === 'json') {
              process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
            } else {
              process.stderr.write(`Error: ${errorMsg}\n`)
            }
            process.exitCode = 1
            return
          }
          fromPhase = opts.from as PhaseName
        }

        const exitCode = await runAutoRun({
          pack: opts.pack,
          from: fromPhase,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          concept: opts.concept,
          conceptFile: opts.conceptFile,
          stories: opts.stories,
          concurrency: opts.concurrency,
          outputFormat,
          projectRoot: opts.projectRoot,
          events: opts.events,
          verbose: opts.verbose,
          tui: opts.tui,
        })
        process.exitCode = exitCode
      },
    )

  // ----------- auto resume -----------
  auto
    .command('resume')
    .description('Resume a previously interrupted pipeline run')
    .option('--run-id <id>', 'Pipeline run ID to resume (defaults to latest)')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--stop-after <phase>', 'Stop pipeline after this phase completes (overrides saved state)')
    .option('--concurrency <n>', 'Maximum parallel conflict groups', (v) => parseInt(v, 10), 3)
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(
      async (opts: {
        runId?: string
        stopAfter?: string
        pack: string
        concurrency: number
        projectRoot: string
        outputFormat: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runAutoResume({
          runId: opts.runId,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          outputFormat,
          projectRoot: opts.projectRoot,
          concurrency: opts.concurrency,
          pack: opts.pack,
        })
        process.exitCode = exitCode
      },
    )

  // ----------- auto status -----------
  auto
    .command('status')
    .description('Show status of the most recent (or specified) pipeline run')
    .option('--run-id <id>', 'Pipeline run ID to query (defaults to latest)')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (opts: { runId?: string; projectRoot: string; outputFormat: string }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runAutoStatus({
        outputFormat,
        runId: opts.runId,
        projectRoot: opts.projectRoot,
      })
      process.exitCode = exitCode
    })

  // ----------- auto health -----------
  auto
    .command('health')
    .description('Check pipeline health: process status, stall detection, and verdict')
    .option('--run-id <id>', 'Pipeline run ID to query (defaults to latest)')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (opts: { runId?: string; projectRoot: string; outputFormat: string }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runAutoHealth({
        outputFormat,
        runId: opts.runId,
        projectRoot: opts.projectRoot,
      })
      process.exitCode = exitCode
    })

  // ----------- auto amend -----------
  auto
    .command('amend')
    .description('Run an amendment pipeline against a completed run and an existing run')
    .option('--concept <text>', 'Amendment concept description (inline)')
    .option('--concept-file <path>', 'Path to concept file')
    .option('--run-id <id>', 'Parent run ID (defaults to latest completed run)')
    .option('--stop-after <phase>', 'Stop pipeline after this phase completes')
    .option('--from <phase>', 'Start pipeline from this phase')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(
      async (opts: {
        concept?: string
        conceptFile?: string
        runId?: string
        stopAfter?: string
        from?: string
        pack: string
        projectRoot: string
        outputFormat: string
      }) => {
        const exitCode = await runAmendCommand({
          concept: opts.concept,
          conceptFile: opts.conceptFile,
          runId: opts.runId,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          from: opts.from as PhaseName | undefined,
          projectRoot: opts.projectRoot,
          pack: opts.pack,
        })
        process.exitCode = exitCode
      },
    )
}
