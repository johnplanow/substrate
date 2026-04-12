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
import { existsSync, readFileSync } from 'node:fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  getLatestRun,
  getPipelineRunById,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import type { OutputFormat } from './pipeline-shared.js'
import { formatOutput, parseDbTimestampAsUtc } from './pipeline-shared.js'
import type { StateStore } from '../../modules/state/index.js'
import { createStateStore } from '../../modules/state/index.js'
import { resolveRunManifest } from './manifest-read.js'
import type { PerStoryState } from '@substrate-ai/sdlc'

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
  stateStore?: StateStore
  stateStoreConfig?: { backend?: string; basePath?: string }
}

export type HealthVerdict = 'HEALTHY' | 'STALLED' | 'NO_PIPELINE_RUNNING'

// ---------------------------------------------------------------------------
// DoltStateInfo — Dolt connectivity status for health output
// ---------------------------------------------------------------------------

export interface DoltStateInfo {
  initialized: boolean
  responsive: boolean
  version?: string
  branches?: string[]
  current_branch?: string
}

interface ProcessInfo {
  orchestrator_pid: number | null
  child_pids: number[]
  zombies: number[]
  /** True when the PID file existed and contained a valid PID, but that PID was
   *  not alive in `ps`. Distinguishes "PID file found, process dead" (AC2 → STALLED)
   *  from "no PID file" (AC3 → fall through to existing heuristics). */
  pid_file_dead?: boolean
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
    /** PENDING stories (not yet dispatched). Included so consumers can reconcile
     *  total story count: active + completed + escalated + pending = total stories. */
    pending?: number
    /** FAILED stories (failed or verification-failed). Populated when manifest is available. */
    failed?: number
    details: Record<string, { phase: string; review_cycles: number }>
  }
  /** Supervisor ownership from run manifest (when available — AC2). */
  manifest_supervisor?: {
    pid: number | null
    session_id: string | null
  }
  /** Dolt state connectivity info. Present only when Dolt backend is configured. */
  dolt_state?: DoltStateInfo
  /** Non-fatal warnings that indicate degraded pipeline operation */
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Process inspection
// ---------------------------------------------------------------------------

/**
 * Determine whether a ps output line represents the substrate pipeline orchestrator.
 * Handles invocation via:
 *   - `substrate run` (globally installed)
 *   - `substrate-ai run`
 *   - `node dist/cli/index.mjs run` (npm run substrate:dev)
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
  else if (line.includes('index.mjs run') || line.includes('index.js run')) isOrchestrator = true
  // Match node processes where 'run' is a complete argument token (not a substring
  // of another word like 'dry-run-tool'). Require whitespace before 'run' and
  // whitespace or end-of-string after 'run'. Also match processes with substrate
  // CLI path patterns (dist/cli/index.mjs, substrate-ai).
  else if (
    line.includes('node') &&
    /\srun(\s|$)/.test(line) &&
    (line.includes('substrate') || line.includes('--events') || line.includes('--stories'))
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
  /**
   * Path to the `.substrate` directory for the target project.
   * When provided, `inspectProcessTree` first checks for `orchestrator.pid`
   * inside this directory (written by `substrate run` at startup). This
   * enables cross-project process detection where the project root path may
   * not appear in the process command line (e.g. when substrate is invoked
   * from the target project's directory via CWD rather than `--project-root`).
   */
  substrateDirPath?: string
  execFileSync?: ExecFileSyncFn
  /** Injectable readFileSync for testing the PID-file path */
  readFileSync?: (path: string, encoding: string) => string
}

export function inspectProcessTree(opts?: InspectProcessTreeOptions): ProcessInfo {
  const { projectRoot, substrateDirPath, execFileSync: execFileSyncOverride, readFileSync: readFileSyncOverride } = opts ?? {}
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

    // -----------------------------------------------------------------------
    // Primary: PID-file based detection (AC1, AC3 — cross-project fix)
    //
    // `substrate run` writes its PID to `.substrate/orchestrator.pid` at
    // startup. When `substrateDirPath` is provided, we read that file directly
    // and verify the PID is still alive in the ps output. This works even when
    // `--project-root` does not appear in the process command line (i.e. when
    // the orchestrator was started from the target project's CWD).
    // -----------------------------------------------------------------------
    if (substrateDirPath !== undefined) {
      try {
        const readFileSyncFn = readFileSyncOverride ??
          ((path: string, encoding: string) => readFileSync(path, encoding as BufferEncoding))
        const pidContent = readFileSyncFn(join(substrateDirPath, 'orchestrator.pid'), 'utf-8')
        const pid = parseInt(pidContent.trim(), 10)
        if (!isNaN(pid) && pid > 0) {
          // Verify the PID is still alive and not a zombie by checking the ps output
          const isAlive = lines.some((line) => {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 3) return false
            return parseInt(parts[0], 10) === pid && !parts[2].includes('Z')
          })
          if (isAlive) {
            result.orchestrator_pid = pid
          } else {
            // PID file exists but process is dead — flag so verdict logic can
            // return STALLED per AC2, even when DB is fresh and active=0.
            result.pid_file_dead = true
          }
        }
      } catch {
        // PID file doesn't exist or can't be read — fall through to command-line matching
      }
    }

    // -----------------------------------------------------------------------
    // Fallback: command-line pattern matching
    //
    // Used when no PID file is available (older substrate versions, or the
    // PID file was cleaned up before health was polled).
    // When projectRoot is provided, only match orchestrators for that project.
    // -----------------------------------------------------------------------
    if (result.orchestrator_pid === null) {
      for (const line of lines) {
        if (isOrchestratorProcessLine(line, projectRoot)) {
          const match = line.trim().match(/^(\d+)/)
          if (match) {
            result.orchestrator_pid = parseInt(match[1], 10)
            break
          }
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
// Manifest → health story count helpers
// ---------------------------------------------------------------------------

interface ManifestStoryCounts {
  active: number
  completed: number
  escalated: number
  pending: number
  failed: number
}

/**
 * Derive health story counts from manifest `per_story_state`.
 * Maps manifest status strings to health output buckets.
 */
function buildHealthStoryCountsFromManifest(
  perStoryState: Record<string, PerStoryState>,
): ManifestStoryCounts {
  const counts: ManifestStoryCounts = { active: 0, completed: 0, escalated: 0, pending: 0, failed: 0 }
  for (const entry of Object.values(perStoryState)) {
    switch (entry.status) {
      case 'complete':
        counts.completed++
        break
      case 'escalated':
        counts.escalated++
        break
      case 'failed':
      case 'verification-failed':
        counts.failed++
        break
      case 'pending':
      case 'gated':
        counts.pending++
        break
      case 'dispatched':
      case 'in-review':
      case 'recovered':
      default:
        counts.active++
        break
    }
  }
  return counts
}

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
  stateStore?: StateStore
  stateStoreConfig?: { backend?: string; basePath?: string }
  /** @internal test-only: override process tree inspection result */
  _processInfoOverride?: ProcessInfo
}): Promise<PipelineHealthOutput> {
  const { runId, projectRoot, stateStore, stateStoreConfig } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  // Task 4 (AC3): Compute Dolt connectivity info regardless of pipeline run status
  let doltStateInfo: DoltStateInfo | undefined
  if (stateStoreConfig?.backend === 'dolt' && stateStore) {
    const repoPath = stateStoreConfig.basePath ?? projectRoot
    const doltDirPath = join(repoPath, '.dolt')
    const initialized = existsSync(doltDirPath)
    let responsive = false
    let version: string | undefined
    let branches: string[] | undefined
    let currentBranch: string | undefined
    try {
      await stateStore.getHistory(1)
      responsive = true
      // Try to get dolt version and branch info
      try {
        const { execFile: ef } = await import('node:child_process')
        const { promisify: p } = await import('node:util')
        const execFileAsync = p(ef)
        const { stdout } = await execFileAsync('dolt', ['version'])
        const match = stdout.match(/dolt version (\S+)/)
        if (match) version = match[1]
      } catch { /* ignore */ }
      // List branches
      try {
        const { execFile: ef } = await import('node:child_process')
        const { promisify: p } = await import('node:util')
        const execFileAsync = p(ef)
        const { stdout } = await execFileAsync('dolt', ['branch', '--list'], { cwd: repoPath })
        const lines = stdout.split('\n').filter((l: string) => l.trim().length > 0)
        branches = lines.map((l: string) => {
          const trimmed = l.trim()
          if (trimmed.startsWith('* ')) {
            currentBranch = trimmed.slice(2).trim()
            return currentBranch
          }
          return trimmed
        })
      } catch { /* ignore — dolt branch may fail if not a dolt repo */ }
    } catch {
      responsive = false
    }
    doltStateInfo = {
      initialized,
      responsive,
      ...(version !== undefined ? { version } : {}),
      ...(branches !== undefined ? { branches } : {}),
      ...(currentBranch !== undefined ? { current_branch: currentBranch } : {}),
    }
  }

  const NO_PIPELINE: PipelineHealthOutput = {
    verdict: 'NO_PIPELINE_RUNNING',
    run_id: null,
    status: null,
    current_phase: null,
    staleness_seconds: 0,
    last_activity: '',
    process: { orchestrator_pid: null, child_pids: [], zombies: [] },
    stories: { active: 0, completed: 0, escalated: 0, details: {} },
    ...(doltStateInfo !== undefined ? { dolt_state: doltStateInfo } : {}),
  }

  const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')
  if (!existsSync(dbPath) && !existsSync(doltDir)) {
    return NO_PIPELINE
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
  try {
    await initSchema(adapter)

    let run: PipelineRun | undefined
    if (runId !== undefined) {
      run = await getPipelineRunById(adapter, runId)
    } else {
      // AC2: Try current-run-id file before falling back to getLatestRun() (Story 39-3)
      // This ensures health reports on the correct active run, not a stale one.
      let currentRunId: string | undefined
      try {
        const currentRunIdPath = join(dbRoot, '.substrate', 'current-run-id')
        const content = readFileSync(currentRunIdPath, 'utf-8').trim()
        // Validate UUID format to guard against corrupted file content (Story 39-3 AC2)
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if (UUID_RE.test(content)) {
          currentRunId = content
        }
      } catch {
        // File doesn't exist or can't be read — fall through to getLatestRun()
      }

      if (currentRunId !== undefined) {
        run = await getPipelineRunById(adapter, currentRunId)
      }
      if (run === undefined) {
        // AC3: Fallback to getLatestRun() for backward compatibility
        run = await getLatestRun(adapter)
      }
    }

    if (run === undefined) {
      // No DB run record — but check if a process is alive anyway.
      // The pipeline may not write to the DB (e.g., cross-project runs with
      // adapter issues) while still actively running.
      const substrateDirPath = join(dbRoot, '.substrate')
      const fallbackProcessInfo = inspectProcessTree({ projectRoot: dbRoot, substrateDirPath })
      if (fallbackProcessInfo.orchestrator_pid !== null) {
        return {
          verdict: 'HEALTHY',
          run_id: null,
          status: 'running',
          current_phase: 'implementation',
          staleness_seconds: 0,
          last_activity: new Date().toISOString(),
          process: fallbackProcessInfo,
          stories: { active: 0, completed: 0, escalated: 0, details: {} },
          ...(doltStateInfo !== undefined ? { dolt_state: doltStateInfo } : {}),
        }
      }
      return NO_PIPELINE
    }

    // Compute staleness — parse timestamp as UTC to avoid timezone shift
    const updatedAt = parseDbTimestampAsUtc(run.updated_at ?? '')
    const stalenessSeconds = Math.round((Date.now() - updatedAt.getTime()) / 1000)

    // Parse story state from token_usage_json (Dolt-based fallback)
    let storyDetails: Record<string, { phase: string; review_cycles: number }> = {}
    let active = 0
    let completed = 0
    let escalated = 0
    let pending = 0

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
            else if (s.phase === 'PENDING') pending++
            else active++
          }
        }
      }
    } catch {
      // ignore parse errors
    }

    // Story 52-6 (AC2, AC4): Read supervisor ownership and per-story counts from manifest.
    // Manifest-derived counts replace Dolt token_usage_json counts when available.
    let manifestSupervisor: { pid: number | null; session_id: string | null } | undefined
    let manifestStoryCounts: ManifestStoryCounts | undefined

    try {
      const { manifest: resolvedManifest } = await resolveRunManifest(dbRoot, run.id)
      if (resolvedManifest !== null) {
        const manifestData = await resolvedManifest.read()
        manifestSupervisor = {
          pid: manifestData.supervisor_pid,
          session_id: manifestData.supervisor_session_id,
        }
        manifestStoryCounts = buildHealthStoryCountsFromManifest(manifestData.per_story_state)
        logger.debug({ runId: run.id }, 'health: story counts and supervisor read from manifest')
      }
    } catch {
      // Non-fatal: fall back to token_usage_json counts (AC4)
      logger.debug({ runId: run.id }, 'health: manifest read failed — using token_usage_json counts')
    }

    // Use manifest counts if available; fall back to token_usage_json counts (AC4)
    const finalActive = manifestStoryCounts?.active ?? active
    const finalCompleted = manifestStoryCounts?.completed ?? completed
    const finalEscalated = manifestStoryCounts?.escalated ?? escalated
    const finalPending = manifestStoryCounts?.pending ?? pending
    const finalFailed = manifestStoryCounts?.failed

    // Inspect process tree — scope to this project so multi-project setups
    // match the correct orchestrator process.
    // Pass substrateDirPath so inspectProcessTree can use the PID file written
    // by `substrate run` — this is the primary fix for cross-project detection
    // where --project-root may not appear in the process command line (AC1, AC3).
    const substrateDirPath = join(dbRoot, '.substrate')
    const processInfo = options._processInfoOverride ?? inspectProcessTree({ projectRoot, substrateDirPath })

    // Derive verdict
    // Priority order (AC1 → AC2 → AC3 heuristics):
    //
    // AC1/AC4/AC5: orchestrator_pid alive → HEALTHY regardless of child count,
    //   zombies, or DB staleness. The live PID is the authoritative health signal.
    // AC2: PID file found but process dead (pid_file_dead=true) → STALLED, with no
    //   carve-outs for fresh DB or zero active stories.
    // AC3: No PID file → fall through to existing heuristics (zombies, DB staleness,
    //   active story count). Fresh DB + 0 active + no PID file → HEALTHY (optimistic).
    let verdict: HealthVerdict = 'NO_PIPELINE_RUNNING'
    if (run.status === 'running') {
      if (processInfo.orchestrator_pid !== null) {
        // AC1: Orchestrator is alive — HEALTHY regardless of zombie children,
        // child count, or DB staleness (AC4, AC5).
        verdict = 'HEALTHY'
      } else if (processInfo.pid_file_dead === true) {
        // AC2: PID file existed but process is dead — STALLED with no carve-outs.
        verdict = 'STALLED'
      } else if (processInfo.zombies.length > 0) {
        // AC3 heuristic: zombie children with no live orchestrator → STALLED
        verdict = 'STALLED'
      } else if (stalenessSeconds > DEFAULT_STALL_THRESHOLD_SECONDS) {
        // AC3 heuristic: no orchestrator found + DB is stale → STALLED
        verdict = 'STALLED'
      } else if (finalActive > 0) {
        // AC3 heuristic: no orchestrator found but stories actively tracked
        // (process died without cleanup)
        verdict = 'STALLED'
      } else {
        // AC3 heuristic: no PID file, fresh DB, 0 active — optimistic HEALTHY
        verdict = 'HEALTHY'
      }
    } else if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
      verdict = 'NO_PIPELINE_RUNNING'
    }

    // Collect non-fatal degradation warnings
    const warnings: string[] = []
    if (doltStateInfo !== undefined && doltStateInfo.responsive === false) {
      warnings.push('Dolt not connected — decision store queries may fail, story context will be degraded')
    }
    if (finalEscalated > 0) {
      warnings.push(`${finalEscalated} story(ies) escalated — operator intervention may be needed`)
    }

    const healthOutput: PipelineHealthOutput = {
      verdict,
      run_id: run.id,
      status: run.status,
      current_phase: run.current_phase ?? null,
      staleness_seconds: stalenessSeconds,
      last_activity: run.updated_at ?? '',
      process: processInfo,
      stories: {
        active: finalActive,
        completed: finalCompleted,
        escalated: finalEscalated,
        pending: finalPending,
        ...(finalFailed !== undefined ? { failed: finalFailed } : {}),
        details: storyDetails,
      },
      ...(manifestSupervisor !== undefined ? { manifest_supervisor: manifestSupervisor } : {}),
      ...(doltStateInfo !== undefined ? { dolt_state: doltStateInfo } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }

    return healthOutput
  } finally {
    try {
      await adapter.close()
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

      // Recommended next actions based on verdict
      if (health.verdict === 'STALLED') {
        process.stdout.write('\n  Recommended Actions:\n')
        if (health.process.orchestrator_pid !== null) {
          process.stdout.write(`    1. Kill stalled orchestrator: kill ${health.process.orchestrator_pid}\n`)
        }
        if (health.process.zombies.length > 0) {
          process.stdout.write(`    ${health.process.orchestrator_pid !== null ? '2' : '1'}. Kill zombie processes: kill ${health.process.zombies.join(' ')}\n`)
        }
        process.stdout.write(`    ${health.process.orchestrator_pid !== null ? '3' : '2'}. Resume the run: substrate resume\n`)
        process.stdout.write(`    ${health.process.orchestrator_pid !== null ? '4' : '3'}. Or start fresh: substrate run --events --stories <keys>\n`)
      } else if (health.verdict === 'NO_PIPELINE_RUNNING' && health.stories.escalated > 0) {
        process.stdout.write('\n  Recommended Actions:\n')
        process.stdout.write('    1. Retry escalated stories: substrate retry-escalated\n')
        process.stdout.write('    2. Or start a new run: substrate run --events\n')
      }

      // Degradation warnings
      if (health.warnings !== undefined && health.warnings.length > 0) {
        process.stdout.write('\n  Warnings:\n')
        for (const w of health.warnings) {
          process.stdout.write(`    ⚠ ${w}\n`)
        }
      }

      // Task 4 (AC3): Dolt state connectivity info — shown regardless of run_id
      if (health.dolt_state !== undefined) {
        const ds = health.dolt_state
        const initStr = ds.initialized ? 'yes' : 'no'
        const respStr = ds.responsive ? 'yes' : 'no'
        const verStr = ds.version !== undefined ? ` (v${ds.version})` : ''
        process.stdout.write(`\n  Dolt State:   initialized=${initStr} responsive=${respStr}${verStr}\n`)
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
      const root = opts.projectRoot

      // Task 5: Wire StateStore factory using Dolt path detection (same pattern as metrics.ts)
      let stateStore: StateStore | undefined
      let stateStoreConfig: { backend?: string; basePath?: string } | undefined
      const doltStatePath = join(root, '.substrate', 'state', '.dolt')
      if (existsSync(doltStatePath)) {
        const basePath = join(root, '.substrate', 'state')
        stateStoreConfig = { backend: 'dolt', basePath }
        try {
          stateStore = createStateStore({ backend: 'dolt', basePath })
          await stateStore.initialize()
        } catch {
          stateStore = undefined
          stateStoreConfig = undefined
        }
      }

      try {
        const exitCode = await runHealthAction({
          outputFormat,
          runId: opts.runId,
          projectRoot: root,
          stateStore,
          stateStoreConfig,
        })
        process.exitCode = exitCode
      } finally {
        try { await stateStore?.close() } catch { /* ignore */ }
      }
    })
}
