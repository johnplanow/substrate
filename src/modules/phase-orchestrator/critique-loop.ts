/**
 * Critique loop for the Phase Orchestrator.
 *
 * Orchestrates an iterative quality-improvement loop around a phase artifact:
 *  1. Dispatch a critique agent to evaluate the artifact
 *  2. If verdict is 'pass', return immediately
 *  3. If verdict is 'needs_work', dispatch a refinement agent and iterate
 *  4. Repeat up to maxIterations (default 2)
 *  5. On max-iterations reached, log remaining issues as warnings
 *  6. Store each critique result in the decision store under category 'critique'
 *  7. Track token costs separately for critique and refinement passes
 *  8. Track total wall-clock time for the loop
 */

import { upsertDecision } from '../../persistence/queries/decisions.js'
import { upsertPhaseOutput } from '../../persistence/queries/phase-outputs.js'
import { createLogger } from '../../utils/logger.js'
import { CritiqueOutputSchema } from './schemas/critique-output.js'
import type { CritiqueOutput, CritiqueIssue } from './schemas/critique-output.js'
import type { PhaseDeps } from './phases/types.js'

const logger = createLogger('critique-loop')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for configuring the critique loop.
 */
export interface CritiqueOptions {
  /** Maximum number of critique→refine iterations (default: 2) */
  maxIterations?: number
  /** Project context to inject into critique prompts (optional) */
  projectContext?: string
  /** Phase context to inject into refinement prompts (optional) */
  phaseContext?: string
  /**
   * G11: If provided, write each critique and refinement dispatch's raw
   * output to the `phase_outputs` table so the eval CLI can read them.
   * Composite `step_name`s:
   *   - `${captureStepName}:critique:${iteration}` — critique dispatch output
   *   - `${captureStepName}:critique:${iteration}:refine` — refinement dispatch output
   *
   * When omitted, no capture happens (backward-compatible). Pre-G11 the
   * critique and refinement dispatches lived outside the G2 step-runner
   * capture path and their output was invisible to eval.
   */
  captureStepName?: string
}

/**
 * Result of a single critique loop execution.
 */
export interface CritiqueLoopResult {
  /** Whether the artifact passed all critique checks (pass) or loop exhausted (needs_work) */
  verdict: 'pass' | 'needs_work'
  /** Total number of critique iterations executed */
  iterations: number
  /** Issues remaining after all iterations (empty if verdict is 'pass') */
  remainingIssues: CritiqueIssue[]
  /** Token costs attributed to critique dispatches */
  critiqueTokens: { input: number; output: number }
  /** Token costs attributed to refinement dispatches */
  refinementTokens: { input: number; output: number }
  /** Total wall-clock time for the entire loop in milliseconds */
  totalMs: number
  /** Whether an error occurred (loop continues but logs warning) */
  error?: string
}

// ---------------------------------------------------------------------------
// Phase → prompt name mapping
// ---------------------------------------------------------------------------

/**
 * Maps a phase name to the critique prompt template name.
 * Falls back to `critique-${phase}` for unknown phases.
 */
function getCritiquePromptName(phase: string): string {
  const mapping: Record<string, string> = {
    analysis: 'critique-analysis',
    planning: 'critique-planning',
    solutioning: 'critique-architecture',
    architecture: 'critique-architecture',
    stories: 'critique-stories',
    research: 'critique-research',
  }
  return mapping[phase] ?? `critique-${phase}`
}

// ---------------------------------------------------------------------------
// runCritiqueLoop
// ---------------------------------------------------------------------------

/**
 * Execute a critique-and-refine loop on a phase artifact.
 *
 * Dispatches a critique agent, checks the verdict, and if the artifact
 * needs work, dispatches a refinement agent and repeats up to maxIterations.
 * After each critique, stores the result in the decision store under category 'critique'.
 *
 * @param artifact - The artifact content (raw text/YAML/markdown) to critique
 * @param phaseId - Phase name used to select the critique prompt template
 * @param runId - Pipeline run ID for decision store scoping
 * @param phase - Phase name for decision store persistence
 * @param deps - Shared phase dependencies (db, pack, dispatcher)
 * @param options - Critique loop configuration options
 * @returns CritiqueLoopResult with verdict, token costs, and timing
 */
export async function runCritiqueLoop(
  artifact: string,
  phaseId: string,
  runId: string,
  phase: string,
  deps: PhaseDeps,
  options: CritiqueOptions = {},
): Promise<CritiqueLoopResult> {
  const {
    maxIterations = 2,
    projectContext = '',
    phaseContext = '',
    captureStepName,
  } = options
  const startMs = Date.now()

  const critiqueTokens = { input: 0, output: 0 }
  const refinementTokens = { input: 0, output: 0 }
  let iterations = 0
  let currentArtifact = artifact
  let lastCritiqueOutput: CritiqueOutput | null = null

  const critiquePromptName = getCritiquePromptName(phaseId)

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1

    // ------------------------------------------------------------------
    // 1. Load and render critique prompt
    // ------------------------------------------------------------------
    let critiquePrompt: string
    try {
      const critiqueTemplate = await deps.pack.getPrompt(critiquePromptName)
      critiquePrompt = critiqueTemplate
        .replace('{{artifact_content}}', currentArtifact)
        .replace('{{project_context}}', projectContext)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        { phaseId, promptName: critiquePromptName, err: message },
        'Critique loop: failed to load critique prompt template — skipping critique',
      )
      return {
        verdict: 'pass',
        iterations,
        remainingIssues: [],
        critiqueTokens,
        refinementTokens,
        totalMs: Date.now() - startMs,
        error: `Failed to load critique prompt '${critiquePromptName}': ${message}`,
      }
    }

    // ------------------------------------------------------------------
    // 2. Dispatch critique agent
    // ------------------------------------------------------------------
    let critiqueOutput: CritiqueOutput
    try {
      const handle = deps.dispatcher.dispatch({
        prompt: critiquePrompt,
        agent: deps.agentId ?? 'claude-code',
        taskType: 'critique',
        outputSchema: CritiqueOutputSchema,
      })

      const result = await handle.result
      critiqueTokens.input += result.tokenEstimate.input
      critiqueTokens.output += result.tokenEstimate.output

      // G11: capture the raw critique dispatch output to phase_outputs.
      // Wrapped in try/catch — capture is diagnostic, must not fail the
      // loop. Idempotent via composite key so a retry upserts in place.
      if (captureStepName && result.output && result.output.length > 0) {
        try {
          await upsertPhaseOutput(deps.db, {
            pipeline_run_id: runId,
            phase,
            step_name: `${captureStepName}:critique:${i + 1}`,
            raw_output: result.output,
          })
        } catch (captureErr) {
          logger.warn(
            {
              phaseId,
              iteration: i + 1,
              err: captureErr instanceof Error ? captureErr.message : String(captureErr),
            },
            'Critique loop: phase_outputs capture failed — continuing without raw-output record',
          )
        }
      }

      if (result.status !== 'completed' || result.parsed === null) {
        const errMsg = result.parseError ?? `Critique dispatch ended with status '${result.status}'`
        logger.warn(
          { phaseId, iteration: i + 1, err: errMsg },
          'Critique loop: critique dispatch failed — treating as pass to avoid blocking pipeline',
        )
        return {
          verdict: 'pass',
          iterations,
          remainingIssues: [],
          critiqueTokens,
          refinementTokens,
          totalMs: Date.now() - startMs,
          error: errMsg,
        }
      }

      critiqueOutput = result.parsed as CritiqueOutput
      lastCritiqueOutput = critiqueOutput
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        { phaseId, iteration: i + 1, err: message },
        'Critique loop: critique dispatch threw — treating as pass to avoid blocking pipeline',
      )
      return {
        verdict: 'pass',
        iterations,
        remainingIssues: [],
        critiqueTokens,
        refinementTokens,
        totalMs: Date.now() - startMs,
        error: message,
      }
    }

    // ------------------------------------------------------------------
    // 3. Store critique result in decision store (AC7)
    // ------------------------------------------------------------------
    try {
      await upsertDecision(deps.db, {
        pipeline_run_id: runId,
        phase,
        category: 'critique',
        key: `${phaseId}-iteration-${i + 1}-verdict`,
        value: critiqueOutput.verdict,
        rationale: `Critique loop iteration ${i + 1} of ${maxIterations}`,
      })

      await upsertDecision(deps.db, {
        pipeline_run_id: runId,
        phase,
        category: 'critique',
        key: `${phaseId}-iteration-${i + 1}-issue_count`,
        value: String(critiqueOutput.issue_count),
      })

      if (critiqueOutput.issues.length > 0) {
        await upsertDecision(deps.db, {
          pipeline_run_id: runId,
          phase,
          category: 'critique',
          key: `${phaseId}-iteration-${i + 1}-issues`,
          value: JSON.stringify(critiqueOutput.issues),
        })
      }
    } catch (err) {
      // Non-fatal: decision store write failure should not block the pipeline
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        { phaseId, iteration: i + 1, err: message },
        'Critique loop: failed to store critique decision — continuing',
      )
    }

    // ------------------------------------------------------------------
    // 4. Check verdict
    // ------------------------------------------------------------------
    if (critiqueOutput.verdict === 'pass') {
      logger.info(
        { phaseId, iteration: i + 1 },
        'Critique loop: artifact passed critique — loop complete',
      )
      return {
        verdict: 'pass',
        iterations,
        remainingIssues: [],
        critiqueTokens,
        refinementTokens,
        totalMs: Date.now() - startMs,
      }
    }

    // ------------------------------------------------------------------
    // 5. Needs work: dispatch refinement (unless this was the last iteration)
    // ------------------------------------------------------------------
    logger.info(
      { phaseId, iteration: i + 1, issueCount: critiqueOutput.issue_count },
      'Critique loop: artifact needs work — dispatching refinement',
    )

    if (i < maxIterations - 1) {
      // There is at least one more iteration — refine and continue
      let refinePrompt: string
      try {
        const refineTemplate = await deps.pack.getPrompt('refine-artifact')
        const issuesText = critiqueOutput.issues
          .map((issue) => `- [${issue.severity}] ${issue.category}: ${issue.description}\n  Suggestion: ${issue.suggestion}`)
          .join('\n')

        refinePrompt = refineTemplate
          .replace('{{original_artifact}}', currentArtifact)
          .replace('{{critique_issues}}', issuesText)
          .replace('{{phase_context}}', phaseContext)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(
          { phaseId, iteration: i + 1, err: message },
          'Critique loop: failed to load refinement prompt — stopping loop',
        )
        break
      }

      try {
        const refineHandle = deps.dispatcher.dispatch({
          prompt: refinePrompt,
          agent: deps.agentId ?? 'claude-code',
          taskType: 'critique',
          outputSchema: undefined,
        })

        const refineResult = await refineHandle.result
        refinementTokens.input += refineResult.tokenEstimate.input
        refinementTokens.output += refineResult.tokenEstimate.output

        // G11: capture the raw refinement dispatch output to phase_outputs.
        // Same pattern as the critique capture above: diagnostic, wrapped
        // in try/catch, composite-keyed for idempotency. Separate
        // step_name suffix (:refine) so the eval CLI can distinguish the
        // critique-evaluated artifact from the refined artifact.
        if (
          captureStepName &&
          refineResult.output &&
          refineResult.output.length > 0
        ) {
          try {
            await upsertPhaseOutput(deps.db, {
              pipeline_run_id: runId,
              phase,
              step_name: `${captureStepName}:critique:${i + 1}:refine`,
              raw_output: refineResult.output,
            })
          } catch (captureErr) {
            logger.warn(
              {
                phaseId,
                iteration: i + 1,
                err: captureErr instanceof Error ? captureErr.message : String(captureErr),
              },
              'Critique loop: refinement phase_outputs capture failed — continuing without raw-output record',
            )
          }
        }

        if (refineResult.status === 'completed' && refineResult.output) {
          // Log delta between original and refined artifact
          const originalLength = currentArtifact.length
          const refinedLength = refineResult.output.length
          const delta = refinedLength - originalLength
          logger.info(
            { phaseId, iteration: i + 1, originalLength, refinedLength, delta },
            'Critique loop: refinement complete',
          )
          currentArtifact = refineResult.output
        } else {
          logger.warn(
            { phaseId, iteration: i + 1, status: refineResult.status },
            'Critique loop: refinement dispatch failed — stopping loop',
          )
          break
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(
          { phaseId, iteration: i + 1, err: message },
          'Critique loop: refinement dispatch threw — stopping loop',
        )
        break
      }
    }
  }

  // ------------------------------------------------------------------
  // 6. Max iterations reached — log remaining issues as warnings
  // ------------------------------------------------------------------
  const remainingIssues = lastCritiqueOutput?.issues ?? []

  if (remainingIssues.length > 0) {
    logger.warn(
      { phaseId, maxIterations, issueCount: remainingIssues.length },
      'Critique loop: max iterations reached with unresolved issues',
    )
    for (const issue of remainingIssues) {
      logger.warn(
        { phaseId, severity: issue.severity, category: issue.category, description: issue.description },
        `Critique loop: unresolved issue — ${issue.severity}: ${issue.description}`,
      )
    }
  }

  return {
    verdict: 'needs_work',
    iterations,
    remainingIssues,
    critiqueTokens,
    refinementTokens,
    totalMs: Date.now() - startMs,
  }
}
