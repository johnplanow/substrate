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
 *  3. Adversarial Readiness Check (Story 16.6):
 *     a. Assembles comprehensive context (FRs, NFRs, architecture decisions, stories, UX decisions)
 *     b. Dispatches readiness-check sub-agent for adversarial review
 *     c. Agent evaluates FR coverage, architecture compliance, story quality, UX alignment, dependency validity
 *     d. Handles verdict: READY (proceed), NEEDS_WORK (retry with gap analysis), NOT_READY (fail)
 *     e. If NEEDS_WORK with blockers: retries story generation with gap analysis, re-checks (max 1 retry)
 *     f. Returns { result: 'failed', readiness_passed: false } if still failing after retry
 *  4. Returns a typed SolutioningResult with decision/epic/story counts and readiness status
 */

import {
  upsertDecision,
  createRequirement,
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
  registerArtifact,
} from '../../../persistence/queries/decisions.js'
import { createLogger } from '../../../utils/logger.js'
import { calculateDynamicBudget, summarizeDecisions } from '../budget-utils.js'
import { runSteps } from '../step-runner.js'
import { ReadinessOutputSchema } from '../schemas/readiness-output.js'
import type { ReadinessFinding, ReadinessOutput } from '../schemas/readiness-output.js'

import type { StepDefinition } from '../step-runner.js'
import {
  ArchitectureOutputSchema,
  StoryGenerationOutputSchema,
  ArchContextOutputSchema,
  EpicDesignOutputSchema,
} from './schemas.js'
import type {
  ArchitectureDecision,
  EpicDefinition,
  PhaseDeps,
  SolutioningPhaseParams,
  SolutioningResult,
  StoryDefinition,
} from './types.js'

const logger = createLogger('solutioning')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base token budget for architecture generation (covers template + requirements) */
const BASE_ARCH_PROMPT_TOKENS = 3_000

/** Base token budget for story generation (covers template + requirements + architecture) */
const BASE_STORY_PROMPT_TOKENS = 4_000

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

/** Placeholders in readiness-check prompt template */
const READINESS_FR_PLACEHOLDER = '{{functional_requirements}}'
const READINESS_NFR_PLACEHOLDER = '{{non_functional_requirements}}'
const READINESS_ARCH_PLACEHOLDER = STORY_ARCHITECTURE_PLACEHOLDER
const READINESS_STORIES_PLACEHOLDER = '{{stories}}'
const READINESS_UX_PLACEHOLDER = '{{ux_decisions}}'

// Re-export shared utilities for backward compatibility with existing importers
// (e.g., solutioning.test.ts).
export { calculateDynamicBudget, summarizeDecisions } from '../budget-utils.js'

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

  // Step 3: Assemble prompt with dynamic token budget
  let prompt = template.replace(REQUIREMENTS_PLACEHOLDER, formattedRequirements)

  // Step 3b: Inject amendment context if provided
  const dynamicBudgetTokens = calculateDynamicBudget(BASE_ARCH_PROMPT_TOKENS, 0)
  const dynamicBudgetChars = dynamicBudgetTokens * 4

  if (amendmentContext !== undefined && amendmentContext !== '') {
    const framingLen = AMENDMENT_CONTEXT_HEADER.length + AMENDMENT_CONTEXT_FOOTER.length
    const availableForContext = dynamicBudgetChars - prompt.length - framingLen - TRUNCATED_MARKER.length
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
  if (estimatedTokens > dynamicBudgetTokens) {
    return {
      error: `Architecture prompt exceeds token budget: ${estimatedTokens} tokens (max ${dynamicBudgetTokens})`,
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

  // Step 5: Persist each decision to the decision store (upsert to deduplicate on retry)
  for (const decision of decisions) {
    upsertDecision(db, {
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
  const archDecisions = getDecisionsByPhaseForRun(db, runId, 'solutioning').filter(
    (d) => d.category === 'architecture',
  )

  // Calculate dynamic budget based on decision count
  const dynamicBudgetTokens = calculateDynamicBudget(BASE_STORY_PROMPT_TOKENS, archDecisions.length)
  const dynamicBudgetChars = dynamicBudgetTokens * 4

  let formattedArchitecture = formatArchitectureDecisions(db, runId)

  // Step 3: Assemble prompt with dynamic token budget
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
    const availableForContext = dynamicBudgetChars - prompt.length - framingLen - TRUNCATED_MARKER.length
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

  // Step 3c: If prompt exceeds dynamic budget, fall back to summarized decisions
  let estimatedTokens = Math.ceil(prompt.length / 4)
  if (estimatedTokens > dynamicBudgetTokens) {
    const availableForDecisions = dynamicBudgetChars - (prompt.length - formattedArchitecture.length)
    formattedArchitecture = summarizeDecisions(
      archDecisions.map((d) => ({ key: d.key, value: d.value, category: d.category })),
      Math.max(availableForDecisions, 200),
    )
    prompt = template
      .replace(STORY_REQUIREMENTS_PLACEHOLDER, formattedRequirements)
      .replace(STORY_ARCHITECTURE_PLACEHOLDER, formattedArchitecture)
    if (gapAnalysis !== undefined) {
      prompt = prompt.replace(GAP_ANALYSIS_PLACEHOLDER, gapAnalysis)
    }
    estimatedTokens = Math.ceil(prompt.length / 4)
  }

  if (estimatedTokens > dynamicBudgetTokens) {
    return {
      error: `Story generation prompt exceeds token budget: ${estimatedTokens} tokens (max ${dynamicBudgetTokens})`,
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

  // Step 5: Store epics as decisions (upsert to deduplicate on retry)
  for (const [epicIndex, epic] of epics.entries()) {
    upsertDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'epics',
      key: `epic-${epicIndex + 1}`,
      value: JSON.stringify({ title: epic.title, description: epic.description }),
    })

    // Step 5b: Store each story as a decision
    for (const story of epic.stories) {
      upsertDecision(db, {
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
        description: `${story.key}: ${story.title}: ${story.description}`,
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
 * Result types for the adversarial readiness check.
 */
type ReadinessCheckSuccess = {
  verdict: 'READY' | 'NEEDS_WORK' | 'NOT_READY'
  findings: ReadinessFinding[]
  coverageScore: number
  tokenUsage: { input: number; output: number }
}

type ReadinessCheckError = {
  verdict: 'error'
  error: string
  tokenUsage: { input: number; output: number }
}

type ReadinessCheckResult = ReadinessCheckSuccess | ReadinessCheckError

/**
 * Format functional requirements from pre-fetched planning phase decisions for prompt injection.
 * Accepts pre-fetched planning decisions to avoid duplicate DB queries (shared with formatNFRsForReadiness).
 */
function formatFRsForReadiness(planningDecisions: Array<{ category: string; key: string; value: string }>): string {
  const frDecisions = planningDecisions.filter((d) => d.category === 'functional-requirements')

  if (frDecisions.length === 0) {
    return '(No functional requirements found)'
  }

  const lines: string[] = []
  for (const [i, d] of frDecisions.entries()) {
    try {
      const fr = JSON.parse(d.value) as { description: string; priority: string }
      lines.push(`- [${d.key ?? `FR-${i}`}] [${fr.priority?.toUpperCase() ?? 'MUST'}] ${fr.description}`)
    } catch {
      lines.push(`- [${d.key ?? `FR-${i}`}] ${d.value}`)
    }
  }
  return lines.join('\n')
}

/**
 * Format non-functional requirements from pre-fetched planning phase decisions for prompt injection.
 * Accepts pre-fetched planning decisions to avoid duplicate DB queries (shared with formatFRsForReadiness).
 */
function formatNFRsForReadiness(planningDecisions: Array<{ category: string; key: string; value: string }>): string {
  const nfrDecisions = planningDecisions.filter((d) => d.category === 'non-functional-requirements')

  if (nfrDecisions.length === 0) {
    return '(No non-functional requirements found)'
  }

  const lines: string[] = []
  for (const d of nfrDecisions) {
    try {
      const nfr = JSON.parse(d.value) as { description: string; category: string }
      lines.push(`- [${nfr.category?.toUpperCase() ?? 'NFR'}] ${nfr.description}`)
    } catch {
      lines.push(`- ${d.value}`)
    }
  }
  return lines.join('\n')
}

/**
 * Format all stories from solutioning phase for prompt injection.
 */
function formatStoriesForReadiness(db: import('better-sqlite3').Database, runId: string): string {
  const solutioningDecisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
  const storyDecisions = solutioningDecisions.filter((d) => d.category === 'stories')

  if (storyDecisions.length === 0) {
    return '(No stories found)'
  }

  const lines: string[] = []
  for (const d of storyDecisions) {
    try {
      const story = JSON.parse(d.value) as {
        key?: string
        title?: string
        description?: string
        ac?: string[]
        acceptance_criteria?: string[]
        priority?: string
      }
      lines.push(`### Story ${story.key ?? d.key}: ${story.title ?? '(untitled)'}`)
      lines.push(`**Priority**: ${story.priority ?? 'must'}`)
      lines.push(`**Description**: ${story.description ?? ''}`)
      const acList = story.acceptance_criteria ?? story.ac
      if (acList && acList.length > 0) {
        lines.push('**Acceptance Criteria**:')
        for (const ac of acList) {
          lines.push(`  - ${ac}`)
        }
      }
      lines.push('')
    } catch {
      lines.push(`### Story ${d.key}: ${d.value}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * Format UX decisions from the UX design phase (if any) for prompt injection.
 */
function formatUxDecisionsForReadiness(db: import('better-sqlite3').Database, runId: string): string {
  const uxDecisions = getDecisionsByPhaseForRun(db, runId, 'ux-design')

  if (uxDecisions.length === 0) {
    return ''
  }

  const lines: string[] = ['### UX Design Decisions']
  for (const d of uxDecisions) {
    lines.push(`- **${d.key}** [${d.category}]: ${d.value}`)
  }
  return lines.join('\n')
}

/**
 * Run the adversarial readiness check by dispatching a sub-agent.
 *
 * Assembles comprehensive context (FRs, NFRs, architecture decisions, stories,
 * optional UX decisions) and dispatches a readiness-check agent to perform a
 * proper adversarial review — replacing the old QualityGate keyword matcher.
 *
 * @param deps - Shared phase dependencies
 * @param runId - Pipeline run ID to scope the query
 * @returns Readiness check result with verdict, findings, and coverage score
 */
async function runReadinessCheck(
  deps: PhaseDeps,
  runId: string,
): Promise<ReadinessCheckResult> {
  const { db, pack, dispatcher } = deps

  const zeroTokenUsage = { input: 0, output: 0 }

  // Step 1: Retrieve readiness-check prompt template
  let template: string
  try {
    template = await pack.getPrompt('readiness-check')
  } catch {
    return { verdict: 'error', error: 'readiness-check prompt template not found in methodology pack', tokenUsage: zeroTokenUsage }
  }

  // Step 2: Assemble context from decision store
  // Fetch planning decisions once and share between FR and NFR formatters (avoids duplicate DB query)
  const planningDecisions = getDecisionsByPhaseForRun(db, runId, 'planning')
  const formattedFRs = formatFRsForReadiness(planningDecisions)
  const formattedNFRs = formatNFRsForReadiness(planningDecisions)
  const formattedArchitecture = formatArchitectureDecisions(db, runId)
  const formattedStories = formatStoriesForReadiness(db, runId)
  const formattedUx = formatUxDecisionsForReadiness(db, runId)

  // Step 3: Build prompt — inject all context into placeholders
  let prompt = template
    .replace(READINESS_FR_PLACEHOLDER, formattedFRs)
    .replace(READINESS_NFR_PLACEHOLDER, formattedNFRs)
    .replace(READINESS_ARCH_PLACEHOLDER, formattedArchitecture)
    .replace(READINESS_STORIES_PLACEHOLDER, formattedStories)

  // Inject UX decisions section or remove placeholder if no UX data
  if (formattedUx) {
    prompt = prompt.replace(READINESS_UX_PLACEHOLDER, formattedUx)
  } else {
    prompt = prompt.replace(READINESS_UX_PLACEHOLDER, '')
  }

  // Step 4: Dispatch readiness-check sub-agent
  const handle = dispatcher.dispatch({
    prompt,
    agent: 'claude-code',
    taskType: 'readiness-check',
    outputSchema: ReadinessOutputSchema,
  })

  const dispatchResult = await handle.result
  const tokenEstimate = dispatchResult.tokenEstimate
  const tokenUsage = { input: tokenEstimate.input, output: tokenEstimate.output }

  logger.info(
    { runId, durationMs: dispatchResult.durationMs, tokens: tokenEstimate },
    'Readiness check dispatch completed',
  )

  if (dispatchResult.status === 'timeout') {
    return { verdict: 'error', error: `Readiness check agent timed out after ${dispatchResult.durationMs}ms`, tokenUsage }
  }

  if (dispatchResult.status === 'failed') {
    return {
      verdict: 'error',
      error: `Readiness check dispatch failed: ${dispatchResult.parseError ?? dispatchResult.output}`,
      tokenUsage,
    }
  }

  if (dispatchResult.parsed === null || dispatchResult.parseError !== null) {
    return {
      verdict: 'error',
      error: `Readiness check schema validation failed: ${dispatchResult.parseError ?? 'No parsed output'}`,
      tokenUsage,
    }
  }

  const parsed = dispatchResult.parsed as ReadinessOutput

  return {
    verdict: parsed.verdict,
    findings: parsed.findings ?? [],
    coverageScore: parsed.coverage_score,
    tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// Multi-step architecture generation
// ---------------------------------------------------------------------------

/**
 * Build step definitions for 3-step architecture decomposition.
 */
function buildArchitectureSteps(): StepDefinition[] {
  return [
    {
      name: 'architecture-step-1-context',
      taskType: 'arch-context',
      outputSchema: ArchContextOutputSchema,
      context: [
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
        { placeholder: 'nfr', source: 'decision:planning.non-functional-requirements' },
      ],
      persist: [
        { field: 'architecture_decisions', category: 'architecture', key: 'array' },
      ],
    },
    {
      name: 'architecture-step-2-decisions',
      taskType: 'arch-decisions',
      outputSchema: ArchContextOutputSchema,
      context: [
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
        { placeholder: 'starter_decisions', source: 'step:architecture-step-1-context' },
      ],
      persist: [
        { field: 'architecture_decisions', category: 'architecture', key: 'array' },
      ],
    },
    {
      name: 'architecture-step-3-patterns',
      taskType: 'arch-patterns',
      outputSchema: ArchContextOutputSchema,
      context: [
        { placeholder: 'architecture_decisions', source: 'decision:solutioning.architecture' },
      ],
      persist: [
        { field: 'architecture_decisions', category: 'architecture', key: 'array' },
      ],
      registerArtifact: {
        type: 'architecture',
        path: 'decision-store://solutioning/architecture',
        summarize: (parsed) => {
          const decisions = parsed.architecture_decisions as unknown[] | undefined
          return `${decisions?.length ?? 0} pattern decisions (multi-step)`
        },
      },
    },
  ]
}

/**
 * Run architecture generation using multi-step decomposition (3 steps).
 */
async function runArchitectureGenerationMultiStep(
  deps: PhaseDeps,
  params: SolutioningPhaseParams,
): Promise<ArchitectureGenerationSuccess | ArchitectureGenerationFailure> {
  const steps = buildArchitectureSteps()
  const result = await runSteps(steps, deps, params.runId, 'solutioning', {})

  if (!result.success) {
    return {
      error: result.error ?? 'multi_step_arch_failed',
      tokenUsage: result.tokenUsage,
    }
  }

  // Collect all architecture decisions from the decision store (accumulated across steps)
  const allDecisions = getDecisionsByPhaseForRun(deps.db, params.runId, 'solutioning')
    .filter((d) => d.category === 'architecture')

  const decisions: ArchitectureDecision[] = allDecisions.map((d) => {
    // Each decision was persisted as JSON; try to parse for structured fields
    try {
      const parsed = JSON.parse(d.value) as Partial<ArchitectureDecision>
      return {
        category: parsed.category ?? d.category,
        key: parsed.key ?? d.key,
        value: parsed.value ?? d.value,
        rationale: parsed.rationale ?? d.rationale ?? '',
      }
    } catch {
      return {
        category: d.category,
        key: d.key,
        value: d.value,
        rationale: d.rationale ?? '',
      }
    }
  })

  const artifactId = result.steps[result.steps.length - 1]?.artifactId ?? ''

  return {
    decisions,
    artifactId,
    tokenUsage: result.tokenUsage,
  }
}

// ---------------------------------------------------------------------------
// Multi-step story generation
// ---------------------------------------------------------------------------

/**
 * Build step definitions for 2-step story decomposition.
 */
function buildStorySteps(): StepDefinition[] {
  return [
    {
      name: 'stories-step-1-epics',
      taskType: 'story-epics',
      outputSchema: EpicDesignOutputSchema,
      context: [
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
        { placeholder: 'architecture_decisions', source: 'decision:solutioning.architecture' },
      ],
      persist: [
        { field: 'epics', category: 'epic-design', key: 'array' },
      ],
    },
    {
      name: 'stories-step-2-stories',
      taskType: 'story-stories',
      outputSchema: StoryGenerationOutputSchema,
      context: [
        { placeholder: 'epic_structure', source: 'step:stories-step-1-epics' },
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
        { placeholder: 'architecture_decisions', source: 'decision:solutioning.architecture' },
      ],
      persist: [], // Story persistence handled inline below (matches existing pattern)
      registerArtifact: {
        type: 'stories',
        path: 'decision-store://solutioning/stories',
        summarize: (parsed) => {
          const epics = parsed.epics as EpicDefinition[] | undefined
          const totalStories = epics?.reduce((sum, e) => sum + (e.stories?.length ?? 0), 0) ?? 0
          return `${epics?.length ?? 0} epics, ${totalStories} stories (multi-step)`
        },
      },
    },
  ]
}

/**
 * Run story generation using multi-step decomposition (2 steps).
 */
async function runStoryGenerationMultiStep(
  deps: PhaseDeps,
  params: SolutioningPhaseParams,
): Promise<StoryGenerationSuccess | StoryGenerationFailure> {
  const steps = buildStorySteps()
  const result = await runSteps(steps, deps, params.runId, 'solutioning', {})

  if (!result.success) {
    return {
      error: result.error ?? 'multi_step_story_failed',
      tokenUsage: result.tokenUsage,
    }
  }

  const storyStep = result.steps.find((s) => s.name === 'stories-step-2-stories')
  const storyOutput = storyStep?.parsed
  if (!storyOutput || !storyOutput.epics) {
    return {
      error: 'Story generation step produced no epics',
      tokenUsage: result.tokenUsage,
    }
  }

  const epics = storyOutput.epics as EpicDefinition[]

  // Persist epics and stories (same logic as single-dispatch path)
  for (const [epicIndex, epic] of epics.entries()) {
    upsertDecision(deps.db, {
      pipeline_run_id: params.runId,
      phase: 'solutioning',
      category: 'epics',
      key: `epic-${epicIndex + 1}`,
      value: JSON.stringify({ title: epic.title, description: epic.description }),
    })

    for (const story of epic.stories) {
      upsertDecision(deps.db, {
        pipeline_run_id: params.runId,
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

  // Create Requirement records for each story
  for (const epic of epics) {
    for (const story of epic.stories) {
      createRequirement(deps.db, {
        pipeline_run_id: params.runId,
        source: 'solutioning-phase',
        type: 'functional',
        description: `${story.key}: ${story.title}: ${story.description}`,
        priority: story.priority,
      })
    }
  }

  const artifactId = storyStep?.artifactId ?? ''

  return {
    epics,
    artifactId,
    tokenUsage: result.tokenUsage,
  }
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
    // Determine if multi-step mode is available
    const solutioningPhase = deps.pack.manifest.phases?.find((p) => p.name === 'solutioning')
    const hasSteps = solutioningPhase?.steps && solutioningPhase.steps.length > 0 && !params.amendmentContext

    // Step 1: Check if architecture artifact already exists (skip on retry)
    const existingArchArtifact = getArtifactByTypeForRun(deps.db, params.runId, 'solutioning', 'architecture')
    let archResult: ArchitectureGenerationSuccess | ArchitectureGenerationFailure

    if (existingArchArtifact) {
      // Architecture already completed — reuse existing decisions
      const existingDecisions = getDecisionsByPhaseForRun(deps.db, params.runId, 'solutioning')
        .filter((d) => d.category === 'architecture')
      logger.info(
        { runId: params.runId, artifactId: existingArchArtifact.id, decisionCount: existingDecisions.length },
        'Architecture artifact already exists — skipping architecture sub-phase, transitioning to story generation',
      )
      archResult = {
        decisions: existingDecisions.map((d) => ({
          category: d.category,
          key: d.key,
          value: d.value,
          rationale: d.rationale ?? '',
        })),
        artifactId: existingArchArtifact.id,
        tokenUsage: { input: 0, output: 0 },
      }
    } else if (hasSteps) {
      archResult = await runArchitectureGenerationMultiStep(deps, params)
    } else {
      archResult = await runArchitectureGeneration(deps, params)
    }

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

    // Step 3: Architecture→Story Generation transition
    logger.info(
      { runId: params.runId, decisionCount: archResult.decisions.length, mode: hasSteps ? 'multi-step' : 'single-dispatch' },
      'Architecture sub-phase complete — transitioning to story generation',
    )

    const storyResult = hasSteps
      ? await runStoryGenerationMultiStep(deps, params)
      : await runStoryGeneration(deps, params)

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

    // Step 5: Run adversarial readiness check (sub-agent dispatch, not keyword matching)
    const readinessResult = await runReadinessCheck(deps, params.runId)

    // Accumulate token usage from readiness check
    totalInput += readinessResult.tokenUsage.input
    totalOutput += readinessResult.tokenUsage.output

    // Step 5a: Handle readiness agent error
    if (readinessResult.verdict === 'error') {
      logger.error({ runId: params.runId, error: readinessResult.error }, 'Readiness check agent failed')
      return {
        result: 'failed',
        error: 'readiness_check_error',
        details: readinessResult.error,
        readiness_passed: false,
        artifact_ids: [archResult.artifactId, storyResult.artifactId],
        tokenUsage: { input: totalInput, output: totalOutput },
      }
    }

    logger.info(
      { runId: params.runId, verdict: readinessResult.verdict, coverageScore: readinessResult.coverageScore, findingCount: readinessResult.findings.length },
      'Readiness check verdict received',
    )

    // Step 5b: NOT_READY — fail immediately (AC7)
    if (readinessResult.verdict === 'NOT_READY') {
      const blockers = readinessResult.findings.filter((f) => f.severity === 'blocker')
      const majorFindings = readinessResult.findings.filter((f) => f.severity === 'major')

      // Store findings in decision store (AC7)
      for (const [i, finding] of readinessResult.findings.entries()) {
        upsertDecision(deps.db, {
          pipeline_run_id: params.runId,
          phase: 'solutioning',
          category: 'readiness-findings',
          key: `finding-${i + 1}`,
          value: JSON.stringify(finding),
        })
      }

      // Emit detailed failure report via event bus (AC7)
      logger.error(
        {
          runId: params.runId,
          verdict: 'NOT_READY',
          coverageScore: readinessResult.coverageScore,
          blockers: blockers.length,
          major: majorFindings.length,
          findings: readinessResult.findings,
        },
        'Readiness check returned NOT_READY — solutioning phase failed',
      )

      // Emit typed events via event bus (T9, AC7)
      if (deps.eventBus) {
        deps.eventBus.emit('solutioning:readiness-check', {
          runId: params.runId,
          verdict: 'NOT_READY',
          coverageScore: readinessResult.coverageScore,
          findingCount: readinessResult.findings.length,
          blockerCount: blockers.length,
        })
        deps.eventBus.emit('solutioning:readiness-failed', {
          runId: params.runId,
          verdict: 'NOT_READY',
          coverageScore: readinessResult.coverageScore,
          findings: readinessResult.findings.map((f) => ({
            category: f.category,
            severity: f.severity,
            description: f.description,
            affected_items: f.affected_items,
          })),
        })
      }

      return {
        result: 'failed',
        error: 'readiness_not_ready',
        details: `Readiness check returned NOT_READY: ${blockers.length} blockers, coverage score ${readinessResult.coverageScore}%`,
        readiness_passed: false,
        gaps: readinessResult.findings.filter((f) => f.category === 'fr_coverage').map((f) => f.description),
        artifact_ids: [archResult.artifactId, storyResult.artifactId],
        tokenUsage: { input: totalInput, output: totalOutput },
      }
    }

    // Step 5c: NEEDS_WORK with blocker findings — retry story generation with gap analysis (AC6)
    if (readinessResult.verdict === 'NEEDS_WORK') {
      const blockers = readinessResult.findings.filter((f) => f.severity === 'blocker')

      if (blockers.length > 0) {
        // Store NEEDS_WORK findings in decision store (T8)
        for (const [i, finding] of readinessResult.findings.entries()) {
          upsertDecision(deps.db, {
            pipeline_run_id: params.runId,
            phase: 'solutioning',
            category: 'readiness-findings',
            key: `finding-${i + 1}`,
            value: JSON.stringify(finding),
          })
        }

        // Emit event for NEEDS_WORK verdict (T9)
        if (deps.eventBus) {
          deps.eventBus.emit('solutioning:readiness-check', {
            runId: params.runId,
            verdict: 'NEEDS_WORK',
            coverageScore: readinessResult.coverageScore,
            findingCount: readinessResult.findings.length,
            blockerCount: blockers.length,
          })
        }

        // Format gap analysis from blocker findings (AC6)
        const gapAnalysis = [
          '## Gap Analysis: Readiness Check Blocker Findings',
          'The readiness check identified the following blocker issues that must be addressed:',
          '',
          ...blockers.map((f) => [
            `### [${f.category.toUpperCase()}] ${f.description}`,
            f.affected_items.length > 0 ? `Affected: ${f.affected_items.join(', ')}` : '',
          ].filter(Boolean).join('\n')),
          '',
          'Please generate additional or revised stories to specifically address each blocker above.',
        ].join('\n')

        logger.info(
          { runId: params.runId, blockerCount: blockers.length },
          'Readiness NEEDS_WORK with blockers — retrying story generation with gap analysis',
        )

        // Re-dispatch story generation with gap analysis (AC6)
        const retryResult = await runStoryGeneration(deps, params, gapAnalysis)

        // Accumulate token usage from retry
        totalInput += retryResult.tokenUsage.input
        totalOutput += retryResult.tokenUsage.output

        if ('error' in retryResult) {
          return {
            result: 'failed',
            error: 'story_generation_retry_failed',
            details: retryResult.error,
            readiness_passed: false,
            gaps: blockers.map((f) => f.description),
            artifact_ids: [archResult.artifactId, storyResult.artifactId],
            tokenUsage: { input: totalInput, output: totalOutput },
          }
        }

        // Re-check readiness after retry (max 1 retry, 2 total checks per AC6)
        const retryReadiness = await runReadinessCheck(deps, params.runId)

        // Accumulate token usage from retry readiness check
        totalInput += retryReadiness.tokenUsage.input
        totalOutput += retryReadiness.tokenUsage.output

        if (retryReadiness.verdict === 'error') {
          return {
            result: 'failed',
            error: 'readiness_check_error',
            details: retryReadiness.error,
            readiness_passed: false,
            artifact_ids: [archResult.artifactId, storyResult.artifactId, retryResult.artifactId],
            tokenUsage: { input: totalInput, output: totalOutput },
          }
        }

        if (retryReadiness.verdict === 'NOT_READY' || retryReadiness.verdict === 'NEEDS_WORK') {
          // Still not READY after retry — fail (AC6)
          const retryBlockers = retryReadiness.findings.filter((f) => f.severity === 'blocker')

          logger.error(
            { runId: params.runId, verdict: retryReadiness.verdict, retryBlockers: retryBlockers.length },
            'Readiness check failed after maximum retries',
          )

          return {
            result: 'failed',
            error: 'readiness_check_failed',
            details: `Readiness check failed after maximum retries: verdict=${retryReadiness.verdict}, coverage=${retryReadiness.coverageScore}%`,
            readiness_passed: false,
            gaps: retryReadiness.findings
              .filter((f) => f.category === 'fr_coverage')
              .map((f) => f.description),
            artifact_ids: [archResult.artifactId, storyResult.artifactId, retryResult.artifactId],
            tokenUsage: { input: totalInput, output: totalOutput },
          }
        }

        // Retry succeeded — READY after gap analysis retry
        const retryStories = retryResult.epics.reduce(
          (sum, epic) => sum + epic.stories.length,
          0,
        )

        // Log any remaining minor findings as warnings (AC8)
        const minorFindings = retryReadiness.findings.filter((f) => f.severity === 'minor')
        if (minorFindings.length > 0) {
          logger.warn({ runId: params.runId, minorFindings }, 'Readiness READY with minor findings after retry')
        }

        // Emit READY event after successful retry (AC8, T9 — observability for event bus consumers)
        if (deps.eventBus) {
          deps.eventBus.emit('solutioning:readiness-check', {
            runId: params.runId,
            verdict: 'READY',
            coverageScore: retryReadiness.coverageScore,
            findingCount: retryReadiness.findings.length,
            blockerCount: 0,
          })
        }

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

      // NEEDS_WORK but no blockers — only major/minor findings, proceed with warnings
      const majorFindings = readinessResult.findings.filter((f) => f.severity === 'major')
      logger.warn(
        { runId: params.runId, majorCount: majorFindings.length, findings: readinessResult.findings },
        'Readiness NEEDS_WORK (no blockers) — proceeding with warnings',
      )

      // Emit event for NEEDS_WORK-no-blockers verdict (T9)
      if (deps.eventBus) {
        deps.eventBus.emit('solutioning:readiness-check', {
          runId: params.runId,
          verdict: 'NEEDS_WORK',
          coverageScore: readinessResult.coverageScore,
          findingCount: readinessResult.findings.length,
          blockerCount: 0,
        })
      }
    }

    // Step 5d: READY or NEEDS_WORK without blockers — gate satisfied (AC8)
    // Log minor findings as warnings
    const minorFindings = readinessResult.findings.filter((f) => f.severity === 'minor')
    if (minorFindings.length > 0) {
      const verdictLabel = readinessResult.verdict === 'READY' ? 'READY' : 'NEEDS_WORK (no blockers)'
      logger.warn({ runId: params.runId, verdict: readinessResult.verdict, minorFindings }, `Readiness ${verdictLabel} with minor findings — proceeding`)
    }

    // Emit READY event via event bus (T9, AC8)
    if (readinessResult.verdict === 'READY' && deps.eventBus) {
      deps.eventBus.emit('solutioning:readiness-check', {
        runId: params.runId,
        verdict: 'READY',
        coverageScore: readinessResult.coverageScore,
        findingCount: readinessResult.findings.length,
        blockerCount: 0,
      })
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
