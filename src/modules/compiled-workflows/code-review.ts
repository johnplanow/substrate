/**
 * runCodeReview — compiled code-review workflow function.
 *
 * Retrieves a compiled prompt template from the methodology pack,
 * injects context (story content, git diff, architecture constraints),
 * enforces a 12,000-token budget, dispatches to the configured agent,
 * and parses the structured YAML result.
 *
 * Token budget strategy (priority order — never truncate story_content):
 *  1. Template base:          ~400 tokens (adversarial framing, review dimensions)
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
import { CodeReviewResultSchema } from './schemas.js'
import type { WorkflowDeps, CodeReviewParams, CodeReviewResult } from './types.js'
import { getGitDiffSummary, getGitDiffStatSummary } from './git-helpers.js'

const logger = createLogger('compiled-workflows:code-review')

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/**
 * Hard token ceiling for the assembled code-review prompt (12,000 tokens).
 */
const TOKEN_CEILING = 12000

/**
 * Default fallback result when dispatch fails or times out.
 */
function defaultFailResult(error: string, tokenUsage: { input: number; output: number }): CodeReviewResult {
  return {
    verdict: 'NEEDS_MAJOR_REWORK',
    issues: 0,
    issue_list: [],
    error,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// runCodeReview
// ---------------------------------------------------------------------------

/**
 * Execute the compiled code-review workflow.
 *
 * Steps:
 * 1. Retrieve compiled prompt template via pack.getPrompt('code-review')
 * 2. Read story file contents from storyFilePath
 * 3. Capture git diff via getGitDiffSummary()
 * 4. Query decision store for architecture constraints (solutioning, architecture)
 * 5. Assemble prompt with 1,600-token ceiling
 * 6. If git_diff caused over-budget, retry with stat-only summary
 * 7. Dispatch via dispatcher with taskType='code-review'
 * 8. Validate YAML output against CodeReviewResultSchema
 * 9. Return typed CodeReviewResult
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Story key, story file path, working directory, pipeline run ID
 * @returns Promise resolving to CodeReviewResult
 */
export async function runCodeReview(
  deps: WorkflowDeps,
  params: CodeReviewParams,
): Promise<CodeReviewResult> {
  const { storyKey, storyFilePath, workingDirectory, pipelineRunId } = params
  const cwd = workingDirectory ?? process.cwd()

  logger.debug({ storyKey, storyFilePath, cwd, pipelineRunId }, 'Starting code-review workflow')

  // Step 1: Get compiled prompt template
  let template: string
  try {
    template = await deps.pack.getPrompt('code-review')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ error }, 'Failed to retrieve code-review prompt template')
    return defaultFailResult(`Failed to retrieve prompt template: ${error}`, { input: 0, output: 0 })
  }

  // Step 2: Read story file
  let storyContent: string
  try {
    storyContent = await readFile(storyFilePath, 'utf-8')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ storyFilePath, error }, 'Failed to read story file')
    return defaultFailResult(`Failed to read story file: ${error}`, { input: 0, output: 0 })
  }

  // Step 3: Capture git diff (full)
  const gitDiffFull = await getGitDiffSummary(cwd)

  // Step 4: Query architecture constraints from decision store
  const archConstraintsContent = getArchConstraints(deps)

  // Step 5: Check if full git diff would cause the prompt to exceed the token ceiling.
  // Strategy: estimate total tokens with full diff; if over budget, use stat-only summary instead.
  // This avoids truncating mid-diff (which produces less useful partial diffs).
  const templateTokens = countTokens(template)
  const storyTokens = countTokens(storyContent)
  const diffTokens = countTokens(gitDiffFull)
  const constraintTokens = countTokens(archConstraintsContent)
  const estimatedTotal = templateTokens + storyTokens + diffTokens + constraintTokens

  let gitDiffContent = gitDiffFull
  if (estimatedTotal > TOKEN_CEILING) {
    logger.warn(
      { estimatedTotal, ceiling: TOKEN_CEILING },
      'Full git diff would exceed token ceiling — using stat-only summary',
    )
    gitDiffContent = await getGitDiffStatSummary(cwd)
  }

  const sections = [
    { name: 'story_content', content: storyContent, priority: 'required' as const },
    { name: 'git_diff', content: gitDiffContent, priority: 'important' as const },
    { name: 'arch_constraints', content: archConstraintsContent, priority: 'optional' as const },
  ]

  const assembleResult = assemblePrompt(template, sections, TOKEN_CEILING)

  if (assembleResult.truncated) {
    // Truncation occurred (arch_constraints trimmed) — log for observability
    logger.warn(
      { storyKey, tokenCount: assembleResult.tokenCount },
      'Code-review prompt truncated to fit token ceiling',
    )
  }

  logger.debug(
    { storyKey, tokenCount: assembleResult.tokenCount, truncated: assembleResult.truncated },
    'Prompt assembled for code-review',
  )

  const { prompt } = assembleResult

  // Step 7: Dispatch to agent
  const handle = deps.dispatcher.dispatch({
    prompt,
    agent: 'claude-code',
    taskType: 'code-review',
    timeout: 300000,
    outputSchema: CodeReviewResultSchema,
  })

  let dispatchResult
  try {
    dispatchResult = await handle.result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ storyKey, error }, 'Code-review dispatch threw unexpected error')
    return defaultFailResult(`Dispatch error: ${error}`, {
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
    const errorMsg = `Dispatch status: failed. Exit code: ${dispatchResult.exitCode}. ${dispatchResult.parseError ?? ''} ${dispatchResult.output ? `Stderr: ${dispatchResult.output}` : ''}`.trim()
    logger.warn({ storyKey, exitCode: dispatchResult.exitCode }, 'Code-review dispatch failed')
    return defaultFailResult(errorMsg, tokenUsage)
  }

  if (dispatchResult.status === 'timeout') {
    logger.warn({ storyKey }, 'Code-review dispatch timed out')
    return defaultFailResult(
      'Dispatch status: timeout. The agent did not complete within the allowed time.',
      tokenUsage,
    )
  }

  // Step 8: Schema validation
  if (dispatchResult.parsed === null) {
    const details = dispatchResult.parseError ?? 'No YAML block found in output'
    logger.warn({ storyKey, details }, 'Code-review output schema validation failed')
    return {
      verdict: 'NEEDS_MAJOR_REWORK',
      issues: 0,
      issue_list: [],
      error: 'schema_validation_failed',
      details,
      tokenUsage,
    }
  }

  const parseResult = CodeReviewResultSchema.safeParse(dispatchResult.parsed)
  if (!parseResult.success) {
    const details = parseResult.error.message
    logger.warn({ storyKey, details }, 'Code-review output failed schema validation')
    return {
      verdict: 'NEEDS_MAJOR_REWORK',
      issues: 0,
      issue_list: [],
      error: 'schema_validation_failed',
      details,
      tokenUsage,
    }
  }

  const parsed = parseResult.data

  logger.info(
    { storyKey, verdict: parsed.verdict, issues: parsed.issues },
    'Code-review workflow completed successfully',
  )

  return {
    verdict: parsed.verdict,
    issues: parsed.issues,
    issue_list: parsed.issue_list,
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

// ---------------------------------------------------------------------------
// Token count export for testing
// ---------------------------------------------------------------------------

export { countTokens }
