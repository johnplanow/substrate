/**
 * Multi-step phase decomposition runner.
 *
 * Provides the core abstraction for executing a sequence of focused steps
 * within a phase, where each step:
 *  1. Loads a prompt template from the methodology pack
 *  2. Resolves context references (from params or decision store)
 *  3. Injects context into the template placeholders
 *  4. Dispatches to an agent via the dispatcher
 *  5. Persists output to the decision store
 *
 * This enables iterative refinement within a phase — each step builds on
 * the accumulated context from previous steps.
 */

import type { ZodSchema } from 'zod'
import {
  upsertDecision,
  getDecisionsByPhaseForRun,
  registerArtifact,
} from '../../persistence/queries/decisions.js'
import { upsertPhaseOutput } from '../../persistence/queries/phase-outputs.js'
import { calculateDynamicBudget, summarizeDecisions } from './budget-utils.js'
import { createLogger } from '../../utils/logger.js'
import type { PhaseDeps } from './phases/types.js'
import { runCritiqueLoop } from './critique-loop.js'
import {
  selectMethods,
  deriveContentType,
  type ElicitationMethod,
} from './elicitation-selector.js'
import { ElicitationOutputSchema } from './phases/schemas.js'

const logger = createLogger('step-runner')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A reference to context to inject into a step prompt template.
 */
export interface ContextRef {
  /** Placeholder in the template, e.g. "concept" maps to {{concept}} */
  placeholder: string
  /**
   * Source of the context value:
   * - "param:key" — reads from the params map passed to runSteps
   * - "decision:phase.category" — reads all decisions for that phase+category from the store
   * - "step:stepName" — reads the raw output from a prior step in the current run
   */
  source: string
}

/**
 * Mapping for persisting step output fields to the decision store.
 */
export interface PersistMapping {
  /** Field name in the parsed output object */
  field: string
  /** Decision store category to persist under */
  category: string
  /** Decision store key (or "array" to persist each array element with indexed keys) */
  key: string
}

/**
 * Optional artifact registration after a step completes.
 */
export interface ArtifactRegistration {
  /** Artifact type (e.g., 'product-brief', 'architecture') */
  type: string
  /** Artifact path */
  path: string
  /** Function to compute the artifact summary from parsed output */
  summarize: (parsed: Record<string, unknown>) => string
}

/**
 * Definition for a single step in a multi-step phase.
 */
export interface StepDefinition {
  /** Unique step name */
  name: string
  /** Task type for the dispatcher (determines timeout and max turns) */
  taskType: string
  /** Zod output schema for validating the agent's YAML output */
  outputSchema: ZodSchema
  /** Context references to resolve and inject into the template */
  context: ContextRef[]
  /** Mappings for persisting output fields to the decision store */
  persist: PersistMapping[]
  /** Optional artifact registration on success */
  registerArtifact?: ArtifactRegistration
  /**
   * When true, a critique loop is run after the step completes successfully.
   * The critique agent evaluates the artifact and may trigger a refinement pass
   * before the step result is finalized. Token costs from the critique loop are
   * included in the overall token usage totals. Critique failure is non-blocking
   * — the pipeline continues even if the critique loop errors.
   */
  critique?: boolean
  /**
   * When true, automated elicitation runs after the step completes successfully.
   * The elicitation selector picks 1-2 methods appropriate for the content type,
   * dispatches a sub-agent to apply each method, and stores insights in the
   * decision store with category 'elicitation'. Token costs from elicitation are
   * tracked separately. Elicitation failure is non-blocking.
   */
  elicitate?: boolean
  /**
   * Optional list of preferred elicitation method names to hint the elicitation
   * subsystem toward techniques well-suited for this step's content type.
   * For example, UX discovery steps may prefer 'User Persona Focus Group' and
   * 'SCAMPER'. When provided, these names are passed as domain keywords to the
   * elicitation selector to boost their selection probability.
   */
  elicitationMethods?: string[]
}

/**
 * Result of a single step execution.
 */
export interface StepResult {
  /** Step name */
  name: string
  /** Whether the step succeeded */
  success: boolean
  /** Parsed output from the agent (null on failure) */
  parsed: Record<string, unknown> | null
  /** Error message (null on success) */
  error: string | null
  /** Token usage for this step */
  tokenUsage: { input: number; output: number }
  /** Registered artifact ID (if any) */
  artifactId?: string
  /** Token usage from elicitation dispatches (separate from main step tokens) */
  elicitationTokenUsage?: { input: number; output: number }
}

/**
 * Result of a self-eval check after all phase steps complete (V1b / Epic 55).
 */
export interface SelfEvalResult {
  /** Aggregate phase score from the eval engine */
  score: number
  /** Whether the score meets the configured threshold */
  pass: boolean
  /** Human-readable feedback suitable for retry prompt injection */
  feedback: string
}

/**
 * Callback interface for self-eval at phase boundaries (Epic 55-1).
 *
 * Decouples the step runner from the eval module — the caller wires
 * the EvalEngine into this hook. The step runner only knows it gets
 * a score and feedback; it doesn't import eval types or modules.
 */
export interface SelfEvalHook {
  /**
   * Evaluate the combined phase output.
   * @param phaseOutput - Concatenated step outputs (same format eval.ts uses)
   * @param phase - Phase name
   * @param promptTemplate - The prompt template from the last step (used for prompt-compliance)
   * @param context - Upstream context as key-value pairs
   * @returns Score, pass/fail, and feedback for potential retry
   */
  evaluate(
    phaseOutput: string,
    phase: string,
    promptTemplate: string,
    context: Record<string, string>,
  ): Promise<SelfEvalResult>
}

/**
 * Result of a multi-step run.
 */
export interface MultiStepResult {
  /** Whether all steps completed successfully */
  success: boolean
  /** Results for each executed step (may be fewer than total if a step failed) */
  steps: StepResult[]
  /** Aggregated token usage across all steps */
  tokenUsage: { input: number; output: number }
  /** Aggregated token usage from elicitation dispatches across all steps */
  elicitationTokenUsage: { input: number; output: number }
  /** Error from the first failed step (if any) */
  error?: string
  /** Self-eval result (Epic 55-1). Undefined if self-eval not configured or phase failed. */
  selfEvalResult?: SelfEvalResult
}

/** Action to take when self-eval fails after all retries are exhausted (Epic 55-2). */
export type SelfEvalOnFail = 'retry' | 'escalate' | 'block'

/**
 * Configuration for self-eval retry behavior (Epic 55-2).
 * The caller provides this alongside the SelfEvalHook.
 */
export interface SelfEvalOptions {
  /** The eval hook to invoke */
  hook: SelfEvalHook
  /** Max retry attempts on low score (default: 1) */
  maxRetries?: number
  /** Action on final failure: 'retry' re-runs (redundant here), 'escalate' flags + continues, 'block' halts */
  onFail?: SelfEvalOnFail
}

/**
 * Extended result from runStepsWithSelfEval (Epic 55-2).
 * Includes retry history alongside the final MultiStepResult.
 */
export interface SelfEvalRunResult {
  /** The final MultiStepResult (from the last attempt) */
  result: MultiStepResult
  /** Number of self-eval retries performed (0 if first attempt passed) */
  retryCount: number
  /** Self-eval results from each attempt (first attempt + retries) */
  evalHistory: SelfEvalResult[]
  /** Whether the phase was escalated due to self-eval failure */
  escalated: boolean
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

/**
 * Format an array of decision records into a markdown section for injection.
 *
 * @param decisions - Decision records from the store
 * @param sectionTitle - Title for the markdown section
 * @returns Formatted markdown string
 */
export function formatDecisionsForInjection(
  decisions: Array<{ key: string; value: string; rationale?: string | null }>,
  sectionTitle?: string,
): string {
  if (decisions.length === 0) return ''

  const parts: string[] = []
  if (sectionTitle) {
    parts.push(`## ${sectionTitle}`)
  }

  for (const d of decisions) {
    const rationale = d.rationale ? ` (${d.rationale})` : ''
    // Try to parse JSON array/object values for better formatting
    try {
      const parsed = JSON.parse(d.value)
      if (Array.isArray(parsed)) {
        parts.push(`### ${d.key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`)
        for (const item of parsed) {
          parts.push(`- ${String(item)}`)
        }
      } else if (typeof parsed === 'object' && parsed !== null) {
        parts.push(`- **${d.key}**: ${JSON.stringify(parsed)}${rationale}`)
      } else {
        parts.push(`- **${d.key}**: ${String(parsed)}${rationale}`)
      }
    } catch {
      parts.push(`- **${d.key}**: ${d.value}${rationale}`)
    }
  }

  return parts.join('\n')
}

/**
 * Resolve a single context reference to a string value.
 *
 * @param ref - The context reference to resolve
 * @param deps - Phase dependencies (for DB access)
 * @param runId - Pipeline run ID
 * @param params - Runtime parameters map
 * @param stepOutputs - Map of step name → raw parsed output from prior steps
 * @returns Resolved string value
 */
export async function resolveContext(
  ref: ContextRef,
  deps: PhaseDeps,
  runId: string,
  params: Record<string, string>,
  stepOutputs: Map<string, Record<string, unknown>>,
): Promise<string> {
  const { source } = ref

  // param:key — read from runtime params
  if (source.startsWith('param:')) {
    const key = source.slice('param:'.length)
    return params[key] ?? ''
  }

  // decision:phase.category — read from decision store
  if (source.startsWith('decision:')) {
    const path = source.slice('decision:'.length)
    const [phase, category] = path.split('.')
    if (!phase || !category) return ''

    const decisions = await getDecisionsByPhaseForRun(deps.db, runId, phase)
    const filtered = decisions.filter((d) => d.category === category)

    return formatDecisionsForInjection(
      filtered.map((d) => ({ key: d.key, value: d.value, rationale: d.rationale ?? null })),
      category.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    )
  }

  // step:stepName — read raw output from a prior step
  if (source.startsWith('step:')) {
    const stepName = source.slice('step:'.length)
    const output = stepOutputs.get(stepName)
    if (!output) return ''

    // Format the step output as YAML-ish markdown
    const parts: string[] = []
    for (const [key, value] of Object.entries(output)) {
      if (key === 'result') continue
      if (Array.isArray(value)) {
        parts.push(`### ${key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`)
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            parts.push(`- ${JSON.stringify(item)}`)
          } else {
            parts.push(`- ${String(item)}`)
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        parts.push(`- **${key}**: ${JSON.stringify(value)}`)
      } else {
        parts.push(`- **${key}**: ${String(value)}`)
      }
    }
    return parts.join('\n')
  }

  return ''
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/**
 * Execute a sequence of steps, accumulating context and persisting results.
 *
 * Halts on the first step that fails. Each step's output is available to
 * subsequent steps via the stepOutputs map and decision store.
 *
 * @param steps - Ordered list of step definitions to execute
 * @param deps - Shared phase dependencies
 * @param runId - Pipeline run ID
 * @param phase - Phase name (for decision store persistence)
 * @param params - Runtime parameters map (concept, product_brief, etc.)
 * @returns Aggregated multi-step result
 */
export async function runSteps(
  steps: StepDefinition[],
  deps: PhaseDeps,
  runId: string,
  phase: string,
  params: Record<string, string>,
  selfEval?: SelfEvalHook,
): Promise<MultiStepResult> {
  const stepResults: StepResult[] = []
  const stepOutputs = new Map<string, Record<string, unknown>>()
  let totalInput = 0
  let totalOutput = 0
  let totalElicitationInput = 0
  let totalElicitationOutput = 0
  const usedElicitationMethods: string[] = []

  for (const step of steps) {
    try {
      // 1. Load prompt template
      const template = await deps.pack.getPrompt(step.name)

      // 2. Resolve context references and inject into template
      let prompt = template
      for (const ref of step.context) {
        const value = await resolveContext(ref, deps, runId, params, stepOutputs)
        prompt = prompt.replace(`{{${ref.placeholder}}}`, value)
      }

      // 3. Validate token budget (use dynamic budget based on decision count)
      const allDecisions = await getDecisionsByPhaseForRun(deps.db, runId, phase)
      const budgetTokens = calculateDynamicBudget(8_000, allDecisions.length)
      let estimatedTokens = Math.ceil(prompt.length / 4)

      // 3b. If prompt exceeds budget, attempt to summarize decision-based context
      if (estimatedTokens > budgetTokens) {
        const decisionRefs = step.context.filter((ref) => ref.source.startsWith('decision:'))

        if (decisionRefs.length > 0) {
          logger.warn(
            { step: step.name, estimatedTokens, budgetTokens },
            'Prompt exceeds budget — attempting decision summarization',
          )

          // Re-resolve decision refs with summarized content
          let summarizedPrompt = template
          for (const ref of step.context) {
            let value: string
            if (ref.source.startsWith('decision:')) {
              // Resolve decisions and summarize them
              const path = ref.source.slice('decision:'.length)
              const [decPhase, decCategory] = path.split('.')
              if (decPhase && decCategory) {
                const decisions = await getDecisionsByPhaseForRun(deps.db, runId, decPhase)
                const filtered = decisions.filter((d) => d.category === decCategory)
                const budgetChars = budgetTokens * 4
                const availableChars = Math.max(200, Math.floor(budgetChars / decisionRefs.length))
                value = summarizeDecisions(
                  filtered.map((d) => ({ key: d.key, value: d.value, category: d.category })),
                  availableChars,
                )
              } else {
                value = await resolveContext(ref, deps, runId, params, stepOutputs)
              }
            } else {
              value = await resolveContext(ref, deps, runId, params, stepOutputs)
            }
            summarizedPrompt = summarizedPrompt.replace(`{{${ref.placeholder}}}`, value)
          }

          prompt = summarizedPrompt
          estimatedTokens = Math.ceil(prompt.length / 4)

          if (estimatedTokens <= budgetTokens) {
            logger.info(
              { step: step.name, estimatedTokens, budgetTokens },
              'Decision summarization brought prompt within budget',
            )
          }
        }

        // If still over budget after summarization attempt, fail
        if (estimatedTokens > budgetTokens) {
          const errorMsg = `Step '${step.name}' prompt exceeds token budget after summarization: ${estimatedTokens} tokens (max ${budgetTokens})`
          stepResults.push({
            name: step.name,
            success: false,
            parsed: null,
            error: errorMsg,
            tokenUsage: { input: 0, output: 0 },
          })
          return {
            success: false,
            steps: stepResults,
            tokenUsage: { input: totalInput, output: totalOutput },
            elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput },
            error: errorMsg,
          }
        }
      }

      // 4. Dispatch to agent
      const handle = deps.dispatcher.dispatch({
        prompt,
        agent: deps.agentId ?? 'claude-code',
        taskType: step.taskType,
        outputSchema: step.outputSchema,
      })

      const dispatchResult = await handle.result
      const tokenUsage = {
        input: dispatchResult.tokenEstimate.input,
        output: dispatchResult.tokenEstimate.output,
      }
      totalInput += tokenUsage.input
      totalOutput += tokenUsage.output

      // 5. Check dispatch status
      if (dispatchResult.status === 'timeout') {
        const errorMsg = `Step '${step.name}' timed out after ${dispatchResult.durationMs}ms`
        stepResults.push({ name: step.name, success: false, parsed: null, error: errorMsg, tokenUsage })
        return { success: false, steps: stepResults, tokenUsage: { input: totalInput, output: totalOutput }, elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput }, error: errorMsg }
      }

      if (dispatchResult.status === 'failed') {
        const errorMsg = `Step '${step.name}' dispatch failed: ${dispatchResult.parseError ?? dispatchResult.output}`
        stepResults.push({ name: step.name, success: false, parsed: null, error: errorMsg, tokenUsage })
        return { success: false, steps: stepResults, tokenUsage: { input: totalInput, output: totalOutput }, elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput }, error: errorMsg }
      }

      // 6. Validate parsed output
      if (dispatchResult.parsed === null || dispatchResult.parseError !== null) {
        const errorMsg = `Step '${step.name}' schema validation failed: ${dispatchResult.parseError ?? 'No parsed output'}`
        stepResults.push({ name: step.name, success: false, parsed: null, error: errorMsg, tokenUsage })
        return { success: false, steps: stepResults, tokenUsage: { input: totalInput, output: totalOutput }, elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput }, error: errorMsg }
      }

      const parsed = dispatchResult.parsed as Record<string, unknown>

      if (parsed.result === 'failed') {
        const errorMsg = `Step '${step.name}' agent reported failure`
        stepResults.push({ name: step.name, success: false, parsed: null, error: errorMsg, tokenUsage })
        return { success: false, steps: stepResults, tokenUsage: { input: totalInput, output: totalOutput }, elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput }, error: errorMsg }
      }

      // 7. Store output in step outputs map for subsequent steps
      stepOutputs.set(step.name, parsed)

      // 7.5 Capture raw LLM output for eval fidelity (deferred-work G2).
      // Writes one phase_outputs row per successful dispatch so the eval CLI
      // can judge the actual artifact rather than reconstructing from parsed
      // decisions. Idempotent via composite key — safe on resume/retry.
      // Wrapped in try/catch: raw-output capture is diagnostic; a DB hiccup
      // here must NOT fail decision persistence on the happy path.
      try {
        await upsertPhaseOutput(deps.db, {
          pipeline_run_id: runId,
          phase,
          step_name: step.name,
          raw_output: dispatchResult.output,
        })
      } catch (captureErr) {
        logger.warn(
          {
            step: step.name,
            phase,
            err: captureErr instanceof Error ? captureErr.message : String(captureErr),
          },
          'phase_outputs capture failed — continuing without raw-output record for this step',
        )
      }

      // 8. Persist output fields to decision store
      for (const mapping of step.persist) {
        const fieldValue = parsed[mapping.field]
        if (fieldValue === undefined) continue

        if (mapping.key === 'array' && Array.isArray(fieldValue)) {
          // Persist each array element with step-name-prefixed keys to avoid
          // key collisions when multiple steps persist to the same category.
          for (const [index, item] of fieldValue.entries()) {
            await upsertDecision(deps.db, {
              pipeline_run_id: runId,
              phase,
              category: mapping.category,
              key: `${step.name}-${index}`,
              value: typeof item === 'object' ? JSON.stringify(item) : String(item),
            })
          }
        } else if (typeof fieldValue === 'object' && fieldValue !== null) {
          await upsertDecision(deps.db, {
            pipeline_run_id: runId,
            phase,
            category: mapping.category,
            key: mapping.key,
            value: JSON.stringify(fieldValue),
          })
        } else {
          await upsertDecision(deps.db, {
            pipeline_run_id: runId,
            phase,
            category: mapping.category,
            key: mapping.key,
            value: String(fieldValue),
          })
        }
      }

      // 9. Register artifact if configured
      let artifactId: string | undefined
      if (step.registerArtifact) {
        const artifact = await registerArtifact(deps.db, {
          pipeline_run_id: runId,
          phase,
          type: step.registerArtifact.type,
          path: step.registerArtifact.path,
          summary: step.registerArtifact.summarize(parsed),
        })
        artifactId = artifact.id
      }

      // 10. Run critique loop if configured (non-blocking — failure does not abort step)
      if (step.critique === true) {
        try {
          // Serialize the step output as the artifact to critique
          const artifactContent = JSON.stringify(parsed, null, 2)
          const critiqueResult = await runCritiqueLoop(
            artifactContent,
            phase,
            runId,
            phase,
            deps,
            // G11: pass step.name as the capture prefix so critique and
            // refinement dispatches write phase_outputs rows with
            // composite step_names (<step>:critique:<iter>,
            // <step>:critique:<iter>:refine). Eval can then see the
            // full conversational trace for this step.
            { captureStepName: step.name },
          )
          // Add critique and refinement token costs to running totals
          totalInput += critiqueResult.critiqueTokens.input + critiqueResult.refinementTokens.input
          totalOutput += critiqueResult.critiqueTokens.output + critiqueResult.refinementTokens.output
          logger.info(
            {
              step: step.name,
              verdict: critiqueResult.verdict,
              iterations: critiqueResult.iterations,
              totalMs: critiqueResult.totalMs,
            },
            'Step critique loop complete',
          )
        } catch (critiqueErr) {
          // Critique errors are non-blocking — log and continue
          const critiqueMsg = critiqueErr instanceof Error ? critiqueErr.message : String(critiqueErr)
          logger.warn(
            { step: step.name, err: critiqueMsg },
            'Step critique loop threw an error — continuing without critique',
          )
        }
      }

      // 11. Run automated elicitation if configured (non-blocking — failure does not abort step)
      let stepElicitationTokens: { input: number; output: number } | undefined
      if (step.elicitate === true) {
        try {
          const contentType = deriveContentType(phase, step.name)
          const selectedMethods = selectMethods(
            { content_type: contentType },
            usedElicitationMethods,
          )

          if (selectedMethods.length > 0) {
            logger.info(
              {
                step: step.name,
                methods: selectedMethods.map((m) => m.name),
                contentType,
              },
              'Running automated elicitation',
            )

            // Load elicitation prompt template
            const elicitationTemplate = await deps.pack.getPrompt('elicitation-apply')
            const artifactContent = JSON.stringify(parsed, null, 2)
            let elicitInput = 0
            let elicitOutput = 0
            let roundIndex = 0

            for (const method of selectedMethods) {
              roundIndex++
              // Fill the prompt template with method data
              const elicitPrompt = elicitationTemplate
                .replace(/\{\{method_name\}\}/g, method.name)
                .replace(/\{\{method_description\}\}/g, method.description)
                .replace(/\{\{output_pattern\}\}/g, method.output_pattern)
                .replace(/\{\{artifact_content\}\}/g, artifactContent)

              // Dispatch elicitation agent
              const elicitHandle = deps.dispatcher.dispatch({
                prompt: elicitPrompt,
                agent: deps.agentId ?? 'claude-code',
                taskType: 'elicitation',
                outputSchema: ElicitationOutputSchema,
              })

              const elicitResult = await elicitHandle.result
              elicitInput += elicitResult.tokenEstimate.input
              elicitOutput += elicitResult.tokenEstimate.output

              // G11: capture the elicitation dispatch's raw output to
              // phase_outputs so eval can see what the sub-agent produced.
              // Composite step_name: <step>:elicit:<round>:<sanitized-method>
              // where sanitized-method lowercases and kebab-cases the
              // method name for URL/file-safe display. Wrapped in try/catch
              // — capture is a diagnostic side channel and must not fail
              // the step.
              if (elicitResult.output && elicitResult.output.length > 0) {
                try {
                  const sanitizedMethod = method.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '')
                  await upsertPhaseOutput(deps.db, {
                    pipeline_run_id: runId,
                    phase,
                    step_name: `${step.name}:elicit:${roundIndex}:${sanitizedMethod}`,
                    raw_output: elicitResult.output,
                  })
                } catch (captureErr) {
                  logger.warn(
                    {
                      step: step.name,
                      method: method.name,
                      roundIndex,
                      err: captureErr instanceof Error ? captureErr.message : String(captureErr),
                    },
                    'phase_outputs capture failed for elicitation dispatch — continuing',
                  )
                }
              }

              // Store results in decision store if dispatch succeeded
              if (
                elicitResult.status === 'completed' &&
                elicitResult.parsed !== null
              ) {
                const elicitParsed = elicitResult.parsed as { result: string; insights: string }
                if (elicitParsed.result === 'success' && elicitParsed.insights) {
                  // Store method name
                  await upsertDecision(deps.db, {
                    pipeline_run_id: runId,
                    phase,
                    category: 'elicitation',
                    key: `${phase}-round-${roundIndex}-method`,
                    value: method.name,
                  })
                  // Store insights
                  await upsertDecision(deps.db, {
                    pipeline_run_id: runId,
                    phase,
                    category: 'elicitation',
                    key: `${phase}-round-${roundIndex}-insights`,
                    value: elicitParsed.insights,
                  })
                  logger.info(
                    { step: step.name, method: method.name, roundIndex },
                    'Elicitation insights stored in decision store',
                  )
                }
              } else {
                logger.warn(
                  {
                    step: step.name,
                    method: method.name,
                    status: elicitResult.status,
                  },
                  'Elicitation dispatch did not produce valid output — skipping',
                )
              }

              // Track used methods for rotation
              usedElicitationMethods.push(method.name)
            }

            stepElicitationTokens = { input: elicitInput, output: elicitOutput }
            totalElicitationInput += elicitInput
            totalElicitationOutput += elicitOutput
          }
        } catch (elicitErr) {
          // Elicitation errors are non-blocking — log and continue
          const elicitMsg = elicitErr instanceof Error ? elicitErr.message : String(elicitErr)
          logger.warn(
            { step: step.name, err: elicitMsg },
            'Step elicitation threw an error — continuing without elicitation',
          )
        }
      }

      const stepResult: StepResult = {
        name: step.name,
        success: true,
        parsed,
        error: null,
        tokenUsage,
      }
      if (artifactId !== undefined) {
        stepResult.artifactId = artifactId
      }
      if (stepElicitationTokens !== undefined) {
        stepResult.elicitationTokenUsage = stepElicitationTokens
      }
      stepResults.push(stepResult)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const errorMsg = `Step '${step.name}' unexpected error: ${message}`
      stepResults.push({
        name: step.name,
        success: false,
        parsed: null,
        error: errorMsg,
        tokenUsage: { input: 0, output: 0 },
      })
      return {
        success: false,
        steps: stepResults,
        tokenUsage: { input: totalInput, output: totalOutput },
        elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput },
        error: errorMsg,
      }
    }
  }

  // Self-eval at phase boundary (Epic 55-1).
  // Runs after ALL steps succeed. The hook evaluates the combined phase output
  // and returns a score + feedback. The caller (phase orchestrator) uses the
  // result to decide whether to retry the phase with feedback (Story 55-2).
  // Error isolation: self-eval failure is non-blocking — the phase proceeds.
  let selfEvalResult: SelfEvalResult | undefined
  if (selfEval) {
    try {
      // Combine all step outputs into a single phase output string,
      // matching the format eval.ts reads from phase_outputs table.
      const phaseOutput = stepResults
        .filter((r) => r.success && r.parsed)
        .map((r) => JSON.stringify(r.parsed, null, 2))
        .join('\n\n<!-- step-boundary -->\n\n')

      // Use the last step's template as representative for prompt-compliance.
      // This is an approximation — multi-step phases have multiple templates.
      // Future: evaluate each step independently for more granular feedback.
      const lastStep = steps[steps.length - 1]
      const promptTemplate = await deps.pack.getPrompt(lastStep.taskType).catch(() => '')

      // Build context from params (upstream decisions are already in params)
      const context: Record<string, string> = { ...params }

      selfEvalResult = await selfEval.evaluate(phaseOutput, phase, promptTemplate, context)

      logger.info(
        {
          phase,
          score: selfEvalResult.score,
          pass: selfEvalResult.pass,
        },
        'Self-eval complete',
      )
    } catch (evalErr) {
      // Self-eval errors are non-blocking — log and continue.
      // The phase result is still success; the caller sees no selfEvalResult.
      logger.warn(
        {
          phase,
          err: evalErr instanceof Error ? evalErr.message : String(evalErr),
        },
        'Self-eval threw an error — continuing without eval result',
      )
    }
  }

  return {
    success: true,
    steps: stepResults,
    tokenUsage: { input: totalInput, output: totalOutput },
    elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput },
    selfEvalResult,
  }
}

// ---------------------------------------------------------------------------
// Self-eval retry wrapper (Epic 55-2)
// ---------------------------------------------------------------------------

/** Feedback section delimiter injected into retry prompt context. */
const SELF_EVAL_FEEDBACK_KEY = 'self_eval_feedback'

/**
 * Run phase steps with self-eval and automatic retry on low score.
 *
 * Wraps `runSteps()` with a retry loop: if the self-eval hook reports a
 * failing score, the phase is re-run with eval feedback appended to the
 * params so the agent gets corrective guidance. On retry exhaustion, the
 * phase is flagged as escalated (default) or the pipeline blocks.
 *
 * @param steps - Step definitions for this phase
 * @param deps - Phase dependencies
 * @param runId - Pipeline run ID
 * @param phase - Phase name
 * @param params - Runtime parameters (will be enriched with feedback on retry)
 * @param selfEvalOptions - Self-eval hook + retry configuration
 * @returns Final result with retry history
 */
export async function runStepsWithSelfEval(
  steps: StepDefinition[],
  deps: PhaseDeps,
  runId: string,
  phase: string,
  params: Record<string, string>,
  selfEvalOptions: SelfEvalOptions,
): Promise<SelfEvalRunResult> {
  const maxRetries = selfEvalOptions.maxRetries ?? 1
  const onFail: SelfEvalOnFail = selfEvalOptions.onFail ?? 'escalate'
  const evalHistory: SelfEvalResult[] = []
  let retryCount = 0
  let currentParams = { ...params }

  // First attempt
  let result = await runSteps(steps, deps, runId, phase, currentParams, selfEvalOptions.hook)

  // If steps failed or no self-eval result, return immediately
  if (!result.success || !result.selfEvalResult) {
    return { result, retryCount: 0, evalHistory: [], escalated: false }
  }

  evalHistory.push(result.selfEvalResult)

  // Retry loop: re-run with feedback while score is below threshold
  while (!result.selfEvalResult!.pass && retryCount < maxRetries) {
    retryCount++
    const feedback = result.selfEvalResult!.feedback

    logger.info(
      {
        phase,
        retryCount,
        maxRetries,
        previousScore: result.selfEvalResult!.score,
      },
      'Self-eval below threshold — retrying with diagnostic feedback',
    )

    // Inject feedback into params for the retry dispatch.
    // The prompt template can reference {{self_eval_feedback}} or the
    // feedback is appended as a markdown section by the context resolver.
    currentParams = {
      ...currentParams,
      [SELF_EVAL_FEEDBACK_KEY]: [
        '## Previous Output Quality Feedback',
        '',
        feedback,
        '',
        `This is retry ${retryCount} of ${maxRetries}. Address the issues above to improve the output quality.`,
      ].join('\n'),
    }

    result = await runSteps(steps, deps, runId, phase, currentParams, selfEvalOptions.hook)

    if (!result.success || !result.selfEvalResult) {
      // Steps failed on retry or self-eval errored — stop retrying
      return { result, retryCount, evalHistory, escalated: false }
    }

    evalHistory.push(result.selfEvalResult)
  }

  // Check final result
  const finalEval = evalHistory[evalHistory.length - 1]
  const escalated = !!finalEval && !finalEval.pass && onFail !== 'block'

  if (finalEval && !finalEval.pass) {
    if (onFail === 'block') {
      logger.error(
        { phase, score: finalEval.score, retryCount },
        'Self-eval failed after all retries — blocking pipeline (on_fail=block)',
      )
      // Mark result as failed to signal the caller to halt
      result = { ...result, success: false, error: `Self-eval failed after ${retryCount} retries (score: ${finalEval.score.toFixed(2)}, on_fail: block)` }
    } else {
      logger.warn(
        { phase, score: finalEval.score, retryCount },
        'Self-eval failed after all retries — escalating (on_fail=escalate)',
      )
    }
  }

  return { result, retryCount, evalHistory, escalated }
}
