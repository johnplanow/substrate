/**
 * runProbeAuthor — orchestrator integration for probe-author phase.
 *
 * Wraps the probe-author dispatch with orchestrator-level concerns:
 * event-driven AC detection, idempotency checking, atomic file append,
 * retry logic for timeout/invalid-YAML failure modes, and telemetry
 * event emission.
 *
 * Story 60-13: Orchestrator Integration of Probe-Author Phase.
 *
 * Architecture constraints (ADR-001, ADR-003):
 *  - Services consumed via WorkflowDeps injection
 *  - All imports use .js extension (ESM)
 *  - Never throws — all errors are result-encoded (mirrors runTestPlan shape)
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import type { WorkflowDeps } from '../compiled-workflows/types.js'
import { detectsEventDrivenAC, RuntimeProbeListSchema } from '@substrate-ai/sdlc'
import type { RuntimeProbe } from '@substrate-ai/sdlc'
import { ProbeAuthorResultSchema } from '../compiled-workflows/schemas.js'
import { assemblePrompt } from '../compiled-workflows/prompt-assembler.js'
import { getTokenCeiling } from '../compiled-workflows/token-ceiling.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('implementation-orchestrator:probe-author')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for probe-author dispatches (5 min) */
const DEFAULT_TIMEOUT_MS = 300_000

/** Timeout multiplier for the single retry after a timeout failure */
const TIMEOUT_RETRY_MULTIPLIER = 1.5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for the orchestrator-level probe-author integration.
 * Distinct from compiled-workflows ProbeAuthorParams — this layer adds
 * file-path and epic-content for the gate checks.
 */
export interface ProbeAuthorParams {
  /** Story key for tracking and telemetry event payloads */
  storyKey: string
  /** Absolute path to the story artifact file on disk */
  storyFilePath: string
  /** Pipeline run ID for telemetry events and decision-store attribution */
  pipelineRunId: string
  /**
   * Source AC content from the epic file used as `source_epic_ac_section`
   * in the probe-author prompt. Typically the story's section extracted
   * from the consolidated epics document.
   */
  sourceAcContent: string
  /**
   * Epic content passed to `detectsEventDrivenAC` for the event-driven gate.
   * Usually the same as sourceAcContent (the story's AC section from the epic),
   * but kept separate so callers can pass a broader context if needed.
   */
  epicContent: string
  /**
   * Optional telemetry event emitter. When provided, the function calls
   * `emitEvent(name, payload)` for probe-author:dispatched and failure events.
   * Tests inject a spy here; orchestrator-impl.ts wires in eventBus.emit.
   */
  emitEvent?: (eventName: string, payload: Record<string, unknown>) => void
  /**
   * Story 60-14e: bypass Gate 1 (event-driven AC detection) and Gate 2
   * (artifact already has Runtime Probes section). Used by the
   * `substrate probe-author dispatch --bypass-gates` operator path so
   * the eval harness can measure probe-author's *authoring quality*
   * across non-event-driven defect classes independent of its production
   * *dispatch gating*. Production callers (orchestrator) leave this
   * undefined / false — the gates remain authoritative there.
   */
  bypassGates?: boolean
}

/**
 * Result from the orchestrator-level probe-author integration.
 * Mirrors runTestPlan shape: same (deps, params) call convention, returns
 * typed result object with tokenUsage, never throws.
 */
export interface ProbeAuthorResult {
  /** Whether the phase succeeded, failed, or was skipped */
  result: 'success' | 'failed' | 'skipped'
  /** Number of probes authored and appended to the story artifact (0 on skip/fail) */
  probesAuthoredCount: number
  /** Error description — populated on failure paths only */
  error?: string
  /** Accumulated token usage across all dispatch attempts */
  tokenUsage: {
    input: number
    output: number
  }
  /** Total elapsed milliseconds for this phase */
  durationMs: number
}

// ---------------------------------------------------------------------------
// runProbeAuthor
// ---------------------------------------------------------------------------

/**
 * Execute the probe-author integration phase.
 *
 * Gate 1 — Event-driven AC check: calls `detectsEventDrivenAC(epicContent)`.
 *   Skip if the source AC does not describe a hook, timer, signal, or webhook.
 *
 * Gate 2 — Idempotency check: reads storyFilePath and checks for an existing
 *   `## Runtime Probes` section. Skip if present (probes already authored).
 *
 * Dispatch: assembles the probe-author prompt and dispatches via WorkflowDeps.
 *   Uses ProbeAuthorResultSchema (result + probes) as outputSchema so the
 *   existing YAML-parser anchor-key detection works correctly.
 *
 * Retry policy:
 *   - Timeout → single retry at TIMEOUT_RETRY_MULTIPLIER × DEFAULT_TIMEOUT_MS.
 *     Fall through if second attempt also times out.
 *   - Invalid YAML → single retry with augmented prompt that includes the parse
 *     error and the first 500 chars of bad output. Fall through if retry fails.
 *   - Dispatch error (process crash, network failure) → fall through immediately.
 *   - Empty probes list → emit `probe-author:no-probes-authored`, fall through.
 *
 * All failure paths are non-fatal — returns result: 'failed' instead of
 * throwing so the caller can unconditionally fall through to dev-story.
 */
export async function runProbeAuthor(
  deps: WorkflowDeps,
  params: ProbeAuthorParams,
): Promise<ProbeAuthorResult> {
  const start = Date.now()
  const { storyKey, storyFilePath, pipelineRunId, sourceAcContent, epicContent, emitEvent, bypassGates } = params
  const tokenUsage = { input: 0, output: 0 }

  // ---------------------------------------------------------------------------
  // Gate 1: Is the AC event-driven?
  // ---------------------------------------------------------------------------
  // Story 60-14e: --bypass-gates allows operator/eval-harness invocations
  // to skip the production dispatch gates and measure authoring quality
  // independent of dispatch gating. Production (orchestrator) calls leave
  // bypassGates undefined.

  if (bypassGates !== true && !detectsEventDrivenAC(epicContent)) {
    logger.debug({ storyKey }, 'probe-author: source AC not event-driven — skipping')
    emitEvent?.('probe-author:skipped', {
      storyKey,
      runId: pipelineRunId,
      reason: 'non-event-driven',
    })
    return makeSkippedResult(tokenUsage, start)
  }

  // ---------------------------------------------------------------------------
  // Gate 2: Does the story file already have a ## Runtime Probes section?
  // ---------------------------------------------------------------------------

  let storyContent: string
  try {
    storyContent = await readFile(storyFilePath, 'utf-8')
    if (bypassGates !== true && /^## Runtime Probes/m.test(storyContent)) {
      logger.info({ storyKey }, 'probe-author: story artifact already has ## Runtime Probes — skipping')
      emitEvent?.('probe-author:skipped', {
        storyKey,
        runId: pipelineRunId,
        reason: 'author-declared-probes-present',
      })
      return makeSkippedResult(tokenUsage, start)
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'probe-author: failed to read story file — falling through')
    emitEvent?.('probe-author:dispatch-error', { storyKey, runId: pipelineRunId, error })
    return makeFailedResult(`story_file_read_error: ${error}`, tokenUsage, start)
  }

  // ---------------------------------------------------------------------------
  // Retrieve prompt template from methodology pack
  // ---------------------------------------------------------------------------

  const { ceiling: TOKEN_CEILING } = getTokenCeiling('probe-author', deps.tokenCeilings)
  let template: string
  try {
    template = await deps.pack.getPrompt('probe-author')
    logger.debug({ storyKey }, 'probe-author: retrieved prompt template')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'probe-author: failed to get prompt template — falling through')
    emitEvent?.('probe-author:dispatch-error', { storyKey, runId: pipelineRunId, error })
    return makeFailedResult(`template_load_failed: ${error}`, tokenUsage, start)
  }

  // ---------------------------------------------------------------------------
  // Assemble base prompt
  // ---------------------------------------------------------------------------

  const { prompt: basePrompt } = assemblePrompt(
    template,
    [
      { name: 'rendered_ac_section', content: storyContent, priority: 'required' },
      { name: 'source_epic_ac_section', content: sourceAcContent, priority: 'required' },
    ],
    TOKEN_CEILING,
  )

  // ---------------------------------------------------------------------------
  // Dispatch helper (shared across first attempt and retries)
  // ---------------------------------------------------------------------------

  const doDispatch = async (promptText: string, timeoutMs: number) => {
    const handle = deps.dispatcher.dispatch({
      prompt: promptText,
      agent: deps.agentId ?? 'claude-code',
      taskType: 'probe-author',
      timeout: timeoutMs,
      // Use ProbeAuthorResultSchema so the YAML-parser's anchor-key detector
      // picks up `result:` in the agent output. RuntimeProbeListSchema
      // (bare list) lacks anchor keys and would always produce parsed=null.
      outputSchema: ProbeAuthorResultSchema,
      ...(deps.projectRoot !== undefined ? { workingDirectory: deps.projectRoot } : {}),
      ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
      storyKey,
    })
    return await handle.result
  }

  // ---------------------------------------------------------------------------
  // Failure mode: Dispatch error
  // ---------------------------------------------------------------------------

  let dispatchResult: Awaited<ReturnType<typeof doDispatch>>
  try {
    logger.info({ storyKey }, 'probe-author: dispatching probe-author agent')
    dispatchResult = await doDispatch(basePrompt, DEFAULT_TIMEOUT_MS)
    tokenUsage.input += dispatchResult.tokenEstimate.input
    tokenUsage.output += dispatchResult.tokenEstimate.output
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'probe-author: dispatch error — falling through to dev-story')
    emitEvent?.('probe-author:dispatch-error', { storyKey, runId: pipelineRunId, error })
    return makeFailedResult(`dispatch_error: ${error}`, tokenUsage, start)
  }

  // ---------------------------------------------------------------------------
  // Failure mode: Timeout → single retry at 1.5× timeout
  // ---------------------------------------------------------------------------

  if (dispatchResult.status === 'timeout') {
    const elapsedMs = Date.now() - start
    logger.warn({ storyKey, elapsedMs }, 'probe-author: dispatch timed out — retrying with 1.5× timeout')
    emitEvent?.('probe-author:timeout', { storyKey, runId: pipelineRunId, elapsedMs })

    try {
      const retryResult = await doDispatch(basePrompt, Math.round(DEFAULT_TIMEOUT_MS * TIMEOUT_RETRY_MULTIPLIER))
      tokenUsage.input += retryResult.tokenEstimate.input
      tokenUsage.output += retryResult.tokenEstimate.output

      if (retryResult.status === 'timeout') {
        logger.warn({ storyKey }, 'probe-author: retry also timed out — falling through to dev-story')
        return makeFailedResult('dispatch_timeout', tokenUsage, start)
      }

      dispatchResult = retryResult
    } catch (retryErr) {
      const error = retryErr instanceof Error ? retryErr.message : String(retryErr)
      logger.warn({ storyKey, error }, 'probe-author: retry dispatch error — falling through to dev-story')
      return makeFailedResult(`retry_dispatch_error: ${error}`, tokenUsage, start)
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch failure (non-zero exit code)
  // ---------------------------------------------------------------------------

  if (dispatchResult.status === 'failed' || dispatchResult.exitCode !== 0) {
    const error = `dispatch_failed with exit_code=${dispatchResult.exitCode}`
    logger.warn({ storyKey }, `probe-author: ${error} — falling through to dev-story`)
    emitEvent?.('probe-author:dispatch-error', { storyKey, runId: pipelineRunId, error })
    return makeFailedResult(error, tokenUsage, start)
  }

  // ---------------------------------------------------------------------------
  // Failure mode: Invalid YAML → single retry with augmented prompt
  // ---------------------------------------------------------------------------

  if (dispatchResult.parseError !== null || dispatchResult.parsed === null) {
    const parseError = dispatchResult.parseError ?? 'parsed result was null'
    const rawOutputSnippet = dispatchResult.output.slice(0, 500)
    logger.warn(
      { storyKey, parseError, rawOutputSnippet },
      'probe-author: YAML parse failure — retrying with augmented prompt',
    )
    emitEvent?.('probe-author:invalid-output', {
      storyKey,
      runId: pipelineRunId,
      parseError,
      rawOutputSnippet,
    })

    const augmentedPrompt =
      `${basePrompt}\n\n---\n\n` +
      `Previous output failed parsing with: ${parseError}; ` +
      `produce a single yaml block conforming to RuntimeProbeListSchema`

    try {
      const retryResult = await doDispatch(augmentedPrompt, DEFAULT_TIMEOUT_MS)
      tokenUsage.input += retryResult.tokenEstimate.input
      tokenUsage.output += retryResult.tokenEstimate.output

      if (retryResult.parseError !== null || retryResult.parsed === null) {
        logger.warn({ storyKey }, 'probe-author: retry still produced invalid YAML — falling through')
        return makeFailedResult('invalid_yaml_after_retry', tokenUsage, start)
      }

      dispatchResult = retryResult
    } catch (retryErr) {
      const error = retryErr instanceof Error ? retryErr.message : String(retryErr)
      logger.warn({ storyKey, error }, 'probe-author: retry error after invalid YAML — falling through')
      return makeFailedResult(`retry_error_after_invalid_yaml: ${error}`, tokenUsage, start)
    }
  }

  // ---------------------------------------------------------------------------
  // Extract and validate probes from parsed result
  // ---------------------------------------------------------------------------

  // dispatchResult.parsed is ProbeAuthorSchemaOutput: { result, probes }
  const parsedOutput = dispatchResult.parsed!
  const probeValidation = RuntimeProbeListSchema.safeParse(parsedOutput.probes)
  if (!probeValidation.success) {
    const validationError = probeValidation.error.message
    logger.warn({ storyKey, validationError }, 'probe-author: probes failed RuntimeProbeListSchema — falling through')
    return makeFailedResult(`schema_validation_failed: ${validationError}`, tokenUsage, start)
  }
  // Story 60-15: stamp every authored probe with `_authoredBy: 'probe-author'`
  // before append. Powers the byAuthor breakdown in `substrate status`/`metrics`
  // and the catch-rate KPI's per-author attribution. Pre-existing probes
  // already in the artifact (legacy create-story-ac-transfer path) carry no
  // discriminator; the rollup helper treats absence as
  // `'create-story-ac-transfer'`.
  const probes: RuntimeProbe[] = probeValidation.data.map((p) => ({
    ...p,
    _authoredBy: 'probe-author' as const,
  }))

  // Story 60-15: emit output-parsed event after schema validation
  // succeeded but before append/idempotency checks.
  emitEvent?.('probe-author:output-parsed', {
    storyKey,
    runId: pipelineRunId,
    probesParsedCount: probes.length,
  })

  // ---------------------------------------------------------------------------
  // Failure mode: Empty probes list (valid, not a failure)
  // ---------------------------------------------------------------------------

  if (probes.length === 0) {
    logger.info({ storyKey }, 'probe-author: authored empty probes list — no probes needed')
    emitEvent?.('probe-author:no-probes-authored', { storyKey, runId: pipelineRunId })
    return {
      result: 'success',
      probesAuthoredCount: 0,
      tokenUsage,
      durationMs: Date.now() - start,
    }
  }

  // ---------------------------------------------------------------------------
  // Append probes to story file atomically and idempotently
  // ---------------------------------------------------------------------------

  try {
    // Re-read for idempotency: another caller might have written probes
    // between our initial check and now (e.g., concurrent retry).
    const refreshedContent = await readFile(storyFilePath, 'utf-8')
    if (/^## Runtime Probes/m.test(refreshedContent)) {
      logger.info(
        { storyKey },
        'probe-author: ## Runtime Probes section appeared after dispatch — skipping append (idempotent)',
      )
      const dispatchDurationMs = Date.now() - start
      emitEvent?.('probe-author:dispatched', {
        storyKey,
        runId: pipelineRunId,
        probesAuthoredCount: 0,
        dispatchDurationMs,
        costUsd: estimateDispatchCost(tokenUsage.input, tokenUsage.output),
      })
      return makeSkippedResult(tokenUsage, start)
    }

    // Serialize probes back to YAML and wrap in the ## Runtime Probes section.
    // `parseRuntimeProbes` expects: ## heading + yaml fenced block.
    const probesYaml = (yaml.dump(probes, { lineWidth: 120 }) as string).trimEnd()
    const probesSection = `\n## Runtime Probes\n\n\`\`\`yaml\n${probesYaml}\n\`\`\`\n`
    const newContent = refreshedContent + probesSection

    // Atomic write: write to a temp file in the same directory, then rename.
    // rename() is atomic on POSIX filesystems; prevents partial-write visibility.
    const targetDir = dirname(storyFilePath)
    const tmpPath = join(targetDir, `.probe-author-${Date.now()}.tmp.md`)
    await writeFile(tmpPath, newContent, 'utf-8')
    await rename(tmpPath, storyFilePath)

    logger.info({ storyKey, probesCount: probes.length }, 'probe-author: appended ## Runtime Probes section')

    // Story 60-15: terminal success event for the probe-author phase.
    emitEvent?.('probe-author:appended-to-artifact', {
      storyKey,
      runId: pipelineRunId,
      probesAuthoredCount: probes.length,
      storyFilePath,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'probe-author: failed to append probes — falling through to dev-story')
    return {
      result: 'failed',
      probesAuthoredCount: probes.length,
      error: `append_error: ${error}`,
      tokenUsage,
      durationMs: Date.now() - start,
    }
  }

  // ---------------------------------------------------------------------------
  // Emit telemetry and return success
  // ---------------------------------------------------------------------------

  const dispatchDurationMs = Date.now() - start
  const costUsd = estimateDispatchCost(tokenUsage.input, tokenUsage.output)
  emitEvent?.('probe-author:dispatched', {
    storyKey,
    runId: pipelineRunId,
    probesAuthoredCount: probes.length,
    dispatchDurationMs,
    costUsd,
  })

  logger.info({ storyKey, probesAuthoredCount: probes.length }, 'probe-author: phase complete')

  return {
    result: 'success',
    probesAuthoredCount: probes.length,
    tokenUsage,
    durationMs: Date.now() - start,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkippedResult(
  tokenUsage: { input: number; output: number },
  start: number,
): ProbeAuthorResult {
  return { result: 'skipped', probesAuthoredCount: 0, tokenUsage, durationMs: Date.now() - start }
}

function makeFailedResult(
  error: string,
  tokenUsage: { input: number; output: number },
  start: number,
): ProbeAuthorResult {
  return { result: 'failed', probesAuthoredCount: 0, error, tokenUsage, durationMs: Date.now() - start }
}

/** Claude pricing: $3/1M input, $15/1M output */
function estimateDispatchCost(input: number, output: number): number {
  return (input * 3 + output * 15) / 1_000_000
}
