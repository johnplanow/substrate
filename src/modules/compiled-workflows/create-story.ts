/**
 * runCreateStory — compiled create-story workflow function.
 *
 * Retrieves a compiled prompt template from the methodology pack,
 * injects decision-store context (epic shard, previous dev notes,
 * architecture constraints), enforces a 2,500-token budget, dispatches
 * to the configured agent, and parses the structured YAML result.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../../utils/logger.js'
import { getDecisionsByPhase, getDecisionsByPhaseForRun } from '../../persistence/queries/decisions.js'
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
// hashSourceAcSection (AC1, Story 58-6)
// ---------------------------------------------------------------------------

/**
 * Compute a hex SHA-256 of the normalized source AC section text.
 *
 * Normalization (minimal — avoids spurious regen from editor whitespace noise):
 *   1. Split on `\n`
 *   2. Strip trailing whitespace from each line (`.trimEnd()`)
 *   3. Rejoin with `\n`
 *   4. Trim the whole result (`.trim()`)
 *
 * Pure function: no I/O, no side effects. Safe to call from tests with zero setup.
 */
export function hashSourceAcSection(section: string): string {
  const normalized = section
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

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
  const { epicId, storyKey, pipelineRunId, source_ac_hash, priorDriftFeedback } = params

  logger.debug({ epicId, storyKey, pipelineRunId }, 'Starting create-story workflow')

  // Resolve token ceiling: config override takes priority over hardcoded default
  const { ceiling: TOKEN_CEILING, source: tokenCeilingSource } = getTokenCeiling(
    'create-story',
    deps.tokenCeilings,
  )
  logger.info({ workflow: 'create-story', ceiling: TOKEN_CEILING, source: tokenCeilingSource }, 'Token ceiling resolved')

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
  // Pass storyKey for per-story extraction (AC3).
  // Path E Bug #4: use parentProjectRoot for file-based fallback so uncommitted
  // planning artifacts in the parent's working tree are visible to dispatch,
  // even when the per-story worktree was checked out from a commit that
  // predates the fixture authoring. Falls back to deps.projectRoot when
  // parentProjectRoot is unset (single-tree projects + --no-worktree path).
  const epicShardContent = getEpicShard(
    implementationDecisions,
    epicId,
    deps.parentProjectRoot ?? deps.projectRoot,
    storyKey,
  )

  // Story 58-18: source_ac_hash content integrity. The orchestrator computes
  // `source_ac_hash` from epics.md via extractStorySection BEFORE create-story
  // dispatch. Pre-58-13, the agent might have received different content
  // (truncated decisions-store shard) — meaning the embedded hash claimed
  // authority over content the agent never saw. Even with 58-13's
  // file-fallback, the decisions-store path could feed minor formatting
  // variants. Closing the integrity gap: re-derive the hash from the actual
  // `epicShardContent` the agent will receive.
  //
  // The re-extract step is critical for the case where `epicShardContent` is
  // a full-epic fallback (58-13 last-resort, e.g. no per-story decision and
  // file-extract failed too). Hashing the whole epic would produce a value
  // that represents "all stories in the epic" rather than this story's
  // source AC. Re-running extractStorySection narrows to the story-specific
  // section when possible; when it fails (story not in shard at all), we
  // fall back to the orchestrator's hash (which is also undefined in that
  // case, so the agent omits the hash comment per 58-6's empty-handling).
  let effectiveSourceAcHash = source_ac_hash
  if (epicShardContent.length > 0) {
    const storySection = extractStorySection(epicShardContent, storyKey)
    if (storySection !== null) {
      const computedHash = hashSourceAcSection(storySection)
      if (source_ac_hash !== undefined && source_ac_hash !== computedHash) {
        logger.debug(
          { storyKey, suppliedHash: source_ac_hash, computedHash },
          'Orchestrator-supplied source_ac_hash differs from epic_shard content hash — using computed (Story 58-18)',
        )
      }
      effectiveSourceAcHash = computedHash
    }
  }

  // Step 3: Query previous story dev notes (reuse cached decisions)
  const prevDevNotesContent = getPrevDevNotes(implementationDecisions, epicId)

  // Step 3b: Query the specific story definition from solutioning decisions
  // This provides the authoritative title, description, and ACs so the
  // create-story agent doesn't re-interpret the story scope from the epic shard.
  let storyDefinitionContent = ''
  try {
    const storyDecisions = await getDecisionsByPhase(deps.db, 'solutioning')
    const storyDef = storyDecisions.find(
      (d: Decision) => d.category === 'stories' && d.key === storyKey,
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
      // AC3 (Story 58-6): only inject source_ac_hash when a hash is actually
      // available. When undefined (no epics.md found, or source section absent),
      // we omit the context item entirely; the prompt assembler's {{source_ac_hash}}
      // fallback yields an empty string, and the prompt directive instructs the
      // agent to omit the hash comment when the value is empty. Passing `?? ''`
      // would silently send an empty-string value that could cause the agent to
      // emit an invalid `<!-- source-ac-hash:  -->` comment (zero-length hash).
      //
      // Story 58-18: use effectiveSourceAcHash, which is the hash of the actual
      // epicShardContent the agent receives (or the orchestrator's supplied
      // hash when re-extraction fails — preserving 58-6's freshness invariant).
      ...(effectiveSourceAcHash !== undefined
        ? [{ name: 'source_ac_hash', content: effectiveSourceAcHash, priority: 'required' as const }]
        : []),
      // Story 59-5: drift-correction guidance from a prior failed dispatch.
      // When absent (first dispatch), the placeholder resolves to empty and
      // the prompt section is invisible. When present, it surfaces the
      // missing-paths list directly above the Mission section so the agent
      // attends to the correction before rendering.
      ...(priorDriftFeedback !== undefined && priorDriftFeedback.length > 0
        ? [{ name: 'prior_drift_feedback', content: priorDriftFeedback, priority: 'required' as const }]
        : [{ name: 'prior_drift_feedback', content: '', priority: 'optional' as const }]),
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
    const errorMsg = dispatchResult.parseError ?? `Dispatch failed with exit code ${dispatchResult.exitCode}`
    const stderrDetail = dispatchResult.output ? ` Output: ${dispatchResult.output}` : ''
    logger.warn(
      {
        epicId,
        storyKey,
        exitCode: dispatchResult.exitCode,
        outputSnippet: dispatchResult.output?.slice(0, 500),
      },
      'Create-story dispatch failed',
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
 * Retrieve implementation decisions, scoped to the current run when available.
 * Falls back to unscoped query if run-scoped returns empty (backward compat with
 * decisions created before run IDs were tracked).
 * Returns an empty array and logs a warning if the query fails.
 */
async function getImplementationDecisions(deps: WorkflowDeps, pipelineRunId?: string): Promise<Decision[]> {
  try {
    if (pipelineRunId) {
      const scoped = await getDecisionsByPhaseForRun(deps.db, pipelineRunId, 'implementation')
      if (scoped.length > 0) return scoped
    }
    return await getDecisionsByPhase(deps.db, 'implementation')
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve implementation decisions')
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

  // Story 58-5: normalize separator characters in the storyKey so `1-7` matches
  // `### Story 1.7:` and vice versa. Epic authors in different projects use
  // different conventions (dash, dot, underscore, space) — substrate's own docs
  // use `1-7`, strata's epics use `1.7`. When the supplied storyKey doesn't
  // textually match the heading, extraction silently returns the WHOLE epic,
  // and the create-story agent freelances ACs from the full epic scope —
  // dropping hard clauses and restructuring (strata observation
  // obs_2026-04-20_001). Splitting on any separator and rejoining with a
  // permissive character class makes extraction robust to author convention.
  const parts = storyKey.split(/[-._ ]/)
  const normalized = parts
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[-._ ]')

  // Story heading patterns (in order of preference):
  // 1. Markdown headings: "### Story 23-1" or "#### Story 23.1"
  // 2. Label with colon: "Story 23-1:"
  // 3. Bold: "**23-1**"
  // 4. Bare key with colon: "23-1:"
  const headingPattern = new RegExp(
    `(?:^#{2,4}\\s+Story\\s+${normalized}\\b|^Story\\s+${normalized}:|^\\*\\*${normalized}\\*\\*|^${normalized}:)`,
    'mi',
  )

  const match = headingPattern.exec(shardContent)
  if (!match) return null

  const startIdx = match.index
  // Find the next story heading after this match to determine the end boundary
  const rest = shardContent.slice(startIdx + match[0].length)
  // Next story heading: any of the same patterns. 58-5: accept dashes, dots,
  // and lowercase letter suffixes (e.g. `11a`, `1.7`, `1-11a`) as part of the
  // key so boundary detection works across author conventions.
  const nextStoryPattern = new RegExp(
    `(?:^#{2,4}\\s+Story\\s+[\\d]|^Story\\s+[\\d][\\d.\\-_a-z]*:|^\\*\\*[\\d][\\d.\\-_a-z]*\\*\\*|^[\\d][\\d.\\-_a-z]*:)`,
    'mi',
  )
  const nextMatch = nextStoryPattern.exec(rest)
  const endIdx = nextMatch !== null
    ? startIdx + match[0].length + nextMatch.index
    : shardContent.length

  const section = shardContent.slice(startIdx, endIdx).trim()
  return section.length > 0 ? section : null
}

/**
 * Story 59-3: extract the list of named filesystem paths and filenames from
 * source AC text. Looks for backtick-wrapped strings that contain a path
 * separator OR end with a recognized source-file extension. The result is
 * a deduped list of names the source AC declares as part of the story's
 * artifact contract.
 *
 * Used by the orchestrator's pre-dev fidelity gate to detect create-story
 * output drift: if the agent produced a story file that doesn't reference
 * the source AC's named files (`adjacency-store.ts`, `wikilink-parser.ts`,
 * etc.) the gate fires and the orchestrator renames-to-stale + retries.
 *
 * Heuristic chosen over LLM-based fidelity check because deterministic,
 * fast, and the LLM-based source-ac-fidelity check still runs at
 * verification phase as a backstop for nuanced drift this gate can't see.
 */
export function extractNamedPathsFromSource(shardContent: string): string[] {
  const paths = new Set<string>()
  const backtickPattern = /`([^`\n]+)`/g
  // Recognized source extensions — covers TS/JS/Go/Rust/Python and common
  // structural file types that appear in BMAD-template source ACs. Excludes
  // generic command words by requiring an extension OR a path separator.
  const extensionPattern = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|sql|sh|toml|yaml|yml|html|css|scss|svelte)$/i

  let match: RegExpExecArray | null
  while ((match = backtickPattern.exec(shardContent)) !== null) {
    const candidate = match[1]?.trim()
    if (candidate === undefined || candidate.length === 0) continue
    // Reject obvious non-paths: contains a space (likely a sentence) or
    // looks like a directive keyword.
    if (candidate.includes(' ')) continue
    // Reject single-word identifiers that aren't file-like.
    if (!candidate.includes('/') && !extensionPattern.test(candidate)) continue
    paths.add(candidate)
  }
  return Array.from(paths)
}

/**
 * Story 59-3: compute fidelity between a generated story file and the
 * named paths in the source AC. Drift is the fraction of source-AC paths
 * that do NOT appear anywhere in the story file content.
 *
 * Substring-match (not exact) — a source AC path
 * `packages/memory/src/graph/adjacency-store.ts` matches a story-file
 * mention of just the basename `adjacency-store.ts`. This is intentional:
 * stories sometimes shorten paths in prose while still preserving the
 * named file. Full-path or basename — both count as present. The drift
 * case we're catching (Run 9's WikilinkResolver substituting for
 * adjacency-store) has neither full nor basename present.
 *
 * Empty namedPaths list returns drift=0 (cannot drift from nothing).
 */
export function computeStoryFileFidelity(
  storyFileContent: string,
  namedPaths: string[],
): { missing: string[]; present: string[]; drift: number } {
  if (namedPaths.length === 0) {
    return { missing: [], present: [], drift: 0 }
  }
  const missing: string[] = []
  const present: string[] = []
  for (const path of namedPaths) {
    // Full-path match OR basename match
    const basename = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
    if (storyFileContent.includes(path) || storyFileContent.includes(basename)) {
      present.push(path)
    } else {
      missing.push(path)
    }
  }
  return { missing, present, drift: missing.length / namedPaths.length }
}

/**
 * Story 60-1: extract behavioral assertions from source AC text. Catches the
 * class of drift 59-3's path-fidelity gate is structurally blind to: silent
 * AC clause-set reduction (strata obs_2026-04-25_011 — Run 11's 1-10 source
 * AC declared "exactly four tools" + A2A integration; rendered artifact had
 * "exactly two tools" + zero A2A; fidelity gate passed because all
 * backtick-wrapped paths still appeared somewhere in the artifact).
 *
 * Returns three signals the caller can compose into a drift verdict:
 *
 * - `whenClauseCount`: count of `**When**` blocks (Given/When/Then triples).
 *   Strata's source ACs use this convention. Other projects may use other
 *   patterns (`### AC<N>`, numbered lists); the fidelity comparison
 *   accommodates both forms via `whenOrAcCount`.
 *
 * - `whenOrAcCount`: max(whenClauseCount, count of `### AC<N>:` headings).
 *   Robust across the two common AC-rendering styles.
 *
 * - `numericQuantifiers`: phrases like "exactly four tools", "all three
 *   skills", "both endpoints". Each is `{ phrase, count, noun }`. The
 *   word-numbers ("two" → 2, "four" → 4) and bare digits both convert.
 *   This is the highest-signal check — if source says "exactly four tools"
 *   and rendered says "exactly two tools", the mismatch is unambiguous.
 *
 * Empty source returns zeroed signals (cannot drift from nothing).
 */
export interface BehavioralAssertions {
  whenClauseCount: number
  whenOrAcCount: number
  numericQuantifiers: Array<{ phrase: string; count: number; noun: string }>
}

const WORD_TO_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

/**
 * obs_2026-05-03_021: nouns that genuinely end in `-s` in their singular form
 * — must NOT be lemma-stripped (would yield `proces`, `statu`, `busines`).
 * The list is the conservative set of common engineering vocabulary; broader
 * coverage can be added as new false-strips surface.
 */
const LEMMA_STOPLIST = new Set([
  'process', 'status', 'class', 'access', 'success', 'address', 'business',
  'analysis', 'basis', 'crisis', 'thesis', 'axis', 'series', 'species',
])

/**
 * obs_2026-05-03_021: collapse plural ↔ singular noun forms to a shared
 * lemma so that the source AC's plural ("functions") and the rendered story's
 * singular code-form (`'function'`) compare on the same key.
 *
 * Strata Story 1-11b's failure shape was a canonical TS/JS rendering: source
 * AC says "X and Y are both **functions**" (prose plural), rendered story
 * expresses the same constraint as `typeof X === 'function' && typeof Y === 'function'`
 * (singular literal in backticks). The pre-fix heuristic counted plural
 * forms only, saw source=2, rendered=0, escalated as drift after 2 retries.
 *
 * Rules (priority order):
 *  - Stoplist hit → return as-is (preserves `process`, `status`, etc.)
 *  - `-ies` suffix (≥5 chars) → strip + 'y' (categories → category)
 *  - `-es` suffix (≥5 chars) where stem ends in s/x/z/ch/sh → strip 'es' (classes → class, boxes → box, watches → watch)
 *  - `-s` suffix (≥4 chars) → strip (functions → function, tools → tool)
 *  - otherwise return as-is
 */
export function lemmatizeNoun(noun: string): string {
  const lower = noun.toLowerCase()
  if (LEMMA_STOPLIST.has(lower)) return lower
  if (lower.length >= 5 && lower.endsWith('ies')) {
    return lower.slice(0, -3) + 'y'
  }
  // -ches disambiguation: `watch`/`watches` (singular ends in `tch`) strips
  // `es`; `cache`/`caches` (singular ends in `che`) strips just `s`. The
  // marker is the consonant before `ches`: `t` → strip `es`; otherwise →
  // strip `s` (preserving the singular's terminal `e`).
  if (lower.length >= 5 && lower.endsWith('ches')) {
    if (lower.endsWith('tches')) {
      return lower.slice(0, -2)
    }
    return lower.slice(0, -1)
  }
  if (lower.length >= 5 && lower.endsWith('es')) {
    const stem = lower.slice(0, -2)
    if (/[sxz]$/.test(stem) || /sh$/.test(stem)) {
      return stem
    }
  }
  if (lower.length >= 4 && lower.endsWith('s')) {
    return lower.slice(0, -1)
  }
  return lower
}

export function extractBehavioralAssertions(content: string): BehavioralAssertions {
  if (content.length === 0) {
    return { whenClauseCount: 0, whenOrAcCount: 0, numericQuantifiers: [] }
  }

  // Count Given/When/Then triples by **When** marker (case-insensitive).
  const whenMatches = content.match(/\*\*When\*\*/gi)
  const whenClauseCount = whenMatches?.length ?? 0

  // Count rendered-style AC headings (### AC<N>:) — covers projects that use
  // headed AC sections instead of Given/When/Then prose.
  const acHeadings = content.match(/^#{2,4}\s+AC\d+\b/gim)
  const acCount = acHeadings?.length ?? 0

  const whenOrAcCount = Math.max(whenClauseCount, acCount)

  // Numeric quantifiers: "exactly N <noun>", "all N <noun>", "both <noun>".
  // The phrase captures the determiner + count + noun (lowercased).
  const numericQuantifiers: Array<{ phrase: string; count: number; noun: string }> = []
  const seen = new Set<string>()
  // Match: (exactly|all|both) (word-number|digits)? (intermediate adjectives)? <plural noun>
  // The final noun MUST end in `s` (plural form) — filters out adjective
  // false-positives like "both **new** tools" (noun=new) which the simpler
  // regex captured incorrectly. Intermediate slots {0,2} allow up to two
  // adjectives (e.g., "exactly four MCP server tools" → intermediates
  // "MCP server", final noun "tools"). Irregular plurals (people, men,
  // children) are not captured — acceptable trade-off; they're rare in
  // engineering AC vocabulary which favors regular plurals (tools, skills,
  // endpoints, services, methods, files).
  const wordNum = '(?:one|two|three|four|five|six|seven|eight|nine|ten)'
  const pattern = new RegExp(
    `\\b(exactly|all|both)\\s+(?:(${wordNum}|\\d+)\\s+)?(?:[a-z][a-z_-]*\\s+){0,2}([a-z][a-z_-]+s)\\b`,
    'gi',
  )

  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const determiner = match[1]?.toLowerCase() ?? ''
    const numStr = match[2]?.toLowerCase() ?? ''
    const noun = match[3]?.toLowerCase() ?? ''

    // Determine count
    let count: number
    if (numStr === '') {
      // "both" without explicit number → 2. "exactly"/"all" without number → ambiguous, skip.
      if (determiner === 'both') count = 2
      else continue
    } else if (WORD_TO_NUMBER[numStr] !== undefined) {
      count = WORD_TO_NUMBER[numStr]!
    } else {
      const parsed = Number.parseInt(numStr, 10)
      if (Number.isNaN(parsed)) continue
      count = parsed
    }

    // Filter to plausible behavioral nouns. Length >= 3 excludes "is/an/of".
    if (noun.length < 3) continue

    const phrase = `${determiner} ${numStr || (determiner === 'both' ? '' : '')} ${noun}`.trim().replace(/\s+/g, ' ')
    // obs_2026-05-03_021: lemmatize so plural source ("functions") shares
    // a noun key with singular rendered backtick literals (`'function'`).
    const lemma = lemmatizeNoun(noun)
    const dedupKey = `${count}|${lemma}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    numericQuantifiers.push({ phrase, count, noun: lemma })
  }

  // obs_2026-05-03_021: code-span pass — backtick-wrapped singular literals
  // contribute occurrence counts. Catches the canonical TS/JS rendering
  // pattern `typeof X === 'function'` where the rendered story expresses
  // a noun-counted constraint via singular literals in code spans, not via
  // prose plural quantifiers. Pattern matches `'noun'` (single-quoted token
  // inside backticks). Accumulates per-lemma occurrence counts; each lemma
  // reaching ≥1 occurrence contributes one synthetic numericQuantifier.
  const backtickLiteralPattern = /`[^`]*?'([a-z][a-z_-]+)'[^`]*?`/gi
  const backtickCounts = new Map<string, number>()
  let blMatch: RegExpExecArray | null
  while ((blMatch = backtickLiteralPattern.exec(content)) !== null) {
    const rawNoun = blMatch[1]?.toLowerCase() ?? ''
    if (rawNoun.length < 3) continue
    const lemma = lemmatizeNoun(rawNoun)
    backtickCounts.set(lemma, (backtickCounts.get(lemma) ?? 0) + 1)
  }
  for (const [lemma, count] of backtickCounts) {
    const dedupKey = `${count}|${lemma}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    numericQuantifiers.push({ phrase: `<backtick-literal-occurrences>`, count, noun: lemma })
  }

  return { whenClauseCount, whenOrAcCount, numericQuantifiers }
}

/**
 * Story 60-1: compute clause-fidelity drift between rendered artifact and
 * source AC. Returns a multi-signal drift verdict. Caller composes signals
 * to decide whether to trip the gate.
 *
 * Three drift signals:
 *
 * - `clauseRatio`: rendered / source behavioral count. < 1.0 means the
 *   rendered has fewer behavioral clauses. Returns 1.0 when source has
 *   none (nothing to drift from).
 *
 * - `numericMismatches`: numeric quantifiers from source whose count is
 *   missing or DIFFERENT in rendered. The strata 1-10 case: source said
 *   "exactly four tools" with count=4; rendered says "exactly two tools"
 *   with count=2 → mismatch noun=tools, source=4, rendered=2.
 *
 * - `drift`: 0.0 (no drift) … 1.0 (total drift). Composite metric:
 *   weighted toward numeric mismatches (high signal) and clause-ratio
 *   shortfall (medium signal).
 */
export interface ClauseFidelityResult {
  clauseRatio: number
  sourceClauseCount: number
  renderedClauseCount: number
  /**
   * obs_2026-05-03_021: each entry carries a severity. `error` mismatches
   * (rendered/source ratio ≤ 0.5) trip the drift gate and block dispatch.
   * `warn` mismatches (ratio > 0.5) are recorded but do NOT contribute to
   * the drift composite — preserves the strata 1-10 catch class while
   * unblocking the prose↔code-rendering false-positive class. Orchestrator
   * filters by severity when assembling retry feedback.
   */
  numericMismatches: Array<{
    noun: string
    sourceCount: number
    renderedCount: number
    severity: 'warn' | 'error'
  }>
  drift: number
}

/**
 * obs_2026-05-03_021: hard-fail threshold for numeric-quantifier drift.
 * When `renderedCount / sourceCount ≤ 0.5`, the drop is large enough to
 * indicate genuine clause reduction (strata 1-10 was 4→2 = 0.5; the
 * boundary is inclusive). Above 0.5, the gap is within plausible
 * lemma/code-rendering variance and demoted to warn.
 */
const NUMERIC_HARD_FAIL_RATIO = 0.5

export function computeClauseFidelity(
  storyFileContent: string,
  sourceContent: string,
): ClauseFidelityResult {
  const sourceSignals = extractBehavioralAssertions(sourceContent)
  const renderedSignals = extractBehavioralAssertions(storyFileContent)

  const sourceCount = sourceSignals.whenOrAcCount
  const renderedCount = renderedSignals.whenOrAcCount
  const clauseRatio = sourceCount === 0 ? 1 : Math.min(1, renderedCount / sourceCount)

  // Numeric mismatches: for each (noun → count) in source, look up rendered's
  // count for the same noun. Difference flagged. Multiple-occurrence nouns
  // in source resolve to the MAX count (most-restrictive interpretation).
  const sourceNounCounts = new Map<string, number>()
  for (const q of sourceSignals.numericQuantifiers) {
    sourceNounCounts.set(q.noun, Math.max(sourceNounCounts.get(q.noun) ?? 0, q.count))
  }
  const renderedNounCounts = new Map<string, number>()
  for (const q of renderedSignals.numericQuantifiers) {
    renderedNounCounts.set(q.noun, Math.max(renderedNounCounts.get(q.noun) ?? 0, q.count))
  }

  const numericMismatches: ClauseFidelityResult['numericMismatches'] = []
  for (const [noun, sourceCnt] of sourceNounCounts.entries()) {
    const renderedCnt = renderedNounCounts.get(noun) ?? 0
    if (renderedCnt < sourceCnt) {
      // obs_2026-05-03_021: severity by rendered/source ratio. `error`
      // when ratio ≤ 0.5 (real clause-reduction, e.g., 4→2); `warn`
      // when ratio > 0.5 (likely lemma/code-rendering false-positive,
      // e.g., 2→1 from a singular code literal not yet counted).
      const ratio = sourceCnt === 0 ? 1 : renderedCnt / sourceCnt
      const severity: 'warn' | 'error' = ratio <= NUMERIC_HARD_FAIL_RATIO ? 'error' : 'warn'
      numericMismatches.push({ noun, sourceCount: sourceCnt, renderedCount: renderedCnt, severity })
    }
  }

  // Composite drift: trip on EITHER signal independently.
  // obs_2026-05-03_021: only `error`-severity numeric mismatches contribute.
  // Warn-severity mismatches stay in the array (orchestrator surfaces them
  // for telemetry / retro analysis) but don't trip the drift gate.
  const hasNumericHardFail = numericMismatches.some((m) => m.severity === 'error')
  const numericDriftComponent = hasNumericHardFail ? 1 : 0

  // Clause shortfall: when rendered drops below 70% of source count, that's
  // strong evidence of dropped clauses. Scales linearly to 1.0 at 0% rendered.
  // Above 70%, treated as stylistic restructuring (merging two source
  // clauses into one rendered AC is acceptable).
  const CLAUSE_RATIO_FLOOR = 0.7
  const clauseDriftComponent = clauseRatio >= CLAUSE_RATIO_FLOOR
    ? 0
    : Math.min(1, (CLAUSE_RATIO_FLOOR - clauseRatio) / CLAUSE_RATIO_FLOOR)

  // Trip on EITHER signal. Most-restrictive interpretation.
  const drift = Math.max(numericDriftComponent, clauseDriftComponent)

  return {
    clauseRatio,
    sourceClauseCount: sourceCount,
    renderedClauseCount: renderedCount,
    numericMismatches,
    drift,
  }
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
function getEpicShard(decisions: Decision[], epicId: string, projectRoot?: string, storyKey?: string): string {
  try {
    // AC4: Direct per-story lookup (post-37-0 schema — key = storyKey).
    // Preferred: the solutioning phase stored a shard keyed on storyKey
    // itself, so no section extraction needed.
    if (storyKey) {
      const perStoryShard = decisions.find(
        (d: Decision) => d.category === 'epic-shard' && d.key === storyKey
      )
      if (perStoryShard?.value) {
        logger.debug({ epicId, storyKey }, 'Found per-story epic shard (direct lookup)')
        return perStoryShard.value
      }
    }

    // AC6 migration shim — fall back to per-epic lookup for pre-37-0 projects.
    const epicShard = decisions.find(
      (d: Decision) => d.category === 'epic-shard' && d.key === epicId
    )
    const shardContent = epicShard?.value

    if (shardContent && storyKey) {
      const storySection = extractStorySection(shardContent, storyKey)
      if (storySection) {
        logger.debug({ epicId, storyKey }, 'Extracted per-story section from epic shard (pre-37-0 fallback)')
        return storySection
      }
      // Story 58-13: the per-epic shard exists but doesn't contain the
      // requested storyKey's section. Strata obs_2026-04-20_001 Run 8
      // asymmetric-fix finding surfaced this path — a solutioning-phase
      // shard stored only 12K (Stories 1.1-1.5 + partial 1.7), missing 1-9
      // entirely. The old code returned the stale shard here, so
      // create-story received prompt input containing lots of context
      // about OTHER stories but nothing about 1-9, and the agent
      // hallucinated the spec from domain priors (LanceDB class-based
      // design instead of the JSON adjacency-list the author specified).
      // Fall through to the file-based fallback to get a fresh section
      // from epics.md. If the file also lacks the section, we still
      // prefer the full-file epic content over the stale shard (dev gets
      // SOMETHING legitimate to ground the render).
      logger.info(
        { epicId, storyKey },
        'Story section absent in decisions-store shard — attempting file-based fallback before returning stale shard',
      )
    }

    // File-based fallback: extract epic section from epics.md.
    // Runs whenever (a) no decisions-store shard at all, or (b) shard
    // exists but doesn't contain the requested storyKey's section.
    if (projectRoot) {
      const fallback = readEpicShardFromFile(projectRoot, epicId, storyKey)
      if (fallback) {
        logger.info({ epicId }, 'Using file-based fallback for epic shard')
        if (storyKey) {
          const storySection = extractStorySection(fallback, storyKey)
          if (storySection) {
            logger.debug({ epicId, storyKey }, 'Extracted per-story section from file-based epic shard')
            return storySection
          }
        }
        return fallback
      }
    }

    // Last resort (Story 58-13): if the decisions-store shard exists but
    // we couldn't extract the story section AND no file-based fallback
    // was available (no projectRoot, or epics.md missing / doesn't
    // contain the epic), return the stale shard rather than an empty
    // string. Matches prior behavior when neither lookup is fruitful.
    if (shardContent) {
      return shardContent
    }

    return ''
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
      const summarized = constraints.map((d: Decision) => {
        const lines = d.value.split('\n')
        const header = lines[0] ?? d.key
        const body = lines.slice(1).join('\n')
        const truncatedBody = body.length > 300 ? body.slice(0, 297) + '...' : body
        return `${header}\n${truncatedBody}`
      }).join('\n\n')

      logger.info(
        { fullLength: full.length, summarizedLength: summarized.length, decisions: constraints.length },
        'Architecture constraints summarized to fit create-story budget',
      )
      return summarized.slice(0, ARCH_CONSTRAINT_MAX_CHARS)
    }

    // File-based fallback: read architecture.md directly
    // Path E Bug #4: arch constraints are READ-ONLY planning artifacts —
    // resolve from parent root before falling back to projectRoot/worktree.
    const archRoot = deps.parentProjectRoot ?? deps.projectRoot
    if (archRoot) {
      const fallback = readArchConstraintsFromFile(archRoot)
      if (fallback) {
        logger.info('Using file-based fallback for architecture constraints (decisions table empty)')
        return fallback.length > ARCH_CONSTRAINT_MAX_CHARS
          ? fallback.slice(0, ARCH_CONSTRAINT_MAX_CHARS) + '\n\n[truncated for token budget]'
          : fallback
      }
    }

    return ''
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to retrieve architecture constraints')
    return ''
  }
}

/**
 * File-based fallback: read epic shard from _bmad-output planning files.
 *
 * Lookup order:
 *   1. Consolidated `_bmad-output/planning-artifacts/epics.md` — the
 *      multi-epic-per-file convention used by external projects (strata,
 *      ynab, NextGen Ticketing). Section extracted via heading regex.
 *   2. Consolidated `_bmad-output/epics.md` — alternate location.
 *   3. Per-epic file `_bmad-output/planning-artifacts/epic-<epicNum>-*.md`
 *      — the per-epic convention substrate's own planning artifacts use
 *      (Story 61-1). Returns the entire file content as the shard;
 *      downstream `extractStorySection` callers narrow to the per-story
 *      section by `### Story X:` heading match.
 *
 * Returns the matched section content, or empty string if no path matches.
 */
function readEpicShardFromFile(projectRoot: string, epicId: string, storyKey?: string): string {
  try {
    // Check both planning-artifacts (standard BMAD layout) and root _bmad-output
    const candidates = [
      join(projectRoot, '_bmad-output', 'planning-artifacts', 'epics.md'),
      join(projectRoot, '_bmad-output', 'epics.md'),
    ]
    const epicsPath = candidates.find((p) => existsSync(p))
    // Extract the numeric part of epicId (e.g., '7' from '7' or 'epic-7')
    const epicNum = epicId.replace(/^epic-/i, '')

    if (epicsPath) {
      const content = readFileSync(epicsPath, 'utf-8')
      // Step 1: Find the epic heading and detect its heading level (##, ###, or ####)
      const headingPattern = new RegExp(
        `^(#{2,4})\\s+(?:Epic\\s+)?${epicNum}[.:\\s]`,
        'm',
      )
      const headingMatch = headingPattern.exec(content)
      if (headingMatch) {
        const startIdx = headingMatch.index
        const headingLevel = headingMatch[1]!.length // 2, 3, or 4

        // Step 2: Find the next heading at the same or higher level (fewer or equal #'s)
        // This ensures story sub-headings (###, ####) within the epic are included.
        const hashes = '#'.repeat(headingLevel)
        const endPattern = new RegExp(`\\n${hashes}\\s`, 'g')
        endPattern.lastIndex = startIdx + headingMatch[0].length
        const endMatch = endPattern.exec(content)
        const endIdx = endMatch ? endMatch.index : content.length

        return content.slice(startIdx, endIdx).trim()
      }
      // Consolidated file exists but doesn't contain this epic — fall
      // through to the per-epic-file scan rather than returning empty,
      // because a project might mix conventions (consolidated for some
      // epics + per-epic for others).
    }

    // Story 61-1: per-epic file fallback. Substrate's own planning
    // artifacts use the per-epic-file convention
    // (`epic-NN-<name>.md`); the consolidated convention above doesn't
    // see them. Without this path, substrate-on-substrate dispatches
    // (and any other project using the per-epic convention) escalate
    // immediately at create-story with `source-ac-content-missing`
    // because epic_shard ends up empty.
    //
    // Match files by literal `epic-<epicNum>-*.md` (no leading-zero
    // tolerance — epicId is already canonical from the caller). Sort
    // alphabetically for deterministic selection when multiple files
    // could plausibly match (rare; usually exactly one per epic).
    const planningDir = join(projectRoot, '_bmad-output', 'planning-artifacts')
    if (existsSync(planningDir)) {
      try {
        const entries = readdirSync(planningDir, { encoding: 'utf-8' })
        const perEpicPattern = new RegExp(`^epic-${epicNum}-.*\\.md$`)
        const matches = entries.filter((e) => perEpicPattern.test(e)).sort()
        if (matches.length > 0) {
          // When multiple per-epic files share the same epic number, locate the
          // file that actually contains the requested story heading. Prevents
          // alphabetically-first selection from silently returning a sibling
          // fixture's content. This was the obs_2026-05-05_026 root cause —
          // confirmed 2026-05-10 after week-long misdiagnosis: `_bmad-output/
          // planning-artifacts/` had three `epic-999-*.md` files; the
          // alphabetically-first (`...production-shaped-fixtures.md`) contained
          // `Story 999-2` while the dispatch requested `999-1`. The agent's
          // Input Validation gate then correctly emitted `source-ac-content-missing`
          // because the shard delivered wasn't the shard requested. Falls back
          // to `matches[0]` only when no file contains the storyKey (single-
          // file projects + projects with no naming-collision are unchanged).
          let chosenIdx = 0
          if (storyKey !== undefined && matches.length > 1) {
            for (let i = 0; i < matches.length; i++) {
              const candidateContent = readFileSync(join(planningDir, matches[i]!), 'utf-8')
              if (extractStorySection(candidateContent, storyKey) !== null) {
                chosenIdx = i
                break
              }
            }
          }
          const perEpicPath = join(planningDir, matches[chosenIdx]!)
          const content = readFileSync(perEpicPath, 'utf-8')
          // Return the entire file content as the shard — downstream
          // `extractStorySection` narrows to the per-story section by
          // matching `### Story X:` headings, which works the same
          // regardless of the epic-heading level (`# Epic NN:` /
          // `## Epic NN:`).
          return content.trim()
        }
      } catch {
        // fall through to empty
      }
    }

    return ''
  } catch (err) {
    logger.warn({ epicId, error: err instanceof Error ? err.message : String(err) }, 'File-based epic shard fallback failed')
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
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'File-based architecture fallback failed')
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
export async function isValidStoryFile(filePath: string): Promise<{ valid: boolean; reason?: string }> {
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
