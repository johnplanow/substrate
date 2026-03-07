/**
 * Implementation Orchestrator — factory and core implementation.
 *
 * Orchestrates the create-story → dev-story → code-review pipeline for a set
 * of story keys with retry logic, escalation, parallel conflict-group
 * execution, pause/resume control, and SQLite state persistence.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../methodology-pack/types.js'
import type { ContextCompiler } from '../context-compiler/context-compiler.js'
import type { Dispatcher } from '../agent-dispatch/types.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { TokenCeilings } from '../config/config-schema.js'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { updatePipelineRun, getDecisionsByPhase, getDecisionsByCategory, registerArtifact, createDecision } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { writeStoryMetrics, aggregateTokenUsageForStory } from '../../persistence/queries/metrics.js'
import { STORY_METRICS, ESCALATION_DIAGNOSIS, STORY_OUTCOME, TEST_EXPANSION_FINDING, ADVISORY_NOTES } from '../../persistence/schemas/operational.js'
import { generateEscalationDiagnosis } from './escalation-diagnosis.js'
import { assemblePrompt } from '../compiled-workflows/prompt-assembler.js'
import { DevStoryResultSchema } from '../compiled-workflows/schemas.js'
import { runCreateStory, isValidStoryFile } from '../compiled-workflows/create-story.js'
import { runDevStory } from '../compiled-workflows/dev-story.js'
import { runCodeReview } from '../compiled-workflows/code-review.js'
import { runTestPlan } from '../compiled-workflows/test-plan.js'
import { runTestExpansion } from '../compiled-workflows/test-expansion.js'
import { analyzeStoryComplexity, planTaskBatches } from '../compiled-workflows/index.js'
import { detectConflictGroupsWithContracts } from './conflict-detector.js'
import type { ContractDeclaration } from './conflict-detector.js'
import { inspectProcessTree } from '../../cli/commands/health.js'
import type { ImplementationOrchestrator } from './orchestrator.js'
import type {
  OrchestratorConfig,
  OrchestratorState,
  OrchestratorStatus,
  StoryPhase,
  StoryState,
  DecompositionMetrics,
  PerBatchMetrics,
} from './types.js'
import { addTokenUsage } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import { seedMethodologyContext } from './seed-methodology-context.js'
import { sleep } from '../../utils/helpers.js'
import { runBuildVerification, checkGitDiffFiles } from '../agent-dispatch/dispatcher-impl.js'
import { detectInterfaceChanges } from '../agent-dispatch/interface-change-detector.js'
import { computeStoryComplexity, resolveFixStoryMaxTurns, logComplexityResult } from '../compiled-workflows/story-complexity.js'
import { parseInterfaceContracts } from '../compiled-workflows/interface-contracts.js'
import { verifyContracts } from './contract-verifier.js'
import type { ContractMismatch } from './types.js'

// ---------------------------------------------------------------------------
// OrchestratorDeps
// ---------------------------------------------------------------------------

/**
 * Dependency injection container for the implementation orchestrator.
 */
export interface OrchestratorDeps {
  /** Better-SQLite3 database instance */
  db: BetterSqlite3Database
  /** Loaded methodology pack */
  pack: MethodologyPack
  /** Context compiler for assembling decision-store context */
  contextCompiler: ContextCompiler
  /** Agent dispatcher for sub-agent spawning */
  dispatcher: Dispatcher
  /** Typed event bus for lifecycle events */
  eventBus: TypedEventBus
  /** Orchestrator configuration */
  config: OrchestratorConfig
  /** Optional project root for file-based context fallback */
  projectRoot?: string
  /** Optional per-workflow token ceiling overrides from parsed config (Story 24-7) */
  tokenCeilings?: TokenCeilings
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pause gate: a promise that resolves when resume() is called.
 * The orchestrator awaits this before starting each new phase.
 */
interface PauseGate {
  promise: Promise<void>
  resolve: () => void
}

function createPauseGate(): PauseGate {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Build the targeted_files content string from a code-review issue list.
 * Deduplicates file paths and includes line numbers where available.
 * Returns empty string when no issues have file references.
 */
function buildTargetedFilesContent(issueList: unknown[]): string {
  const seen = new Map<string, Set<number>>()
  for (const issue of issueList) {
    const iss = issue as { file?: string; line?: number }
    if (!iss.file) continue
    if (!seen.has(iss.file)) seen.set(iss.file, new Set())
    if (iss.line !== undefined) seen.get(iss.file)!.add(iss.line)
  }
  if (seen.size === 0) return ''
  const lines: string[] = []
  for (const [file, lineNums] of seen) {
    if (lineNums.size > 0) {
      const sorted = [...lineNums].sort((a, b) => a - b)
      lines.push(`- ${file} (lines: ${sorted.join(', ')})`)
    } else {
      lines.push(`- ${file}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// createImplementationOrchestrator
// ---------------------------------------------------------------------------

/**
 * Factory function that creates an ImplementationOrchestrator instance.
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher,
 *               eventBus, config)
 * @returns A fully-configured ImplementationOrchestrator ready to call run()
 */
export function createImplementationOrchestrator(
  deps: OrchestratorDeps,
): ImplementationOrchestrator {
  const { db, pack, contextCompiler, dispatcher, eventBus, config, projectRoot, tokenCeilings } = deps

  const logger = createLogger('implementation-orchestrator')

  // -- mutable orchestrator state --

  let _state: OrchestratorState = 'IDLE'
  let _startedAt: string | undefined
  let _completedAt: string | undefined
  let _decomposition: DecompositionMetrics | undefined

  const _stories = new Map<string, StoryState>()

  let _paused = false
  let _pauseGate: PauseGate | null = null

  // -- heartbeat / watchdog state --
  let _lastProgressTs = Date.now()
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const HEARTBEAT_INTERVAL_MS = 30_000
  const DEFAULT_STALL_THRESHOLD_MS = 600_000 // 10 minutes
  const DEV_STORY_STALL_THRESHOLD_MS = 900_000 // 15 minutes — dev-story commonly runs 10-15 min
  // Track which stories have already emitted a stall event to prevent duplicates
  const _stalledStories = new Set<string>()
  // Track which stories ever stalled (persistent — never cleared) for story-metrics decision
  const _storiesWithStall = new Set<string>()

  // -- per-story phase timing state (for AC2 of Story 17-2) --
  const _phaseStartMs = new Map<string, Map<string, number>>() // storyKey → phase → start ms
  const _phaseEndMs = new Map<string, Map<string, number>>()   // storyKey → phase → end ms
  const _storyDispatches = new Map<string, number>()           // storyKey → dispatch count

  // -- actual peak concurrency observed during runWithConcurrency --
  let _maxConcurrentActual = 0

  // -- post-sprint contract verification mismatches (Story 25-6) --
  let _contractMismatches: ContractMismatch[] | undefined

  // -- memory pressure backoff (Story 23-8, AC1) --
  // Exponential backoff intervals (ms) before retrying a story dispatch
  // when memory pressure is detected.  After all intervals are exhausted
  // the story is escalated with reason 'memory_pressure_exhausted'.
  const MEMORY_PRESSURE_BACKOFF_MS = [30_000, 60_000, 120_000]

  function startPhase(storyKey: string, phase: string): void {
    if (!_phaseStartMs.has(storyKey)) _phaseStartMs.set(storyKey, new Map())
    _phaseStartMs.get(storyKey)!.set(phase, Date.now())
  }

  function endPhase(storyKey: string, phase: string): void {
    if (!_phaseEndMs.has(storyKey)) _phaseEndMs.set(storyKey, new Map())
    _phaseEndMs.get(storyKey)!.set(phase, Date.now())
  }

  function incrementDispatches(storyKey: string): void {
    _storyDispatches.set(storyKey, (_storyDispatches.get(storyKey) ?? 0) + 1)
  }

  function buildPhaseDurationsJson(storyKey: string): string {
    const starts = _phaseStartMs.get(storyKey)
    const ends = _phaseEndMs.get(storyKey)
    if (!starts || starts.size === 0) return '{}'
    const durations: Record<string, number> = {}
    const nowMs = Date.now()
    for (const [phase, startMs] of starts) {
      const endMs = ends?.get(phase)
      if (endMs === undefined) {
        logger.warn(
          { storyKey, phase },
          'Phase has no end time — story may have errored mid-phase. Duration capped to now() and may be inflated.',
        )
      }
      durations[phase] = Math.round(((endMs ?? nowMs) - startMs) / 1000)
    }
    return JSON.stringify(durations)
  }

  function writeStoryMetricsBestEffort(storyKey: string, result: string, reviewCycles: number): void {
    if (config.pipelineRunId === undefined) return
    try {
      const storyState = _stories.get(storyKey)
      const startedAt = storyState?.startedAt
      const completedAt = storyState?.completedAt ?? new Date().toISOString()
      const wallClockSeconds = startedAt
        ? Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000)
        : 0
      // Compute wall-clock ms (higher precision than seconds) for event payload
      const wallClockMs = startedAt
        ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
        : 0
      const tokenAgg = aggregateTokenUsageForStory(db, config.pipelineRunId, storyKey)
      // Capture phase durations JSON once so it can be reused for the event payload
      const phaseDurationsJson = buildPhaseDurationsJson(storyKey)
      writeStoryMetrics(db, {
        run_id: config.pipelineRunId,
        story_key: storyKey,
        result,
        phase_durations_json: phaseDurationsJson,
        started_at: startedAt,
        completed_at: completedAt,
        wall_clock_seconds: wallClockSeconds,
        input_tokens: tokenAgg.input,
        output_tokens: tokenAgg.output,
        cost_usd: tokenAgg.cost,
        review_cycles: reviewCycles,
        dispatches: _storyDispatches.get(storyKey) ?? 0,
      })
      // AC4 of Story 21-1: also write story-metrics decision for queryable insight
      try {
        const runId = config.pipelineRunId ?? 'unknown'
        createDecision(db, {
          pipeline_run_id: config.pipelineRunId,
          phase: 'implementation',
          category: STORY_METRICS,
          key: `${storyKey}:${runId}`,
          value: JSON.stringify({
            wall_clock_seconds: wallClockSeconds,
            input_tokens: tokenAgg.input,
            output_tokens: tokenAgg.output,
            review_cycles: reviewCycles,
            stalled: _storiesWithStall.has(storyKey),
          }),
          rationale: `Story ${storyKey} completed with result=${result} in ${wallClockSeconds}s. Tokens: ${tokenAgg.input}+${tokenAgg.output}. Review cycles: ${reviewCycles}.`,
        })
      } catch (decisionErr) {
        logger.warn({ err: decisionErr, storyKey }, 'Failed to write story-metrics decision (best-effort)')
      }
      // Story 24-4 (AC8): emit story:metrics event for NDJSON consumers
      try {
        // Build per-phase breakdown in ms from raw timestamps (higher precision)
        const phaseBreakdown: Record<string, number> = {}
        const starts = _phaseStartMs.get(storyKey)
        const ends = _phaseEndMs.get(storyKey)
        if (starts) {
          const nowMs = Date.now()
          for (const [phase, startMs] of starts) {
            const endMs = ends?.get(phase)
            phaseBreakdown[phase] = endMs !== undefined ? endMs - startMs : nowMs - startMs
          }
        }
        eventBus.emit('story:metrics', {
          storyKey,
          wallClockMs,
          phaseBreakdown,
          tokens: { input: tokenAgg.input, output: tokenAgg.output },
          reviewCycles,
          dispatches: _storyDispatches.get(storyKey) ?? 0,
        })
      } catch (emitErr) {
        logger.warn({ err: emitErr, storyKey }, 'Failed to emit story:metrics event (best-effort)')
      }
    } catch (err) {
      logger.warn({ err, storyKey }, 'Failed to write story metrics (best-effort)')
    }
  }

  /**
   * Persist a story outcome finding to the decision store (Story 22-1, AC4).
   *
   * Records outcome, review cycles, and any recurring issue patterns for
   * future prompt injection via the learning loop.
   */
  function writeStoryOutcomeBestEffort(
    storyKey: string,
    outcome: 'complete' | 'escalated',
    reviewCycles: number,
    issuePatterns?: string[],
  ): void {
    if (config.pipelineRunId === undefined) return
    try {
      createDecision(db, {
        pipeline_run_id: config.pipelineRunId,
        phase: 'implementation',
        category: STORY_OUTCOME,
        key: `${storyKey}:${config.pipelineRunId}`,
        value: JSON.stringify({
          storyKey,
          outcome,
          reviewCycles,
          recurringPatterns: issuePatterns ?? [],
        }),
        rationale: `Story ${storyKey} ${outcome} after ${reviewCycles} review cycle(s).`,
      })
    } catch (err) {
      logger.warn({ err, storyKey }, 'Failed to write story-outcome decision (best-effort)')
    }
  }

  /**
   * Emit an escalation event with structured diagnosis and persist the
   * diagnosis to the decision store (Story 22-3).
   */
  function emitEscalation(payload: {
    storyKey: string
    lastVerdict: string
    reviewCycles: number
    issues: unknown[]
  }): void {
    const diagnosis = generateEscalationDiagnosis(
      payload.issues,
      payload.reviewCycles,
      payload.lastVerdict,
    )

    eventBus.emit('orchestrator:story-escalated', {
      ...payload,
      diagnosis,
    })

    // Persist diagnosis to decision store (Story 22-3, AC3)
    if (config.pipelineRunId !== undefined) {
      try {
        createDecision(db, {
          pipeline_run_id: config.pipelineRunId,
          phase: 'implementation',
          category: ESCALATION_DIAGNOSIS,
          key: `${payload.storyKey}:${config.pipelineRunId}`,
          value: JSON.stringify(diagnosis),
          rationale: `Escalation diagnosis for ${payload.storyKey}: ${diagnosis.recommendedAction} — ${diagnosis.rationale}`,
        })
      } catch (err) {
        logger.warn({ err, storyKey: payload.storyKey }, 'Failed to persist escalation diagnosis (best-effort)')
      }
    }

    // Persist story outcome for learning loop (Story 22-1, AC4)
    const issuePatterns = extractIssuePatterns(payload.issues)
    writeStoryOutcomeBestEffort(payload.storyKey, 'escalated', payload.reviewCycles, issuePatterns)
  }

  /**
   * Extract short pattern descriptions from an issue list for recurring pattern tracking.
   */
  function extractIssuePatterns(issues: unknown[]): string[] {
    const patterns: string[] = []
    for (const issue of issues) {
      if (typeof issue === 'string') {
        patterns.push(issue.slice(0, 100))
      } else {
        const iss = issue as { description?: string; severity?: string }
        if (iss.description && (iss.severity === 'blocker' || iss.severity === 'major')) {
          patterns.push(iss.description.slice(0, 100))
        }
      }
    }
    return patterns.slice(0, 10)
  }

  // -- helpers --

  function getStatus(): OrchestratorStatus {
    const stories: Record<string, StoryState> = {}
    for (const [key, s] of _stories) {
      stories[key] = { ...s }
    }
    const status: OrchestratorStatus = {
      state: _state,
      stories,
    }
    if (_startedAt !== undefined) status.startedAt = _startedAt
    if (_completedAt !== undefined) {
      status.completedAt = _completedAt
      if (_startedAt !== undefined) {
        status.totalDurationMs =
          new Date(_completedAt).getTime() - new Date(_startedAt).getTime()
      }
    }
    if (_decomposition !== undefined) {
      status.decomposition = { ..._decomposition }
    }
    if (_maxConcurrentActual > 0) {
      status.maxConcurrentActual = _maxConcurrentActual
    }
    if (_contractMismatches !== undefined && _contractMismatches.length > 0) {
      status.contractMismatches = [..._contractMismatches]
    }
    return status
  }

  function updateStory(storyKey: string, updates: Partial<StoryState>): void {
    const existing = _stories.get(storyKey)
    if (existing !== undefined) {
      Object.assign(existing, updates)
    }
  }

  function persistState(): void {
    if (config.pipelineRunId === undefined) return
    recordProgress()
    try {
      const serialized = JSON.stringify(getStatus())
      updatePipelineRun(db, config.pipelineRunId, {
        current_phase: 'implementation',
        token_usage_json: serialized,
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to persist orchestrator state')
    }
  }

  function recordProgress(): void {
    _lastProgressTs = Date.now()
    // Clear stall deduplication set so stories can re-emit stall events after recovering
    _stalledStories.clear()
  }

  function getStallThresholdMs(phase: string): number {
    return phase === 'IN_DEV' ? DEV_STORY_STALL_THRESHOLD_MS : DEFAULT_STALL_THRESHOLD_MS
  }

  function startHeartbeat(): void {
    if (_heartbeatTimer !== null) return
    _heartbeatTimer = setInterval(() => {
      if (_state !== 'RUNNING') return
      let active = 0
      let completed = 0
      let queued = 0
      for (const s of _stories.values()) {
        if (s.phase === 'COMPLETE' || s.phase === 'ESCALATED') completed++
        else if (s.phase === 'PENDING') queued++
        else active++
      }

      // Emit heartbeat when no progress has been made in the last interval
      const timeSinceProgress = Date.now() - _lastProgressTs
      if (timeSinceProgress >= HEARTBEAT_INTERVAL_MS) {
        eventBus.emit('orchestrator:heartbeat', {
          runId: config.pipelineRunId ?? '',
          activeDispatches: active,
          completedDispatches: completed,
          queuedDispatches: queued,
        })
      }

      // Watchdog: check for stalls with phase-aware thresholds (AC3, AC4)
      const elapsed = Date.now() - _lastProgressTs

      // Only run process inspection once per tick (shared across all stories)
      let childPids: number[] = []
      let childActive = false
      let processInspected = false

      for (const [key, s] of _stories) {
        if (s.phase === 'PENDING' || s.phase === 'COMPLETE' || s.phase === 'ESCALATED') continue
        const threshold = getStallThresholdMs(s.phase)
        if (elapsed < threshold) continue

        // Deduplication: skip if we already emitted a stall event for this story
        if (_stalledStories.has(key)) continue

        // AC2 (Story 23-7): Check child process liveness before emitting stall.
        // Inspect once per tick and cache the result.
        if (!processInspected) {
          processInspected = true
          try {
            const processInfo = inspectProcessTree()
            childPids = processInfo.child_pids
            const nonZombieChildren = processInfo.child_pids.filter(
              (pid) => !processInfo.zombies.includes(pid)
            )
            childActive = nonZombieChildren.length > 0
          } catch {
            // Process inspection failed — proceed with stall detection
          }
        }

        // AC1 + AC2 (Story 23-7): If any child is alive and not a zombie,
        // reset the staleness timer and suppress the stall event.
        if (childActive) {
          _lastProgressTs = Date.now()
          logger.debug(
            { storyKey: key, phase: s.phase, childPids },
            'Staleness exceeded but child processes are active — suppressing stall'
          )
          break // timer reset — no need to check remaining stories this tick
        }

        _stalledStories.add(key)
        _storiesWithStall.add(key)
        logger.warn({ storyKey: key, phase: s.phase, elapsedMs: elapsed, childPids, childActive }, 'Watchdog: possible stall detected')
        eventBus.emit('orchestrator:stall', {
          runId: config.pipelineRunId ?? '',
          storyKey: key,
          phase: s.phase,
          elapsedMs: elapsed,
          childPids,
          childActive,
        })
      }
    }, HEARTBEAT_INTERVAL_MS)
    // Ensure the timer doesn't prevent process exit
    if (_heartbeatTimer && typeof _heartbeatTimer === 'object' && 'unref' in _heartbeatTimer) {
      _heartbeatTimer.unref()
    }
  }

  function stopHeartbeat(): void {
    if (_heartbeatTimer !== null) {
      clearInterval(_heartbeatTimer)
      _heartbeatTimer = null
    }
  }

  /**
   * Wait until the orchestrator is un-paused (if currently paused).
   */
  async function waitIfPaused(): Promise<void> {
    if (_paused && _pauseGate !== null) {
      await _pauseGate.promise
    }
  }

  /**
   * Check memory pressure before dispatching a story phase (Story 23-8, AC1).
   *
   * When the dispatcher reports memory pressure, this helper waits using
   * exponential backoff (30 s, 60 s, 120 s) and re-checks after each interval.
   * If memory is still pressured after all intervals, returns false so the
   * caller can escalate the story with reason 'memory_pressure_exhausted'.
   *
   * If memory is OK (or clears during a wait), returns true immediately.
   */
  async function checkMemoryPressure(storyKey: string): Promise<boolean> {
    for (let attempt = 0; attempt < MEMORY_PRESSURE_BACKOFF_MS.length; attempt++) {
      const memState = dispatcher.getMemoryState()
      if (!memState.isPressured) {
        return true
      }
      // Log memory state at each hold entry [AC3]
      logger.warn(
        {
          storyKey,
          freeMB: memState.freeMB,
          thresholdMB: memState.thresholdMB,
          pressureLevel: memState.pressureLevel,
          attempt: attempt + 1,
          maxAttempts: MEMORY_PRESSURE_BACKOFF_MS.length,
        },
        'Memory pressure before story dispatch — backing off',
      )
      await sleep(MEMORY_PRESSURE_BACKOFF_MS[attempt] ?? 0)
    }
    // Final check after last sleep
    return !dispatcher.getMemoryState().isPressured
  }

  /**
   * Run the full pipeline for a single story key.
   *
   * Sequence: create-story → dev-story → code-review (with retry/rework up
   * to maxReviewCycles). On SHIP_IT the story is marked COMPLETE. On
   * exhausted retries the story is ESCALATED.
   */
  async function processStory(storyKey: string): Promise<void> {
    logger.info({ storyKey }, 'Processing story')

    // -- memory pressure pre-check (Story 23-8, AC1) --
    // Before starting any dispatch, verify memory is available. If pressured,
    // back off and retry. If memory pressure persists after all retries,
    // escalate this story so the pipeline can continue to the next one.
    {
      const memoryOk = await checkMemoryPressure(storyKey)
      if (!memoryOk) {
        logger.warn({ storyKey }, 'Memory pressure exhausted — escalating story without dispatch')
        _stories.set(storyKey, {
          phase: 'ESCALATED' as import('./types.js').StoryPhase,
          reviewCycles: 0,
          error: 'memory_pressure_exhausted',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
        emitEscalation({
          storyKey,
          lastVerdict: 'memory_pressure_exhausted',
          reviewCycles: 0,
          issues: [
            `Memory pressure exhausted after ${MEMORY_PRESSURE_BACKOFF_MS.length} backoff attempts`,
          ],
        })
        persistState()
        return
      }
    }

    // -- create-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    startPhase(storyKey, 'create-story')
    updateStory(storyKey, {
      phase: 'IN_STORY_CREATION' as StoryPhase,
      startedAt: new Date().toISOString(),
    })

    let storyFilePath: string | undefined

    // Check if a story file already exists for this story key.
    // Pre-existing stories (e.g., from BMAD auto-implement) should be reused
    // so their full task list is available for complexity analysis and batching.
    const artifactsDir = projectRoot ? join(projectRoot, '_bmad-output', 'implementation-artifacts') : undefined
    if (artifactsDir && existsSync(artifactsDir)) {
      try {
        const files = readdirSync(artifactsDir)
        const match = files.find((f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md'))
        if (match) {
          const candidatePath = join(artifactsDir, match)
          const validation = await isValidStoryFile(candidatePath)
          if (!validation.valid) {
            logger.warn(
              { storyKey, storyFilePath: candidatePath, reason: validation.reason },
              `Existing story file for ${storyKey} is invalid (${validation.reason}) — re-creating`,
            )
            // Fall through to create-story by leaving storyFilePath undefined
          } else {
            storyFilePath = candidatePath
            logger.info({ storyKey, storyFilePath }, 'Found existing story file — skipping create-story')
            endPhase(storyKey, 'create-story')
            eventBus.emit('orchestrator:story-phase-complete', {
              storyKey,
              phase: 'IN_STORY_CREATION',
              result: { result: 'success', story_file: storyFilePath, story_key: storyKey },
            })
            persistState()
          }
        }
      } catch {
        // If directory read fails, fall through to create-story
      }
    }

    if (storyFilePath === undefined) {
    try {
      incrementDispatches(storyKey)
      const createResult = await runCreateStory(
        { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
        { epicId: storyKey.split('-')[0] ?? storyKey, storyKey, pipelineRunId: config.pipelineRunId },
      )

      endPhase(storyKey, 'create-story')
      eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'IN_STORY_CREATION',
        result: createResult,
      })
      persistState()

      if (createResult.result === 'failed') {
        const errMsg = createResult.error ?? 'create-story failed'
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, 'failed', 0)
        emitEscalation({
          storyKey,
          lastVerdict: 'create-story-failed',
          reviewCycles: 0,
          issues: [errMsg],
        })
        persistState()
        return
      }

      if (createResult.story_file === undefined || createResult.story_file === '') {
        const errMsg = 'create-story succeeded but returned no story_file path'
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, 'failed', 0)
        emitEscalation({
          storyKey,
          lastVerdict: 'create-story-no-file',
          reviewCycles: 0,
          issues: [errMsg],
        })
        persistState()
        return
      }

      storyFilePath = createResult.story_file
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      endPhase(storyKey, 'create-story')
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      writeStoryMetricsBestEffort(storyKey, 'failed', 0)
      emitEscalation({
        storyKey,
        lastVerdict: 'create-story-exception',
        reviewCycles: 0,
        issues: [errMsg],
      })
      persistState()
      return
    }
    } // end if (storyFilePath === undefined)

    // -- interface contract parsing (Story 25-4: AC3) --
    // Parse the newly created (or pre-existing) story file for interface contract
    // declarations and persist them to the decision store so Story 25-5 dispatch
    // ordering and Story 25-6 verification can build a cross-story dependency graph.
    if (storyFilePath) {
      try {
        const storyContent = await readFile(storyFilePath, 'utf-8')
        const contracts = parseInterfaceContracts(storyContent, storyKey)
        if (contracts.length > 0) {
          for (const contract of contracts) {
            createDecision(db, {
              pipeline_run_id: config.pipelineRunId ?? null,
              phase: 'implementation',
              category: 'interface-contract',
              key: `${storyKey}:${contract.contractName}`,
              value: JSON.stringify({
                direction: contract.direction,
                schemaName: contract.contractName,
                filePath: contract.filePath,
                storyKey: contract.storyKey,
                ...(contract.transport !== undefined ? { transport: contract.transport } : {}),
              }),
            })
          }
          logger.info(
            { storyKey, contractCount: contracts.length, contracts },
            'Stored interface contract declarations in decision store',
          )
        }
      } catch (err) {
        logger.warn(
          { storyKey, error: err instanceof Error ? err.message : String(err) },
          'Failed to parse interface contracts — continuing without contract declarations',
        )
      }
    }

    // -- test-plan phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    startPhase(storyKey, 'test-plan')
    updateStory(storyKey, { phase: 'IN_TEST_PLANNING' as StoryPhase })
    persistState()

    let testPlanPhaseResult: 'success' | 'failed' = 'failed'
    try {
      const testPlanResult = await runTestPlan(
        { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
        { storyKey, storyFilePath: storyFilePath ?? '', pipelineRunId: config.pipelineRunId ?? '' },
      )
      testPlanPhaseResult = testPlanResult.result
      if (testPlanResult.result === 'success') {
        logger.info({ storyKey }, 'Test plan generated successfully')
      } else {
        logger.warn({ storyKey }, 'Test planning returned failed result — proceeding to dev-story without test plan')
      }
    } catch (err) {
      logger.warn({ storyKey, err }, 'Test planning failed — proceeding to dev-story without test plan')
    }

    endPhase(storyKey, 'test-plan')

    eventBus.emit('orchestrator:story-phase-complete', {
      storyKey,
      phase: 'IN_TEST_PLANNING',
      result: { result: testPlanPhaseResult },
    })

    // -- dev-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    startPhase(storyKey, 'dev-story')
    updateStory(storyKey, { phase: 'IN_DEV' as StoryPhase })
    persistState()

    let devFilesModified: string[] = []
    // Per-batch file tracking for batched review (empty when single dispatch)
    const batchFileGroups: Array<{ batchIndex: number; files: string[] }> = []
    // Track whether dev-story reported a COMPLETE (success) result — used by
    // the zero-diff detection gate (Story 24-1) below.
    let devStoryWasSuccess = false

    try {
      // Analyze story complexity to determine whether batching is needed (AC1, AC7)
      let storyContentForAnalysis = ''
      try {
        storyContentForAnalysis = await readFile(storyFilePath ?? '', 'utf-8')
      } catch (err) {
        // If we can't read for analysis, fall back to single dispatch
        logger.error(
          { storyKey, storyFilePath, error: err instanceof Error ? err.message : String(err) },
          'Could not read story file for complexity analysis — falling back to single dispatch',
        )
      }

      const analysis = analyzeStoryComplexity(storyContentForAnalysis)
      const batches = planTaskBatches(analysis)

      logger.info(
        { storyKey, estimatedScope: analysis.estimatedScope, batchCount: batches.length, taskCount: analysis.taskCount },
        'Story complexity analyzed',
      )

      if (analysis.estimatedScope === 'large' && batches.length > 1) {
        // AC1: Large story — dispatch sequentially per batch
        const allFilesModified = new Set<string>()

        // AC1: Record decomposition metrics on the orchestrator run result
        _decomposition = {
          totalTasks: analysis.taskCount,
          batchCount: batches.length,
          batchSizes: batches.map((b) => b.taskIds.length),
        }

        for (const batch of batches) {
          await waitIfPaused()
          if (_state !== 'RUNNING') break

          // AC2: Build taskScope string listing this batch's tasks
          const taskScope = batch.taskIds
            .map((id, i) => `T${id}: ${batch.taskTitles[i] ?? ''}`)
            .join('\n')

          // AC4: Prior files from all previously accumulated batches
          const priorFiles = allFilesModified.size > 0 ? Array.from(allFilesModified) : undefined

          logger.info(
            { storyKey, batchIndex: batch.batchIndex, taskCount: batch.taskIds.length },
            'Dispatching dev-story batch',
          )

          const batchStartMs = Date.now()
          incrementDispatches(storyKey)
          let batchResult
          try {
            batchResult = await runDevStory(
              { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
              {
                storyKey,
                storyFilePath: storyFilePath ?? '',
                pipelineRunId: config.pipelineRunId,
                taskScope,
                priorFiles,
              },
            )
          } catch (batchErr) {
            // AC6: Batch failure — log and continue with partial files
            const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr)
            logger.warn(
              { storyKey, batchIndex: batch.batchIndex, error: errMsg },
              'Batch dispatch threw an exception — continuing with partial files',
            )
            continue
          }

          const batchDurationMs = Date.now() - batchStartMs
          const batchFilesModified = batchResult.files_modified ?? []

          // AC2: Emit per-batch metrics log entry
          const batchMetrics: PerBatchMetrics = {
            batchIndex: batch.batchIndex,
            taskIds: batch.taskIds,
            tokensUsed: {
              input: batchResult.tokenUsage?.input ?? 0,
              output: batchResult.tokenUsage?.output ?? 0,
            },
            durationMs: batchDurationMs,
            filesModified: batchFilesModified,
            result: batchResult.result === 'success' ? 'success' : 'failed',
          }
          logger.info(batchMetrics, 'Batch dev-story metrics')

          // AC5: Accumulate files_modified across all batches
          for (const f of batchFilesModified) {
            allFilesModified.add(f)
          }

          // Track per-batch files for batched review
          if (batchFilesModified.length > 0) {
            batchFileGroups.push({ batchIndex: batch.batchIndex, files: batchFilesModified })
          }

          // AC5: Store batch context in token_usage metadata JSON
          if (config.pipelineRunId !== undefined && batchResult.tokenUsage !== undefined) {
            try {
              addTokenUsage(db, config.pipelineRunId, {
                phase: 'dev-story',
                agent: `batch-${batch.batchIndex}`,
                input_tokens: batchResult.tokenUsage.input,
                output_tokens: batchResult.tokenUsage.output,
                cost_usd: 0,
                metadata: JSON.stringify({
                  storyKey,
                  batchIndex: batch.batchIndex,
                  taskIds: batch.taskIds,
                  durationMs: batchDurationMs,
                  result: batchMetrics.result,
                }),
              })
            } catch (tokenErr) {
              logger.warn({ storyKey, batchIndex: batch.batchIndex, err: tokenErr }, 'Failed to record batch token usage')
            }
          }

          if (batchResult.result === 'failed') {
            // AC6: Batch returned failure — log and continue (partial progress)
            logger.warn(
              { storyKey, batchIndex: batch.batchIndex, error: batchResult.error },
              'Batch dev-story reported failure — continuing with partial files',
            )
          } else {
            // At least one batch reported success — track for zero-diff gate (Story 24-1)
            devStoryWasSuccess = true
          }

          eventBus.emit('orchestrator:story-phase-complete', {
            storyKey,
            phase: 'IN_DEV',
            result: batchResult,
          })
          persistState()
        }

        devFilesModified = Array.from(allFilesModified)
      } else {
        // AC7: Small/medium story — single dispatch (existing behavior)
        incrementDispatches(storyKey)
        const devResult = await runDevStory(
          { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
          {
            storyKey,
            storyFilePath: storyFilePath ?? '',
            pipelineRunId: config.pipelineRunId,
          },
        )

        devFilesModified = devResult.files_modified ?? []

        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: 'IN_DEV',
          result: devResult,
        })
        persistState()

        if (devResult.result === 'success') {
          devStoryWasSuccess = true
        } else {
          // Dev agent failed but may have produced code (common when agent
          // exhausts turns or exits non-zero after partial work). Proceed to
          // code review — the reviewer will assess actual code state.
          logger.warn({
            storyKey,
            error: devResult.error,
            filesModified: devFilesModified.length,
          }, 'Dev-story reported failure, proceeding to code review')
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      endPhase(storyKey, 'dev-story')
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      writeStoryMetricsBestEffort(storyKey, 'failed', 0)
      emitEscalation({
        storyKey,
        lastVerdict: 'dev-story-exception',
        reviewCycles: 0,
        issues: [errMsg],
      })
      persistState()
      return
    }

    // -- zero-diff detection gate (Story 24-1) --
    // Only applies when dev-story reported COMPLETE (result === 'success').
    // Non-success results proceed to code-review as before so the reviewer
    // can assess partial work (AC5).
    // gitDiffFiles is hoisted so the interface change detector (24-3) can
    // use ground-truth file paths instead of the agent's self-reported list.
    let gitDiffFiles: string[] | undefined
    if (devStoryWasSuccess) {
      gitDiffFiles = checkGitDiffFiles(projectRoot ?? process.cwd())
      if (gitDiffFiles.length === 0) {
        logger.warn(
          { storyKey },
          'Zero-diff detected after COMPLETE dev-story — no file changes in git working tree',
        )
        eventBus.emit('orchestrator:zero-diff-escalation', {
          storyKey,
          reason: 'zero-diff-on-complete',
        })
        endPhase(storyKey, 'dev-story')
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: 'zero-diff-on-complete',
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
        emitEscalation({
          storyKey,
          lastVerdict: 'zero-diff-on-complete',
          reviewCycles: 0,
          issues: ['dev-story completed with COMPLETE verdict but no file changes detected in git diff'],
        })
        persistState()
        return
      }
    }

    // -- code-review phase (with retry/rework) --
    endPhase(storyKey, 'dev-story')

    // -- build verification gate (Story 24-2) --
    // Runs synchronously after dev-story, before dispatching code-review.
    // Catches compile-time errors (missing exports, type mismatches) before
    // wasting a review cycle.
    {
      const buildVerifyResult = runBuildVerification({
        verifyCommand: pack.manifest.verifyCommand,
        verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
        projectRoot: projectRoot ?? process.cwd(),
      })

      if (buildVerifyResult.status === 'passed') {
        eventBus.emit('story:build-verification-passed', { storyKey })
        logger.info({ storyKey }, 'Build verification passed')
      } else if (buildVerifyResult.status === 'failed' || buildVerifyResult.status === 'timeout') {
        const truncatedOutput = (buildVerifyResult.output ?? '').slice(0, 2000)
        const reason = buildVerifyResult.reason ?? 'build-verification-failed'

        eventBus.emit('story:build-verification-failed', {
          storyKey,
          exitCode: buildVerifyResult.exitCode ?? 1,
          output: truncatedOutput,
        })

        logger.warn(
          { storyKey, reason, exitCode: buildVerifyResult.exitCode },
          'Build verification failed — escalating story',
        )

        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: reason,
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
        emitEscalation({
          storyKey,
          lastVerdict: reason,
          reviewCycles: 0,
          issues: [truncatedOutput],
        })
        persistState()
        return
      }
      // status === 'skipped': gate disabled — proceed directly to code-review
    }

    // -- interface change detection (Story 24-3) --
    // Non-blocking warning: detects exported interfaces/types in modified .ts
    // files and checks if cross-module test files may have stale mocks.
    // Failure never blocks the pipeline (AC5: graceful degradation).
    // Prefer gitDiffFiles (ground truth from git) over devFilesModified
    // (agent self-report) when available.
    {
      try {
        const filesModified = gitDiffFiles ?? devFilesModified
        if (filesModified.length > 0) {
          const icResult = detectInterfaceChanges({
            filesModified,
            projectRoot: projectRoot ?? process.cwd(),
            storyKey,
          })
          if (icResult.potentiallyAffectedTests.length > 0) {
            logger.warn(
              {
                storyKey,
                modifiedInterfaces: icResult.modifiedInterfaces,
                potentiallyAffectedTests: icResult.potentiallyAffectedTests,
              },
              'Interface change warning: modified exports may affect cross-module test mocks',
            )
            eventBus.emit('story:interface-change-warning', {
              storyKey,
              modifiedInterfaces: icResult.modifiedInterfaces,
              potentiallyAffectedTests: icResult.potentiallyAffectedTests,
            })
          }
        }
      } catch {
        // AC5: outer catch — never block pipeline for detection errors
      }
    }

    let reviewCycles = 0
    let keepReviewing = true
    let timeoutRetried = false
    let previousIssueList: Array<{ severity?: string; description?: string; file?: string; line?: number }> = []

    while (keepReviewing) {
      await waitIfPaused()
      if (_state !== 'RUNNING') return

      if (reviewCycles === 0) startPhase(storyKey, 'code-review')
      updateStory(storyKey, {
        phase: 'IN_REVIEW' as StoryPhase,
        reviewCycles,
      })

      let verdict: string
      let issueList: unknown[] = []
      let reviewResult: Awaited<ReturnType<typeof runCodeReview>> | undefined

      try {
        // Batched review: when decomposition produced multiple batches and this is
        // the first review cycle, review each batch's files separately to keep diff
        // sizes manageable for the headless reviewer. Re-reviews after fixes always
        // review all files since fixes may cross batch boundaries.
        const useBatchedReview = batchFileGroups.length > 1 && previousIssueList.length === 0

        if (useBatchedReview) {
          // Per-batch reviews — aggregate worst verdict + union issues
          const allIssues: Array<{ severity: 'blocker' | 'major' | 'minor'; description: string; file?: string; line?: number }> = []
          let worstVerdict: 'SHIP_IT' | 'LGTM_WITH_NOTES' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' = 'SHIP_IT'
          let aggregateTokens = { input: 0, output: 0 }
          let lastError: string | undefined
          let lastRawOutput: string | undefined

          const verdictRank = { 'SHIP_IT': 0, 'LGTM_WITH_NOTES': 0.5, 'NEEDS_MINOR_FIXES': 1, 'NEEDS_MAJOR_REWORK': 2 } as const

          for (const group of batchFileGroups) {
            logger.info(
              { storyKey, batchIndex: group.batchIndex, fileCount: group.files.length },
              'Running batched code review',
            )
            incrementDispatches(storyKey)
            const batchReview = await runCodeReview(
              { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
              {
                storyKey,
                storyFilePath: storyFilePath ?? '',
                workingDirectory: projectRoot,
                pipelineRunId: config.pipelineRunId,
                filesModified: group.files,
              },
            )

            // Accumulate
            if (batchReview.tokenUsage) {
              aggregateTokens.input += batchReview.tokenUsage.input
              aggregateTokens.output += batchReview.tokenUsage.output
            }
            for (const iss of batchReview.issue_list ?? []) {
              allIssues.push(iss)
            }
            const bv = batchReview.verdict as keyof typeof verdictRank
            if (verdictRank[bv] > verdictRank[worstVerdict]) {
              worstVerdict = bv
            }
            if (batchReview.error) lastError = batchReview.error
            if (batchReview.rawOutput) lastRawOutput = batchReview.rawOutput
          }

          // Synthesize aggregate result
          reviewResult = {
            verdict: worstVerdict,
            issues: allIssues.length,
            issue_list: allIssues,
            error: lastError,
            rawOutput: lastRawOutput,
            tokenUsage: aggregateTokens,
          }

          logger.info(
            { storyKey, batchCount: batchFileGroups.length, verdict: worstVerdict, issues: allIssues.length },
            'Batched code review complete — aggregate result',
          )
        } else {
          // Single review (small story or re-review after fix)
          incrementDispatches(storyKey)
          reviewResult = await runCodeReview(
            { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
            {
              storyKey,
              storyFilePath: storyFilePath ?? '',
              workingDirectory: projectRoot,
              pipelineRunId: config.pipelineRunId,
              filesModified: devFilesModified,
              // Scope re-reviews: pass previous issues so the reviewer verifies fixes first
              ...(previousIssueList.length > 0 ? { previousIssues: previousIssueList } : {}),
            },
          )
        }

        // Phantom review detection: dispatch failures (crash, timeout, non-zero exit)
        // are flagged with dispatchFailed=true. Also detect heuristically when verdict
        // is non-SHIP_IT but issue list is empty + error (schema validation failure,
        // truncated response). Either way, retry the review once before escalation.
        const isPhantomReview = reviewResult.dispatchFailed === true
          || (reviewResult.verdict !== 'SHIP_IT'
            && reviewResult.verdict !== 'LGTM_WITH_NOTES'
            && (reviewResult.issue_list === undefined || reviewResult.issue_list.length === 0)
            && reviewResult.error !== undefined)
        if (isPhantomReview && !timeoutRetried) {
          timeoutRetried = true
          logger.warn(
            { storyKey, reviewCycles, error: reviewResult.error },
            'Phantom review detected (0 issues + error) — retrying review once',
          )
          continue
        }

        verdict = reviewResult.verdict
        issueList = reviewResult.issue_list ?? []

        // Improvement-aware verdict adjustment: when a re-review (cycle > 0)
        // returns NEEDS_MAJOR_REWORK but issues decreased compared to the
        // previous cycle, the fix agent made real progress. Demote to
        // NEEDS_MINOR_FIXES so the pipeline dispatches a targeted sonnet fix
        // instead of an expensive opus rework. This avoids escalation when
        // only 1-2 residual issues remain from a previously larger set.
        if (
          verdict === 'NEEDS_MAJOR_REWORK'
          && reviewCycles > 0
          && previousIssueList.length > 0
          && issueList.length < previousIssueList.length
        ) {
          logger.info(
            { storyKey, originalVerdict: verdict, issuesBefore: previousIssueList.length, issuesAfter: issueList.length },
            'Issues decreased between review cycles — demoting MAJOR_REWORK to MINOR_FIXES',
          )
          verdict = 'NEEDS_MINOR_FIXES'
        }

        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: 'IN_REVIEW',
          result: reviewResult,
        })

        // Persist review artifact with full issue details for post-mortem diagnosis
        try {
          const summary = reviewResult.error
            ? `${verdict} (error: ${reviewResult.error}) — ${issueList.length} issues`
            : `${verdict} — ${issueList.length} issues`
          // Serialize full issue_list into content_hash for diagnostic queries.
          // On successful reviews (parsed correctly), this captures the actual findings.
          // On failures, it captures whatever partial data is available.
          const issueDetails = issueList.length > 0
            ? JSON.stringify(issueList)
            : reviewResult.rawOutput
              ? `raw:${reviewResult.rawOutput.slice(0, 500)}`
              : undefined
          registerArtifact(db, {
            pipeline_run_id: config.pipelineRunId,
            phase: 'code-review',
            type: 'review-result',
            path: storyFilePath ?? storyKey,
            summary,
            content_hash: issueDetails,
          })
        } catch {
          // Artifact persistence is best-effort — never block the pipeline
        }

        updateStory(storyKey, { lastVerdict: verdict })
        persistState()

        // AC3 + AC4: Emit pipeline summary log line with decomposition and verdict info
        {
          const totalTokens = reviewResult.tokenUsage
            ? reviewResult.tokenUsage.input + reviewResult.tokenUsage.output
            : 0
          const totalTokensK = totalTokens > 0 ? `${Math.round(totalTokens / 1000)}K` : '0'
          const fileCount = devFilesModified.length
          const parts: string[] = [`Code review completed: ${verdict}`]

          // AC4: When agentVerdict differs from pipeline verdict, log both
          if (reviewResult.agentVerdict !== undefined && reviewResult.agentVerdict !== verdict) {
            parts[0] = `Code review completed: ${verdict} (agent: ${reviewResult.agentVerdict})`
          }

          // AC3: Include decomposition summary when batching was used
          if (_decomposition !== undefined) {
            parts.push(`decomposed: ${_decomposition.batchCount} batches`)
          }

          parts.push(`${fileCount} files`)
          parts.push(`${totalTokensK} tokens`)

          logger.info({ storyKey, verdict, agentVerdict: reviewResult.agentVerdict }, parts.join(' | '))
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        endPhase(storyKey, 'code-review')
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, 'failed', reviewCycles)
        emitEscalation({
          storyKey,
          lastVerdict: 'code-review-exception',
          reviewCycles,
          issues: [errMsg],
        })
        persistState()
        return
      }

      if (verdict === 'SHIP_IT' || verdict === 'LGTM_WITH_NOTES') {
        endPhase(storyKey, 'code-review')
        updateStory(storyKey, {
          phase: 'COMPLETE' as StoryPhase,
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, verdict, reviewCycles + 1)
        writeStoryOutcomeBestEffort(storyKey, 'complete', reviewCycles + 1)
        eventBus.emit('orchestrator:story-complete', { storyKey, reviewCycles })
        persistState()

        // LGTM_WITH_NOTES: persist advisory notes to decision store for learning loop
        if (verdict === 'LGTM_WITH_NOTES' && reviewResult.notes && config.pipelineRunId) {
          try {
            createDecision(db, {
              pipeline_run_id: config.pipelineRunId,
              phase: 'implementation',
              category: ADVISORY_NOTES,
              key: `${storyKey}:${config.pipelineRunId}`,
              value: JSON.stringify({ storyKey, notes: reviewResult.notes }),
              rationale: `Advisory notes from LGTM_WITH_NOTES review of ${storyKey}`,
            })
            logger.info({ storyKey }, 'Advisory notes persisted to decision store')
          } catch (advisoryErr) {
            logger.warn(
              { storyKey, error: advisoryErr instanceof Error ? advisoryErr.message : String(advisoryErr) },
              'Failed to persist advisory notes (best-effort)',
            )
          }
        }

        // Post-SHIP_IT/LGTM_WITH_NOTES: run test expansion analysis (non-blocking — never alters verdict/state)
        try {
          const expansionResult = await runTestExpansion(
            { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings },
            {
              storyKey,
              storyFilePath: storyFilePath ?? '',
              pipelineRunId: config.pipelineRunId,
              filesModified: devFilesModified,
              workingDirectory: projectRoot,
            },
          )
          logger.debug(
            {
              storyKey,
              expansion_priority: expansionResult.expansion_priority,
              coverage_gaps: expansionResult.coverage_gaps.length,
            },
            'Test expansion analysis complete',
          )
          createDecision(db, {
            pipeline_run_id: config.pipelineRunId ?? 'unknown',
            phase: 'implementation',
            category: TEST_EXPANSION_FINDING,
            key: `${storyKey}:${config.pipelineRunId ?? 'unknown'}`,
            value: JSON.stringify(expansionResult),
          })
        } catch (expansionErr) {
          logger.warn(
            { storyKey, error: expansionErr instanceof Error ? expansionErr.message : String(expansionErr) },
            'Test expansion failed — story verdict unchanged',
          )
        }

        keepReviewing = false
        return
      }

      // Exceeded max review cycles
      if (reviewCycles >= config.maxReviewCycles - 1) {
        const finalReviewCycles = reviewCycles + 1

        // NEEDS_MAJOR_REWORK at the limit → escalate (fundamental issues remain)
        if (verdict !== 'NEEDS_MINOR_FIXES') {
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            reviewCycles: finalReviewCycles,
            completedAt: new Date().toISOString(),
          })
          writeStoryMetricsBestEffort(storyKey, 'escalated', finalReviewCycles)
          emitEscalation({
            storyKey,
            lastVerdict: verdict,
            reviewCycles: finalReviewCycles,
            issues: issueList,
          })
          persistState()
          return
        }

        // NEEDS_MINOR_FIXES at the limit → fix then auto-approve (converged on nits)
        logger.info(
          { storyKey, reviewCycles: finalReviewCycles, issueCount: issueList.length },
          'Review cycles exhausted with only minor issues — applying fixes then auto-approving',
        )

        await waitIfPaused()
        if (_state !== 'RUNNING') return

        updateStory(storyKey, { phase: 'NEEDS_FIXES' as StoryPhase })
        try {
          let fixPrompt: string
          let autoApproveMaxTurns: number | undefined
          try {
            const fixTemplate = await pack.getPrompt('fix-story')
            const storyContent = await readFile(storyFilePath ?? '', 'utf-8')

            // Compute maxTurns from story complexity
            const complexity = computeStoryComplexity(storyContent)
            autoApproveMaxTurns = resolveFixStoryMaxTurns(complexity.complexityScore)
            logComplexityResult(storyKey, complexity, autoApproveMaxTurns)

            let reviewFeedback: string
            if (issueList.length === 0) {
              reviewFeedback = `Verdict: ${verdict}\nIssues: Minor issues flagged but no specifics provided. Review the story ACs and fix any remaining gaps.`
            } else {
              reviewFeedback = [
                `Verdict: ${verdict}`,
                `Issues (${issueList.length}):`,
                ...issueList.map((issue, i) => {
                  const iss = issue as { severity?: string; description?: string; file?: string; line?: number }
                  return `  ${i + 1}. [${iss.severity ?? 'unknown'}] ${iss.description ?? 'no description'}${iss.file ? ` (${iss.file}${iss.line ? `:${iss.line}` : ''})` : ''}`
                }),
              ].join('\n')
            }
            let archConstraints = ''
            try {
              const decisions = getDecisionsByPhase(db, 'solutioning')
              const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
              archConstraints = constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
            } catch { /* arch constraints are optional */ }
            const targetedFilesContent = buildTargetedFilesContent(issueList)
            const sections = [
              { name: 'story_content', content: storyContent, priority: 'required' as const },
              { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
              { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
              ...(targetedFilesContent ? [{ name: 'targeted_files', content: targetedFilesContent, priority: 'important' as const }] : []),
            ]
            const assembled = assemblePrompt(fixTemplate, sections, 24000)
            fixPrompt = assembled.prompt
          } catch {
            fixPrompt = `Fix story ${storyKey}: verdict=${verdict}, minor fixes needed`
            logger.warn({ storyKey }, 'Failed to assemble auto-approve fix prompt, using fallback')
          }

          const handle = dispatcher.dispatch<unknown>({
            prompt: fixPrompt,
            agent: 'claude-code',
            taskType: 'minor-fixes',
            workingDirectory: projectRoot,
            ...(autoApproveMaxTurns !== undefined ? { maxTurns: autoApproveMaxTurns } : {}),
          })
          const fixResult = await handle.result

          eventBus.emit('orchestrator:story-phase-complete', {
            storyKey,
            phase: 'IN_MINOR_FIX',
            result: {
              tokenUsage: fixResult.tokenEstimate
                ? { input: fixResult.tokenEstimate.input, output: fixResult.tokenEstimate.output }
                : undefined,
            },
          })

          if (fixResult.status === 'timeout') {
            logger.warn({ storyKey }, 'Auto-approve fix timed out — approving anyway (issues were minor)')
          }
        } catch (err) {
          logger.warn({ storyKey, err }, 'Auto-approve fix dispatch failed — approving anyway (issues were minor)')
        }

        // Auto-approve: mark COMPLETE regardless of fix outcome (issues were minor)
        endPhase(storyKey, 'code-review')
        updateStory(storyKey, {
          phase: 'COMPLETE' as StoryPhase,
          reviewCycles: finalReviewCycles,
          completedAt: new Date().toISOString(),
        })
        writeStoryMetricsBestEffort(storyKey, verdict, finalReviewCycles)
        writeStoryOutcomeBestEffort(storyKey, 'complete', finalReviewCycles)
        eventBus.emit('orchestrator:story-complete', {
          storyKey,
          reviewCycles: finalReviewCycles,
        })
        persistState()
        keepReviewing = false
        return
      }

      // -- dispatch fix prompt --

      await waitIfPaused()
      if (_state !== 'RUNNING') return

      updateStory(storyKey, { phase: 'NEEDS_FIXES' as StoryPhase })

      const taskType = verdict === 'NEEDS_MINOR_FIXES' ? 'minor-fixes' : 'major-rework'

      // Model escalation: use Opus for major rework, Sonnet for minor fixes
      const fixModel = taskType === 'major-rework' ? 'claude-opus-4-6' : undefined

      try {
        // Assemble a context-aware fix/rework prompt from the pack template
        let fixPrompt: string
        const isMajorRework = taskType === 'major-rework'
        const templateName = isMajorRework ? 'rework-story' : 'fix-story'

        // Pre-compute fix-story maxTurns for major rework (Story 24-6, AC5)
        // Declared here so it's accessible at the dispatch call site below.
        let fixMaxTurns: number | undefined

        try {
          const fixTemplate = await pack.getPrompt(templateName)
          const storyContent = await readFile(storyFilePath ?? '', 'utf-8')

          // Compute complexity for turn limit scaling (major-rework: Story 24-6, minor-fix: fix-story enrichment)
          {
            const complexity = computeStoryComplexity(storyContent)
            fixMaxTurns = resolveFixStoryMaxTurns(complexity.complexityScore)
            logComplexityResult(storyKey, complexity, fixMaxTurns)
          }

          // Format review feedback: verdict + serialized issue list
          // Guard against empty issue lists — provide fallback guidance
          let reviewFeedback: string
          if (issueList.length === 0) {
            reviewFeedback = isMajorRework
              ? [
                  `Verdict: ${verdict}`,
                  'Issues: The reviewer flagged fundamental issues but did not provide specifics.',
                  'Instructions: Re-read the story file carefully, re-implement from scratch addressing all acceptance criteria.',
                ].join('\n')
              : [
                  `Verdict: ${verdict}`,
                  'Issues: The reviewer flagged this as needing work but did not provide specific issues.',
                  'Instructions: Re-read the story file carefully, compare each acceptance criterion against the current implementation, and fix any gaps you find.',
                  'Focus on: unimplemented ACs, missing tests, incorrect behavior, and incomplete task checkboxes.',
                ].join('\n')
          } else {
            const issueHeader = isMajorRework
              ? 'Issues from previous review that MUST be addressed'
              : 'Issues'
            reviewFeedback = [
              `Verdict: ${verdict}`,
              `${issueHeader} (${issueList.length}):`,
              ...issueList.map((issue, i) => {
                const iss = issue as { severity?: string; description?: string; file?: string; line?: number }
                return `  ${i + 1}. [${iss.severity ?? 'unknown'}] ${iss.description ?? 'no description'}${iss.file ? ` (${iss.file}${iss.line ? `:${iss.line}` : ''})` : ''}`
              }),
            ].join('\n')
          }

          // Query arch constraints from decision store
          let archConstraints = ''
          try {
            const decisions = getDecisionsByPhase(db, 'solutioning')
            const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
            archConstraints = constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
          } catch { /* arch constraints are optional */ }

          // Build sections based on template type
          const sections = isMajorRework
            ? [
                { name: 'story_content', content: storyContent, priority: 'required' as const },
                { name: 'review_findings', content: reviewFeedback, priority: 'required' as const },
                { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
                { name: 'git_diff', content: '', priority: 'optional' as const },
              ]
            : (() => {
                const targetedFilesContent = buildTargetedFilesContent(issueList)
                return [
                  { name: 'story_content', content: storyContent, priority: 'required' as const },
                  { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
                  { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
                  ...(targetedFilesContent ? [{ name: 'targeted_files', content: targetedFilesContent, priority: 'important' as const }] : []),
                ]
              })()
          const assembled = assemblePrompt(fixTemplate, sections, 24000)
          fixPrompt = assembled.prompt
        } catch {
          fixPrompt = `Fix story ${storyKey}: verdict=${verdict}, taskType=${taskType}`
          logger.warn({ storyKey, taskType }, 'Failed to assemble fix prompt, using fallback')
        }

        incrementDispatches(storyKey)
        // Major rework uses DevStoryResultSchema (full re-implementation output contract)
        const handle = isMajorRework
          ? dispatcher.dispatch({
              prompt: fixPrompt,
              agent: 'claude-code',
              taskType,
              ...(fixModel !== undefined ? { model: fixModel } : {}),
              outputSchema: DevStoryResultSchema,
              ...(fixMaxTurns !== undefined ? { maxTurns: fixMaxTurns } : {}),
              ...(projectRoot !== undefined ? { workingDirectory: projectRoot } : {}),
            })
          : dispatcher.dispatch<unknown>({
              prompt: fixPrompt,
              agent: 'claude-code',
              taskType,
              ...(fixModel !== undefined ? { model: fixModel } : {}),
              ...(fixMaxTurns !== undefined ? { maxTurns: fixMaxTurns } : {}),
              ...(projectRoot !== undefined ? { workingDirectory: projectRoot } : {}),
            })
        const fixResult = await handle.result

        // Record fix dispatch telemetry
        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: taskType === 'minor-fixes' ? 'IN_MINOR_FIX' : 'IN_MAJOR_FIX',
          result: {
            tokenUsage: fixResult.tokenEstimate
              ? { input: fixResult.tokenEstimate.input, output: fixResult.tokenEstimate.output }
              : undefined,
          },
        })

        if (fixResult.status === 'timeout') {
          logger.warn({ storyKey, taskType }, 'Fix dispatch timed out — escalating story')
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: `fix-dispatch-timeout (${taskType})`,
            completedAt: new Date().toISOString(),
          })
          writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
          emitEscalation({
            storyKey,
            lastVerdict: verdict,
            reviewCycles: reviewCycles + 1,
            issues: issueList,
          })
          persistState()
          return
        }

        if (fixResult.status === 'failed') {
          // Major rework failure is a strong escalation signal
          if (isMajorRework) {
            logger.warn({ storyKey, exitCode: fixResult.exitCode }, 'Major rework dispatch failed — escalating story')
            endPhase(storyKey, 'code-review')
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: 'major-rework-dispatch-failed',
              completedAt: new Date().toISOString(),
            })
            writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
            emitEscalation({
              storyKey,
              lastVerdict: verdict,
              reviewCycles: reviewCycles + 1,
              issues: issueList,
            })
            persistState()
            return
          }
          logger.warn({ storyKey, taskType, exitCode: fixResult.exitCode }, 'Fix dispatch failed')
        }
      } catch (err) {
        logger.warn({ storyKey, taskType, err }, 'Fix dispatch failed, continuing to next review')
      }

      // Save current issues for scoped re-review in next cycle
      previousIssueList = issueList.map((issue) => {
        const iss = issue as { severity?: string; description?: string; file?: string; line?: number }
        return { severity: iss.severity, description: iss.description, file: iss.file, line: iss.line }
      })

      reviewCycles++
    }
  }

  /**
   * Process a conflict group: run stories sequentially within the group.
   *
   * After each story completes (any outcome), a GC hint is issued and a short
   * pause inserted so the Node.js process can reclaim memory before the next
   * story dispatch (Story 23-8, AC2).
   */
  async function processConflictGroup(group: string[]): Promise<void> {
    for (const storyKey of group) {
      await processStory(storyKey)
      // GC hint between stories — best-effort, no error handling needed [AC2]
      ;(globalThis as { gc?: () => void }).gc?.()
      const gcPauseMs = config.gcPauseMs ?? 2_000
      await sleep(gcPauseMs)
    }
  }

  /**
   * Promise pool: run up to maxConcurrency groups at a time.
   *
   * Each promise self-removes from `running` upon settlement so that
   * Promise.race() always races only the truly in-flight promises and the
   * concurrency limit is accurately maintained.
   */
  async function runWithConcurrency(groups: string[][], maxConcurrency: number): Promise<void> {
    const queue = [...groups]
    const running: Promise<void>[] = []

    function enqueue(): void {
      const group = queue.shift()
      if (group === undefined) return

      const p: Promise<void> = processConflictGroup(group).finally(() => {
        const idx = running.indexOf(p)
        if (idx !== -1) running.splice(idx, 1)
      })
      running.push(p)
      // Track peak actual concurrency
      if (running.length > _maxConcurrentActual) {
        _maxConcurrentActual = running.length
      }
    }

    // Seed up to maxConcurrency concurrent tasks
    const initial = Math.min(maxConcurrency, queue.length)
    for (let i = 0; i < initial; i++) {
      enqueue()
    }

    // Drain remaining groups: wait for one to finish, then start another
    while (queue.length > 0) {
      await Promise.race(running)
      enqueue()
    }

    // Wait for all remaining
    await Promise.all(running)
  }

  // -- public interface --

  async function run(storyKeys: string[]): Promise<OrchestratorStatus> {
    if (_state === 'RUNNING' || _state === 'PAUSED') {
      logger.warn({ state: _state }, 'run() called while orchestrator is already running or paused — ignoring')
      return getStatus()
    }
    if (_state === 'COMPLETE') {
      logger.warn({ state: _state }, 'run() called on a COMPLETE orchestrator — ignoring')
      return getStatus()
    }

    _state = 'RUNNING'
    _startedAt = new Date().toISOString()

    // Initialize story states
    for (const key of storyKeys) {
      _stories.set(key, {
        phase: 'PENDING',
        reviewCycles: 0,
      })
    }

    eventBus.emit('orchestrator:started', {
      storyKeys,
      pipelineRunId: config.pipelineRunId,
    })
    persistState()
    recordProgress()
    // Only start heartbeat/watchdog when --events mode is active (AC1, Issue 5)
    if (config.enableHeartbeat) {
      startHeartbeat()
    }

    // Seed methodology context from planning artifacts (idempotent)
    if (projectRoot !== undefined) {
      const seedResult = seedMethodologyContext(db, projectRoot)
      if (seedResult.decisionsCreated > 0) {
        logger.info(
          { decisionsCreated: seedResult.decisionsCreated, skippedCategories: seedResult.skippedCategories },
          'Methodology context seeded from planning artifacts',
        )
      }
    }

    // Story 25-5: Query interface-contract declarations stored by Story 25-4.
    // These are populated during create-story for prior runs. On a fresh run
    // there may be no declarations yet — the function gracefully falls back to
    // a single batch (original behavior).
    const interfaceContractDecisions = getDecisionsByCategory(db, 'interface-contract')
    const contractDeclarations: ContractDeclaration[] = interfaceContractDecisions
      .map((d) => {
        try {
          const parsed = JSON.parse(d.value) as Record<string, unknown>
          const storyKey = typeof parsed.storyKey === 'string' ? parsed.storyKey : ''
          // Story 25-4 stores the name as 'schemaName' in the DB value
          const contractName = typeof parsed.schemaName === 'string' ? parsed.schemaName : ''
          const direction = parsed.direction === 'export' ? 'export' : 'import'
          const filePath = typeof parsed.filePath === 'string' ? parsed.filePath : ''
          if (!storyKey || !contractName) return null
          return {
            storyKey,
            contractName,
            direction,
            filePath,
            ...(typeof parsed.transport === 'string' ? { transport: parsed.transport } : {}),
          } satisfies ContractDeclaration
        } catch {
          return null
        }
      })
      .filter((d): d is ContractDeclaration => d !== null)

    // Detect conflict groups with contract-aware dispatch ordering (Story 25-5).
    // Cross-project runs (no conflictGroups in pack) get maximum parallelism within each batch.
    const { batches, edges: contractEdges } = detectConflictGroupsWithContracts(
      storyKeys,
      { moduleMap: pack.manifest.conflictGroups },
      contractDeclarations,
    )

    // AC5: Log contract dependency edges as structured events for observability
    if (contractEdges.length > 0) {
      logger.info(
        { contractEdges, edgeCount: contractEdges.length },
        'Contract dependency edges detected — applying contract-aware dispatch ordering',
      )
    }

    logger.info({
      storyCount: storyKeys.length,
      groupCount: batches.reduce((sum, b) => sum + b.length, 0),
      batchCount: batches.length,
      maxConcurrency: config.maxConcurrency,
    }, 'Orchestrator starting')

    // Pre-flight build gate (Story 25-2): verify project builds before dispatching any story.
    // Reuses runBuildVerification() from Story 24-2. Respects verifyCommand config (AC3) and
    // auto-detects the package manager (AC4). Skip when skipPreflight=true (AC5).
    if (config.skipPreflight !== true) {
      const preFlightResult = runBuildVerification({
        verifyCommand: pack.manifest.verifyCommand,
        verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
        projectRoot: projectRoot ?? process.cwd(),
      })

      if (preFlightResult.status === 'failed' || preFlightResult.status === 'timeout') {
        stopHeartbeat()
        const truncatedOutput = (preFlightResult.output ?? '').slice(0, 2000)
        const exitCode = preFlightResult.exitCode ?? 1

        eventBus.emit('pipeline:pre-flight-failure', {
          exitCode,
          output: truncatedOutput,
        })

        logger.error(
          { exitCode, reason: preFlightResult.reason },
          'Pre-flight build check failed — aborting pipeline before any story dispatch',
        )

        _state = 'FAILED'
        _completedAt = new Date().toISOString()
        persistState()
        return getStatus()
      }

      if (preFlightResult.status !== 'skipped') {
        logger.info('Pre-flight build check passed')
      }
    }

    try {
      // Story 25-5: Run batches sequentially (contract ordering), groups within each batch in parallel.
      // When no contract dependencies exist, batches has a single element (original behavior).
      for (const batchGroups of batches) {
        await runWithConcurrency(batchGroups, config.maxConcurrency)
      }
    } catch (err) {
      stopHeartbeat()
      _state = 'FAILED'
      _completedAt = new Date().toISOString()
      persistState()
      logger.error({ err }, 'Orchestrator failed with unhandled error')
      return getStatus()
    }

    stopHeartbeat()
    _state = 'COMPLETE'
    _completedAt = new Date().toISOString()

    // Story 25-6: Post-sprint contract verification pass.
    // Runs after all stories reach terminal state, before emitting orchestrator:complete.
    // Query all interface-contract decisions and verify export/import pairs.
    if (projectRoot !== undefined && contractDeclarations.length > 0) {
      try {
        const mismatches = verifyContracts(contractDeclarations, projectRoot)
        if (mismatches.length > 0) {
          _contractMismatches = mismatches
          for (const mismatch of mismatches) {
            eventBus.emit('pipeline:contract-mismatch', {
              exporter: mismatch.exporter,
              importer: mismatch.importer,
              contractName: mismatch.contractName,
              mismatchDescription: mismatch.mismatchDescription,
            })
          }
          logger.warn(
            { mismatchCount: mismatches.length, mismatches },
            'Post-sprint contract verification found mismatches — manual review required',
          )
        } else {
          logger.info('Post-sprint contract verification passed — all declared contracts satisfied')
        }
      } catch (err) {
        logger.error({ err }, 'Post-sprint contract verification threw an error — skipping')
      }
    }

    // Tally results
    let completed = 0
    let escalated = 0
    let failed = 0
    for (const s of _stories.values()) {
      if (s.phase === 'COMPLETE') completed++
      else if (s.phase === 'ESCALATED') {
        if (s.error !== undefined) failed++
        else escalated++
      }
    }

    eventBus.emit('orchestrator:complete', {
      totalStories: storyKeys.length,
      completed,
      escalated,
      failed,
    })
    persistState()

    return getStatus()
  }

  function pause(): void {
    if (_state !== 'RUNNING') return
    _paused = true
    _pauseGate = createPauseGate()
    _state = 'PAUSED'
    eventBus.emit('orchestrator:paused', {})
    logger.info('Orchestrator paused')
  }

  function resume(): void {
    if (_state !== 'PAUSED') return
    _paused = false
    if (_pauseGate !== null) {
      _pauseGate.resolve()
      _pauseGate = null
    }
    _state = 'RUNNING'
    eventBus.emit('orchestrator:resumed', {})
    logger.info('Orchestrator resumed')
  }

  return {
    run,
    pause,
    resume,
    getStatus,
  }
}
