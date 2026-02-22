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
import { updatePipelineRun } from '../../persistence/queries/decisions.js'
import { runCreateStory } from '../compiled-workflows/create-story.js'
import { runDevStory } from '../compiled-workflows/dev-story.js'
import { runCodeReview } from '../compiled-workflows/code-review.js'
import { detectConflictGroups } from './conflict-detector.js'
import type { ImplementationOrchestrator } from './orchestrator.js'
import type {
  OrchestratorConfig,
  OrchestratorState,
  OrchestratorStatus,
  StoryPhase,
  StoryState,
} from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('implementation-orchestrator')

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
  const { db, pack, contextCompiler, dispatcher, eventBus, config } = deps

  // -- mutable orchestrator state --

  let _state: OrchestratorState = 'IDLE'
  let _startedAt: string | undefined
  let _completedAt: string | undefined

  const _stories = new Map<string, StoryState>()

  let _paused = false
  let _pauseGate: PauseGate | null = null

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
    try {
      const serialized = JSON.stringify(getStatus())
      updatePipelineRun(db, config.pipelineRunId, {
        current_phase: 'implementation',
        token_usage_json: serialized,
      })
    } catch (err) {
      logger.warn('Failed to persist orchestrator state', { err })
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
   * Run the full pipeline for a single story key.
   *
   * Sequence: create-story → dev-story → code-review (with retry/rework up
   * to maxReviewCycles). On SHIP_IT the story is marked COMPLETE. On
   * exhausted retries the story is ESCALATED.
   */
  async function processStory(storyKey: string): Promise<void> {
    logger.info('Processing story', { storyKey })

    // -- create-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    updateStory(storyKey, {
      phase: 'IN_STORY_CREATION' as StoryPhase,
      startedAt: new Date().toISOString(),
    })

    let storyFilePath: string | undefined

    try {
      const createResult = await runCreateStory(
        { db, pack, contextCompiler, dispatcher },
        { epicId: storyKey.split('-')[0] ?? storyKey, storyKey, pipelineRunId: config.pipelineRunId },
      )

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
        eventBus.emit('orchestrator:story-escalated', {
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
        eventBus.emit('orchestrator:story-escalated', {
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
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      eventBus.emit('orchestrator:story-escalated', {
        storyKey,
        lastVerdict: 'create-story-exception',
        reviewCycles: 0,
        issues: [errMsg],
      })
      persistState()
      return
    }

    // -- dev-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    updateStory(storyKey, { phase: 'IN_DEV' as StoryPhase })

    try {
      const devResult = await runDevStory(
        { db, pack, contextCompiler, dispatcher },
        {
          storyKey,
          storyFilePath: storyFilePath ?? '',
          pipelineRunId: config.pipelineRunId,
        },
      )

      eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'IN_DEV',
        result: devResult,
      })
      persistState()

      if (devResult.result === 'failed') {
        const errMsg = devResult.error ?? 'dev-story failed'
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        eventBus.emit('orchestrator:story-escalated', {
          storyKey,
          lastVerdict: 'dev-story-failed',
          reviewCycles: 0,
          issues: [errMsg],
        })
        persistState()
        return
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      eventBus.emit('orchestrator:story-escalated', {
        storyKey,
        lastVerdict: 'dev-story-exception',
        reviewCycles: 0,
        issues: [errMsg],
      })
      persistState()
      return
    }

    // -- code-review phase (with retry/rework) --

    let reviewCycles = 0
    let keepReviewing = true

    while (keepReviewing) {
      await waitIfPaused()
      if (_state !== 'RUNNING') return

      updateStory(storyKey, {
        phase: 'IN_REVIEW' as StoryPhase,
        reviewCycles,
      })

      let verdict: string
      let issueList: unknown[] = []

      try {
        const reviewResult = await runCodeReview(
          { db, pack, contextCompiler, dispatcher },
          {
            storyKey,
            storyFilePath: storyFilePath ?? '',
            pipelineRunId: config.pipelineRunId,
          },
        )

        verdict = reviewResult.verdict
        issueList = reviewResult.issue_list ?? []

        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: 'IN_REVIEW',
          result: reviewResult,
        })

        updateStory(storyKey, { lastVerdict: verdict })
        persistState()
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        eventBus.emit('orchestrator:story-escalated', {
          storyKey,
          lastVerdict: 'code-review-exception',
          reviewCycles,
          issues: [errMsg],
        })
        persistState()
        return
      }

      if (verdict === 'SHIP_IT') {
        updateStory(storyKey, {
          phase: 'COMPLETE' as StoryPhase,
          completedAt: new Date().toISOString(),
        })
        eventBus.emit('orchestrator:story-complete', { storyKey, reviewCycles })
        persistState()
        keepReviewing = false
        return
      }

      // Exceeded max review cycles → escalate
      if (reviewCycles >= config.maxReviewCycles - 1) {
        const finalReviewCycles = reviewCycles + 1
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          reviewCycles: finalReviewCycles,
          completedAt: new Date().toISOString(),
        })
        eventBus.emit('orchestrator:story-escalated', {
          storyKey,
          lastVerdict: verdict,
          reviewCycles: finalReviewCycles,
          issues: issueList,
        })
        persistState()
        return
      }

      // -- dispatch fix prompt --

      await waitIfPaused()
      if (_state !== 'RUNNING') return

      updateStory(storyKey, { phase: 'NEEDS_FIXES' as StoryPhase })

      const taskType = verdict === 'NEEDS_MINOR_FIXES' ? 'minor-fixes' : 'major-rework'

      try {
        let fixPrompt: string
        // Attempt to compile a context-aware prompt; fall back to a descriptive stub
        // if no template is registered for this taskType.
        try {
          const compileResult = contextCompiler.compile({
            taskType,
            pipelineRunId: config.pipelineRunId ?? 'unknown',
            tokenBudget: 8000,
            overrides: { storyKey, verdict },
          })
          fixPrompt = compileResult.prompt
        } catch {
          fixPrompt = `Fix story ${storyKey}: verdict=${verdict}, taskType=${taskType}`
          logger.warn('contextCompiler.compile() failed for fix prompt, using fallback', { storyKey, taskType })
        }

        const handle = dispatcher.dispatch<unknown>({
          prompt: fixPrompt,
          agent: 'claude-code',
          taskType,
        })
        await handle.result
      } catch (err) {
        logger.warn('Fix dispatch failed, continuing to next review', { storyKey, taskType, err })
      }

      reviewCycles++
    }
  }

  /**
   * Process a conflict group: run stories sequentially within the group.
   */
  async function processConflictGroup(group: string[]): Promise<void> {
    for (const storyKey of group) {
      await processStory(storyKey)
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
      logger.warn('run() called while orchestrator is already running or paused — ignoring', { state: _state })
      return getStatus()
    }
    if (_state === 'COMPLETE') {
      logger.warn('run() called on a COMPLETE orchestrator — ignoring', { state: _state })
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

    // Detect conflict groups
    const groups = detectConflictGroups(storyKeys)

    logger.info('Orchestrator starting', {
      storyCount: storyKeys.length,
      groupCount: groups.length,
      maxConcurrency: config.maxConcurrency,
    })

    try {
      await runWithConcurrency(groups, config.maxConcurrency)
    } catch (err) {
      _state = 'FAILED'
      _completedAt = new Date().toISOString()
      persistState()
      logger.error('Orchestrator failed with unhandled error', { err })
      return getStatus()
    }

    _state = 'COMPLETE'
    _completedAt = new Date().toISOString()

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
