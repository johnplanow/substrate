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
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { updatePipelineRun, getDecisionsByPhase, registerArtifact } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { assemblePrompt } from '../compiled-workflows/prompt-assembler.js'
import { runCreateStory } from '../compiled-workflows/create-story.js'
import { runDevStory } from '../compiled-workflows/dev-story.js'
import { runCodeReview } from '../compiled-workflows/code-review.js'
import { analyzeStoryComplexity, planTaskBatches } from '../compiled-workflows/index.js'
import { detectConflictGroups } from './conflict-detector.js'
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
  const { db, pack, contextCompiler, dispatcher, eventBus, config, projectRoot } = deps

  const logger = createLogger('implementation-orchestrator')

  // -- mutable orchestrator state --

  let _state: OrchestratorState = 'IDLE'
  let _startedAt: string | undefined
  let _completedAt: string | undefined
  let _decomposition: DecompositionMetrics | undefined

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
    if (_decomposition !== undefined) {
      status.decomposition = { ..._decomposition }
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

    // Check if a story file already exists for this story key.
    // Pre-existing stories (e.g., from BMAD auto-implement) should be reused
    // so their full task list is available for complexity analysis and batching.
    const artifactsDir = projectRoot ? join(projectRoot, '_bmad-output', 'implementation-artifacts') : undefined
    if (artifactsDir && existsSync(artifactsDir)) {
      try {
        const files = readdirSync(artifactsDir)
        const match = files.find((f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md'))
        if (match) {
          storyFilePath = join(artifactsDir, match)
          logger.info({ storyKey, storyFilePath }, 'Found existing story file — skipping create-story')
          eventBus.emit('orchestrator:story-phase-complete', {
            storyKey,
            phase: 'IN_STORY_CREATION',
            result: { result: 'success', story_file: storyFilePath, story_key: storyKey },
          })
          persistState()
        }
      } catch {
        // If directory read fails, fall through to create-story
      }
    }

    if (storyFilePath === undefined) {
    try {
      const createResult = await runCreateStory(
        { db, pack, contextCompiler, dispatcher, projectRoot },
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
    } // end if (storyFilePath === undefined)

    // -- dev-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    updateStory(storyKey, { phase: 'IN_DEV' as StoryPhase })
    persistState()

    let devFilesModified: string[] = []
    // Per-batch file tracking for batched review (empty when single dispatch)
    const batchFileGroups: Array<{ batchIndex: number; files: string[] }> = []

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
          let batchResult
          try {
            batchResult = await runDevStory(
              { db, pack, contextCompiler, dispatcher, projectRoot },
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
        const devResult = await runDevStory(
          { db, pack, contextCompiler, dispatcher, projectRoot },
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

        if (devResult.result === 'failed') {
          // Dev agent failed but may have produced code (common when agent
          // exhausts turns or exits non-zero after partial work). Proceed to
          // code review — the reviewer will assess actual code state.
          logger.warn('Dev-story reported failure, proceeding to code review', {
            storyKey,
            error: devResult.error,
            filesModified: devFilesModified.length,
          })
        }
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
    let timeoutRetried = false
    let previousIssueList: Array<{ severity?: string; description?: string; file?: string; line?: number }> = []

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
        // Batched review: when decomposition produced multiple batches and this is
        // the first review cycle, review each batch's files separately to keep diff
        // sizes manageable for the headless reviewer. Re-reviews after fixes always
        // review all files since fixes may cross batch boundaries.
        const useBatchedReview = batchFileGroups.length > 1 && previousIssueList.length === 0

        let reviewResult: Awaited<ReturnType<typeof runCodeReview>>

        if (useBatchedReview) {
          // Per-batch reviews — aggregate worst verdict + union issues
          const allIssues: Array<{ severity: 'blocker' | 'major' | 'minor'; description: string; file?: string; line?: number }> = []
          let worstVerdict: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' = 'SHIP_IT'
          let aggregateTokens = { input: 0, output: 0 }
          let lastError: string | undefined
          let lastRawOutput: string | undefined

          const verdictRank = { 'SHIP_IT': 0, 'NEEDS_MINOR_FIXES': 1, 'NEEDS_MAJOR_REWORK': 2 } as const

          for (const group of batchFileGroups) {
            logger.info(
              { storyKey, batchIndex: group.batchIndex, fileCount: group.files.length },
              'Running batched code review',
            )
            const batchReview = await runCodeReview(
              { db, pack, contextCompiler, dispatcher, projectRoot },
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
          reviewResult = await runCodeReview(
            { db, pack, contextCompiler, dispatcher, projectRoot },
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

        // Phantom review detection: if the verdict is NEEDS_MAJOR_REWORK but the
        // issue list is empty, the reviewer failed to produce actionable output
        // (schema validation failure, timeout, truncated response). Dispatching a
        // fix agent with no specific issues to fix is pure waste (~$0.07/cycle).
        // Retry the review once before treating it as a real verdict.
        const isPhantomReview = reviewResult.verdict !== 'SHIP_IT'
          && (reviewResult.issue_list === undefined || reviewResult.issue_list.length === 0)
          && reviewResult.error !== undefined
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

      // Model escalation: use Opus for major rework, Sonnet for minor fixes
      const fixModel = taskType === 'major-rework' ? 'claude-opus-4-6' : undefined

      try {
        // Assemble a context-aware fix prompt from the pack template
        let fixPrompt: string
        try {
          const fixTemplate = await pack.getPrompt('fix-story')
          const storyContent = await readFile(storyFilePath ?? '', 'utf-8')

          // Format review feedback: verdict + serialized issue list
          // Guard against empty issue lists — provide fallback guidance
          let reviewFeedback: string
          if (issueList.length === 0) {
            reviewFeedback = [
              `Verdict: ${verdict}`,
              'Issues: The reviewer flagged this as needing work but did not provide specific issues.',
              'Instructions: Re-read the story file carefully, compare each acceptance criterion against the current implementation, and fix any gaps you find.',
              'Focus on: unimplemented ACs, missing tests, incorrect behavior, and incomplete task checkboxes.',
            ].join('\n')
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

          // Query arch constraints from decision store
          let archConstraints = ''
          try {
            const decisions = getDecisionsByPhase(db, 'solutioning')
            const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
            archConstraints = constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
          } catch { /* arch constraints are optional */ }

          const sections = [
            { name: 'story_content', content: storyContent, priority: 'required' as const },
            { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
            { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
          ]
          const assembled = assemblePrompt(fixTemplate, sections, 24000)
          fixPrompt = assembled.prompt
        } catch {
          fixPrompt = `Fix story ${storyKey}: verdict=${verdict}, taskType=${taskType}`
          logger.warn('Failed to assemble fix prompt, using fallback', { storyKey, taskType })
        }

        const handle = dispatcher.dispatch<unknown>({
          prompt: fixPrompt,
          agent: 'claude-code',
          taskType,
          ...(fixModel !== undefined ? { model: fixModel } : {}),
          workingDirectory: projectRoot,
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
          logger.warn('Fix dispatch timed out — escalating story', { storyKey, taskType })
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: `fix-dispatch-timeout (${taskType})`,
            completedAt: new Date().toISOString(),
          })
          eventBus.emit('orchestrator:story-escalated', {
            storyKey,
            lastVerdict: verdict,
            reviewCycles: reviewCycles + 1,
            issues: issueList,
          })
          persistState()
          return
        }

        if (fixResult.status === 'failed') {
          logger.warn('Fix dispatch failed', { storyKey, taskType, exitCode: fixResult.exitCode })
        }
      } catch (err) {
        logger.warn('Fix dispatch failed, continuing to next review', { storyKey, taskType, err })
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
