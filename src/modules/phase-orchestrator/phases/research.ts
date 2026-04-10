/**
 * Research phase implementation for the Phase Orchestrator pipeline.
 *
 * Implements `runResearchPhase()` which executes a 2-step research workflow:
 *
 *  Step 1: Research Discovery
 *    - Market context, competitive landscape, technical feasibility
 *    - Produces raw findings for synthesis
 *
 *  Step 2: Research Synthesis
 *    - Distills discovery findings into structured insights
 *    - Identifies risk flags and opportunity signals
 *    - Registers 'research-findings' artifact
 *
 * Each step builds on prior step decisions via the decision store.
 * The phase registers a 'research-findings' artifact on completion.
 */

import { registerArtifact } from '../../../persistence/queries/decisions.js'
import { runSteps } from '../step-runner.js'
import type { StepDefinition } from '../step-runner.js'
import { ResearchDiscoveryOutputSchema, ResearchSynthesisOutputSchema } from './schemas.js'
import type { ResearchPhaseParams, ResearchResult, PhaseDeps } from './types.js'

// ---------------------------------------------------------------------------
// Multi-step research definitions
// ---------------------------------------------------------------------------

/**
 * Build step definitions for 2-step research decomposition.
 *
 * Step 1: Discovery
 *   - Injects concept context
 *   - Produces: concept_classification, market_findings, domain_findings, technical_findings
 *
 * Step 2: Synthesis
 *   - Injects concept and Step 1 raw findings
 *   - Produces: market_context, competitive_landscape, technical_feasibility, risk_flags, opportunity_signals
 *   - Registers 'research-findings' artifact
 */
export function buildResearchSteps(): StepDefinition[] {
  return [
    {
      name: 'research-step-1-discovery',
      taskType: 'research-discovery',
      outputSchema: ResearchDiscoveryOutputSchema,
      context: [{ placeholder: 'concept', source: 'param:concept' }],
      persist: [
        { field: 'concept_classification', category: 'research', key: 'concept_classification' },
        { field: 'market_findings', category: 'research', key: 'market_findings' },
        { field: 'domain_findings', category: 'research', key: 'domain_findings' },
        { field: 'technical_findings', category: 'research', key: 'technical_findings' },
      ],
      elicitate: true,
    },
    {
      name: 'research-step-2-synthesis',
      taskType: 'research-synthesis',
      outputSchema: ResearchSynthesisOutputSchema,
      context: [
        { placeholder: 'concept', source: 'param:concept' },
        { placeholder: 'raw_findings', source: 'step:research-step-1-discovery' },
      ],
      persist: [
        { field: 'market_context', category: 'research', key: 'market_context' },
        { field: 'competitive_landscape', category: 'research', key: 'competitive_landscape' },
        { field: 'technical_feasibility', category: 'research', key: 'technical_feasibility' },
        { field: 'risk_flags', category: 'research', key: 'risk_flags' },
        { field: 'opportunity_signals', category: 'research', key: 'opportunity_signals' },
      ],
      registerArtifact: {
        type: 'research-findings',
        path: 'decision-store://research/research-findings',
        summarize: (parsed) => {
          const risks = Array.isArray(parsed.risk_flags) ? parsed.risk_flags : undefined
          const opportunities = Array.isArray(parsed.opportunity_signals)
            ? parsed.opportunity_signals
            : undefined
          const count = (risks?.length ?? 0) + (opportunities?.length ?? 0)
          return count > 0
            ? `${count} research insights captured (risks + opportunities)`
            : 'Research synthesis complete'
        },
      },
      critique: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// runResearchPhase
// ---------------------------------------------------------------------------

/**
 * Execute the research phase of the BMAD pipeline.
 *
 * Runs 2 sequential steps covering discovery and synthesis.
 * Each step builds on prior step decisions via the decision store.
 *
 * On success, a 'research-findings' artifact is registered and research decisions
 * are available to subsequent phases via `decision:research.*`.
 *
 * @param deps - Shared phase dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Phase parameters (runId, concept)
 * @returns ResearchResult with success/failure status and token usage
 */
export async function runResearchPhase(
  deps: PhaseDeps,
  params: ResearchPhaseParams
): Promise<ResearchResult> {
  const { runId } = params
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    const steps = buildResearchSteps()
    const result = await runSteps(steps, deps, runId, 'research', { concept: params.concept })

    if (!result.success) {
      return {
        result: 'failed',
        error: result.error ?? 'research_multi_step_failed',
        details: result.error ?? 'Research multi-step execution failed',
        tokenUsage: result.tokenUsage,
      }
    }

    // Confirm the artifact was registered by the last step
    const lastStep = result.steps[result.steps.length - 1]
    const artifactId = lastStep?.artifactId

    // If the artifact wasn't registered by the step runner (e.g., fallback path),
    // register it now using the decision store as the artifact path.
    if (!artifactId) {
      const artifact = await registerArtifact(deps.db, {
        pipeline_run_id: runId,
        phase: 'research',
        type: 'research-findings',
        path: 'decision-store://research/research-findings',
        summary: 'Research phase completed',
      })
      return {
        result: 'success',
        artifact_id: artifact.id,
        tokenUsage: result.tokenUsage,
      }
    }

    return {
      result: 'success',
      artifact_id: artifactId,
      tokenUsage: result.tokenUsage,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      result: 'failed',
      error: message,
      tokenUsage: zeroTokenUsage,
    }
  }
}
