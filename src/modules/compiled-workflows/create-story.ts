/**
 * runCreateStory — compiled create-story workflow function.
 *
 * Retrieves a compiled prompt template from the methodology pack,
 * injects decision-store context (epic shard, previous dev notes,
 * architecture constraints), enforces a 2,500-token budget, dispatches
 * to the configured agent, and parses the structured YAML result.
 */

import { createLogger } from '../../utils/logger.js'
import { getDecisionsByPhase } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { assemblePrompt } from './prompt-assembler.js'
import { CreateStoryResultSchema } from './schemas.js'
import type { WorkflowDeps, CreateStoryParams, CreateStoryResult } from './types.js'

const logger = createLogger('compiled-workflows:create-story')

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/**
 * Hard ceiling for the assembled create-story prompt.
 */
const TOKEN_CEILING = 3000

// ---------------------------------------------------------------------------
// runCreateStory
// ---------------------------------------------------------------------------

/**
 * Execute the compiled create-story workflow.
 *
 * Steps:
 * 1. Retrieve compiled prompt template via pack.getPrompt('create-story')
 * 2. Query decision store for epic shard (implementation phase, category=epic-shard, key=epicId)
 * 3. Query decision store for previous story dev notes (implementation phase, category=prev-dev-notes)
 * 4. Query decision store for architecture constraints (solutioning phase, category=architecture)
 * 5. Assemble prompt with 2,500-token ceiling enforcement
 * 6. Dispatch to agent with taskType='create-story'
 * 7. Parse and validate YAML output against CreateStoryResultSchema
 * 8. Return typed CreateStoryResult
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Epic ID, story key, and optional pipeline run ID
 * @returns Promise resolving to CreateStoryResult
 */
export async function runCreateStory(
  deps: WorkflowDeps,
  params: CreateStoryParams
): Promise<CreateStoryResult> {
  const { epicId, storyKey, pipelineRunId } = params

  logger.debug({ epicId, storyKey, pipelineRunId }, 'Starting create-story workflow')

  // Step 1: Get compiled prompt template
  let template: string
  try {
    template = await deps.pack.getPrompt('create-story')
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ error }, 'Failed to retrieve create-story prompt template')
    return {
      result: 'failed',
      error: `Failed to retrieve prompt template: ${error}`,
      tokenUsage: { input: 0, output: 0 },
    }
  }

  // Step 2: Query epic shard from decision store
  // Cache the implementation-phase decisions to avoid querying twice (issues #5)
  const implementationDecisions = getImplementationDecisions(deps)
  const epicShardContent = getEpicShard(implementationDecisions, epicId)

  // Step 3: Query previous story dev notes (reuse cached decisions)
  const prevDevNotesContent = getPrevDevNotes(implementationDecisions, epicId)

  // Step 4: Query architecture constraints
  const archConstraintsContent = getArchConstraints(deps)

  // Step 4b: Retrieve story template from pack
  const storyTemplateContent = await getStoryTemplate(deps)

  // Step 5: Assemble prompt with token budget enforcement
  const { prompt, tokenCount, truncated } = assemblePrompt(
    template,
    [
      {
        name: 'story_key',
        content: storyKey,
        priority: 'required',
      },
      {
        name: 'epic_shard',
        content: epicShardContent,
        priority: 'required',
      },
      {
        name: 'arch_constraints',
        content: archConstraintsContent,
        priority: 'important',
      },
      {
        name: 'prev_dev_notes',
        content: prevDevNotesContent,
        priority: 'optional',
      },
      {
        name: 'story_template',
        content: storyTemplateContent,
        priority: 'important',
      },
    ],
    TOKEN_CEILING
  )

  logger.debug(
    { tokenCount, truncated, tokenCeiling: TOKEN_CEILING },
    'Prompt assembled for create-story'
  )

  // Step 6: Dispatch to agent
  const handle = deps.dispatcher.dispatch({
    prompt,
    agent: 'claude-code',
    taskType: 'create-story',
    outputSchema: CreateStoryResultSchema,
  })

  let dispatchResult
  try {
    dispatchResult = await handle.result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error({ epicId, storyKey, error }, 'Dispatch threw an unexpected error')
    return {
      result: 'failed',
      error: `Dispatch error: ${error}`,
      tokenUsage: { input: Math.ceil(prompt.length / 4), output: 0 },
    }
  }

  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  // Step 7: Handle failure and timeout
  if (dispatchResult.status === 'failed') {
    const errorMsg = dispatchResult.parseError ?? `Dispatch failed with exit code ${dispatchResult.exitCode}`
    const stderrDetail = dispatchResult.output ? ` Output: ${dispatchResult.output}` : ''
    logger.warn({ epicId, storyKey, exitCode: dispatchResult.exitCode }, 'Create-story dispatch failed')
    return {
      result: 'failed',
      error: `Dispatch status: failed. ${errorMsg}${stderrDetail}`,
      tokenUsage,
    }
  }

  if (dispatchResult.status === 'timeout') {
    logger.warn({ epicId, storyKey }, 'Create-story dispatch timed out')
    return {
      result: 'failed',
      error: 'Dispatch status: timeout. The agent did not complete within the allowed time.',
      tokenUsage,
    }
  }

  // Step 8: Schema validation
  if (dispatchResult.parsed === null) {
    const details = dispatchResult.parseError ?? 'No YAML block found in output'
    // Log up to 1000 chars of raw output to help diagnose missing YAML blocks
    const rawSnippet = dispatchResult.output
      ? dispatchResult.output.slice(0, 1000)
      : '(empty)'
    logger.warn({ epicId, storyKey, details, rawOutputSnippet: rawSnippet }, 'Create-story output schema validation failed')
    return {
      result: 'failed',
      error: 'schema_validation_failed',
      details,
      tokenUsage,
    }
  }

  // Validate the parsed output against our schema
  const parseResult = CreateStoryResultSchema.safeParse(dispatchResult.parsed)
  if (!parseResult.success) {
    const details = parseResult.error.message
    logger.warn({ epicId, storyKey, details }, 'Create-story output failed schema validation')
    return {
      result: 'failed',
      error: 'schema_validation_failed',
      details,
      tokenUsage,
    }
  }

  const parsed = parseResult.data

  logger.info(
    { epicId, storyKey, storyFile: parsed.story_file, storyTitle: parsed.story_title },
    'Create-story workflow completed successfully'
  )

  return {
    result: 'success',
    story_file: parsed.story_file,
    story_key: parsed.story_key,
    story_title: parsed.story_title,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve and cache all decisions for the implementation phase.
 * Returns an empty array and logs a warning if the query fails.
 */
function getImplementationDecisions(deps: WorkflowDeps): Decision[] {
  try {
    return getDecisionsByPhase(deps.db, 'implementation')
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve implementation decisions')
    return []
  }
}

/**
 * Retrieve the epic shard from the pre-fetched implementation decisions.
 * Looks for decisions with category='epic-shard', key=epicId.
 */
function getEpicShard(decisions: Decision[], epicId: string): string {
  try {
    const epicShard = decisions.find(
      (d: Decision) => d.category === 'epic-shard' && d.key === epicId
    )
    return epicShard?.value ?? ''
  } catch (err) {
    logger.warn({ epicId, error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve epic shard')
    return ''
  }
}

/**
 * Retrieve the most recent previous story dev notes from the pre-fetched implementation decisions.
 * Looks for decisions with category='prev-dev-notes'.
 */
function getPrevDevNotes(decisions: Decision[], epicId: string): string {
  try {
    // Filter to prev-dev-notes for this epic, take the most recent (last in array)
    const devNotes = decisions.filter(
      (d: Decision) => d.category === 'prev-dev-notes' && d.key.startsWith(epicId)
    )
    if (devNotes.length === 0) return ''
    return devNotes[devNotes.length - 1].value
  } catch (err) {
    logger.warn({ epicId, error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve prev dev notes')
    return ''
  }
}

/**
 * Retrieve architecture constraints from the decision store.
 * Looks for decisions with phase='solutioning', category='architecture'.
 */
function getArchConstraints(deps: WorkflowDeps): string {
  try {
    const decisions = getDecisionsByPhase(deps.db, 'solutioning')
    const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
    if (constraints.length === 0) return ''
    return constraints.map((d: Decision) => d.value).join('\n\n')
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve architecture constraints')
    return ''
  }
}

/**
 * Retrieve the story template from the methodology pack.
 * Uses pack.getTemplate('story') to load the template file.
 * Returns empty string if the template is not available.
 */
async function getStoryTemplate(deps: WorkflowDeps): Promise<string> {
  try {
    return await deps.pack.getTemplate('story')
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve story template from pack')
    return ''
  }
}
