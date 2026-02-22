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
import { AnalysisOutputSchema } from './schemas.js'
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
// runAnalysisPhase
// ---------------------------------------------------------------------------

/**
 * Execute the analysis phase of the BMAD pipeline.
 *
 * Retrieves the compiled analysis prompt, injects the user concept,
 * dispatches to a claude-code agent, validates the output, and persists
 * the product brief to the decision store.
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
