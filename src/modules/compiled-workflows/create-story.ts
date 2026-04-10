/**
 * runCreateStory — compiled create-story workflow function.
 *
 * Retrieves a compiled prompt template from the methodology pack,
 * injects decision-store context (epic shard, previous dev notes,
 * architecture constraints), enforces a 2,500-token budget, dispatches
 * to the configured agent, and parses the structured YAML result.
 */

import { readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../../utils/logger.js'
import {
  getDecisionsByPhase,
  getDecisionsByPhaseForRun,
} from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { assemblePrompt } from './prompt-assembler.js'
import { CreateStoryResultSchema } from './schemas.js'
import type { WorkflowDeps, CreateStoryParams, CreateStoryResult } from './types.js'
import { getTokenCeiling } from './token-ceiling.js'

const logger = createLogger('compiled-workflows:create-story')

// ---------------------------------------------------------------------------
// Token budget (resolved at runtime via getTokenCeiling — see token-ceiling.ts)
// ---------------------------------------------------------------------------

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

  // Resolve token ceiling: config override takes priority over hardcoded default
  const { ceiling: TOKEN_CEILING, source: tokenCeilingSource } = getTokenCeiling(
    'create-story',
    deps.tokenCeilings
  )
  logger.info(
    { workflow: 'create-story', ceiling: TOKEN_CEILING, source: tokenCeilingSource },
    'Token ceiling resolved'
  )

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
  const implementationDecisions = await getImplementationDecisions(deps, pipelineRunId)
  // Pass storyKey for per-story extraction (AC3)
  const epicShardContent = getEpicShard(implementationDecisions, epicId, deps.projectRoot, storyKey)

  // Step 3: Query previous story dev notes (reuse cached decisions)
  const prevDevNotesContent = getPrevDevNotes(implementationDecisions, epicId)

  // Step 3b: Query the specific story definition from solutioning decisions
  // This provides the authoritative title, description, and ACs so the
  // create-story agent doesn't re-interpret the story scope from the epic shard.
  let storyDefinitionContent = ''
  try {
    const storyDecisions = await getDecisionsByPhase(deps.db, 'solutioning')
    const storyDef = storyDecisions.find(
      (d: Decision) => d.category === 'stories' && d.key === storyKey
    )
    if (storyDef) {
      storyDefinitionContent = storyDef.value
      logger.debug({ storyKey }, 'Injected story definition from solutioning decisions')
    }
  } catch {
    // Best-effort — create-story can still work from epic shard alone
  }

  // Step 4: Query architecture constraints
  const archConstraintsContent = await getArchConstraints(deps)

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
        name: 'story_definition',
        content: storyDefinitionContent,
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
  // Set maxTurns to 50 — default 30 is insufficient for projects with
  // complex architecture constraints (boardgame-sandbox Epic 3 stories
  // exhausted 30 turns before producing valid output).
  const handle = deps.dispatcher.dispatch({
    prompt,
    agent: deps.agentId ?? 'claude-code',
    taskType: 'create-story',
    outputSchema: CreateStoryResultSchema,
    maxTurns: 50,
    ...(deps.projectRoot !== undefined ? { workingDirectory: deps.projectRoot } : {}),
    ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
    storyKey,
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
    const errorMsg =
      dispatchResult.parseError ?? `Dispatch failed with exit code ${dispatchResult.exitCode}`
    const stderrDetail = dispatchResult.output ? ` Output: ${dispatchResult.output}` : ''
    logger.warn(
      {
        epicId,
        storyKey,
        exitCode: dispatchResult.exitCode,
        outputSnippet: dispatchResult.output?.slice(0, 500),
      },
      'Create-story dispatch failed'
    )
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
    const rawSnippet = dispatchResult.output ? dispatchResult.output.slice(0, 1000) : '(empty)'
    logger.warn(
      { epicId, storyKey, details, rawOutputSnippet: rawSnippet },
      'Create-story output schema validation failed'
    )
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
 * Retrieve implementation decisions, scoped to the current run when available.
 * Falls back to unscoped query if run-scoped returns empty (backward compat with
 * decisions created before run IDs were tracked).
 * Returns an empty array and logs a warning if the query fails.
 */
async function getImplementationDecisions(
  deps: WorkflowDeps,
  pipelineRunId?: string
): Promise<Decision[]> {
  try {
    if (pipelineRunId) {
      const scoped = await getDecisionsByPhaseForRun(deps.db, pipelineRunId, 'implementation')
      if (scoped.length > 0) return scoped
    }
    return await getDecisionsByPhase(deps.db, 'implementation')
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to retrieve implementation decisions'
    )
    return []
  }
}

/**
 * Extract the section for a specific story key from a full epic shard.
 *
 * Matches patterns like:
 *   - "Story 23-1:" / "### Story 23-1" / "#### Story 23-1"
 *   - "23-1:" / "**23-1**"
 *
 * Returns the matched section content (from heading to next story heading or end),
 * or null if no matching section is found (caller falls back to full shard).
 *
 * @deprecated Used only as a migration shim for pre-37-0 projects that have
 * per-epic (key=epicId) shards in the decision store. Post-37-0 shards are
 * keyed by storyKey directly and do not need extraction. Do not delete until
 * all per-epic shards have been superseded by per-story shards (AC6).
 */
export function extractStorySection(shardContent: string, storyKey: string): string | null {
  if (!shardContent || !storyKey) return null

  // Escape special regex characters in storyKey (e.g. '23-1' contains a dash)
  const escaped = storyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Story heading patterns (in order of preference):
  // 1. Markdown headings: "### Story 23-1" or "#### Story 23-1"
  // 2. Label with colon: "Story 23-1:"
  // 3. Bold: "**23-1**"
  // 4. Bare key with colon: "23-1:"
  const headingPattern = new RegExp(
    `(?:^#{2,4}\\s+Story\\s+${escaped}\\b|^Story\\s+${escaped}:|^\\*\\*${escaped}\\*\\*|^${escaped}:)`,
    'mi'
  )

  const match = headingPattern.exec(shardContent)
  if (!match) return null

  const startIdx = match.index
  // Find the next story heading after this match to determine the end boundary
  const rest = shardContent.slice(startIdx + match[0].length)
  // Next story heading: any of the same patterns
  const nextStoryPattern = new RegExp(
    `(?:^#{2,4}\\s+Story\\s+[\\d]|^Story\\s+[\\d][\\d-]*:|^\\*\\*[\\d][\\d-]*\\*\\*|^[\\d][\\d-]*:)`,
    'mi'
  )
  const nextMatch = nextStoryPattern.exec(rest)
  const endIdx =
    nextMatch !== null ? startIdx + match[0].length + nextMatch.index : shardContent.length

  const section = shardContent.slice(startIdx, endIdx).trim()
  return section.length > 0 ? section : null
}

/**
 * Retrieve the epic shard from the pre-fetched implementation decisions.
 *
 * Lookup order (post-37-0 schema):
 *   1. Direct per-story lookup: category='epic-shard', key=storyKey  → AC4
 *      If found, return content immediately — no extractStorySection() needed.
 *   2. Migration shim (pre-37-0 fallback): category='epic-shard', key=epicId
 *      + extractStorySection() to narrow to the requested story.            → AC6
 *   3. File-based fallback: read epics.md from disk + extractStorySection(). → AC6
 */
function getEpicShard(
  decisions: Decision[],
  epicId: string,
  projectRoot?: string,
  storyKey?: string
): string {
  try {
    // AC4: Direct per-story lookup (post-37-0 schema — key = storyKey)
    if (storyKey) {
      const perStoryShard = decisions.find(
        (d: Decision) => d.category === 'epic-shard' && d.key === storyKey
      )
      if (perStoryShard?.value) {
        logger.debug({ epicId, storyKey }, 'Found per-story epic shard (direct lookup)')
        return perStoryShard.value
      }
    }

    // AC6 migration shim — fall back to per-epic lookup for pre-37-0 projects
    const epicShard = decisions.find(
      (d: Decision) => d.category === 'epic-shard' && d.key === epicId
    )
    const shardContent = epicShard?.value

    if (shardContent) {
      // If storyKey is provided, extract only the story-specific section
      if (storyKey) {
        const storySection = extractStorySection(shardContent, storyKey)
        if (storySection) {
          logger.debug(
            { epicId, storyKey },
            'Extracted per-story section from epic shard (pre-37-0 fallback)'
          )
          return storySection
        }
        logger.debug(
          { epicId, storyKey },
          'No matching story section found — using full epic shard'
        )
      }
      return shardContent
    }

    // File-based fallback: extract epic section from epics.md
    if (projectRoot) {
      const fallback = readEpicShardFromFile(projectRoot, epicId)
      if (fallback) {
        logger.info({ epicId }, 'Using file-based fallback for epic shard (decisions table empty)')
        if (storyKey) {
          const storySection = extractStorySection(fallback, storyKey)
          if (storySection) {
            logger.debug(
              { epicId, storyKey },
              'Extracted per-story section from file-based epic shard'
            )
            return storySection
          }
        }
        return fallback
      }
    }

    return ''
  } catch (err) {
    logger.warn(
      { epicId, error: err instanceof Error ? err.message : String(err) },
      'Failed to retrieve epic shard'
    )
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
    logger.warn(
      { epicId, error: err instanceof Error ? err.message : String(err) },
      'Failed to retrieve prev dev notes'
    )
    return ''
  }
}

/**
 * Retrieve architecture constraints from the decision store.
 * Looks for decisions with phase='solutioning', category='architecture'.
 * Falls back to reading _bmad-output/architecture/architecture.md on disk if decisions are empty.
 */
/**
 * Maximum character budget for architecture constraints injected into
 * create-story prompts. Full architecture decisions can be 20K+ characters
 * which causes agent loop exhaustion (max turns). Summarizing to ~12K chars
 * (~3K tokens) keeps the prompt focused while retaining key decisions.
 */
const ARCH_CONSTRAINT_MAX_CHARS = 12_000

async function getArchConstraints(deps: WorkflowDeps): Promise<string> {
  try {
    const decisions = await getDecisionsByPhase(deps.db, 'solutioning')
    const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
    if (constraints.length > 0) {
      const full = constraints.map((d: Decision) => d.value).join('\n\n')
      if (full.length <= ARCH_CONSTRAINT_MAX_CHARS) return full

      // Summarize: keep each decision's first line (key: value) and truncate
      // long values to prevent agent loop exhaustion on large architecture docs
      const summarized = constraints
        .map((d: Decision) => {
          const lines = d.value.split('\n')
          const header = lines[0] ?? d.key
          const body = lines.slice(1).join('\n')
          const truncatedBody = body.length > 300 ? body.slice(0, 297) + '...' : body
          return `${header}\n${truncatedBody}`
        })
        .join('\n\n')

      logger.info(
        {
          fullLength: full.length,
          summarizedLength: summarized.length,
          decisions: constraints.length,
        },
        'Architecture constraints summarized to fit create-story budget'
      )
      return summarized.slice(0, ARCH_CONSTRAINT_MAX_CHARS)
    }

    // File-based fallback: read architecture.md directly
    if (deps.projectRoot) {
      const fallback = readArchConstraintsFromFile(deps.projectRoot)
      if (fallback) {
        logger.info(
          'Using file-based fallback for architecture constraints (decisions table empty)'
        )
        return fallback.length > ARCH_CONSTRAINT_MAX_CHARS
          ? fallback.slice(0, ARCH_CONSTRAINT_MAX_CHARS) + '\n\n[truncated for token budget]'
          : fallback
      }
    }

    return ''
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to retrieve architecture constraints'
    )
    return ''
  }
}

/**
 * File-based fallback: read epic shard from _bmad-output/epics.md.
 * Extracts the section for the target epic (## Epic N or ## N.) using regex.
 * Returns the matched section content, or empty string if not found.
 */
function readEpicShardFromFile(projectRoot: string, epicId: string): string {
  try {
    // Check both planning-artifacts (standard BMAD layout) and root _bmad-output
    const candidates = [
      join(projectRoot, '_bmad-output', 'planning-artifacts', 'epics.md'),
      join(projectRoot, '_bmad-output', 'epics.md'),
    ]
    const epicsPath = candidates.find((p) => existsSync(p))
    if (!epicsPath) return ''

    const content = readFileSync(epicsPath, 'utf-8')
    // Extract the numeric part of epicId (e.g., '7' from '7' or 'epic-7')
    const epicNum = epicId.replace(/^epic-/i, '')
    // Step 1: Find the epic heading and detect its heading level (##, ###, or ####)
    const headingPattern = new RegExp(`^(#{2,4})\\s+(?:Epic\\s+)?${epicNum}[.:\\s]`, 'm')
    const headingMatch = headingPattern.exec(content)
    if (!headingMatch) return ''

    const startIdx = headingMatch.index
    const headingLevel = headingMatch[1].length // 2, 3, or 4

    // Step 2: Find the next heading at the same or higher level (fewer or equal #'s)
    // This ensures story sub-headings (###, ####) within the epic are included.
    const hashes = '#'.repeat(headingLevel)
    const endPattern = new RegExp(`\\n${hashes}\\s`, 'g')
    endPattern.lastIndex = startIdx + headingMatch[0].length
    const endMatch = endPattern.exec(content)
    const endIdx = endMatch ? endMatch.index : content.length

    return content.slice(startIdx, endIdx).trim()
  } catch (err) {
    logger.warn(
      { epicId, error: err instanceof Error ? err.message : String(err) },
      'File-based epic shard fallback failed'
    )
    return ''
  }
}

/**
 * File-based fallback: read architecture constraints from _bmad-output/architecture/architecture.md.
 * Returns up to 1500 chars to stay within token budget.
 */
function readArchConstraintsFromFile(projectRoot: string): string {
  try {
    // Check both planning-artifacts (standard BMAD layout) and root _bmad-output
    const candidates = [
      join(projectRoot, '_bmad-output', 'planning-artifacts', 'architecture.md'),
      join(projectRoot, '_bmad-output', 'architecture', 'architecture.md'),
      join(projectRoot, '_bmad-output', 'architecture.md'),
    ]
    const archPath = candidates.find((p) => existsSync(p))
    if (!archPath) return ''

    const content = readFileSync(archPath, 'utf-8')
    // Return a truncated version to fit within the token budget
    return content.slice(0, 1500)
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'File-based architecture fallback failed'
    )
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
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to retrieve story template from pack'
    )
    return ''
  }
}

// ---------------------------------------------------------------------------
// Story file validation (Story 23-3)
// ---------------------------------------------------------------------------

/**
 * Validate that an existing story file is non-empty and structurally valid.
 *
 * A valid story file must:
 * 1. Be non-empty (> 0 bytes after trim)
 * 2. Contain at least one heading (`#`) AND either "Acceptance Criteria" or "AC1"
 *
 * @returns `{ valid: true }` or `{ valid: false, reason: 'empty' | 'missing_structure' }`
 */
export async function isValidStoryFile(
  filePath: string
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const content = await readFile(filePath, 'utf-8')
    if (content.trim().length === 0) {
      return { valid: false, reason: 'empty' }
    }
    const hasHeading = content.includes('#')
    const hasAC = /acceptance criteria|AC1/i.test(content)
    if (!hasHeading || !hasAC) {
      return { valid: false, reason: 'missing_structure' }
    }
    return { valid: true }
  } catch {
    return { valid: false, reason: 'empty' }
  }
}
