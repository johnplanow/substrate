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
  getPipelineRunById,
  registerArtifact,
} from '../../../persistence/queries/decisions.js'
import { runSteps, resolveContext, formatDecisionsForInjection } from '../step-runner.js'
import type { StepDefinition } from '../step-runner.js'
import { createLogger } from '../../../utils/logger.js'

const logger = createLogger('planning-phase')
import {
  PlanningOutputSchema,
  PlanningClassificationOutputSchema,
  PlanningFRsOutputSchema,
  PlanningNFRsOutputSchema,
} from './schemas.js'
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
  'technology_constraints',
] as const

// ---------------------------------------------------------------------------
// Tech stack constraint validation
// ---------------------------------------------------------------------------

/** Keywords indicating JavaScript/TypeScript/Node.js ecosystem */
const JS_TS_PATTERN =
  /\b(TypeScript|JavaScript|Node\.js|NestJS|Express|Fastify|Hapi|Koa|Next\.js.*backend|Next\.js.*API|Deno|Bun)\b/i

/** Keywords indicating non-JS backend languages that satisfy high-concurrency constraints */
const COMPLIANT_LANG_PATTERN =
  /\b(Kotlin|JVM|Java|Go\b|Golang|Rust|C#|\.NET|Scala|Erlang|Elixir)\b/i

/**
 * Check whether the tech stack's language/framework fields violate technology
 * constraints that exclude JavaScript/Node.js from backend services.
 *
 * @returns A violation message if detected, or null if compliant.
 */
function detectTechStackViolation(
  techStack: Record<string, string>,
  technologyConstraints: Array<{ key: string; value: string }>
): string | null {
  // Check if any technology constraint discourages/excludes JS/Node
  const constraintsText = technologyConstraints.map((c) => c.value).join(' ')
  const excludesJS =
    /\b(excluded|not.*right choice|not.*recommended|avoid|do not use|prohibited)\b/i.test(
      constraintsText
    ) && /\b(JavaScript|Node\.js|TypeScript)\b/i.test(constraintsText)
  const prefersNonJS =
    COMPLIANT_LANG_PATTERN.test(constraintsText) &&
    /\b(prefer|must|required|evaluate|choose)\b/i.test(constraintsText)

  if (!excludesJS && !prefersNonJS) return null // No relevant constraint

  // Check the language and framework fields for JS/TS
  const langValue = techStack['language'] ?? ''
  const frameworkValue = techStack['framework'] ?? techStack['backend_framework'] ?? ''

  if (JS_TS_PATTERN.test(langValue) || JS_TS_PATTERN.test(frameworkValue)) {
    return (
      `Tech stack violates technology constraints: language="${langValue}", framework="${frameworkValue}". ` +
      `Constraints specify: ${constraintsText.substring(0, 200)}`
    )
  }

  return null
}

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
function formatProductBriefFromDecisions(decisions: Array<{ key: string; value: string }>): string {
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
// Multi-step planning definitions
// ---------------------------------------------------------------------------

/**
 * Build step definitions for 3-step planning decomposition.
 */
function buildPlanningSteps(): StepDefinition[] {
  return [
    {
      name: 'planning-step-1-classification',
      taskType: 'planning-classification',
      outputSchema: PlanningClassificationOutputSchema,
      context: [{ placeholder: 'product_brief', source: 'decision:analysis.product-brief' }],
      persist: [
        { field: 'project_type', category: 'classification', key: 'project_type' },
        { field: 'vision', category: 'classification', key: 'vision' },
        { field: 'key_goals', category: 'classification', key: 'key_goals' },
      ],
    },
    {
      name: 'planning-step-2-frs',
      taskType: 'planning-frs',
      outputSchema: PlanningFRsOutputSchema,
      context: [
        { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
        { placeholder: 'classification', source: 'step:planning-step-1-classification' },
      ],
      persist: [
        { field: 'functional_requirements', category: 'functional-requirements', key: 'array' },
        { field: 'user_stories', category: 'user-stories', key: 'array' },
      ],
    },
    {
      name: 'planning-step-3-nfrs',
      taskType: 'planning-nfrs',
      outputSchema: PlanningNFRsOutputSchema,
      context: [
        { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
        { placeholder: 'classification', source: 'step:planning-step-1-classification' },
        { placeholder: 'functional_requirements', source: 'step:planning-step-2-frs' },
        {
          placeholder: 'technology_constraints',
          source: 'decision:analysis.technology-constraints',
        },
        { placeholder: 'concept', source: 'param:concept' },
      ],
      persist: [
        {
          field: 'non_functional_requirements',
          category: 'non-functional-requirements',
          key: 'array',
        },
        { field: 'tech_stack', category: 'tech-stack', key: 'tech_stack' },
        { field: 'domain_model', category: 'domain-model', key: 'entities' },
        { field: 'out_of_scope', category: 'out-of-scope', key: 'items' },
      ],
      registerArtifact: {
        type: 'prd',
        path: 'decision-store://planning/prd',
        summarize: (parsed) => {
          const nfrs = parsed.non_functional_requirements as unknown[] | undefined
          return `Planning complete: ${nfrs?.length ?? 0} NFRs, tech stack defined`
        },
      },
    },
  ]
}

/**
 * Run planning phase using multi-step decomposition (3 steps).
 */
async function runPlanningMultiStep(
  deps: PhaseDeps,
  params: PlanningPhaseParams
): Promise<PlanningResult> {
  const { db, runId } = { db: deps.db, runId: params.runId }
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    // Verify product brief exists
    const allAnalysisDecisions = await getDecisionsByPhaseForRun(db, runId, 'analysis')
    const productBriefDecisions = allAnalysisDecisions.filter((d) => d.category === 'product-brief')
    if (productBriefDecisions.length === 0) {
      return {
        result: 'failed',
        error: 'missing_product_brief',
        details: 'No product brief decisions found in the analysis phase.',
        tokenUsage: zeroTokenUsage,
      }
    }

    // Retrieve original concept from pipeline run config_json so planning step 3
    // can see the user's unfiltered technology constraint language.
    let concept = ''
    const run = await getPipelineRunById(db, runId)
    if (run?.config_json) {
      try {
        const config = JSON.parse(run.config_json) as { concept?: string }
        concept = config.concept ?? ''
      } catch {
        /* ignore parse errors */
      }
    }

    const steps = buildPlanningSteps()
    const result = await runSteps(steps, deps, params.runId, 'planning', { concept })

    if (!result.success) {
      return {
        result: 'failed',
        error: result.error ?? 'multi_step_failed',
        details: result.error ?? 'Multi-step planning failed',
        tokenUsage: result.tokenUsage,
      }
    }

    // Extract outputs from steps
    const frsOutput = result.steps[1]?.parsed
    let nfrsOutput = result.steps[2]?.parsed
    let totalTokenUsage = { ...result.tokenUsage }

    if (!frsOutput || !nfrsOutput) {
      return {
        result: 'failed',
        error: 'incomplete_steps',
        details: 'Not all planning steps produced output',
        tokenUsage: result.tokenUsage,
      }
    }

    // Validate tech stack against technology constraints — retry step 3 once if violated
    const techStack = nfrsOutput.tech_stack as Record<string, string> | undefined
    if (techStack) {
      const techConstraintDecisions = allAnalysisDecisions.filter(
        (d) => d.category === 'technology-constraints'
      )
      const violation = detectTechStackViolation(techStack, techConstraintDecisions)

      if (violation) {
        logger.warn(
          { violation },
          'Tech stack constraint violation detected — retrying step 3 with correction'
        )

        // Build a corrected prompt: prepend the violation as feedback
        const correctionPrefix =
          `CRITICAL CORRECTION: Your previous output was rejected because it violates the stated technology constraints.\n\n` +
          `Violation: ${violation}\n\n` +
          `You MUST NOT use TypeScript, JavaScript, or Node.js for ANY backend service. ` +
          `Choose from Go, Kotlin/JVM, or Rust as stated in the technology constraints.\n\n` +
          `Re-generate your output with a compliant tech stack. Everything else (NFRs, domain model, out-of-scope) can remain the same.\n\n---\n\n`

        // Re-dispatch step 3 with correction prefix
        const step3Template = await deps.pack.getPrompt('planning-step-3-nfrs')

        // Resolve the same context refs as the original step 3
        const stepOutputs = new Map<string, Record<string, unknown>>()
        stepOutputs.set('planning-step-1-classification', result.steps[0]?.parsed ?? {})
        stepOutputs.set('planning-step-2-frs', frsOutput)

        let correctedPrompt = step3Template
        const step3Def = steps[2]
        for (const ref of step3Def?.context ?? []) {
          const value = await resolveContext(ref, deps, runId, { concept }, stepOutputs)
          correctedPrompt = correctedPrompt.replace(`{{${ref.placeholder}}}`, value)
        }
        correctedPrompt = correctionPrefix + correctedPrompt

        const retryHandle = deps.dispatcher.dispatch({
          prompt: correctedPrompt,
          agent: deps.agentId ?? 'claude-code',
          taskType: 'planning-nfrs',
          outputSchema: PlanningNFRsOutputSchema,
        })
        const retryResult = await retryHandle.result
        totalTokenUsage.input += retryResult.tokenEstimate.input
        totalTokenUsage.output += retryResult.tokenEstimate.output

        if (
          retryResult.status === 'completed' &&
          retryResult.parsed !== null &&
          (retryResult.parsed as Record<string, unknown>).result !== 'failed'
        ) {
          const retryParsed = retryResult.parsed as Record<string, unknown>
          const retryTechStack = retryParsed.tech_stack as Record<string, string> | undefined
          const retryViolation = retryTechStack
            ? detectTechStackViolation(retryTechStack, techConstraintDecisions)
            : null

          if (!retryViolation) {
            logger.info('Retry produced compliant tech stack — using corrected output')
            nfrsOutput = retryParsed
          } else {
            logger.warn(
              { retryViolation },
              'Retry still violates constraints — using original output'
            )
          }
        } else {
          logger.warn('Retry dispatch failed — using original output')
        }
      }
    }

    const frs = frsOutput.functional_requirements as FunctionalRequirement[] | undefined
    const nfrs = nfrsOutput.non_functional_requirements as NonFunctionalRequirement[] | undefined
    const userStories = frsOutput.user_stories as
      | Array<{ title: string; description: string }>
      | undefined

    if (!frs?.length) {
      return {
        result: 'failed',
        error: 'missing_functional_requirements',
        details: 'FRs step did not return functional_requirements',
        tokenUsage: totalTokenUsage,
      }
    }

    if (!nfrs?.length) {
      return {
        result: 'failed',
        error: 'missing_non_functional_requirements',
        details: 'NFRs step did not return non_functional_requirements',
        tokenUsage: totalTokenUsage,
      }
    }

    // Create Requirement records for FRs
    for (const fr of frs) {
      await createRequirement(db, {
        pipeline_run_id: params.runId,
        source: 'planning-phase',
        type: 'functional',
        description: fr.description,
        priority: fr.priority,
      })
    }

    // Create Requirement records for NFRs
    for (const nfr of nfrs) {
      await createRequirement(db, {
        pipeline_run_id: params.runId,
        source: 'planning-phase',
        type: 'non_functional',
        description: nfr.description,
        priority: 'should',
      })
    }

    const requirementsCount = frs.length + nfrs.length
    const userStoriesCount = userStories?.length ?? 0
    const planningResult: PlanningResult = {
      result: 'success',
      requirements_count: requirementsCount,
      user_stories_count: userStoriesCount,
      tokenUsage: totalTokenUsage,
    }
    const artifactId = result.steps[2]?.artifactId
    if (artifactId !== undefined) {
      planningResult.artifact_id = artifactId
    }
    return planningResult
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      result: 'failed',
      error: message,
      tokenUsage: zeroTokenUsage,
    }
  }
}

// ---------------------------------------------------------------------------
// runPlanningPhase
// ---------------------------------------------------------------------------

/**
 * Execute the planning phase of the BMAD pipeline.
 *
 * If the manifest defines steps for the planning phase, uses multi-step
 * decomposition. Otherwise falls back to the single-dispatch code path.
 *
 * @param deps - Shared phase dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Phase parameters (runId)
 * @returns PlanningResult with success/failure status and token usage
 */
export async function runPlanningPhase(
  deps: PhaseDeps,
  params: PlanningPhaseParams
): Promise<PlanningResult> {
  const { db, pack, dispatcher } = deps
  const { runId, amendmentContext } = params

  // Check if manifest defines steps for the planning phase → use multi-step path
  const planningPhase = pack.manifest.phases?.find((p) => p.name === 'planning')
  if (planningPhase?.steps && planningPhase.steps.length > 0 && !amendmentContext) {
    return runPlanningMultiStep(deps, params)
  }

  // Zero token usage as default for error paths
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    // Step 1: Retrieve compiled planning prompt template
    const template = await pack.getPrompt('planning')

    // Step 2: Get product brief decisions from analysis phase (scoped to current run)
    const allAnalysisDecisions = await getDecisionsByPhaseForRun(db, runId, 'analysis')
    const productBriefDecisions = allAnalysisDecisions.filter((d) => d.category === 'product-brief')

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
      const availableForContext =
        MAX_PROMPT_CHARS - prompt.length - framingLen - TRUNCATED_MARKER.length

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
        (d) => d.key !== 'constraints' && d.key !== 'out_of_scope'
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
      agent: deps.agentId ?? 'claude-code',
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
    for (let index = 0; index < output.functional_requirements.length; index++) {
      const fr = output.functional_requirements[index]!
      await createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: `FR-${index}`,
        value: JSON.stringify(fr),
      })
    }

    // Step 10: Store non-functional requirements as decisions
    for (let index = 0; index < output.non_functional_requirements.length; index++) {
      const nfr = output.non_functional_requirements[index]!
      await createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'non-functional-requirements',
        key: `NFR-${index}`,
        value: JSON.stringify(nfr),
      })
    }

    // Step 11: Store user stories as decisions
    for (let index = 0; index < output.user_stories.length; index++) {
      const us = output.user_stories[index]!
      await createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'user-stories',
        key: `US-${index}`,
        value: JSON.stringify(us),
      })
    }

    // Step 12: Store tech stack as decisions (one per key)
    for (const [techKey, techValue] of Object.entries(output.tech_stack)) {
      await createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'tech-stack',
        key: techKey,
        value: techValue,
      })
    }

    // Step 13: Store domain model as a single decision
    await createDecision(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'domain-model',
      key: 'entities',
      value: JSON.stringify(output.domain_model),
    })

    // Step 14: Store out_of_scope as a single decision (if any)
    if (output.out_of_scope.length > 0) {
      await createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'out-of-scope',
        key: 'items',
        value: JSON.stringify(output.out_of_scope),
      })
    }

    // Step 15: Create Requirement records for functional requirements
    for (const fr of output.functional_requirements) {
      await createRequirement(db, {
        pipeline_run_id: runId,
        source: 'planning-phase',
        type: 'functional',
        description: fr.description,
        priority: fr.priority,
      })
    }

    // Step 16: Create Requirement records for non-functional requirements
    for (const nfr of output.non_functional_requirements) {
      await createRequirement(db, {
        pipeline_run_id: runId,
        source: 'planning-phase',
        type: 'non_functional',
        description: nfr.description,
        priority: 'should',
      })
    }

    // Step 17: Register prd artifact
    const requirementsCount =
      output.functional_requirements.length + output.non_functional_requirements.length
    const userStoriesCount = output.user_stories.length
    const summary = `${output.functional_requirements.length} FRs, ${output.non_functional_requirements.length} NFRs, ${userStoriesCount} user stories`

    const artifact = await registerArtifact(db, {
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
