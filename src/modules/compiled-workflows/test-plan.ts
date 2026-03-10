/**
 * runTestPlan — compiled test-plan workflow function.
 *
 * Generates a pre-implementation test plan per-story immediately after
 * story creation and before dev-story begins. The plan is stored in the
 * decision store so dev-story can inject it into the implementation prompt.
 *
 * Architecture constraints (ADR-001, ADR-003, ADR-005):
 *  - Services consumed via WorkflowDeps injection
 *  - SQLite queries use the passed db instance
 *  - Subprocess management delegated to Dispatcher
 *  - All imports use .js extension (ESM)
 */

import { readFile } from 'node:fs/promises'
import type { WorkflowDeps, TestPlanParams, TestPlanResult } from './types.js'
import { TestPlanResultSchema } from './schemas.js'
import { assemblePrompt } from './prompt-assembler.js'
import { createDecision, getDecisionsByPhase } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { TEST_PLAN } from '../../persistence/schemas/operational.js'
import { createLogger } from '../../utils/logger.js'
import { getTokenCeiling } from './token-ceiling.js'

const logger = createLogger('compiled-workflows:test-plan')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Token ceiling resolved at runtime via getTokenCeiling (see token-ceiling.ts)

/** Default timeout for test-plan dispatches in milliseconds (5 min — lightweight call) */
const DEFAULT_TIMEOUT_MS = 300_000

// ---------------------------------------------------------------------------
// runTestPlan
// ---------------------------------------------------------------------------

/**
 * Execute the compiled test-plan workflow.
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Parameters (storyKey, storyFilePath, pipelineRunId)
 * @returns TestPlanResult with result, test_files, test_categories, coverage_notes, tokenUsage
 */
export async function runTestPlan(
  deps: WorkflowDeps,
  params: TestPlanParams,
): Promise<TestPlanResult> {
  const { storyKey, storyFilePath, pipelineRunId } = params

  logger.info({ storyKey, storyFilePath }, 'Starting compiled test-plan workflow')

  // Resolve token ceiling: config override takes priority over hardcoded default
  const { ceiling: TOKEN_CEILING, source: tokenCeilingSource } = getTokenCeiling(
    'test-plan',
    deps.tokenCeilings,
  )
  logger.info({ workflow: 'test-plan', ceiling: TOKEN_CEILING, source: tokenCeilingSource }, 'Token ceiling resolved')

  // ---------------------------------------------------------------------------
  // Step 1: Retrieve compiled prompt template from methodology pack
  // ---------------------------------------------------------------------------

  let template: string
  try {
    template = await deps.pack.getPrompt('test-plan')
    logger.debug({ storyKey }, 'Retrieved test-plan prompt template from pack')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Failed to retrieve test-plan prompt template')
    return makeTestPlanFailureResult(`template_load_failed: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 2: Read story file from disk
  // ---------------------------------------------------------------------------

  let storyContent: string
  try {
    storyContent = await readFile(storyFilePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn({ storyKey, storyFilePath }, 'Story file not found for test planning')
      return makeTestPlanFailureResult('story_file_not_found')
    }
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, storyFilePath, error }, 'Failed to read story file for test planning')
    return makeTestPlanFailureResult(`story_file_read_error: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 3: Query architecture constraints from decision store (optional context)
  // ---------------------------------------------------------------------------

  const archConstraintsContent = getArchConstraints(deps)

  // ---------------------------------------------------------------------------
  // Step 4: Assemble prompt with token budget enforcement
  // ---------------------------------------------------------------------------

  const { prompt, tokenCount, truncated } = assemblePrompt(
    template,
    [
      { name: 'story_content', content: storyContent, priority: 'required' },
      { name: 'architecture_constraints', content: archConstraintsContent, priority: 'optional' },
    ],
    TOKEN_CEILING,
  )

  logger.info(
    { storyKey, tokenCount, ceiling: TOKEN_CEILING, truncated },
    'Assembled test-plan prompt',
  )

  // ---------------------------------------------------------------------------
  // Step 5: Dispatch to agent
  // ---------------------------------------------------------------------------

  let dispatchResult
  try {
    const handle = deps.dispatcher.dispatch({
      prompt,
      agent: 'claude-code',
      taskType: 'test-plan',
      timeout: DEFAULT_TIMEOUT_MS,
      outputSchema: TestPlanResultSchema,
      ...(deps.projectRoot !== undefined ? { workingDirectory: deps.projectRoot } : {}),
      ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
      storyKey,
    })

    dispatchResult = await handle.result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Test-plan dispatch threw an unexpected error')
    return makeTestPlanFailureResult(`dispatch_error: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 5: Check dispatch status
  // ---------------------------------------------------------------------------

  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  if (dispatchResult.status === 'timeout') {
    logger.warn({ storyKey, durationMs: dispatchResult.durationMs }, 'Test-plan dispatch timed out')
    return { ...makeTestPlanFailureResult(`dispatch_timeout after ${dispatchResult.durationMs}ms`), tokenUsage }
  }

  if (dispatchResult.status === 'failed' || dispatchResult.exitCode !== 0) {
    logger.warn(
      { storyKey, exitCode: dispatchResult.exitCode, status: dispatchResult.status },
      'Test-plan dispatch failed',
    )
    return {
      ...makeTestPlanFailureResult(`dispatch_failed with exit_code=${dispatchResult.exitCode}`),
      tokenUsage,
    }
  }

  if (dispatchResult.parseError !== null || dispatchResult.parsed === null) {
    const details = dispatchResult.parseError ?? 'parsed result was null'
    logger.warn({ storyKey, parseError: details }, 'Test-plan YAML schema validation failed')
    return {
      ...makeTestPlanFailureResult(`schema_validation_failed: ${details}`),
      tokenUsage,
    }
  }

  // ---------------------------------------------------------------------------
  // Step 6: Persist test plan to decision store (best-effort)
  // ---------------------------------------------------------------------------

  const parsed = dispatchResult.parsed

  try {
    createDecision(deps.db, {
      pipeline_run_id: pipelineRunId,
      phase: 'implementation',
      category: TEST_PLAN,
      key: storyKey,
      value: JSON.stringify({
        test_files: parsed.test_files,
        test_categories: parsed.test_categories,
        coverage_notes: parsed.coverage_notes,
      }),
      rationale: `Test plan for ${storyKey}: ${parsed.test_files.length} test files, categories: ${parsed.test_categories.join(', ')}`,
    })
    logger.info(
      { storyKey, fileCount: parsed.test_files.length, categories: parsed.test_categories },
      'Test plan stored in decision store',
    )
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Failed to store test plan in decision store — proceeding anyway')
  }

  // ---------------------------------------------------------------------------
  // Step 7: Return typed success result
  // ---------------------------------------------------------------------------

  logger.info({ storyKey, result: parsed.result }, 'Test-plan workflow completed')

  return {
    result: parsed.result,
    test_files: parsed.test_files,
    test_categories: parsed.test_categories,
    coverage_notes: parsed.coverage_notes,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a failure result with sensible defaults.
 */
function makeTestPlanFailureResult(error: string): TestPlanResult {
  return {
    result: 'failed',
    test_files: [],
    test_categories: [],
    coverage_notes: '',
    error,
    tokenUsage: { input: 0, output: 0 },
  }
}

/**
 * Retrieve architecture constraints from the decision store.
 * Looks for decisions with phase='solutioning', category='architecture'.
 * Returns empty string if none found or on error (graceful degradation).
 */
function getArchConstraints(deps: WorkflowDeps): string {
  try {
    const decisions = getDecisionsByPhase(deps.db, 'solutioning')
    const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
    if (constraints.length === 0) return ''
    return constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to retrieve architecture constraints for test-plan — proceeding without them',
    )
    return ''
  }
}
