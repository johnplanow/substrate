/**
 * Planning phase implementation for the Phase Orchestrator pipeline.
 *
 * Implements `runPlanningPhase()` which:
 *  1. Retrieves the compiled planning prompt template from the methodology pack
 *  2. Formats the product brief from the decision store (analysis phase output)
 *  3. Injects the product brief into the {{product_brief}} placeholder
 *  4. Validates token budget compliance (<= 3,500 tokens)
 *  5. Dispatches to a claude-code agent via the Dispatcher
 *  6. Parses and validates the YAML output via PlanningOutputSchema
 *  7. Stores functional/non-functional requirements, tech stack, user stories, domain model, out_of_scope as decisions
 *  8. Creates Requirement records for functional and non-functional requirements
 *  9. Registers a prd artifact in the decision store
 * 10. Returns a typed PlanningResult
 */

import {
  createDecision,
  createRequirement,
  getDecisionsByPhaseForRun,
  registerArtifact,
} from '../../../persistence/queries/decisions.js'
import { PlanningOutputSchema } from './schemas.js'
import type {
  FunctionalRequirement,
  NonFunctionalRequirement,
  PhaseDeps,
  PlanningOutput,
  PlanningPhaseParams,
  PlanningResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total prompt length in tokens (3,500 tokens × 4 chars/token = 14,000 chars) */
const MAX_PROMPT_TOKENS = 3_500
const MAX_PROMPT_CHARS = MAX_PROMPT_TOKENS * 4

/** Product brief placeholder in the prompt template */
const PRODUCT_BRIEF_PLACEHOLDER = '{{product_brief}}'

/** Amendment context framing block prefix */
const AMENDMENT_CONTEXT_HEADER = '\n\n--- AMENDMENT CONTEXT (Parent Run Decisions) ---\n'

/** Amendment context framing block suffix */
const AMENDMENT_CONTEXT_FOOTER = '\n--- END AMENDMENT CONTEXT ---\n'

/** Marker appended when amendment context is truncated to fit token budget */
const TRUNCATED_MARKER = '\n[TRUNCATED]'

/** Product brief fields from analysis phase decisions */
const BRIEF_FIELDS = [
  'problem_statement',
  'target_users',
  'core_features',
  'success_metrics',
  'constraints',
] as const

// ---------------------------------------------------------------------------
// formatProductBrief
// ---------------------------------------------------------------------------

/**
 * Format product brief decisions from the analysis phase into markdown-like text
 * suitable for prompt injection.
 *
 * @param decisions - All decisions from the analysis phase with category='product-brief'
 * @returns Formatted product brief string for prompt injection
 */
function formatProductBriefFromDecisions(
  decisions: Array<{ key: string; value: string }>,
): string {
  const briefMap = Object.fromEntries(decisions.map((d) => [d.key, d.value]))

  const parts: string[] = ['## Product Brief']

  for (const field of BRIEF_FIELDS) {
    const rawValue = briefMap[field]
    if (rawValue === undefined) continue

    const fieldLabel = field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

    let displayValue: string
    try {
      const parsed = JSON.parse(rawValue)
      if (Array.isArray(parsed)) {
        displayValue = parsed.map((item: unknown) => `- ${String(item)}`).join('\n')
      } else {
        displayValue = String(parsed)
      }
    } catch {
      displayValue = rawValue
    }

    parts.push(`### ${fieldLabel}\n${displayValue}`)
  }

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// runPlanningPhase
// ---------------------------------------------------------------------------

/**
 * Execute the planning phase of the BMAD pipeline.
 *
 * Retrieves the compiled planning prompt, injects the product brief from the
 * analysis phase decision store, dispatches to a claude-code agent, validates
 * the output, creates requirement records, and persists planning decisions.
 *
 * @param deps - Shared phase dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Phase parameters (runId)
 * @returns PlanningResult with success/failure status and token usage
 */
export async function runPlanningPhase(
  deps: PhaseDeps,
  params: PlanningPhaseParams,
): Promise<PlanningResult> {
  const { db, pack, dispatcher } = deps
  const { runId, amendmentContext } = params

  // Zero token usage as default for error paths
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    // Step 1: Retrieve compiled planning prompt template
    const template = await pack.getPrompt('planning')

    // Step 2: Get product brief decisions from analysis phase (scoped to current run)
    const allAnalysisDecisions = getDecisionsByPhaseForRun(db, runId, 'analysis')
    const productBriefDecisions = allAnalysisDecisions.filter(
      (d) => d.category === 'product-brief',
    )

    if (productBriefDecisions.length === 0) {
      return {
        result: 'failed',
        error: 'missing_product_brief',
        details:
          'No product brief decisions found in the analysis phase. The analysis phase must complete before planning can begin.',
        tokenUsage: zeroTokenUsage,
      }
    }

    // Step 3: Format product brief for injection
    const formattedBrief = formatProductBriefFromDecisions(productBriefDecisions)

    // Step 4: Replace {{product_brief}} placeholder in template
    let prompt = template.replace(PRODUCT_BRIEF_PLACEHOLDER, formattedBrief)

    // Step 4b: Inject amendment context if provided (AC2, AC3)
    if (amendmentContext !== undefined && amendmentContext !== '') {
      const framingLen = AMENDMENT_CONTEXT_HEADER.length + AMENDMENT_CONTEXT_FOOTER.length
      const availableForContext = MAX_PROMPT_CHARS - prompt.length - framingLen - TRUNCATED_MARKER.length

      let contextToInject = amendmentContext
      if (availableForContext <= 0) {
        // No room for any context — skip injection to avoid prompt_too_long
        contextToInject = ''
      } else if (amendmentContext.length > availableForContext) {
        // Truncate context to fit within budget
        contextToInject = amendmentContext.slice(0, availableForContext) + TRUNCATED_MARKER
      }

      if (contextToInject !== '') {
        prompt += AMENDMENT_CONTEXT_HEADER + contextToInject + AMENDMENT_CONTEXT_FOOTER
      }
    }

    // Step 5: Validate total prompt token count <= 3,500 (chars/4 heuristic)
    // If over budget, summarize constraints and out_of_scope fields
    if (prompt.length > MAX_PROMPT_CHARS) {
      // Try to fit within budget by using a condensed brief (skip constraints and out_of_scope)
      const condensedDecisions = productBriefDecisions.filter(
        (d) => d.key !== 'constraints' && d.key !== 'out_of_scope',
      )
      const condensedBrief = formatProductBriefFromDecisions(condensedDecisions)
      prompt = template.replace(PRODUCT_BRIEF_PLACEHOLDER, condensedBrief)
    }

    const estimatedTokens = Math.ceil(prompt.length / 4)
    if (estimatedTokens > MAX_PROMPT_TOKENS) {
      return {
        result: 'failed',
        error: `prompt_too_long`,
        details: `Assembled prompt exceeds token budget: ${estimatedTokens} tokens (max ${MAX_PROMPT_TOKENS})`,
        tokenUsage: zeroTokenUsage,
      }
    }

    // Step 6: Dispatch to claude-code agent
    const handle = dispatcher.dispatch({
      prompt,
      agent: 'claude-code',
      taskType: 'planning',
      outputSchema: PlanningOutputSchema,
    })

    // Step 7: Await dispatch result
    const dispatchResult = await handle.result

    // Build token usage from dispatch result
    const tokenUsage = {
      input: dispatchResult.tokenEstimate.input,
      output: dispatchResult.tokenEstimate.output,
    }

    // Check dispatch status
    if (dispatchResult.status === 'timeout') {
      return {
        result: 'failed',
        error: 'dispatch_timeout',
        details: `Planning agent timed out after ${dispatchResult.durationMs}ms`,
        tokenUsage,
      }
    }

    if (dispatchResult.status === 'failed') {
      return {
        result: 'failed',
        error: 'dispatch_failed',
        details: dispatchResult.parseError ?? dispatchResult.output,
        tokenUsage,
      }
    }

    // Step 8: Validate and extract PlanningOutput from parsed result
    if (dispatchResult.parsed === null || dispatchResult.parseError !== null) {
      return {
        result: 'failed',
        error: 'schema_validation_failed',
        details: dispatchResult.parseError ?? 'No parsed output returned',
        tokenUsage,
      }
    }

    const parsed = dispatchResult.parsed as { result: string } & Partial<PlanningOutput>

    if (parsed.result === 'failed') {
      return {
        result: 'failed',
        error: 'agent_reported_failure',
        details: 'Agent returned result: failed',
        tokenUsage,
      }
    }

    if (
      !parsed.functional_requirements ||
      !parsed.non_functional_requirements ||
      !parsed.user_stories ||
      !parsed.tech_stack ||
      !parsed.domain_model
    ) {
      return {
        result: 'failed',
        error: 'schema_validation_failed',
        details: 'Planning output missing required fields',
        tokenUsage,
      }
    }

    const output: PlanningOutput = {
      functional_requirements: parsed.functional_requirements,
      non_functional_requirements: parsed.non_functional_requirements,
      user_stories: parsed.user_stories,
      tech_stack: parsed.tech_stack,
      domain_model: parsed.domain_model,
      out_of_scope: parsed.out_of_scope ?? [],
    }

    // Step 9: Store functional requirements as decisions
    output.functional_requirements.forEach((fr: FunctionalRequirement, index: number) => {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: `FR-${index}`,
        value: JSON.stringify(fr),
      })
    })

    // Step 10: Store non-functional requirements as decisions
    output.non_functional_requirements.forEach(
      (nfr: NonFunctionalRequirement, index: number) => {
        createDecision(db, {
          pipeline_run_id: runId,
          phase: 'planning',
          category: 'non-functional-requirements',
          key: `NFR-${index}`,
          value: JSON.stringify(nfr),
        })
      },
    )

    // Step 11: Store user stories as decisions
    output.user_stories.forEach((us, index: number) => {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'user-stories',
        key: `US-${index}`,
        value: JSON.stringify(us),
      })
    })

    // Step 12: Store tech stack as decisions (one per key)
    for (const [techKey, techValue] of Object.entries(output.tech_stack)) {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'tech-stack',
        key: techKey,
        value: techValue,
      })
    }

    // Step 13: Store domain model as a single decision
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'domain-model',
      key: 'entities',
      value: JSON.stringify(output.domain_model),
    })

    // Step 14: Store out_of_scope as a single decision (if any)
    if (output.out_of_scope.length > 0) {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'out-of-scope',
        key: 'items',
        value: JSON.stringify(output.out_of_scope),
      })
    }

    // Step 15: Create Requirement records for functional requirements
    output.functional_requirements.forEach((fr: FunctionalRequirement) => {
      createRequirement(db, {
        pipeline_run_id: runId,
        source: 'planning-phase',
        type: 'functional',
        description: fr.description,
        priority: fr.priority,
      })
    })

    // Step 16: Create Requirement records for non-functional requirements
    output.non_functional_requirements.forEach((nfr: NonFunctionalRequirement) => {
      createRequirement(db, {
        pipeline_run_id: runId,
        source: 'planning-phase',
        type: 'non_functional',
        description: nfr.description,
        priority: 'should',
      })
    })

    // Step 17: Register prd artifact
    const requirementsCount =
      output.functional_requirements.length + output.non_functional_requirements.length
    const userStoriesCount = output.user_stories.length
    const summary = `${output.functional_requirements.length} FRs, ${output.non_functional_requirements.length} NFRs, ${userStoriesCount} user stories`

    const artifact = registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      type: 'prd',
      path: 'decision-store://planning/prd',
      summary,
    })

    // Step 18: Return success result
    return {
      result: 'success',
      requirements_count: requirementsCount,
      user_stories_count: userStoriesCount,
      artifact_id: artifact.id,
      tokenUsage,
    }
  } catch (err) {
    // Step 19: On any unexpected failure, return error result
    const message = err instanceof Error ? err.message : String(err)
    return {
      result: 'failed',
      error: message,
      tokenUsage: zeroTokenUsage,
    }
  }
}
