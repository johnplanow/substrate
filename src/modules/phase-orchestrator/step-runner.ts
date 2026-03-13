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
      const budgetTokens = calculateDynamicBudget(4_000, allDecisions.length)
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
        agent: 'claude-code',
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
                agent: 'claude-code',
                taskType: 'elicitation',
                outputSchema: ElicitationOutputSchema,
              })

              const elicitResult = await elicitHandle.result
              elicitInput += elicitResult.tokenEstimate.input
              elicitOutput += elicitResult.tokenEstimate.output

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

  return {
    success: true,
    steps: stepResults,
    tokenUsage: { input: totalInput, output: totalOutput },
    elicitationTokenUsage: { input: totalElicitationInput, output: totalElicitationOutput },
  }
}
