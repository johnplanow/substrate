/**
 * Solutioning phase implementation for the Phase Orchestrator pipeline.
 *
 * Implements `runSolutioningPhase()` which:
 *  1. Architecture Generation sub-phase:
 *     a. Retrieves architecture prompt from methodology pack
 *     b. Formats planning-phase requirements for prompt injection
 *     c. Validates token budget (<= 3,000 tokens)
 *     d. Dispatches to an architecture agent
 *     e. Parses ArchitectureOutputSchema from YAML output
 *     f. Stores each decision in the decision store (phase='solutioning', category='architecture')
 *     g. Registers architecture artifact
 *  2. Epic/Story Generation sub-phase:
 *     a. Retrieves story-generation prompt from methodology pack
 *     b. Formats requirements AND architecture decisions for prompt injection
 *     c. Validates token budget (<= 4,000 tokens)
 *     d. Dispatches to a planning agent (taskType='story-generation')
 *     e. Parses StoryGenerationOutputSchema from YAML output
 *     f. Stores epics and stories as decisions; creates Requirement records per story
 *     g. Registers stories artifact
 *  3. Readiness Check:
 *     a. Queries all planning-phase functional requirements for this run
 *     b. Queries all solutioning-phase stories for this run
 *     c. Uses QualityGate to check FR-to-story traceability
 *     d. If gate fails and no retries yet, re-dispatches story generation with gap analysis
 *     e. Runs readiness check again after retry
 *     f. Returns { result: 'failed', readiness_passed: false } if still failing after retry
 *  4. Returns a typed SolutioningResult with decision/epic/story counts and readiness status
 */

import {
  createDecision,
  createRequirement,
  getDecisionsByPhaseForRun,
  registerArtifact,
} from '../../../persistence/queries/decisions.js'
import { createQualityGate } from '../../quality-gates/gate-impl.js'
import { ArchitectureOutputSchema, StoryGenerationOutputSchema } from './schemas.js'
import type {
  ArchitectureDecision,
  EpicDefinition,
  PhaseDeps,
  SolutioningPhaseParams,
  SolutioningResult,
  StoryDefinition,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total prompt token budget for architecture generation (3,000 tokens × 4 chars = 12,000 chars) */
const MAX_ARCH_PROMPT_TOKENS = 3_000
const MAX_ARCH_PROMPT_CHARS = MAX_ARCH_PROMPT_TOKENS * 4

/** Maximum total prompt token budget for story generation (4,000 tokens × 4 chars = 16,000 chars) */
const MAX_STORY_PROMPT_TOKENS = 4_000
const MAX_STORY_PROMPT_CHARS = MAX_STORY_PROMPT_TOKENS * 4

/** Placeholder in architecture prompt template */
const REQUIREMENTS_PLACEHOLDER = '{{requirements}}'

/** Amendment context framing block prefix */
const AMENDMENT_CONTEXT_HEADER = '\n\n--- AMENDMENT CONTEXT (Parent Run Decisions) ---\n'

/** Amendment context framing block suffix */
const AMENDMENT_CONTEXT_FOOTER = '\n--- END AMENDMENT CONTEXT ---\n'

/** Marker appended when amendment context is truncated to fit token budget */
const TRUNCATED_MARKER = '\n[TRUNCATED]'

/** Placeholders in story generation prompt template */
const STORY_REQUIREMENTS_PLACEHOLDER = '{{requirements}}'
const STORY_ARCHITECTURE_PLACEHOLDER = '{{architecture_decisions}}'

/** Gap analysis placeholder used in retry prompt */
const GAP_ANALYSIS_PLACEHOLDER = '{{gap_analysis}}'

// ---------------------------------------------------------------------------
// formatRequirements
// ---------------------------------------------------------------------------

/**
 * Format functional and non-functional requirements from the planning phase
 * into a compact text block suitable for prompt injection.
 *
 * Queries decisions from the planning phase scoped to the current run,
 * filtering for functional-requirements and non-functional-requirements categories.
 *
 * @param db - SQLite database instance
 * @param runId - Pipeline run ID to scope the query
 * @returns Formatted requirements string for prompt injection
 */
function formatRequirements(
  db: import('better-sqlite3').Database,
  runId: string,
): string {
  const decisions = getDecisionsByPhaseForRun(db, runId, 'planning')
  const frDecisions = decisions.filter((d) => d.category === 'functional-requirements')
  const nfrDecisions = decisions.filter((d) => d.category === 'non-functional-requirements')

  const parts: string[] = ['## Requirements']

  if (frDecisions.length > 0) {
    parts.push('### Functional Requirements')
    for (const d of frDecisions) {
      try {
        const fr = JSON.parse(d.value) as { description: string; priority: string }
        parts.push(`- [${fr.priority?.toUpperCase() ?? 'MUST'}] ${fr.description}`)
      } catch {
        parts.push(`- ${d.value}`)
      }
    }
  }

  if (nfrDecisions.length > 0) {
    parts.push('### Non-Functional Requirements')
    for (const d of nfrDecisions) {
      try {
        const nfr = JSON.parse(d.value) as { description: string; category: string }
        parts.push(`- [${nfr.category?.toUpperCase() ?? 'NFR'}] ${nfr.description}`)
      } catch {
        parts.push(`- ${d.value}`)
      }
    }
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// formatArchitectureDecisions
// ---------------------------------------------------------------------------

/**
 * Format architecture decisions from the solutioning phase decision store
 * into a compact text block suitable for prompt injection.
 *
 * Queries decisions from the solutioning phase scoped to the current run,
 * filtering for category='architecture'.
 *
 * @param db - SQLite database instance
 * @param runId - Pipeline run ID to scope the query
 * @returns Formatted architecture decisions string for prompt injection
 */
function formatArchitectureDecisions(
  db: import('better-sqlite3').Database,
  runId: string,
): string {
  const decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
  const archDecisions = decisions.filter((d) => d.category === 'architecture')

  const parts: string[] = ['## Architecture Decisions']

  for (const d of archDecisions) {
    const rationale = d.rationale ? ` (${d.rationale})` : ''
    parts.push(`- **${d.key}**: ${d.value}${rationale}`)
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// runArchitectureGeneration
// ---------------------------------------------------------------------------

type ArchitectureGenerationSuccess = {
  decisions: ArchitectureDecision[]
  artifactId: string
  tokenUsage: { input: number; output: number }
}

type ArchitectureGenerationFailure = {
  error: string
  tokenUsage: { input: number; output: number }
}

/**
 * Run the architecture generation sub-phase.
 *
 * Retrieves the architecture prompt template, injects requirements context,
 * validates token budget, dispatches to an architecture agent, parses the output,
 * persists decisions, and registers the architecture artifact.
 *
 * @param deps - Shared phase dependencies
 * @param params - Solutioning phase parameters (runId, amendmentContext)
 * @returns Success with decisions and artifactId, or failure with error
 */
async function runArchitectureGeneration(
  deps: PhaseDeps,
  params: SolutioningPhaseParams,
): Promise<ArchitectureGenerationSuccess | ArchitectureGenerationFailure> {
  const { db, pack, dispatcher } = deps
  const { runId, amendmentContext } = params
  const zeroTokenUsage = { input: 0, output: 0 }

  // Step 1: Retrieve architecture prompt template
  const template = await pack.getPrompt('architecture')

  // Step 2: Format requirements from decision store
  const formattedRequirements = formatRequirements(db, runId)

  // Step 3: Assemble prompt within 3,000-token ceiling
  let prompt = template.replace(REQUIREMENTS_PLACEHOLDER, formattedRequirements)

  // Step 3b: Inject amendment context if provided
  if (amendmentContext !== undefined && amendmentContext !== '') {
    const framingLen = AMENDMENT_CONTEXT_HEADER.length + AMENDMENT_CONTEXT_FOOTER.length
    const availableForContext = MAX_ARCH_PROMPT_CHARS - prompt.length - framingLen - TRUNCATED_MARKER.length
    let contextToInject = amendmentContext
    if (availableForContext <= 0) {
      contextToInject = ''
    } else if (amendmentContext.length > availableForContext) {
      contextToInject = amendmentContext.slice(0, availableForContext) + TRUNCATED_MARKER
    }
    if (contextToInject !== '') {
      prompt += AMENDMENT_CONTEXT_HEADER + contextToInject + AMENDMENT_CONTEXT_FOOTER
    }
  }

  const estimatedTokens = Math.ceil(prompt.length / 4)
  if (estimatedTokens > MAX_ARCH_PROMPT_TOKENS) {
    return {
      error: `Architecture prompt exceeds token budget: ${estimatedTokens} tokens (max ${MAX_ARCH_PROMPT_TOKENS})`,
      tokenUsage: zeroTokenUsage,
    }
  }

  // Step 4: Dispatch with taskType='architecture', outputSchema=ArchitectureOutputSchema
  const handle = dispatcher.dispatch({
    prompt,
    agent: 'claude-code',
    taskType: 'architecture',
    outputSchema: ArchitectureOutputSchema,
  })

  const dispatchResult = await handle.result
  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  if (dispatchResult.status === 'timeout') {
    return {
      error: `Architecture agent timed out after ${dispatchResult.durationMs}ms`,
      tokenUsage,
    }
  }

  if (dispatchResult.status === 'failed') {
    return {
      error: `Architecture dispatch failed: ${dispatchResult.parseError ?? dispatchResult.output}`,
      tokenUsage,
    }
  }

  if (dispatchResult.parsed === null || dispatchResult.parseError !== null) {
    return {
      error: `Architecture schema validation failed: ${dispatchResult.parseError ?? 'No parsed output'}`,
      tokenUsage,
    }
  }

  const parsed = dispatchResult.parsed as { result: string; architecture_decisions: ArchitectureDecision[] }

  if (parsed.result === 'failed' || !parsed.architecture_decisions) {
    return {
      error: 'Architecture agent reported failure or missing architecture_decisions',
      tokenUsage,
    }
  }

  const decisions = parsed.architecture_decisions

  // Step 5: Persist each decision to the decision store
  for (const decision of decisions) {
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: decision.key,
      value: decision.value,
      rationale: decision.rationale,
    })
  }

  // Step 6: Register architecture artifact
  const artifact = registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    type: 'architecture',
    path: 'decision-store://solutioning/architecture',
    summary: `${decisions.length} architecture decisions`,
  })

  return {
    decisions,
    artifactId: artifact.id,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// runStoryGeneration
// ---------------------------------------------------------------------------

type StoryGenerationSuccess = {
  epics: EpicDefinition[]
  artifactId: string
  tokenUsage: { input: number; output: number }
}

type StoryGenerationFailure = {
  error: string
  tokenUsage: { input: number; output: number }
}

/**
 * Run the epic/story generation sub-phase.
 *
 * Retrieves the story-generation prompt template, injects requirements and
 * architecture decisions, validates token budget, dispatches to a planning agent,
 * parses the output, persists epics and stories as decisions, creates Requirement
 * records for each story, and registers the stories artifact.
 *
 * @param deps - Shared phase dependencies
 * @param params - Solutioning phase parameters (runId, amendmentContext)
 * @param gapAnalysis - Optional gap analysis text for retry dispatches
 * @returns Success with epics and artifactId, or failure with error
 */
async function runStoryGeneration(
  deps: PhaseDeps,
  params: SolutioningPhaseParams,
  gapAnalysis?: string,
): Promise<StoryGenerationSuccess | StoryGenerationFailure> {
  const { db, pack, dispatcher } = deps
  const { runId, amendmentContext } = params
  const zeroTokenUsage = { input: 0, output: 0 }

  // Step 1: Retrieve story-generation prompt template
  const template = await pack.getPrompt('story-generation')

  // Step 2: Format requirements AND architecture decisions
  const formattedRequirements = formatRequirements(db, runId)
  const formattedArchitecture = formatArchitectureDecisions(db, runId)

  // Step 3: Assemble prompt within 4,000-token ceiling
  let prompt = template
    .replace(STORY_REQUIREMENTS_PLACEHOLDER, formattedRequirements)
    .replace(STORY_ARCHITECTURE_PLACEHOLDER, formattedArchitecture)

  // If this is a retry, inject gap analysis
  if (gapAnalysis !== undefined) {
    prompt = prompt.replace(GAP_ANALYSIS_PLACEHOLDER, gapAnalysis)
  }

  // Step 3b: Inject amendment context if provided
  if (amendmentContext !== undefined && amendmentContext !== '') {
    const framingLen = AMENDMENT_CONTEXT_HEADER.length + AMENDMENT_CONTEXT_FOOTER.length
    const availableForContext = MAX_STORY_PROMPT_CHARS - prompt.length - framingLen - TRUNCATED_MARKER.length
    let contextToInject = amendmentContext
    if (availableForContext <= 0) {
      contextToInject = ''
    } else if (amendmentContext.length > availableForContext) {
      contextToInject = amendmentContext.slice(0, availableForContext) + TRUNCATED_MARKER
    }
    if (contextToInject !== '') {
      prompt += AMENDMENT_CONTEXT_HEADER + contextToInject + AMENDMENT_CONTEXT_FOOTER
    }
  }

  const estimatedTokens = Math.ceil(prompt.length / 4)
  if (estimatedTokens > MAX_STORY_PROMPT_TOKENS) {
    return {
      error: `Story generation prompt exceeds token budget: ${estimatedTokens} tokens (max ${MAX_STORY_PROMPT_TOKENS})`,
      tokenUsage: zeroTokenUsage,
    }
  }

  // Step 4: Dispatch with taskType='story-generation', outputSchema=StoryGenerationOutputSchema
  const handle = dispatcher.dispatch({
    prompt,
    agent: 'claude-code',
    taskType: 'story-generation',
    outputSchema: StoryGenerationOutputSchema,
  })

  const dispatchResult = await handle.result
  const tokenUsage = {
    input: dispatchResult.tokenEstimate.input,
    output: dispatchResult.tokenEstimate.output,
  }

  if (dispatchResult.status === 'timeout') {
    return {
      error: `Story generation agent timed out after ${dispatchResult.durationMs}ms`,
      tokenUsage,
    }
  }

  if (dispatchResult.status === 'failed') {
    return {
      error: `Story generation dispatch failed: ${dispatchResult.parseError ?? dispatchResult.output}`,
      tokenUsage,
    }
  }

  if (dispatchResult.parsed === null || dispatchResult.parseError !== null) {
    return {
      error: `Story generation schema validation failed: ${dispatchResult.parseError ?? 'No parsed output'}`,
      tokenUsage,
    }
  }

  const parsed = dispatchResult.parsed as { result: string; epics: EpicDefinition[] }

  if (parsed.result === 'failed' || !parsed.epics) {
    return {
      error: 'Story generation agent reported failure or missing epics',
      tokenUsage,
    }
  }

  const epics = parsed.epics

  // Step 5: Store epics as decisions
  for (const [epicIndex, epic] of epics.entries()) {
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'epics',
      key: `epic-${epicIndex + 1}`,
      value: JSON.stringify({ title: epic.title, description: epic.description }),
    })

    // Step 5b: Store each story as a decision
    for (const story of epic.stories) {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'solutioning',
        category: 'stories',
        key: story.key,
        value: JSON.stringify({
          key: story.key,
          title: story.title,
          description: story.description,
          ac: story.acceptance_criteria,
          priority: story.priority,
        }),
      })
    }
  }

  // Step 6: Create Requirement records for each story
  for (const epic of epics) {
    for (const story of epic.stories) {
      createRequirement(db, {
        pipeline_run_id: runId,
        source: 'solutioning-phase',
        type: 'functional',
        description: `${story.title}: ${story.description}`,
        priority: story.priority,
      })
    }
  }

  // Step 7: Register stories artifact
  const totalStories = epics.reduce((sum, epic) => sum + epic.stories.length, 0)
  const artifact = registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    type: 'stories',
    path: 'decision-store://solutioning/stories',
    summary: `${epics.length} epics, ${totalStories} stories`,
  })

  return {
    epics,
    artifactId: artifact.id,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// runReadinessCheck
// ---------------------------------------------------------------------------

/**
 * Run the readiness check using a QualityGate to verify FR-to-story traceability.
 *
 * For each functional requirement from the planning phase, checks if at least
 * one solutioning-phase story references it (simple substring keyword match).
 *
 * @param deps - Shared phase dependencies
 * @param runId - Pipeline run ID to scope the query
 * @returns Object with `passed` boolean and optional `gaps` array (uncovered FRs)
 */
async function runReadinessCheck(
  deps: PhaseDeps,
  runId: string,
): Promise<{ passed: boolean; gaps?: string[] }> {
  const { db } = deps

  // Query all functional requirements from planning phase for this run
  const planningDecisions = getDecisionsByPhaseForRun(db, runId, 'planning')
  const frDecisions = planningDecisions.filter((d) => d.category === 'functional-requirements')

  // Parse FR descriptions
  const functionalRequirements: string[] = []
  for (const d of frDecisions) {
    try {
      const fr = JSON.parse(d.value) as { description: string }
      if (fr.description) {
        functionalRequirements.push(fr.description)
      }
    } catch {
      functionalRequirements.push(d.value)
    }
  }

  // Query all stories from solutioning phase for this run
  const solutioningDecisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
  const storyDecisions = solutioningDecisions.filter((d) => d.category === 'stories')

  // Parse story content for keyword matching
  const stories: Array<{ description: string; ac: string[] }> = []
  for (const d of storyDecisions) {
    try {
      const story = JSON.parse(d.value) as {
        description?: string
        ac?: string[]
        title?: string
      }
      stories.push({
        description: [story.title ?? '', story.description ?? ''].join(' '),
        ac: story.ac ?? [],
      })
    } catch {
      stories.push({ description: d.value, ac: [] })
    }
  }

  // Build the coverage structure for the gate evaluator
  const coverageData = { functionalRequirements, stories }

  // Use QualityGate to check FR-to-story traceability
  const gate = createQualityGate({
    name: 'solutioning-readiness',
    maxRetries: 0,
    evaluator: (output: unknown) => {
      const data = output as typeof coverageData
      const gaps: string[] = []

      for (const fr of data.functionalRequirements) {
        // Simple keyword/substring match — MVP approach per story spec
        const frLower = fr.toLowerCase()
        const frKeywords = frLower.split(/\s+/).filter((w) => w.length > 4)

        const covered = data.stories.some((story) => {
          const storyText = [story.description, ...story.ac].join(' ').toLowerCase()
          // Check if any keyword from the FR appears in the story text
          return frKeywords.some((kw) => storyText.includes(kw)) || storyText.includes(frLower)
        })

        if (!covered) {
          gaps.push(fr)
        }
      }

      return {
        pass: gaps.length === 0,
        issues: gaps.map((g) => `Uncovered FR: ${g}`),
        severity: gaps.length === 0 ? ('info' as const) : ('error' as const),
      }
    },
  })

  const gateResult = gate.evaluate(coverageData)

  if (gateResult.action === 'proceed') {
    return { passed: true }
  }

  // Extract gaps from gate issues
  const gaps = gateResult.issues.map((issue) => issue.replace(/^Uncovered FR: /, ''))
  return { passed: false, gaps }
}

// ---------------------------------------------------------------------------
// runSolutioningPhase
// ---------------------------------------------------------------------------

/**
 * Execute the solutioning phase of the BMAD pipeline.
 *
 * Orchestrates the two-phase dispatch strategy:
 *  1. Architecture generation: requirements → technology choices + module structure
 *  2. Story generation: requirements + architecture → epics + stories
 *
 * After both sub-phases complete, runs a readiness check to verify FR-to-story
 * traceability. If the check fails, retries story generation once with gap analysis.
 *
 * @param deps - Shared phase dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Phase parameters (runId)
 * @returns SolutioningResult with success/failure status, counts, and token usage
 */
export async function runSolutioningPhase(
  deps: PhaseDeps,
  params: SolutioningPhaseParams,
): Promise<SolutioningResult> {
  const zeroTokenUsage = { input: 0, output: 0 }
  let totalInput = 0
  let totalOutput = 0

  try {
    // Step 1: Run architecture generation sub-phase
    const archResult = await runArchitectureGeneration(deps, params)

    // Accumulate token usage
    totalInput += archResult.tokenUsage.input
    totalOutput += archResult.tokenUsage.output

    // Step 2: If architecture fails, return failure with error
    if ('error' in archResult) {
      return {
        result: 'failed',
        error: `architecture_generation_failed`,
        details: archResult.error,
        tokenUsage: { input: totalInput, output: totalOutput },
      }
    }

    // Step 3: Run story generation sub-phase
    const storyResult = await runStoryGeneration(deps, params)

    // Accumulate token usage
    totalInput += storyResult.tokenUsage.input
    totalOutput += storyResult.tokenUsage.output

    // Step 4: If story generation fails, return partial failure (architecture artifacts preserved)
    if ('error' in storyResult) {
      return {
        result: 'failed',
        error: `story_generation_failed`,
        details: storyResult.error,
        artifact_ids: [archResult.artifactId],
        tokenUsage: { input: totalInput, output: totalOutput },
      }
    }

    // Step 5: Run readiness check
    const readinessResult = await runReadinessCheck(deps, params.runId)

    // Step 6: If readiness fails, retry once with gap analysis
    if (!readinessResult.passed) {
      const gaps = readinessResult.gaps ?? []

      // Compile gap analysis for re-dispatch
      const gapAnalysis = [
        '## Gap Analysis: Uncovered Functional Requirements',
        'The following functional requirements are not covered by any generated story:',
        ...gaps.map((g) => `- ${g}`),
        '',
        'Please generate additional stories to cover these requirements.',
      ].join('\n')

      // Re-dispatch story generation with gap analysis
      const retryResult = await runStoryGeneration(deps, params, gapAnalysis)

      // Accumulate token usage from retry
      totalInput += retryResult.tokenUsage.input
      totalOutput += retryResult.tokenUsage.output

      if ('error' in retryResult) {
        // Retry dispatch failed — return failure with gaps
        return {
          result: 'failed',
          error: 'story_generation_retry_failed',
          details: retryResult.error,
          readiness_passed: false,
          gaps,
          artifact_ids: [archResult.artifactId, storyResult.artifactId],
          tokenUsage: { input: totalInput, output: totalOutput },
        }
      }

      // Re-check readiness after retry
      const retryReadiness = await runReadinessCheck(deps, params.runId)

      if (!retryReadiness.passed) {
        // Still failing after retry — return failure per AC6
        return {
          result: 'failed',
          error: 'readiness_check_failed',
          details: 'Readiness check failed after maximum retries',
          readiness_passed: false,
          gaps: retryReadiness.gaps ?? gaps,
          artifact_ids: [archResult.artifactId, storyResult.artifactId, retryResult.artifactId],
          tokenUsage: { input: totalInput, output: totalOutput },
        }
      }

      // Retry succeeded — compute counts from retry result
      const retryStories = retryResult.epics.reduce(
        (sum, epic) => sum + epic.stories.length,
        0,
      )

      return {
        result: 'success',
        architecture_decisions: archResult.decisions.length,
        epics: retryResult.epics.length,
        stories: retryStories,
        readiness_passed: true,
        artifact_ids: [archResult.artifactId, storyResult.artifactId, retryResult.artifactId],
        tokenUsage: { input: totalInput, output: totalOutput },
      }
    }

    // Step 7: Return success result with counts
    const totalStories = storyResult.epics.reduce(
      (sum, epic) => sum + epic.stories.length,
      0,
    )

    return {
      result: 'success',
      architecture_decisions: archResult.decisions.length,
      epics: storyResult.epics.length,
      stories: totalStories,
      readiness_passed: true,
      artifact_ids: [archResult.artifactId, storyResult.artifactId],
      tokenUsage: { input: totalInput, output: totalOutput },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      result: 'failed',
      error: message,
      tokenUsage: { input: totalInput, output: totalOutput },
    }
  }
}
