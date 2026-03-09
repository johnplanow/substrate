/**
 * runTestExpansion — compiled test-expansion workflow function.
 *
 * Runs automatically after a SHIP_IT verdict to identify E2E and integration
 * coverage gaps. Results are persisted to the decision store for later action
 * without blocking story delivery.
 *
 * Token budget strategy (priority order — never truncate story_content):
 *  1. Template base:          ~300 tokens
 *  2. Story content:          ~3,000-4,000 tokens (required — never truncated)
 *  3. Git diff:               ~3,000-5,000 tokens (may fallback to stat-only if oversized)
 *  4. Architecture constraints: ~500 tokens (optional — truncated last)
 */

import { readFile } from 'node:fs/promises'
import { createLogger } from '../../utils/logger.js'
import { getDecisionsByPhase } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { countTokens } from '../context-compiler/token-counter.js'
import { assemblePrompt } from './prompt-assembler.js'
import { TestExpansionResultSchema } from './schemas.js'
import type { WorkflowDeps, TestExpansionParams, TestExpansionResult } from './types.js'
import { getGitDiffForFiles, getGitDiffStatSummary } from './git-helpers.js'
import { getTokenCeiling } from './token-ceiling.js'

const logger = createLogger('compiled-workflows:test-expansion')

// Token ceiling resolved at runtime via getTokenCeiling (see token-ceiling.ts)

// ---------------------------------------------------------------------------
// Graceful fallback
// ---------------------------------------------------------------------------

function defaultFallbackResult(error: string, tokenUsage: { input: number; output: number }): TestExpansionResult {
  return {
    expansion_priority: 'low',
    coverage_gaps: [],
    suggested_tests: [],
    error,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// runTestExpansion
// ---------------------------------------------------------------------------

/**
 * Execute the compiled test-expansion workflow.
 *
 * Steps:
 * 1. Retrieve compiled prompt template via pack.getPrompt('test-expansion')
 * 2. Read story file contents from storyFilePath
 * 3. Query decision store for architecture constraints (solutioning, architecture)
 * 4. Capture scoped git diff for filesModified, with stat-only fallback if oversized
 * 5. Assemble prompt with 20,000-token ceiling
 * 6. Dispatch via dispatcher with taskType='test-expansion'
 * 7. Validate YAML output against TestExpansionResultSchema
 * 8. Return typed TestExpansionResult (never throws — all errors return graceful fallback)
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Story key, story file path, files modified, working directory, pipeline run ID
 * @returns Promise resolving to TestExpansionResult (never rejects)
 */
export async function runTestExpansion(
  deps: WorkflowDeps,
  params: TestExpansionParams,
): Promise<TestExpansionResult> {
  const { storyKey, storyFilePath, pipelineRunId, filesModified, workingDirectory } = params
  const cwd = workingDirectory ?? process.cwd()

  logger.debug({ storyKey, storyFilePath, cwd, pipelineRunId }, 'Starting test-expansion workflow')

  // Resolve token ceiling: config override takes priority over hardcoded default
  const { ceiling: TOKEN_CEILING, source: tokenCeilingSource } = getTokenCeiling(
    'test-expansion',
    deps.tokenCeilings,
  )
  logger.info({ workflow: 'test-expansion', ceiling: TOKEN_CEILING, source: tokenCeilingSource }, 'Token ceiling resolved')

  // Step 1: Get compiled prompt template
  let template: string
  try {
    template = await deps.pack.getPrompt('test-expansion')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ error }, 'Failed to retrieve test-expansion prompt template')
    return defaultFallbackResult(`Failed to retrieve prompt template: ${error}`, { input: 0, output: 0 })
  }

  // Step 2: Read story file
  let storyContent: string
  try {
    storyContent = await readFile(storyFilePath, 'utf-8')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyFilePath, error }, 'Failed to read story file')
    return defaultFallbackResult(`Failed to read story file: ${error}`, { input: 0, output: 0 })
  }

  // Step 3: Query architecture constraints from decision store
  const archConstraintsContent = getArchConstraints(deps)

  // Step 4: Capture scoped git diff (files modified by dev-story) with stat-only fallback
  let gitDiffContent = ''
  if (filesModified && filesModified.length > 0) {
    try {
      const templateTokens = countTokens(template)
      const storyTokens = countTokens(storyContent)
      const constraintTokens = countTokens(archConstraintsContent)
      const nonDiffTokens = templateTokens + storyTokens + constraintTokens

      const scopedDiff = await getGitDiffForFiles(filesModified, cwd)
      const scopedTotal = nonDiffTokens + countTokens(scopedDiff)
      if (scopedTotal <= TOKEN_CEILING) {
        gitDiffContent = scopedDiff
        logger.debug({ fileCount: filesModified.length, tokenCount: scopedTotal }, 'Using scoped file diff')
      } else {
        logger.warn(
          { estimatedTotal: scopedTotal, ceiling: TOKEN_CEILING, fileCount: filesModified.length },
          'Scoped diff exceeds token ceiling — falling back to stat-only summary',
        )
        gitDiffContent = await getGitDiffStatSummary(cwd)
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to get git diff — proceeding with empty diff')
    }
  }

  // Step 5: Assemble prompt
  const sections = [
    { name: 'story_content', content: storyContent, priority: 'required' as const },
    { name: 'git_diff', content: gitDiffContent, priority: 'important' as const },
    { name: 'arch_constraints', content: archConstraintsContent, priority: 'optional' as const },
  ]

  const assembleResult = assemblePrompt(template, sections, TOKEN_CEILING)

  if (assembleResult.truncated) {
    logger.warn(
      { storyKey, tokenCount: assembleResult.tokenCount },
      'Test-expansion prompt truncated to fit token ceiling',
    )
  }

  logger.debug(
    { storyKey, tokenCount: assembleResult.tokenCount, truncated: assembleResult.truncated },
    'Prompt assembled for test-expansion',
  )

  const { prompt } = assembleResult

  // Step 6: Dispatch to agent
  const handle = deps.dispatcher.dispatch({
    prompt,
    agent: 'claude-code',
    taskType: 'test-expansion',
    outputSchema: TestExpansionResultSchema,
    workingDirectory: deps.projectRoot,
    ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
  })

  let dispatchResult
  try {
    dispatchResult = await handle.result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Test-expansion dispatch threw unexpected error')
    return defaultFallbackResult(`Dispatch error: ${error}`, {
      input: Math.ceil(prompt.length / 4),
      output: 0,
    })
  }

  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  // Handle dispatch failures
  if (dispatchResult.status === 'failed') {
    const errorMsg = `Dispatch status: failed. Exit code: ${dispatchResult.exitCode}. ${dispatchResult.parseError ?? ''}`.trim()
    logger.warn({ storyKey, exitCode: dispatchResult.exitCode }, 'Test-expansion dispatch failed')
    return defaultFallbackResult(errorMsg, tokenUsage)
  }

  if (dispatchResult.status === 'timeout') {
    logger.warn({ storyKey }, 'Test-expansion dispatch timed out')
    return defaultFallbackResult(
      'Dispatch status: timeout. The agent did not complete within the allowed time.',
      tokenUsage,
    )
  }

  // Step 7: Schema validation
  if (dispatchResult.parsed === null) {
    const details = dispatchResult.parseError ?? 'No YAML block found in output'
    logger.warn({ storyKey, details }, 'Test-expansion output has no parseable YAML')
    return defaultFallbackResult(`schema_validation_failed: ${details}`, tokenUsage)
  }

  const parseResult = TestExpansionResultSchema.safeParse(dispatchResult.parsed)
  if (!parseResult.success) {
    const details = parseResult.error.message
    logger.warn({ storyKey, details }, 'Test-expansion output failed schema validation')
    return defaultFallbackResult(`schema_validation_failed: ${details}`, tokenUsage)
  }

  const parsed = parseResult.data

  logger.info(
    {
      storyKey,
      expansion_priority: parsed.expansion_priority,
      coverage_gaps: parsed.coverage_gaps.length,
      suggested_tests: parsed.suggested_tests.length,
    },
    'Test-expansion workflow completed successfully',
  )

  return {
    expansion_priority: parsed.expansion_priority,
    coverage_gaps: parsed.coverage_gaps,
    suggested_tests: parsed.suggested_tests,
    notes: parsed.notes,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve architecture constraints from the decision store.
 * Looks for decisions with phase='solutioning', category='architecture'.
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
      'Failed to retrieve architecture constraints',
    )
    return ''
  }
}
