/**
 * `substrate health` command
 *
 * Checks pipeline health: process status, stall detection, and verdict.
 *
 * Usage:
 *   substrate health                          Check health of latest pipeline run
 *   substrate health --run-id <id>           Check health of specific run
 *   substrate health --output-format json    JSON output
 *
 * Exit codes:
 *   0 - Success (health check completed, any verdict)
 *   1 - Error
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import {
  getLatestRun,
  getPipelineRunById,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import type { OutputFormat } from './pipeline-shared.js'
import { formatOutput, parseDbTimestampAsUtc } from './pipeline-shared.js'

const logger = createLogger('health-cmd')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default stall threshold in seconds — also used by supervisor default */
export const DEFAULT_STALL_THRESHOLD_SECONDS = 600

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthOptions {
  outputFormat: OutputFormat
  runId?: string
  projectRoot: string
}

export type HealthVerdict = 'HEALTHY' | 'STALLED' | 'NO_PIPELINE_RUNNING'

interface ProcessInfo {
  orchestrator_pid: number | null
  child_pids: number[]
  zombies: number[]
}

export interface PipelineHealthOutput {
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

// ---------------------------------------------------------------------------
// Process inspection
// ---------------------------------------------------------------------------

/**
 * Determine whether a ps output line represents the substrate pipeline orchestrator.
 * Handles invocation via:
 *   - `substrate run` (globally installed)
 *   - `substrate-ai run`
 *   - `node dist/cli/index.js run` (npm run substrate:dev)
 *   - `npx substrate run`
 *   - any node process whose command contains `run` with `--events` or `--stories`
 *
 * When `projectRoot` is provided, additionally checks that the command line
 * contains that path (via `--project-root` flag or as part of the binary/CWD path).
 * This ensures multi-project environments match the correct orchestrator.
 */
export function isOrchestratorProcessLine(line: string, projectRoot?: string): boolean {
  if (line.includes('grep')) return false
  let isOrchestrator = false
  if (line.includes('substrate run')) isOrchestrator = true
  else if (line.includes('substrate-ai run')) isOrchestrator = true
  else if (line.includes('index.js run')) isOrchestrator = true
  // Match node processes where 'run' is a complete argument token (not a substring
  // of another word like 'dry-run-tool'). Require whitespace before 'run' and
  // whitespace or end-of-string after 'run'.
  else if (
    line.includes('node') &&
    /\srun(\s|$)/.test(line) &&
    (line.includes('--events') || line.includes('--stories'))
  ) {
    isOrchestrator = true
  }

  if (!isOrchestrator) return false

  // When projectRoot is specified, scope to orchestrators for that project
  if (projectRoot !== undefined) {
    return line.includes(projectRoot)
  }

  return true
}

/** Injectable execFileSync for testing */
export type ExecFileSyncFn = (
  file: string,
  args: string[],
  opts: { encoding: string; timeout: number },
) => string

export interface InspectProcessTreeOptions {
  projectRoot?: string
  execFileSync?: ExecFileSyncFn
}

export function inspectProcessTree(opts?: InspectProcessTreeOptions): ProcessInfo {
  const { projectRoot, execFileSync: execFileSyncOverride } = opts ?? {}
  const result: ProcessInfo = { orchestrator_pid: null, child_pids: [], zombies: [] }
  try {
    let psOutput: string
    if (execFileSyncOverride !== undefined) {
      psOutput = execFileSyncOverride('ps', ['-eo', 'pid,ppid,stat,command'], { encoding: 'utf-8', timeout: 5000 })
    } else {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
      psOutput = execFileSync('ps', ['-eo', 'pid,ppid,stat,command'], { encoding: 'utf-8', timeout: 5000 }) as string
    }
    const lines = psOutput.split('\n')

    // Find substrate run process — match multiple invocation patterns
    // When projectRoot is provided, only match orchestrators for that project
    for (const line of lines) {
      if (isOrchestratorProcessLine(line, projectRoot)) {
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

// ---------------------------------------------------------------------------
// Recursive descendant PID collection (AC8: orphan cleanup)
// ---------------------------------------------------------------------------

/**
 * Collect all descendant PIDs of the given root PIDs by walking the process
 * tree recursively. This ensures that grandchildren of the orchestrator
 * (e.g. node subprocesses spawned by `claude -p`) are also killed during
 * stall recovery, leaving no orphan processes.
 *
 * Returns only the descendants — the root PIDs themselves are NOT included.
 */
export function getAllDescendantPids(
  rootPids: number[],
  execFileSyncOverride?: ExecFileSyncFn,
): number[] {
  if (rootPids.length === 0) return []
  try {
    let psOutput: string
    if (execFileSyncOverride !== undefined) {
      psOutput = execFileSyncOverride('ps', ['-eo', 'pid,ppid'], { encoding: 'utf-8', timeout: 5000 })
    } else {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
      psOutput = execFileSync('ps', ['-eo', 'pid,ppid'], { encoding: 'utf-8', timeout: 5000 }) as string
    }

    // Build parent → children map from ps output
    const childrenOf = new Map<number, number[]>()
    for (const line of psOutput.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2) {
        const pid = parseInt(parts[0], 10)
        const ppid = parseInt(parts[1], 10)
        if (!isNaN(pid) && !isNaN(ppid) && pid > 0) {
          if (!childrenOf.has(ppid)) childrenOf.set(ppid, [])
          childrenOf.get(ppid)!.push(pid)
        }
      }
    }

    // BFS to collect all descendants (not including the root PIDs themselves)
    const descendants: number[] = []
    const seen = new Set<number>(rootPids)
    const queue: number[] = [...rootPids]
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = childrenOf.get(current) ?? []
      for (const child of children) {
        if (!seen.has(child)) {
          seen.add(child)
          descendants.push(child)
          queue.push(child)
        }
      }
    }
    return descendants
  } catch {
    // Process inspection failed — return empty (degrade gracefully)
    return []
  }
}

// parseDbTimestampAsUtc is imported from pipeline-shared.ts

// ---------------------------------------------------------------------------
// Health data fetch (used by supervisor and tests)
// ---------------------------------------------------------------------------

/**
 * Fetch pipeline health data as a structured object without any stdout side-effects.
 * Used by runSupervisorAction to poll health without formatting overhead.
 *
 * Returns a NO_PIPELINE_RUNNING health object for all graceful "no data" cases
 * (missing DB, missing run, terminal run status). Throws only on unexpected errors.
 */
export async function getAutoHealthData(options: {
  runId?: string
  projectRoot: string
}): Promise<PipelineHealthOutput> {
  const { runId, projectRoot } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  const NO_PIPELINE: PipelineHealthOutput = {
    verdict: 'NO_PIPELINE_RUNNING',
    run_id: null,
    status: null,
    current_phase: null,
    staleness_seconds: 0,
    last_activity: '',
    process: { orchestrator_pid: null, child_pids: [], zombies: [] },
    stories: { active: 0, completed: 0, escalated: 0, details: {} },
  }

  if (!existsSync(dbPath)) {
    return NO_PIPELINE
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
      return NO_PIPELINE
    }

    // Compute staleness — parse timestamp as UTC to avoid timezone shift
    const updatedAt = parseDbTimestampAsUtc(run.updated_at)
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

    // Inspect process tree — scope to this project so multi-project setups
    // match the correct orchestrator process
    const processInfo = inspectProcessTree({ projectRoot })

    // Derive verdict
    let verdict: HealthVerdict = 'NO_PIPELINE_RUNNING'
    if (run.status === 'running') {
      if (processInfo.orchestrator_pid === null && active === 0 && completed > 0) {
        // Orchestrator exited, no active stories, all completed — pipeline is done
        // even though the DB row wasn't updated to "completed"
        verdict = 'NO_PIPELINE_RUNNING'
      } else if (processInfo.zombies.length > 0) {
        verdict = 'STALLED'
      } else if (processInfo.orchestrator_pid !== null && processInfo.child_pids.length > 0 && stalenessSeconds > DEFAULT_STALL_THRESHOLD_SECONDS) {
        // Children are alive and not zombies — pipeline is actively working even
        // though DB hasn't been updated (agent mid-execution). Treat as HEALTHY.
        verdict = 'HEALTHY'
      } else if (stalenessSeconds > DEFAULT_STALL_THRESHOLD_SECONDS) {
        verdict = 'STALLED'
      } else if (processInfo.orchestrator_pid !== null && processInfo.child_pids.length === 0 && active > 0) {
        verdict = 'STALLED'
      } else {
        verdict = 'HEALTHY'
      }
    } else if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
      verdict = 'NO_PIPELINE_RUNNING'
    }

    return {
      verdict,
      run_id: run.id,
      status: run.status,
      current_phase: run.current_phase,
      staleness_seconds: stalenessSeconds,
      last_activity: run.updated_at,
      process: processInfo,
      stories: { active, completed, escalated, details: storyDetails },
    }
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Health action
// ---------------------------------------------------------------------------

export async function runHealthAction(options: HealthOptions): Promise<number> {
  const { outputFormat } = options

  try {
    const health = await getAutoHealthData(options)

    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(health, 'json', true) + '\n')
    } else {
      // Human-readable output
      const verdictLabel = health.verdict === 'HEALTHY' ? 'HEALTHY'
        : health.verdict === 'STALLED' ? 'STALLED'
        : 'NO PIPELINE RUNNING'
      process.stdout.write(`\nPipeline Health: ${verdictLabel}\n`)

      if (health.run_id !== null) {
        process.stdout.write(`  Run:          ${health.run_id}\n`)
        process.stdout.write(`  Status:       ${health.status}\n`)
        process.stdout.write(`  Phase:        ${health.current_phase ?? 'N/A'}\n`)
        process.stdout.write(`  Last Active:  ${health.last_activity} (${health.staleness_seconds}s ago)\n`)

        const processInfo = health.process
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

        const storyDetails = health.stories.details
        if (Object.keys(storyDetails).length > 0) {
          process.stdout.write('\n  Stories:\n')
          for (const [key, s] of Object.entries(storyDetails)) {
            process.stdout.write(`    ${key}: ${s.phase} (${s.review_cycles} review cycles)\n`)
          }
          process.stdout.write(
            `\n  Summary: ${health.stories.active} active, ${health.stories.completed} completed, ${health.stories.escalated} escalated\n`,
          )
        }
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
    logger.error({ err }, 'health action failed')
    return 1
  }
}

// ---------------------------------------------------------------------------
// registerHealthCommand
// ---------------------------------------------------------------------------

export function registerHealthCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
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
      const exitCode = await runHealthAction({
        outputFormat,
        runId: opts.runId,
        projectRoot: opts.projectRoot,
      })
      process.exitCode = exitCode
    })
}
