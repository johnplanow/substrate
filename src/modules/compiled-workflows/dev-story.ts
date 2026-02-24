/**
 * runDevStory — compiled dev-story workflow function.
 *
 * Retrieves a compiled prompt template from the methodology pack,
 * assembles context (story content, architecture constraints, test patterns)
 * within an 8,000-token hard ceiling, dispatches to a sub-agent, and parses
 * the structured YAML output.
 *
 * Architecture constraints (ADR-001, ADR-003, ADR-005):
 *  - Services consumed via WorkflowDeps injection
 *  - SQLite queries use the passed db instance
 *  - Subprocess management delegated to Dispatcher
 *  - All imports use .js extension (ESM)
 */

import { readFile } from 'node:fs/promises'
import type { WorkflowDeps, DevStoryParams, DevStoryResult } from './types.js'
import { DevStoryResultSchema } from './schemas.js'
import { assemblePrompt } from './prompt-assembler.js'
import type { PromptSection } from './prompt-assembler.js'
import { getDecisionsByPhase } from '../../persistence/queries/decisions.js'
import { getGitChangedFiles } from './git-helpers.js'
import { createLogger } from '../../utils/logger.js'
import type { ContextTemplate } from '../context-compiler/types.js'

const logger = createLogger('compiled-workflows:dev-story')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard token ceiling for the assembled dev-story prompt */
const TOKEN_CEILING = 24_000

/** Default timeout for dev-story dispatches in milliseconds (30 min) */
const DEFAULT_TIMEOUT_MS = 1_800_000

/** Default Vitest test patterns injected when no test-pattern decisions exist */
const DEFAULT_VITEST_PATTERNS = `## Test Patterns (defaults)
- Framework: Vitest (NOT jest — --testPathPattern flag does not work, use -- "pattern")
- Mock approach: vi.mock() with hoisting for module-level mocks
- Assertion style: expect().toBe(), expect().toEqual(), expect().toThrow()
- Test structure: describe/it blocks with beforeEach/afterEach
- Coverage: 80% enforced — run full suite, not filtered
- Run tests: npm test 2>&1 | grep -E "Test Files|Tests " | tail -3`

// ---------------------------------------------------------------------------
// runDevStory
// ---------------------------------------------------------------------------

/**
 * Execute the compiled dev-story workflow.
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Story parameters (storyKey, storyFilePath, pipelineRunId)
 * @returns DevStoryResult with result, ac_met, ac_failures, files_modified, tests, tokenUsage
 */
export async function runDevStory(
  deps: WorkflowDeps,
  params: DevStoryParams,
): Promise<DevStoryResult> {
  const { storyKey, storyFilePath } = params

  logger.info({ storyKey, storyFilePath }, 'Starting compiled dev-story workflow')

  // ---------------------------------------------------------------------------
  // Task 5: Register context template for dev-story with context compiler
  // ---------------------------------------------------------------------------

  // Architecture constraints are already embedded in the story file's Dev Notes
  // section (created by create-story), so we only register story-content and
  // test-patterns with the context compiler.
  const devStoryContextTemplate: ContextTemplate = {
    taskType: 'dev-story',
    sections: [
      {
        name: 'story-content',
        priority: 'required',
        query: { table: 'decisions', filters: { phase: 'implementation', category: 'story-content' } },
        format: (items: unknown[]) => {
          if (items.length === 0) return ''
          const rows = items as Array<{ key: string; value: string }>
          return '## Story Content\n' + rows.map((r) => `${r.key}: ${r.value}`).join('\n')
        },
      },
      {
        name: 'test-patterns',
        priority: 'optional',
        query: { table: 'decisions', filters: { phase: 'solutioning', category: 'test-patterns' } },
        format: (items: unknown[]) => {
          if (items.length === 0) return ''
          const rows = items as Array<{ key: string; value: string }>
          return '## Test Patterns\n' + rows.map((r) => `- ${r.key}: ${r.value}`).join('\n')
        },
      },
    ],
  }

  deps.contextCompiler.registerTemplate(devStoryContextTemplate)

  // ---------------------------------------------------------------------------
  // Step 1: Retrieve compiled prompt template from methodology pack
  // ---------------------------------------------------------------------------

  let template: string
  try {
    template = await deps.pack.getPrompt('dev-story')
    logger.debug({ storyKey }, 'Retrieved dev-story prompt template from pack')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ storyKey, error }, 'Failed to retrieve dev-story prompt template')
    return makeFailureResult(`template_load_failed: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 2: Read story file from disk
  // ---------------------------------------------------------------------------

  let storyContent: string
  try {
    storyContent = await readFile(storyFilePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.error({ storyKey, storyFilePath }, 'Story file not found')
      return makeFailureResult('story_file_not_found')
    }
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ storyKey, storyFilePath, error }, 'Failed to read story file')
    return makeFailureResult(`story_file_read_error: ${error}`)
  }

  if (storyContent.trim().length === 0) {
    logger.error({ storyKey, storyFilePath }, 'Story file is empty')
    return makeFailureResult('story_file_empty')
  }

  // ---------------------------------------------------------------------------
  // Step 3: Query decision store for test patterns (or use defaults)
  // Architecture constraints are NOT injected separately — they are already
  // embedded in the story file's Dev Notes section (created by create-story).
  // Injecting them again wastes ~1,200 tokens of the prompt budget.
  // ---------------------------------------------------------------------------

  let testPatternsContent = ''
  try {
    const solutioningDecisions = getDecisionsByPhase(deps.db, 'solutioning')
    const testPatternDecisions = solutioningDecisions.filter(
      (d) => d.category === 'test-patterns',
    )
    if (testPatternDecisions.length > 0) {
      testPatternsContent =
        '## Test Patterns\n' +
        testPatternDecisions.map((d) => `- ${d.key}: ${d.value}`).join('\n')
      logger.debug({ storyKey, count: testPatternDecisions.length }, 'Loaded test patterns from decision store')
    } else {
      testPatternsContent = DEFAULT_VITEST_PATTERNS
      logger.debug({ storyKey }, 'No test-pattern decisions found — using default Vitest patterns')
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ storyKey, error }, 'Failed to load test patterns — using defaults')
    testPatternsContent = DEFAULT_VITEST_PATTERNS
  }

  // ---------------------------------------------------------------------------
  // Step 4: Assemble prompt with token budget enforcement
  // ---------------------------------------------------------------------------

  const sections: PromptSection[] = [
    { name: 'story_content', content: storyContent, priority: 'required' },
    { name: 'test_patterns', content: testPatternsContent, priority: 'optional' },
  ]

  const { prompt, tokenCount, truncated } = assemblePrompt(template, sections, TOKEN_CEILING)

  logger.info(
    { storyKey, tokenCount, ceiling: TOKEN_CEILING, truncated },
    'Assembled dev-story prompt',
  )

  // ---------------------------------------------------------------------------
  // Step 6: Dispatch to agent
  // ---------------------------------------------------------------------------

  let dispatchResult
  try {
    const handle = deps.dispatcher.dispatch({
      prompt,
      agent: 'claude-code',
      taskType: 'dev-story',
      timeout: DEFAULT_TIMEOUT_MS,
      outputSchema: DevStoryResultSchema,
    })

    dispatchResult = await handle.result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ storyKey, error }, 'Dispatch threw an unexpected error')
    return makeFailureResult(`dispatch_error: ${error}`)
  }

  // ---------------------------------------------------------------------------
  // Step 7: Check dispatch status and extract token usage
  // ---------------------------------------------------------------------------

  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  if (dispatchResult.status === 'timeout') {
    logger.error({ storyKey, durationMs: dispatchResult.durationMs }, 'Dev-story dispatch timed out')
    // Log partial output if any
    if (dispatchResult.output.length > 0) {
      logger.info({ storyKey, partialOutput: dispatchResult.output.slice(0, 500) }, 'Partial output before timeout')
    }
    return {
      ...makeFailureResult(`dispatch_timeout after ${dispatchResult.durationMs}ms`),
      tokenUsage,
    }
  }

  if (dispatchResult.status === 'failed' || dispatchResult.exitCode !== 0) {
    logger.error(
      { storyKey, exitCode: dispatchResult.exitCode, status: dispatchResult.status },
      'Dev-story dispatch failed',
    )
    if (dispatchResult.output.length > 0) {
      logger.info({ storyKey, partialOutput: dispatchResult.output.slice(0, 500) }, 'Partial output from failed dispatch')
    }
    return {
      ...makeFailureResult(`dispatch_failed with exit_code=${dispatchResult.exitCode}: ${dispatchResult.output.slice(0, 200)}`),
      tokenUsage,
    }
  }

  // ---------------------------------------------------------------------------
  // Step 8: Validate parsed output against schema
  // ---------------------------------------------------------------------------

  if (dispatchResult.parseError !== null || dispatchResult.parsed === null) {
    const details = dispatchResult.parseError ?? 'parsed result was null'
    const rawSnippet = dispatchResult.output ? dispatchResult.output.slice(0, 1000) : '(empty)'
    logger.error({ storyKey, parseError: details, rawOutputSnippet: rawSnippet }, 'YAML schema validation failed')

    // Recover files_modified from git when YAML output is missing.
    // The dev agent may have done real work (created files, passed tests)
    // but exhausted turns before emitting the YAML contract.
    let filesModified: string[] = []
    try {
      filesModified = await getGitChangedFiles(process.cwd())
      if (filesModified.length > 0) {
        logger.info(
          { storyKey, fileCount: filesModified.length },
          'Recovered files_modified from git status (YAML fallback)',
        )
      }
    } catch (err) {
      logger.warn(
        { storyKey, error: err instanceof Error ? err.message : String(err) },
        'Failed to recover files_modified from git',
      )
    }

    return {
      result: 'failed',
      ac_met: [],
      ac_failures: [],
      files_modified: filesModified,
      tests: 'fail',
      error: 'schema_validation_failed',
      details,
      tokenUsage,
    }
  }

  // ---------------------------------------------------------------------------
  // Step 9: Return typed success result
  // ---------------------------------------------------------------------------

  const parsed = dispatchResult.parsed

  logger.info(
    { storyKey, result: parsed.result, acMet: parsed.ac_met.length },
    'Dev-story workflow completed',
  )

  const successResult: DevStoryResult = {
    result: parsed.result,
    ac_met: parsed.ac_met,
    ac_failures: parsed.ac_failures,
    files_modified: parsed.files_modified,
    tests: parsed.tests,
    tokenUsage,
  }

  if (parsed.notes !== undefined) {
    successResult.notes = parsed.notes
  }

  return successResult
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a failure result with sensible defaults.
 */
function makeFailureResult(error: string): DevStoryResult {
  return {
    result: 'failed',
    ac_met: [],
    ac_failures: [],
    files_modified: [],
    tests: 'fail',
    error,
    tokenUsage: { input: 0, output: 0 },
  }
}
