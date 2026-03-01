/**
 * Analysis phase implementation for the Phase Orchestrator pipeline.
 *
 * Implements `runAnalysisPhase()` which:
 *  1. Retrieves the compiled analysis prompt template from the methodology pack
 *  2. Injects the user concept into the {{concept}} placeholder
 *  3. Validates token budget compliance
 *  4. Dispatches to a claude-code agent via the Dispatcher
 *  5. Parses and validates the YAML output via AnalysisOutputSchema
 *  6. Stores each product brief field as a decision record
 *  7. Registers a product-brief artifact in the decision store
 *  8. Returns a typed AnalysisResult
 */

import { createDecision, registerArtifact } from '../../../persistence/queries/decisions.js'
import { runSteps } from '../step-runner.js'
import type { StepDefinition } from '../step-runner.js'
import { AnalysisOutputSchema, AnalysisVisionOutputSchema, AnalysisScopeOutputSchema } from './schemas.js'
import type { AnalysisPhaseParams, AnalysisResult, PhaseDeps, ProductBrief } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concept length in tokens before truncation (500 tokens × 4 chars/token = 2000 chars) */
const MAX_CONCEPT_TOKENS = 500
const MAX_CONCEPT_CHARS = MAX_CONCEPT_TOKENS * 4

/** Maximum total prompt length in tokens (2,500 tokens × 4 chars/token = 10,000 chars) */
const MAX_PROMPT_TOKENS = 2_500

/** Amendment context framing block prefix */
const AMENDMENT_CONTEXT_HEADER = '\n\n--- AMENDMENT CONTEXT (Parent Run Decisions) ---\n'

/** Amendment context framing block suffix */
const AMENDMENT_CONTEXT_FOOTER = '\n--- END AMENDMENT CONTEXT ---\n'

/** Marker appended when amendment context is truncated to fit token budget */
const TRUNCATED_MARKER = '\n[TRUNCATED]'

/** Concept placeholder in the prompt template */
const CONCEPT_PLACEHOLDER = '{{concept}}'

/** Product brief fields to persist as decisions */
const BRIEF_FIELDS = [
  'problem_statement',
  'target_users',
  'core_features',
  'success_metrics',
  'constraints',
] as const

// ---------------------------------------------------------------------------
// Multi-step analysis definitions
// ---------------------------------------------------------------------------

/**
 * Build step definitions for 2-step analysis decomposition.
 */
function buildAnalysisSteps(): StepDefinition[] {
  return [
    {
      name: 'analysis-step-1-vision',
      taskType: 'analysis-vision',
      outputSchema: AnalysisVisionOutputSchema,
      context: [
        { placeholder: 'concept', source: 'param:concept' },
      ],
      persist: [
        { field: 'problem_statement', category: 'product-brief', key: 'problem_statement' },
        { field: 'target_users', category: 'product-brief', key: 'target_users' },
      ],
    },
    {
      name: 'analysis-step-2-scope',
      taskType: 'analysis-scope',
      outputSchema: AnalysisScopeOutputSchema,
      context: [
        { placeholder: 'concept', source: 'param:concept' },
        { placeholder: 'vision_output', source: 'step:analysis-step-1-vision' },
      ],
      persist: [
        { field: 'core_features', category: 'product-brief', key: 'core_features' },
        { field: 'success_metrics', category: 'product-brief', key: 'success_metrics' },
        { field: 'constraints', category: 'product-brief', key: 'constraints' },
      ],
      registerArtifact: {
        type: 'product-brief',
        path: 'decision-store://analysis/product-brief',
        summarize: (parsed) => {
          const features = parsed.core_features as string[] | undefined
          return features ? `${features.length} core features defined` : 'Product brief complete'
        },
      },
    },
  ]
}

/**
 * Run analysis phase using multi-step decomposition (2 steps).
 */
async function runAnalysisMultiStep(
  deps: PhaseDeps,
  params: AnalysisPhaseParams,
): Promise<AnalysisResult> {
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    // Truncate concept if needed
    let effectiveConcept = params.concept
    if (params.concept.length > MAX_CONCEPT_CHARS) {
      effectiveConcept = params.concept.slice(0, MAX_CONCEPT_CHARS) + '...'
    }

    const steps = buildAnalysisSteps()
    const result = await runSteps(steps, deps, params.runId, 'analysis', {
      concept: effectiveConcept,
    })

    if (!result.success) {
      return {
        result: 'failed',
        error: result.error ?? 'multi_step_failed',
        details: result.error ?? 'Multi-step analysis failed',
        tokenUsage: result.tokenUsage,
      }
    }

    // Reconstruct ProductBrief from step outputs
    const visionOutput = result.steps[0]?.parsed
    const scopeOutput = result.steps[1]?.parsed

    if (!visionOutput || !scopeOutput) {
      return {
        result: 'failed',
        error: 'incomplete_steps',
        details: 'Not all analysis steps produced output',
        tokenUsage: result.tokenUsage,
      }
    }

    const brief: ProductBrief = {
      problem_statement: visionOutput.problem_statement as string,
      target_users: visionOutput.target_users as string[],
      core_features: scopeOutput.core_features as string[],
      success_metrics: scopeOutput.success_metrics as string[],
      constraints: (scopeOutput.constraints as string[]) ?? [],
    }

    // The step runner already persisted individual fields and registered artifact
    const analysisResult: AnalysisResult = {
      result: 'success',
      product_brief: brief,
      tokenUsage: result.tokenUsage,
    }
    const artifactId = result.steps[1]?.artifactId
    if (artifactId !== undefined) {
      analysisResult.artifact_id = artifactId
    }
    return analysisResult
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
// runAnalysisPhase
// ---------------------------------------------------------------------------

/**
 * Execute the analysis phase of the BMAD pipeline.
 *
 * If the manifest defines steps for the analysis phase, uses multi-step
 * decomposition. Otherwise falls back to the single-dispatch code path.
 *
 * @param deps - Shared phase dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Phase parameters (runId, concept)
 * @returns AnalysisResult with success/failure status and token usage
 */
export async function runAnalysisPhase(
  deps: PhaseDeps,
  params: AnalysisPhaseParams,
): Promise<AnalysisResult> {
  const { db, pack, dispatcher } = deps
  const { runId, concept, amendmentContext } = params

  // Check if manifest defines steps for the analysis phase → use multi-step path
  const analysisPhase = pack.manifest.phases?.find((p) => p.name === 'analysis')
  if (analysisPhase?.steps && analysisPhase.steps.length > 0 && !amendmentContext) {
    return runAnalysisMultiStep(deps, params)
  }

  // Zero token usage as default for error paths
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    // Step 1: Retrieve compiled analysis prompt template
    const template = await pack.getPrompt('analysis')

    // Step 2: Truncate concept if over 500 tokens (2000 chars), append "..." if truncated
    let effectiveConcept = concept
    if (concept.length > MAX_CONCEPT_CHARS) {
      effectiveConcept = concept.slice(0, MAX_CONCEPT_CHARS) + '...'
    }

    // Step 3: Replace {{concept}} placeholder in template with user concept
    let prompt = template.replace(CONCEPT_PLACEHOLDER, effectiveConcept)

    // Step 4: Inject amendment context if provided (AC2, AC3)
    if (amendmentContext !== undefined && amendmentContext !== '') {
      const maxPromptChars = MAX_PROMPT_TOKENS * 4
      const basePromptLen = prompt.length
      const framingLen = AMENDMENT_CONTEXT_HEADER.length + AMENDMENT_CONTEXT_FOOTER.length
      const availableForContext = maxPromptChars - basePromptLen - framingLen - TRUNCATED_MARKER.length

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

    // Step 5: Validate total prompt token count <= 2,500 (chars/4 heuristic)
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
      taskType: 'analysis',
      outputSchema: AnalysisOutputSchema,
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
        details: `Analysis agent timed out after ${dispatchResult.durationMs}ms`,
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

    // Step 8: Validate and extract ProductBrief from parsed result
    if (dispatchResult.parsed === null || dispatchResult.parseError !== null) {
      return {
        result: 'failed',
        error: 'schema_validation_failed',
        details: dispatchResult.parseError ?? 'No parsed output returned',
        tokenUsage,
      }
    }

    const parsed = dispatchResult.parsed as { result: string; product_brief: ProductBrief }

    if (parsed.result === 'failed' || !parsed.product_brief) {
      return {
        result: 'failed',
        error: 'agent_reported_failure',
        details: 'Agent returned result: failed or missing product_brief',
        tokenUsage,
      }
    }

    const brief = parsed.product_brief

    // Step 9: Store each field as a separate decision record
    for (const field of BRIEF_FIELDS) {
      const value = brief[field]
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'analysis',
        category: 'product-brief',
        key: field,
        value: Array.isArray(value) ? JSON.stringify(value) : String(value),
      })
    }

    // Step 10: Register product-brief artifact
    const artifact = registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      type: 'product-brief',
      path: 'decision-store://analysis/product-brief',
      summary: brief.problem_statement.substring(0, 100),
    })

    // Step 11: Return success result
    return {
      result: 'success',
      product_brief: brief,
      artifact_id: artifact.id,
      tokenUsage,
    }
  } catch (err) {
    // Step 12: On any unexpected failure, return error result
    const message = err instanceof Error ? err.message : String(err)
    return {
      result: 'failed',
      error: message,
      tokenUsage: zeroTokenUsage,
    }
  }
}
