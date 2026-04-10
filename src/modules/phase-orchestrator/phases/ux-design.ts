/**
 * UX Design phase implementation for the Phase Orchestrator pipeline.
 *
 * Implements `runUxDesignPhase()` which executes a 3-step UX design workflow:
 *
 *  Step 1: UX Discovery + Core Experience
 *    - User personas, core experience goals, emotional response, inspiration
 *    - Covers BMAD 14-step UX workflow steps 2-5
 *
 *  Step 2: Design System + Visual Foundation
 *    - Design system approach, visual language, design directions
 *    - Covers BMAD 14-step UX workflow steps 6-9
 *
 *  Step 3: User Journeys + Component Strategy + Accessibility
 *    - User flows, component architecture, UX patterns, responsive/a11y
 *    - Covers BMAD 14-step UX workflow steps 10-13
 *
 * Each step builds on prior step decisions via the decision store.
 * The phase registers a 'ux-design' artifact on completion.
 *
 * Entry gate: 'prd' artifact from planning must exist
 * Exit gate: 'ux-design' artifact must exist
 */

import { registerArtifact } from '../../../persistence/queries/decisions.js'
import { runSteps } from '../step-runner.js'
import type { StepDefinition } from '../step-runner.js'
import {
  UxDiscoveryOutputSchema,
  UxDesignSystemOutputSchema,
  UxJourneysOutputSchema,
} from './schemas.js'
import type { UxDesignPhaseParams, UxDesignResult, PhaseDeps } from './types.js'

// ---------------------------------------------------------------------------
// Multi-step UX design definitions
// ---------------------------------------------------------------------------

/**
 * Build step definitions for 3-step UX design decomposition.
 *
 * Step 1: Discovery + Core Experience
 *   - Injects product brief and requirements context
 *   - Produces: target_personas, core_experience, emotional_goals, inspiration_references
 *
 * Step 2: Design System + Visual Foundation
 *   - Injects product brief, requirements, and Step 1 discoveries
 *   - Produces: design_system, visual_foundation, design_principles, color_and_typography
 *
 * Step 3: User Journeys + Components + Accessibility
 *   - Injects product brief, requirements, Step 1 discoveries, Step 2 design system
 *   - Produces: user_journeys, component_strategy, ux_patterns, accessibility_guidelines
 *   - Registers 'ux-design' artifact
 */
export function buildUxDesignSteps(): StepDefinition[] {
  return [
    {
      name: 'ux-step-1-discovery',
      taskType: 'ux-discovery',
      outputSchema: UxDiscoveryOutputSchema,
      context: [
        { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
      ],
      persist: [
        { field: 'target_personas', category: 'ux-design', key: 'target_personas' },
        { field: 'core_experience', category: 'ux-design', key: 'core_experience' },
        { field: 'emotional_goals', category: 'ux-design', key: 'emotional_goals' },
        { field: 'inspiration_references', category: 'ux-design', key: 'inspiration_references' },
      ],
      elicitate: true,
      elicitationMethods: ['User Persona Focus Group', 'SCAMPER'],
    },
    {
      name: 'ux-step-2-design-system',
      taskType: 'ux-design-system',
      outputSchema: UxDesignSystemOutputSchema,
      context: [
        { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
        { placeholder: 'ux_discovery', source: 'step:ux-step-1-discovery' },
      ],
      persist: [
        { field: 'design_system', category: 'ux-design', key: 'design_system' },
        { field: 'visual_foundation', category: 'ux-design', key: 'visual_foundation' },
        { field: 'design_principles', category: 'ux-design', key: 'design_principles' },
        { field: 'color_and_typography', category: 'ux-design', key: 'color_and_typography' },
      ],
      elicitate: true,
      elicitationMethods: ['SCAMPER', 'Design Thinking'],
    },
    {
      name: 'ux-step-3-journeys',
      taskType: 'ux-journeys',
      outputSchema: UxJourneysOutputSchema,
      context: [
        { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
        { placeholder: 'requirements', source: 'decision:planning.functional-requirements' },
        { placeholder: 'ux_discovery', source: 'step:ux-step-1-discovery' },
        { placeholder: 'design_system', source: 'step:ux-step-2-design-system' },
      ],
      persist: [
        { field: 'user_journeys', category: 'ux-design', key: 'user_journeys' },
        { field: 'component_strategy', category: 'ux-design', key: 'component_strategy' },
        { field: 'ux_patterns', category: 'ux-design', key: 'ux_patterns' },
        {
          field: 'accessibility_guidelines',
          category: 'ux-design',
          key: 'accessibility_guidelines',
        },
      ],
      registerArtifact: {
        type: 'ux-design',
        path: 'decision-store://ux-design/ux-design',
        summarize: (parsed) => {
          const journeys = Array.isArray(parsed.user_journeys) ? parsed.user_journeys : undefined
          const patterns = Array.isArray(parsed.ux_patterns) ? parsed.ux_patterns : undefined
          const count = (journeys?.length ?? 0) + (patterns?.length ?? 0)
          return count > 0
            ? `${count} UX decisions captured (journeys + patterns)`
            : 'UX design complete'
        },
      },
      critique: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// runUxDesignPhase
// ---------------------------------------------------------------------------

/**
 * Execute the UX design phase of the BMAD pipeline.
 *
 * Runs 3 sequential steps covering discovery, design system, and user journeys.
 * Each step builds on prior step decisions via the decision store.
 *
 * On success, a 'ux-design' artifact is registered and UX decisions are
 * available to the architecture phase via `decision:ux-design.*`.
 *
 * @param deps - Shared phase dependencies (db, pack, contextCompiler, dispatcher)
 * @param params - Phase parameters (runId)
 * @returns UxDesignResult with success/failure status and token usage
 */
export async function runUxDesignPhase(
  deps: PhaseDeps,
  params: UxDesignPhaseParams
): Promise<UxDesignResult> {
  const { runId } = params
  const zeroTokenUsage = { input: 0, output: 0 }

  try {
    const steps = buildUxDesignSteps()
    const result = await runSteps(steps, deps, runId, 'ux-design', {})

    if (!result.success) {
      return {
        result: 'failed',
        error: result.error ?? 'ux_design_multi_step_failed',
        details: result.error ?? 'UX design multi-step execution failed',
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
        phase: 'ux-design',
        type: 'ux-design',
        path: 'decision-store://ux-design/ux-design',
        summary: 'UX design phase completed',
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
