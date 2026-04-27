/**
 * runProbeAuthor — compiled probe-author workflow function.
 *
 * Authors runtime probes from AC intent alone (no implementation files,
 * no architecture constraints). Grounds probe quality in the story's
 * acceptance criteria rather than implementation details.
 *
 * Story 60-12: probe-author task type + dispatch wiring.
 *
 * Architecture constraints (ADR-001, ADR-003, ADR-005):
 *  - Services consumed via WorkflowDeps injection
 *  - Subprocess management delegated to Dispatcher
 *  - All imports use .js extension (ESM)
 */

import type { WorkflowDeps, ProbeAuthorParams, ProbeAuthorResult } from './types.js'
import { ProbeAuthorResultSchema } from './schemas.js'
import { assemblePrompt } from './prompt-assembler.js'
import { createLogger } from '../../utils/logger.js'
import { getTokenCeiling } from './token-ceiling.js'
import { RuntimeProbeListSchema } from '@substrate-ai/sdlc'
import type { RuntimeProbe } from '@substrate-ai/sdlc'

const logger = createLogger('compiled-workflows:probe-author')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Token ceiling resolved at runtime via getTokenCeiling (see token-ceiling.ts)

/** Default timeout for probe-author dispatches in milliseconds (5 min — lightweight call) */
const DEFAULT_TIMEOUT_MS = 300_000

// ---------------------------------------------------------------------------
// runProbeAuthor
// ---------------------------------------------------------------------------

/**
 * Execute the compiled probe-author workflow.
 *
 * Deliberately scope-limited: receives rendered AC section and source epic AC
 * section only — no implementation files, no architecture constraints.
 *
 * @param deps - Injected dependencies (pack, dispatcher, etc.)
 * @param params - Parameters (storyKey, renderedAcSection, sourceEpicAcSection)
 * @returns ProbeAuthorResult with result, probes array, and tokenUsage
 */
export async function runProbeAuthor(
  deps: WorkflowDeps,
  params: ProbeAuthorParams,
): Promise<ProbeAuthorResult> {
  const { storyKey, renderedAcSection, sourceEpicAcSection, pipelineRunId } = params

  logger.info({ storyKey, pipelineRunId }, 'Starting compiled probe-author workflow')

  // Resolve token ceiling: config override takes priority over hardcoded default
  const { ceiling: TOKEN_CEILING, source: tokenCeilingSource } = getTokenCeiling(
    'probe-author',
    deps.tokenCeilings,
  )
  logger.info(
    { workflow: 'probe-author', ceiling: TOKEN_CEILING, source: tokenCeilingSource },
    'Token ceiling resolved',
  )

  // ---------------------------------------------------------------------------
  // Step 1: Validate AC inputs — fail loudly before dispatch if either is blank
  // ---------------------------------------------------------------------------

  if (!renderedAcSection.trim() || !sourceEpicAcSection.trim()) {
    logger.warn(
      { storyKey },
      'Probe-author called with empty AC section(s) — failing loudly',
    )
    return makeProbeAuthorFailureResult(
      'missing_ac_input: renderedAcSection and sourceEpicAcSection are required',
    )
  }

  // ---------------------------------------------------------------------------
  // Step 2: Retrieve compiled prompt template from methodology pack
  // ---------------------------------------------------------------------------

  let template: string
  try {
    template = await deps.pack.getPrompt('probe-author')
    logger.debug({ storyKey }, 'Retrieved probe-author prompt template from pack')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Failed to retrieve probe-author prompt template')
    return makeProbeAuthorFailureResult(`template_load_failed: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 3: Assemble prompt with token budget enforcement
  // ---------------------------------------------------------------------------

  const { prompt, tokenCount, truncated } = assemblePrompt(
    template,
    [
      { name: 'rendered_ac_section', content: renderedAcSection, priority: 'required' },
      { name: 'source_epic_ac_section', content: sourceEpicAcSection, priority: 'required' },
    ],
    TOKEN_CEILING,
  )

  logger.info(
    { storyKey, tokenCount, ceiling: TOKEN_CEILING, truncated },
    'Assembled probe-author prompt',
  )

  // ---------------------------------------------------------------------------
  // Step 4: Dispatch to agent
  // ---------------------------------------------------------------------------

  let dispatchResult
  try {
    const handle = deps.dispatcher.dispatch({
      prompt,
      agent: deps.agentId ?? 'claude-code',
      taskType: 'probe-author',
      timeout: DEFAULT_TIMEOUT_MS,
      outputSchema: ProbeAuthorResultSchema,
      ...(deps.projectRoot !== undefined ? { workingDirectory: deps.projectRoot } : {}),
      ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
      storyKey,
    })

    dispatchResult = await handle.result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Probe-author dispatch threw an unexpected error')
    return makeProbeAuthorFailureResult(`dispatch_error: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 5: Check dispatch status and extract token usage
  // ---------------------------------------------------------------------------

  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  if (dispatchResult.status === 'timeout') {
    logger.warn(
      { storyKey, durationMs: dispatchResult.durationMs },
      'Probe-author dispatch timed out',
    )
    return {
      ...makeProbeAuthorFailureResult(`dispatch_timeout after ${dispatchResult.durationMs}ms`),
      tokenUsage,
    }
  }

  if (dispatchResult.status === 'failed' || dispatchResult.exitCode !== 0) {
    logger.warn(
      { storyKey, exitCode: dispatchResult.exitCode, status: dispatchResult.status },
      'Probe-author dispatch failed',
    )
    return {
      ...makeProbeAuthorFailureResult(
        `dispatch_failed with exit_code=${dispatchResult.exitCode}`,
      ),
      tokenUsage,
    }
  }

  if (dispatchResult.parseError !== null || dispatchResult.parsed === null) {
    const details = dispatchResult.parseError ?? 'parsed result was null'
    logger.warn({ storyKey, parseError: details }, 'Probe-author YAML schema validation failed')
    return {
      ...makeProbeAuthorFailureResult(`schema_validation_failed: ${details}`),
      tokenUsage,
    }
  }

  // ---------------------------------------------------------------------------
  // Step 6: Validate probes through RuntimeProbeListSchema and return success
  // ---------------------------------------------------------------------------

  const parsed = dispatchResult.parsed

  // Secondary validation: ensure the probes array itself is valid (belt-and-suspenders
  // since ProbeAuthorResultSchema already wraps RuntimeProbeListSchema)
  const probeValidation = RuntimeProbeListSchema.safeParse(parsed.probes)
  if (!probeValidation.success) {
    const details = probeValidation.error.message
    logger.warn({ storyKey, details }, 'Probe-author probes failed RuntimeProbeListSchema validation')
    return {
      ...makeProbeAuthorFailureResult(`schema_validation_failed: ${details}`),
      tokenUsage,
    }
  }

  const probes: RuntimeProbe[] = probeValidation.data

  logger.info(
    { storyKey, result: parsed.result, probeCount: probes.length },
    'Probe-author workflow completed',
  )

  return {
    result: parsed.result,
    probes,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a failure result with sensible defaults.
 */
function makeProbeAuthorFailureResult(error: string): ProbeAuthorResult {
  return {
    result: 'failed',
    probes: [],
    error,
    tokenUsage: { input: 0, output: 0 },
  }
}
